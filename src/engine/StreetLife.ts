import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RoadPaths } from './tileTypes';
import {
  PATH_KIND_BIKE,
  PATH_KIND_ROAD,
  ROAD_FLAG_PARKING_LEFT,
  ROAD_FLAG_PARKING_RIGHT,
} from './tileTypes';
import { heightAt } from './terrain';
import type { QualityLevel } from './quality';
import {
  POPULATION_BUDGETS,
  POPULATION_TRIANGLES,
  populationCeiling,
  populationRebuildDistance,
  populationRebuildRequired,
  populationStreamSettled,
  type PopulationBudget,
} from './population/budgets';
import {
  PopulationDensityField,
  type DensityAnchor,
  type DensityAnchorKind,
} from './population/density';
import {
  advanceLaneProgress,
  buildRoadGraph,
  sampleLaneRoute,
  type GraphSegment,
  type LaneRoute,
  type RouteSample,
  type RoadGraph,
} from './population/roadGraph';
import {
  trafficFootprintsOverlap,
  trafficSweptConflict,
  yieldsTo,
  type TrafficFootprint,
} from './population/trafficSafety';
import { buildVehicleBodyGeometry } from './population/vehicleGeometry';

type VehicleKind = 'sedan' | 'suv' | 'van' | 'taxi';

interface TrafficState {
  route: LaneRoute;
  distance: number;
  speed: number;
  targetSpeed: number;
  laneOffset: number;
  laneSign: number;
  direction: 1 | -1;
  finished: boolean;
  key: string;
  lastVisualAt: number;
}

interface VehiclePlacement {
  key: string;
  x: number;
  z: number;
  yaw: number;
  color: THREE.Color;
  kind: VehicleKind;
  traffic?: TrafficState;
  shadowIndex: number;
}

interface PedestrianPlacement {
  key: string;
  segment: GraphSegment;
  distance: number;
  speed: number;
  side: -1 | 1;
  phase: number;
  color: THREE.Color;
  skinColor: THREE.Color;
  scale: number;
  shadowIndex: number;
}

interface CyclistPlacement {
  route: LaneRoute;
  distance: number;
  speed: number;
  laneOffset: number;
  color: THREE.Color;
  shadowIndex: number;
}

interface StaticPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  color?: THREE.Color;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  activityKind?: 'vendor' | 'cafe' | 'construction' | 'trash';
}

interface Candidate {
  score: number;
  segment: GraphSegment;
  distance: number;
  side: -1 | 1;
  seed: number;
  activityKind?: StaticPlacement['activityKind'];
}

export interface StreetLifeStats {
  cars: number;
  movingCars: number;
  pedestrians: number;
  cyclists: number;
  activities: number;
  deliveryVehicles: number;
  vendors: number;
  cafes: number;
  construction: number;
  trash: number;
  lamps: number;
  signals: number;
  contextAnchors: number;
  colorDrawCalls: number;
  shadowDrawCalls: number;
  triangles: number;
  lastMatrixWrites: number;
  rebuilds: number;
}

const CAR_COLORS = [
  0x17191d, 0x30353b, 0x5c6167, 0xb7b8b5, 0xe4e1d8,
  0x233a50, 0x4e1820, 0x4d5540, 0xb9974f, 0xf1eee5,
];
const PERSON_COLORS = [
  0x24324a, 0x4b2634, 0x6a5842, 0x293b31, 0xbab3a7,
  0x8f3b32, 0x31577a, 0xd0a442, 0x222326, 0x6b5a79,
];
const SKIN_COLORS = [
  0xf2c7a5, 0xdca47b, 0xb87955, 0x8a5438, 0x5d3528, 0x3d261f,
];
const ACTIVITY_COLORS = [0xd94938, 0xf2c744, 0x2a7f62, 0x3567a5, 0xe7e0cc];
const FUNCTIONAL_ANCHORS: readonly DensityAnchorKind[] = ['station', 'bus', 'bike'];
const WHEEL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1.35, -0.94],
  [-1.35, 0.94],
  [1.35, -0.94],
  [1.35, 0.94],
];
const VEHICLE_SCALES: Record<VehicleKind, readonly [number, number, number]> = {
  sedan: [1, 1, 1],
  suv: [1.04, 1.18, 1.02],
  van: [1.12, 1.34, 1.06],
  taxi: [1.02, 1.02, 1],
};

function hashInt(value: number): number {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function hash01(value: number): number {
  return hashInt(value) / 0xffffffff;
}

function placementSeed(x: number, z: number, index: number): number {
  return (
    Math.imul(Math.round(x * 0.5), 73856093)
    ^ Math.imul(Math.round(z * 0.5), 19349663)
    ^ Math.imul(index, 83492791)
  );
}

function trafficKey(route: LaneRoute, copyIndex: number): string {
  const last = route.points.length - 2;
  return [
    Math.round(route.points[0] * 2),
    Math.round(route.points[1] * 2),
    Math.round(route.points[last] * 2),
    Math.round(route.points[last + 1] * 2),
    Math.round(route.length),
    copyIndex,
  ].join(':');
}

function constrainTrafficSpeed(
  footprint: TrafficFootprint,
  obstacle: TrafficFootprint,
  desired: number,
): number {
  if (obstacle === footprint || obstacle.key === footprint.key) return desired;
  const dx = obstacle.x - footprint.x;
  const dz = obstacle.z - footprint.z;
  const along = dx * footprint.fx + dz * footprint.fz;
  const lateral = Math.abs(dx * -footprint.fz + dz * footprint.fx);
  const headingDot = footprint.fx * obstacle.fx + footprint.fz * obstacle.fz;
  if (
    along > 0
    && along < footprint.halfLength + obstacle.halfLength + 11
    && lateral < footprint.halfWidth + obstacle.halfWidth + 0.8
    && headingDot > 0.45
  ) {
    return Math.min(
      desired,
      obstacle.speed * Math.max(
        0,
        (along - footprint.halfLength - obstacle.halfLength - 1.3) / 7,
      ),
    );
  }
  if (yieldsTo(footprint, obstacle) && trafficSweptConflict(footprint, obstacle)) {
    return 0;
  }
  return desired;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3;
}

function mergePlaced(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) throw new Error('Could not merge shared population geometry');
  return merged;
}

function placedBox(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  rotationZ = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.rotateZ(rotationZ);
  geometry.translate(x, y, z);
  return geometry;
}

function placedCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
  x: number,
  y: number,
  z: number,
  rotationZ = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    radiusTop, radiusBottom, height, segments, 1, false,
  );
  geometry.rotateZ(rotationZ);
  geometry.translate(x, y, z);
  return geometry;
}

function placedSphere(
  radius: number,
  widthSegments: number,
  heightSegments: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
  geometry.translate(x, y, z);
  return geometry;
}

function setPart(geometry: THREE.BufferGeometry, id: number): THREE.BufferGeometry {
  geometry.setAttribute(
    'skinPart',
    new THREE.BufferAttribute(
      new Float32Array(geometry.getAttribute('position').count).fill(id),
      1,
    ),
  );
  return geometry;
}

function buildPedestrianGeometry(): THREE.BufferGeometry {
  // +x is travel-forward, +z spans the shoulders. Rounded six/eight-sided
  // limbs preserve a human silhouette without turning the pooled crowd into a
  // draw-call or triangle problem.
  const parts = [
    { geometry: placedCylinder(0.24, 0.31, 0.72, 8, 0, 1.18, 0), id: 0 },
    { geometry: placedBox(0.28, 0.18, 0.46, 0, 0.84, 0), id: 0 },
    { geometry: placedCylinder(0.075, 0.09, 0.64, 6, 0, 0.5, -0.13), id: 1 },
    { geometry: placedCylinder(0.075, 0.09, 0.64, 6, 0, 0.5, 0.13), id: 2 },
    { geometry: placedCylinder(0.06, 0.075, 0.58, 6, 0, 1.16, -0.3, -0.08), id: 3 },
    { geometry: placedCylinder(0.06, 0.075, 0.58, 6, 0, 1.16, 0.3, 0.08), id: 4 },
    { geometry: placedBox(0.28, 0.12, 0.17, 0.08, 0.13, -0.13), id: 1 },
    { geometry: placedBox(0.28, 0.12, 0.17, 0.08, 0.13, 0.13), id: 2 },
  ];
  for (const part of parts) {
    setPart(part.geometry, part.id);
  }
  return mergePlaced(parts.map((part) => part.geometry));
}

function buildPedestrianSkinGeometry(): THREE.BufferGeometry {
  return mergePlaced([
    setPart(placedSphere(0.18, 8, 6, 0, 1.72, 0), 0),
    setPart(placedSphere(0.072, 6, 4, 0, 0.86, -0.325), 3),
    setPart(placedSphere(0.072, 6, 4, 0, 0.86, 0.325), 4),
  ]);
}

function buildFarPedestrianGeometry(): THREE.BufferGeometry {
  return mergePlaced([
    placedCylinder(0.23, 0.29, 0.76, 6, 0, 1.14, 0),
    placedSphere(0.18, 6, 4, 0, 1.68, 0),
    placedBox(0.2, 0.68, 0.16, 0, 0.48, -0.12),
    placedBox(0.2, 0.68, 0.16, 0, 0.48, 0.12),
  ]);
}

function buildVehicleCabinGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array([
    -1.2, 0.82, -0.78, -1.2, 0.82, 0.78,
    0.95, 0.82, -0.78, 0.95, 0.82, 0.78,
    -0.72, 1.48, -0.61, -0.72, 1.48, 0.61,
    0.57, 1.48, -0.61, 0.57, 1.48, 0.61,
  ]);
  const indices = [
    0, 2, 3, 0, 3, 1,
    4, 5, 7, 4, 7, 6,
    0, 4, 6, 0, 6, 2,
    1, 3, 7, 1, 7, 5,
    0, 1, 5, 0, 5, 4,
    2, 6, 7, 2, 7, 3,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function colorGeometry(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const values = new Float32Array(geometry.getAttribute('position').count * 3);
  for (let i = 0; i < values.length; i += 3) {
    values[i] = c.r;
    values[i + 1] = c.g;
    values[i + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
  return geometry;
}

function buildVehicleDetailGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    colorGeometry(placedBox(0.08, 0.23, 0.48, 2.28, 0.67, -0.58), 0xfff0c2),
    colorGeometry(placedBox(0.08, 0.23, 0.48, 2.28, 0.67, 0.58), 0xfff0c2),
    colorGeometry(placedBox(0.08, 0.2, 0.42, -2.28, 0.66, -0.6), 0xc92727),
    colorGeometry(placedBox(0.08, 0.2, 0.42, -2.28, 0.66, 0.6), 0xc92727),
    colorGeometry(placedBox(0.07, 0.24, 0.82, 2.3, 0.43, 0), 0x20252a),
    colorGeometry(placedBox(0.08, 0.12, 1.5, -2.3, 0.39, 0), 0x2b3035),
    colorGeometry(placedBox(0.06, 0.62, 1.27, -0.06, 1.16, 0), 0x1c252b),
  ];
  for (const [x, z] of WHEEL_OFFSETS) {
    const hub = new THREE.CylinderGeometry(0.17, 0.17, 0.235, 10);
    hub.rotateX(Math.PI / 2);
    hub.translate(x, 0.36, z);
    parts.push(colorGeometry(hub, 0xaab0b2));
  }
  return mergePlaced(parts);
}

function buildCyclistGeometry(): THREE.BufferGeometry {
  const rearWheel = new THREE.TorusGeometry(0.34, 0.035, 3, 8);
  rearWheel.translate(-0.68, 0.38, 0);
  const frontWheel = new THREE.TorusGeometry(0.34, 0.035, 3, 8);
  frontWheel.translate(0.68, 0.38, 0);
  return mergePlaced([
    rearWheel,
    frontWheel,
    placedBox(0.92, 0.055, 0.055, -0.06, 0.58, 0, 0.42),
    placedBox(0.82, 0.055, 0.055, 0.03, 0.58, 0, -0.48),
    placedBox(0.72, 0.05, 0.05, 0.32, 0.69, 0, 1.1),
    placedBox(0.48, 0.05, 0.34, 0.53, 0.79, 0),
    placedBox(0.36, 0.67, 0.27, -0.04, 1.25, 0, -0.18),
    placedBox(0.3, 0.3, 0.28, 0.06, 1.72, 0),
  ]);
}

function buildActivityGeometry(): THREE.BufferGeometry {
  // Six boxes + a seven-sided closed cylinder = exactly 100 triangles. It
  // reads as either a corner vendor cart or compact park café stand depending
  // on its per-instance color and scale.
  const canopy = new THREE.CylinderGeometry(0.75, 0.75, 0.16, 7);
  canopy.translate(0, 2.12, 0);
  return mergePlaced([
    placedBox(1.3, 0.72, 0.72, 0, 0.55, 0),
    placedBox(1.46, 0.1, 0.85, 0, 0.96, 0),
    placedBox(0.07, 1.15, 0.07, -0.55, 1.52, -0.26),
    placedBox(0.07, 1.15, 0.07, 0.55, 1.52, -0.26),
    placedBox(0.22, 0.22, 0.12, -0.48, 0.15, 0.34),
    placedBox(0.22, 0.22, 0.12, 0.48, 0.15, 0.34),
    canopy,
  ]);
}

/**
 * Pooled inhabited-street layer. Every visible actor and prop is an instance
 * of one of sixteen shared geometries; placement comes from streamed OSM road
 * geography and the station/park/landmark/Citi Bike density field.
 */
export class StreetLife {
  private readonly group = new THREE.Group();
  private readonly level: QualityLevel;
  private readonly budget: PopulationBudget;
  private readonly density = new PopulationDensityField();

  private readonly body: THREE.InstancedMesh;
  private readonly cabin: THREE.InstancedMesh;
  private readonly wheels: THREE.InstancedMesh;
  private readonly vehicleDetails: THREE.InstancedMesh;
  private readonly lampPoles: THREE.InstancedMesh;
  private readonly lampArms: THREE.InstancedMesh;
  private readonly lampHeads: THREE.InstancedMesh;
  private readonly signalPoles: THREE.InstancedMesh;
  private readonly signalHeads: THREE.InstancedMesh;
  private readonly signalLights: THREE.InstancedMesh;
  private readonly pedestriansNear: THREE.InstancedMesh;
  private readonly pedestrianSkin: THREE.InstancedMesh;
  private readonly pedestriansFar: THREE.InstancedMesh;
  private readonly contactShadows: THREE.InstancedMesh;
  private readonly cyclistMesh: THREE.InstancedMesh;
  private readonly activityMesh: THREE.InstancedMesh;

  private readonly vehicles: VehiclePlacement[] = [];
  private readonly trafficVehicles: Array<VehiclePlacement & { traffic: TrafficState }> = [];
  private readonly peopleNear: PedestrianPlacement[] = [];
  private readonly peopleFar: PedestrianPlacement[] = [];
  private readonly cyclists: CyclistPlacement[] = [];
  private readonly activities: StaticPlacement[] = [];
  private readonly lamps: StaticPlacement[] = [];
  private readonly signals: StaticPlacement[] = [];

  private graph: RoadGraph = { segments: [], trafficRoutes: [], cycleRoutes: [] };
  private lastBuildX = Number.NaN;
  private lastBuildZ = Number.NaN;
  private lastBuildAt = Number.NEGATIVE_INFINITY;
  private lastNearUpdate = Number.NEGATIVE_INFINITY;
  private lastFarUpdate = Number.NEGATIVE_INFINITY;
  private lastTrafficStep = Number.NaN;
  private lastRoadRevision = -1;
  private observedRoadRevision = -1;
  private observedDensityRevision = -1;
  private densityRevision = 0;
  private lastStreamChangeAt = Number.NEGATIVE_INFINITY;
  private densityDirty = false;
  private populationScale = 1;
  private rebuildCount = 0;
  private matrixWrites = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly yawQ = new THREE.Quaternion();
  private readonly wheelQ = new THREE.Quaternion();
  private readonly glassTint = new THREE.Color(0x78909a);
  private readonly routeSample: RouteSample = { x: 0, z: 0, dx: 1, dz: 0 };
  private readonly pedestrianPosition: RouteSample = { x: 0, z: 0, dx: 1, dz: 0 };
  private readonly wheelTurn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2,
  );
  private pedestrianShaders: THREE.WebGLProgramParametersWithUniforms[] = [];
  private trafficObstacles: readonly TrafficFootprint[] = [];

  constructor(scene: THREE.Scene, level: QualityLevel) {
    this.level = level;
    this.budget = POPULATION_BUDGETS[level];

    const bodyGeo = buildVehicleBodyGeometry();
    const cabinGeo = buildVehicleCabinGeometry();
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 12);
    const vehicleDetailGeo = buildVehicleDetailGeometry();
    const poleGeo = new THREE.CylinderGeometry(0.055, 0.095, 7.1, 7);
    poleGeo.translate(0, 3.55, 0);
    const armGeo = new THREE.BoxGeometry(2.15, 0.075, 0.075);
    armGeo.translate(1.02, 6.98, 0);
    const headGeo = new THREE.BoxGeometry(0.72, 0.18, 0.34);
    headGeo.translate(2.05, 6.82, 0);
    const signalPoleGeo = new THREE.CylinderGeometry(0.045, 0.065, 4.3, 7);
    signalPoleGeo.translate(0, 2.15, 0);
    const signalHeadGeo = new THREE.BoxGeometry(0.34, 0.88, 0.34);
    signalHeadGeo.translate(0.24, 4.05, 0);
    const signalLightGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.035, 8);
    signalLightGeo.rotateX(Math.PI / 2);
    signalLightGeo.translate(0.24, 3.81, 0.19);
    const pedestrianGeo = buildPedestrianGeometry();
    const pedestrianSkinGeo = buildPedestrianSkinGeometry();
    const pedestrianFarGeo = buildFarPedestrianGeometry();
    const contactGeo = new THREE.CircleGeometry(1, 12);
    contactGeo.rotateX(-Math.PI / 2);
    const cyclistGeo = buildCyclistGeometry();
    const activityGeo = buildActivityGeometry();

    const expectedTriangles: Array<[THREE.BufferGeometry, number, string]> = [
      [bodyGeo, POPULATION_TRIANGLES.vehicleBody, 'vehicle body'],
      [cabinGeo, POPULATION_TRIANGLES.vehicleCabin, 'vehicle cabin'],
      [wheelGeo, POPULATION_TRIANGLES.vehicleWheels / 4, 'vehicle wheel'],
      [vehicleDetailGeo, POPULATION_TRIANGLES.vehicleDetails, 'vehicle details'],
      [
        poleGeo,
        POPULATION_TRIANGLES.lamp
          - triangleCount(armGeo)
          - triangleCount(headGeo),
        'lamp pole',
      ],
      [
        signalPoleGeo,
        POPULATION_TRIANGLES.signal
          - triangleCount(signalHeadGeo)
          - triangleCount(signalLightGeo),
        'signal pole',
      ],
      [pedestrianGeo, POPULATION_TRIANGLES.pedestrianNear, 'near pedestrian'],
      [pedestrianSkinGeo, POPULATION_TRIANGLES.pedestrianSkin, 'pedestrian skin'],
      [pedestrianFarGeo, POPULATION_TRIANGLES.pedestrianFar, 'far pedestrian'],
      [contactGeo, POPULATION_TRIANGLES.contactShadow, 'contact shadow'],
      [cyclistGeo, POPULATION_TRIANGLES.cyclist, 'cyclist'],
      [activityGeo, POPULATION_TRIANGLES.activity, 'activity kit'],
    ];
    for (const [geometry, expected, label] of expectedTriangles) {
      if (triangleCount(geometry) !== expected) {
        throw new Error(`${label} geometry broke population triangle contract`);
      }
    }

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.08,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    const cabinMat = new THREE.MeshStandardMaterial({
      color: 0x7895a2,
      roughness: 0.16,
      metalness: 0.38,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.88 });
    const vehicleDetailMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.34,
      metalness: 0.3,
    });
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x3f382b,
      roughness: 0.72,
      metalness: 0.38,
    });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x4a4438,
      roughness: 0.64,
      metalness: 0.3,
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffe6ad,
      emissive: 0xffd78b,
      emissiveIntensity: 0.22,
      roughness: 0.4,
    });
    const signalPoleMat = new THREE.MeshStandardMaterial({
      color: 0x5a5732,
      roughness: 0.72,
      metalness: 0.3,
    });
    const signalHeadMat = new THREE.MeshStandardMaterial({ color: 0x171916, roughness: 0.66 });
    const signalLightMat = new THREE.MeshStandardMaterial({
      color: 0x2bff58,
      emissive: 0x18d943,
      emissiveIntensity: 0.8,
      roughness: 0.32,
    });
    const personMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0,
    });
    const animatePersonMaterial = (material: THREE.MeshStandardMaterial, cacheKey: string) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.populationTime = { value: 0 };
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nattribute float skinPart;\nattribute float instancePhase;\nuniform float populationTime;',
          )
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            float stride = sin(populationTime * 7.4 + instancePhase);
            transformed.y += stride * 0.012;
            if (skinPart > 0.5) {
              bool arm = skinPart > 2.5;
              float pairSide = (skinPart < 1.5 || (skinPart > 3.5)) ? 1.0 : -1.0;
              float angle = stride * (arm ? -0.31 : 0.38) * pairSide;
              float pivotY = arm ? 1.43 : 0.82;
              vec2 limb = vec2(transformed.x, transformed.y - pivotY);
              float c = cos(angle);
              float s = sin(angle);
              transformed.x = limb.x * c - limb.y * s;
              transformed.y = limb.x * s + limb.y * c + pivotY;
            }`,
          );
        this.pedestrianShaders.push(shader);
      };
      material.customProgramCacheKey = () => cacheKey;
    };
    animatePersonMaterial(personMat, 'street-life-pedestrian-clothing-v2');
    animatePersonMaterial(skinMat, 'street-life-pedestrian-skin-v2');
    const farPersonMat = new THREE.MeshLambertMaterial({
      color: 0x667080,
    });
    const contactMat = new THREE.MeshBasicMaterial({
      color: 0x11131a,
      transparent: true,
      opacity: level === 'low' ? 0.2 : 0.27,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const cyclistMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.66,
      metalness: 0.05,
    });
    const activityMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.06,
    });

    const vehicleCapacity = this.budget.parkedVehicles + this.budget.movingVehicles;
    const shadowCapacity = vehicleCapacity + this.budget.pedestriansNear + this.budget.cyclists;
    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, vehicleCapacity);
    this.cabin = new THREE.InstancedMesh(cabinGeo, cabinMat, vehicleCapacity);
    this.wheels = new THREE.InstancedMesh(wheelGeo, tyreMat, vehicleCapacity * 4);
    this.vehicleDetails = new THREE.InstancedMesh(
      vehicleDetailGeo,
      vehicleDetailMat,
      vehicleCapacity,
    );
    this.lampPoles = new THREE.InstancedMesh(poleGeo, poleMat, this.budget.lamps);
    this.lampArms = new THREE.InstancedMesh(armGeo, lampMat, this.budget.lamps);
    this.lampHeads = new THREE.InstancedMesh(headGeo, headMat, this.budget.lamps);
    this.signalPoles = new THREE.InstancedMesh(signalPoleGeo, signalPoleMat, this.budget.signals);
    this.signalHeads = new THREE.InstancedMesh(signalHeadGeo, signalHeadMat, this.budget.signals);
    this.signalLights = new THREE.InstancedMesh(signalLightGeo, signalLightMat, this.budget.signals);
    this.pedestriansNear = new THREE.InstancedMesh(
      pedestrianGeo,
      personMat,
      this.budget.pedestriansNear,
    );
    pedestrianGeo.setAttribute(
      'instancePhase',
      new THREE.InstancedBufferAttribute(new Float32Array(this.budget.pedestriansNear), 1),
    );
    this.pedestrianSkin = new THREE.InstancedMesh(
      pedestrianSkinGeo,
      skinMat,
      this.budget.pedestriansNear,
    );
    pedestrianSkinGeo.setAttribute(
      'instancePhase',
      new THREE.InstancedBufferAttribute(new Float32Array(this.budget.pedestriansNear), 1),
    );
    this.pedestriansFar = new THREE.InstancedMesh(
      pedestrianFarGeo,
      farPersonMat,
      this.budget.pedestriansFar,
    );
    this.contactShadows = new THREE.InstancedMesh(contactGeo, contactMat, shadowCapacity);
    this.cyclistMesh = new THREE.InstancedMesh(cyclistGeo, cyclistMat, this.budget.cyclists);
    this.activityMesh = new THREE.InstancedMesh(activityGeo, activityMat, this.budget.activities);

    const dynamic = [
      this.body,
      this.cabin,
      this.wheels,
      this.vehicleDetails,
      this.pedestriansNear,
      this.pedestrianSkin,
      this.pedestriansFar,
      this.contactShadows,
      this.cyclistMesh,
    ];
    for (const mesh of dynamic) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
    }
    for (const mesh of [
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
      this.activityMesh,
    ]) {
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false;
    }
    this.body.receiveShadow = true;
    this.cabin.receiveShadow = true;
    this.vehicleDetails.receiveShadow = true;
    this.pedestriansNear.receiveShadow = true;
    this.pedestrianSkin.receiveShadow = true;
    this.activityMesh.receiveShadow = true;
    this.body.castShadow = level === 'high' || level === 'ultra';
    this.pedestriansNear.castShadow = level === 'ultra';

    for (const mesh of [
      this.body,
      this.cabin,
      this.wheels,
      this.vehicleDetails,
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
      this.pedestriansNear,
      this.pedestrianSkin,
      this.pedestriansFar,
      this.contactShadows,
      this.cyclistMesh,
      this.activityMesh,
    ]) mesh.count = 0;

    this.group.name = 'Street life (pooled population)';
    this.group.add(
      this.body,
      this.cabin,
      this.wheels,
      this.vehicleDetails,
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
      this.pedestriansNear,
      this.pedestrianSkin,
      this.pedestriansFar,
      this.contactShadows,
      this.cyclistMesh,
      this.activityMesh,
    );
    scene.add(this.group);

    // The layer remains useful immediately with landmark anchors; compact
    // station/park/bike context fills in asynchronously and triggers a rebuild.
    void this.density.load().then(() => {
      this.densityDirty = true;
      this.densityRevision++;
    });
  }

  update(
    camX: number,
    camZ: number,
    paths: RoadPaths[] | (() => RoadPaths[]),
    nowSeconds: number,
    roadRevision = 0,
    trafficObstacles: readonly TrafficFootprint[] = [],
  ): void {
    this.matrixWrites = 0;
    this.trafficObstacles = trafficObstacles;
    const movedSq = (camX - this.lastBuildX) ** 2 + (camZ - this.lastBuildZ) ** 2;
    const elapsed = Math.max(1 / 120, nowSeconds - this.lastBuildAt);
    const rebuildSpeed = Number.isFinite(movedSq) ? Math.sqrt(movedSq) / elapsed : 0;
    // The graph/candidate field extends hundreds of metres. Rebuilding it every
    // 36m is right at walking pace, but makes a bike/aircraft/camera flythrough
    // pay the full OSM candidate scan several times per second. Larger
    // speed-aware hysteresis remains well inside that field and leaves the
    // per-frame traffic/pedestrian simulation continuous between rebuilds.
    const rebuildDistance = populationRebuildDistance(rebuildSpeed);
    if (
      roadRevision !== this.observedRoadRevision
      || this.densityRevision !== this.observedDensityRevision
    ) {
      this.observedRoadRevision = roadRevision;
      this.observedDensityRevision = this.densityRevision;
      this.lastStreamChangeAt = nowSeconds;
    }
    const pendingStreamChange = roadRevision !== this.lastRoadRevision || this.densityDirty;
    const streamChanged = populationStreamSettled(
      pendingStreamChange,
      nowSeconds - this.lastStreamChangeAt,
    );
    // Base topology can integrate over several adjacent frames. Coalesce that
    // burst, then preserve actor identities in rebuild(); a stationary camera
    // never performs the former unconditional three-second population swap.
    if (populationRebuildRequired(
      movedSq,
      rebuildDistance,
      streamChanged,
      nowSeconds - this.lastBuildAt,
    )) {
      const resolvedPaths = typeof paths === 'function' ? paths() : paths;
      this.rebuild(camX, camZ, resolvedPaths, nowSeconds);
      this.lastBuildX = camX;
      this.lastBuildZ = camZ;
      this.lastBuildAt = nowSeconds;
      this.lastRoadRevision = roadRevision;
      this.densityDirty = false;
    }

    for (const shader of this.pedestrianShaders) {
      shader.uniforms.populationTime.value = nowSeconds;
    }
    const nearDue = nowSeconds - this.lastNearUpdate >= 1 / this.budget.nearUpdateHz;
    const farDue = nowSeconds - this.lastFarUpdate >= 1 / this.budget.farUpdateHz;
    if (nearDue) {
      this.updateTraffic(camX, camZ, nowSeconds, farDue);
      this.updateNearPedestrians(nowSeconds);
      this.updateCyclists(nowSeconds);
      this.lastNearUpdate = nowSeconds;
    }
    if (farDue) {
      this.updateFarPedestrians(camX, camZ, nowSeconds);
      this.lastFarUpdate = nowSeconds;
    }
  }

  setPopulationScale(scale: number): void {
    const next = Math.max(0.35, Math.min(1, scale));
    if (Math.abs(next - this.populationScale) < 0.04) return;
    this.populationScale = next;
    // Capacity changes apply at the next ordinary spatial/time rebuild. Forcing
    // an immediate full road-candidate scan made each governor rung itself a
    // frame spike while the system was already under CPU pressure.
  }

  /**
   * Future tile-stream integration point for storefront/land-use centroids.
   * Adding anchors is append-only and only invalidates the sparse placement
   * rebuild; it never creates scene objects or materials.
   */
  addContextAnchors(anchors: DensityAnchor[]): void {
    // The field is sampled on every ordinary spatial/time rebuild. Coalesce
    // streamed batches into that cadence instead of forcing a full road graph
    // scan for each tile integration while the camera is already moving.
    this.density.addMany(anchors);
    if (anchors.length) {
      this.densityDirty = true;
      this.densityRevision++;
    }
  }

  get stats(): StreetLifeStats {
    let triangles = 0;
    for (const child of this.group.children) {
      if (!(child instanceof THREE.InstancedMesh)) continue;
      triangles += triangleCount(child.geometry) * child.count;
    }
    const colorDrawCalls = this.group.children.reduce(
      (count, child) => count + (
        child instanceof THREE.InstancedMesh && child.count > 0 ? 1 : 0
      ),
      0,
    );
    const shadowDrawCalls = this.group.children.reduce(
      (count, child) => count + (
        child instanceof THREE.InstancedMesh && child.count > 0 && child.castShadow ? 1 : 0
      ),
      0,
    );
    return {
      cars: this.vehicles.length,
      movingCars: this.vehicles.reduce((count, car) => count + (car.traffic ? 1 : 0), 0),
      pedestrians: this.peopleNear.length + this.peopleFar.length,
      cyclists: this.cyclists.length,
      activities: this.activities.length,
      deliveryVehicles: this.vehicles.reduce(
        (count, vehicle) => count + (vehicle.kind === 'van' ? 1 : 0),
        0,
      ),
      vendors: this.activities.reduce(
        (count, activity) => count + (activity.activityKind === 'vendor' ? 1 : 0),
        0,
      ),
      cafes: this.activities.reduce(
        (count, activity) => count + (activity.activityKind === 'cafe' ? 1 : 0),
        0,
      ),
      construction: this.activities.reduce(
        (count, activity) => count + (activity.activityKind === 'construction' ? 1 : 0),
        0,
      ),
      trash: this.activities.reduce(
        (count, activity) => count + (activity.activityKind === 'trash' ? 1 : 0),
        0,
      ),
      lamps: this.lamps.length,
      signals: this.signals.length,
      contextAnchors: this.density.anchorCount,
      colorDrawCalls,
      shadowDrawCalls,
      triangles,
      lastMatrixWrites: this.matrixWrites,
      rebuilds: this.rebuildCount,
    };
  }

  get ceiling() {
    return populationCeiling(this.level);
  }

  private rebuild(
    camX: number,
    camZ: number,
    paths: RoadPaths[],
    nowSeconds: number,
  ): void {
    const previousVehicles = [...this.vehicles];
    const previousPeople = [
      ...this.peopleNear.map((person) => ({ person, wasNear: true })),
      ...this.peopleFar.map((person) => ({ person, wasNear: false })),
    ];
    const previousTraffic = new Map<
      string,
      VehiclePlacement & { traffic: TrafficState }
    >();
    for (const vehicle of this.trafficVehicles) {
      previousTraffic.set(vehicle.traffic.key, vehicle);
    }
    this.vehicles.length = 0;
    this.trafficVehicles.length = 0;
    this.peopleNear.length = 0;
    this.peopleFar.length = 0;
    this.cyclists.length = 0;
    this.activities.length = 0;
    this.lamps.length = 0;
    this.signals.length = 0;
    this.rebuildCount++;

    const parkedLimit = Math.max(8, Math.round(this.budget.parkedVehicles * this.populationScale));
    const movingLimit = Math.max(2, Math.round(this.budget.movingVehicles * this.populationScale));
    const nearPeopleLimit = Math.max(
      6,
      Math.round(this.budget.pedestriansNear * this.populationScale),
    );
    const farPeopleLimit = Math.max(
      8,
      Math.round(this.budget.pedestriansFar * this.populationScale),
    );
    const cyclistLimit = Math.max(1, Math.round(this.budget.cyclists * this.populationScale));
    const activityLimit = Math.max(2, Math.round(this.budget.activities * this.populationScale));
    const retentionRadius = this.budget.nearRadius + 48;
    const retentionRadiusSq = retentionRadius * retentionRadius;
    const vehicleCells = new Map<string, Array<readonly [number, number]>>();
    const vehicleCellSize = 5.2;
    const personCells = new Map<string, Array<readonly [number, number]>>();
    const personCellSize = 0.72;
    const addOccupant = (
      cells: Map<string, Array<readonly [number, number]>>,
      cellSize: number,
      x: number,
      z: number,
    ) => {
      const key = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
      const occupants = cells.get(key);
      if (occupants) occupants.push([x, z]);
      else cells.set(key, [[x, z]]);
    };
    const overlapsOccupant = (
      cells: Map<string, Array<readonly [number, number]>>,
      cellSize: number,
      x: number,
      z: number,
      minimumDistance: number,
    ): boolean => {
      const cellX = Math.floor(x / cellSize);
      const cellZ = Math.floor(z / cellSize);
      const minimumDistanceSq = minimumDistance * minimumDistance;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const occupants = cells.get(`${cellX + dx}:${cellZ + dz}`);
          if (!occupants) continue;
          for (const [otherX, otherZ] of occupants) {
            if ((otherX - x) ** 2 + (otherZ - z) ** 2 < minimumDistanceSq) return true;
          }
        }
      }
      return false;
    };
    const retainedVehicleKeys = new Set<string>();
    for (const vehicle of previousVehicles) {
      if (vehicle.traffic || this.vehicles.length >= this.budget.parkedVehicles) continue;
      if ((vehicle.x - camX) ** 2 + (vehicle.z - camZ) ** 2 > retentionRadiusSq) continue;
      vehicle.shadowIndex = this.vehicles.length;
      this.vehicles.push(vehicle);
      addOccupant(vehicleCells, vehicleCellSize, vehicle.x, vehicle.z);
      retainedVehicleKeys.add(vehicle.key);
    }
    this.graph = buildRoadGraph(
      paths,
      camX,
      camZ,
      this.budget.radius,
      Math.max(2, Math.ceil(movingLimit / 2)),
      Math.max(2, cyclistLimit),
    );

    const radiusSq = this.budget.radius ** 2;
    const nearRadiusSq = this.budget.nearRadius ** 2;
    const parkedCandidates: Candidate[] = [];
    const peopleCandidates: Candidate[] = [];
    const activityCandidates: Candidate[] = [];
    const junctions = new Map<string, {
      x: number;
      z: number;
      width: number;
      dirs: Array<[number, number]>;
    }>();

    for (const segment of this.graph.segments) {
      if (segment.kind !== PATH_KIND_ROAD) continue;
      const mx = (segment.ax + segment.bx) * 0.5;
      const mz = (segment.az + segment.bz) * 0.5;
      const midDistanceSq = (mx - camX) ** 2 + (mz - camZ) ** 2;
      if (midDistanceSq > (this.budget.radius + segment.length) ** 2) continue;
      const density = this.density.sample(mx, mz);
      const seed = placementSeed(mx, mz, segment.id);

      for (const [x, z, dx, dz] of [
        [segment.ax, segment.az, segment.dx, segment.dz],
        [segment.bx, segment.bz, -segment.dx, -segment.dz],
      ] as const) {
        if ((x - camX) ** 2 + (z - camZ) ** 2 > radiusSq) continue;
        const key = `${Math.round(x / 3)}:${Math.round(z / 3)}`;
        const junction = junctions.get(key) ?? { x, z, width: segment.width, dirs: [] };
        junction.width = Math.max(junction.width, segment.width);
        if (!junction.dirs.some(([jx, jz]) => jx * dx + jz * dz > 0.985)) {
          junction.dirs.push([dx, dz]);
        }
        junctions.set(key, junction);
      }

      if (segment.length > 18 && segment.width >= 6 && segment.width <= 23) {
        const spacing = 14 + hash01(seed) * 8;
        for (let distance = 8 + hash01(seed + 1) * 6; distance < segment.length - 7; distance += spacing) {
          for (const side of [-1, 1] as const) {
            const parkingFlags = segment.flags
              & (ROAD_FLAG_PARKING_LEFT | ROAD_FLAG_PARKING_RIGHT);
            if (
              parkingFlags !== 0
              && (
                (side > 0 && (parkingFlags & ROAD_FLAG_PARKING_LEFT) === 0)
                || (side < 0 && (parkingFlags & ROAD_FLAG_PARKING_RIGHT) === 0)
              )
            ) continue;
            const candidateSeed = seed ^ Math.round(distance * 17) ^ (side > 0 ? 0x51f15e : 0);
            if (hash01(candidateSeed) < 0.22) continue;
            const x = segment.ax + segment.dx * distance - segment.dz
              * (segment.width * 0.5 - 1.05) * side;
            const z = segment.az + segment.dz * distance + segment.dx
              * (segment.width * 0.5 - 1.05) * side;
            if ((x - camX) ** 2 + (z - camZ) ** 2 > radiusSq) continue;
            if (this.density.nearestDistance(x, z, FUNCTIONAL_ANCHORS, 9) < 9) continue;
            parkedCandidates.push({
              score: hash01(candidateSeed + 7) + density.commerce * 0.18,
              segment,
              distance,
              side,
              seed: candidateSeed,
            });
          }
        }
      }

      if (segment.length > 10) {
        const sidewalkOffset = segment.width * 0.5 + 1.45;
        const spacing = 11 + hash01(seed + 41) * 7;
        for (let distance = 5 + hash01(seed + 43) * 5; distance < segment.length - 4; distance += spacing) {
          const side: -1 | 1 = hash01(seed + Math.round(distance) * 29) < 0.5 ? -1 : 1;
          const x = segment.ax + segment.dx * distance - segment.dz * sidewalkOffset * side;
          const z = segment.az + segment.dz * distance + segment.dx * sidewalkOffset * side;
          const dSq = (x - camX) ** 2 + (z - camZ) ** 2;
          if (dSq > radiusSq) continue;
          const local = this.density.sample(x, z);
          const candidateSeed = seed ^ Math.round(distance * 31);
          const acceptance = Math.min(0.96, 0.16 + local.pedestrian * 0.62);
          if (
            hash01(candidateSeed + 47) < acceptance
            && this.density.nearestDistance(x, z, FUNCTIONAL_ANCHORS, 2.4) >= 2.4
          ) {
            peopleCandidates.push({
              score: local.pedestrian + hash01(candidateSeed + 53) * 0.2,
              segment,
              distance,
              side,
              seed: candidateSeed,
            });
          }
          const roadwork = segment.width >= 14
            && Math.min(distance, segment.length - distance) < 18
            && hash01(candidateSeed + 57) < 0.11;
          const vendor = (
            local.commerce + local.park * 0.7 > 0.38
            && hash01(candidateSeed + 59) < (local.commerce + local.park) * 0.24
          );
          const trash = !roadwork && !vendor
            && local.commerce > 0.22
            && hash01(candidateSeed + 63) < local.commerce * 0.08;
          if (
            (roadwork || vendor || trash)
            && this.density.nearestDistance(x, z, FUNCTIONAL_ANCHORS, 8) >= 8
          ) {
            activityCandidates.push({
              score:
                (roadwork ? 0.52 : local.commerce + local.park * 0.8)
                + hash01(candidateSeed + 61) * 0.1,
              segment,
              distance,
              side,
              seed: candidateSeed,
              activityKind: roadwork
                ? 'construction'
                : vendor ? local.park > local.commerce ? 'cafe' : 'vendor' : 'trash',
            });
          }
        }
      }

      if (this.lamps.length < this.budget.lamps && segment.length > 28) {
        const spacing = 34 + hash01(seed + 71) * 12;
        for (let distance = 14; distance < segment.length - 10; distance += spacing) {
          if (this.lamps.length >= this.budget.lamps) break;
          const side: -1 | 1 = hash01(seed + Math.round(distance) * 73) < 0.5 ? -1 : 1;
          const offset = segment.width * 0.5 + 2.35;
          const x = segment.ax + segment.dx * distance - segment.dz * offset * side;
          const z = segment.az + segment.dz * distance + segment.dx * offset * side;
          if ((x - camX) ** 2 + (z - camZ) ** 2 > radiusSq) continue;
          if (this.density.nearestDistance(x, z, FUNCTIONAL_ANCHORS, 4) < 4) continue;
          this.lamps.push({
            x,
            y: heightAt(x, z),
            z,
            yaw: Math.atan2(segment.dx * side, segment.dz * side),
          });
        }
      }
    }

    parkedCandidates.sort((a, b) => b.score - a.score || a.seed - b.seed);
    for (const candidate of parkedCandidates) {
      if (this.vehicles.length >= parkedLimit) break;
      const key = `parked:${candidate.seed >>> 0}`;
      if (retainedVehicleKeys.has(key)) continue;
      const segment = candidate.segment;
      const offset = Math.max(2.1, segment.width * 0.5 - 1.05) * candidate.side;
      const x = segment.ax + segment.dx * candidate.distance - segment.dz * offset;
      const z = segment.az + segment.dz * candidate.distance + segment.dx * offset;
      const local = this.density.sample(x, z);
      const kindRoll = hash01(candidate.seed + 79);
      const kind: VehicleKind = local.commerce > 0.45 && kindRoll < 0.16
        ? 'van'
        : kindRoll < 0.35
          ? 'suv'
          : local.transit > 0.45 && kindRoll < 0.48
            ? 'taxi'
            : 'sedan';
      const colorIndex = Math.floor(hash01(candidate.seed + 83) * CAR_COLORS.length);
      if (overlapsOccupant(vehicleCells, vehicleCellSize, x, z, 4.9)) continue;
      this.vehicles.push({
        key,
        x,
        z,
        yaw: Math.atan2(-segment.dz, segment.dx) + (candidate.side < 0 ? Math.PI : 0),
        color: new THREE.Color(kind === 'taxi' ? 0xf2bd1d : CAR_COLORS[colorIndex]),
        kind,
        shadowIndex: this.vehicles.length,
      });
      addOccupant(vehicleCells, vehicleCellSize, x, z);
    }

    const usableRoutes = this.graph.trafficRoutes;
    const routeSpecs: Array<{
      route: LaneRoute;
      seed: number;
      targetSpeed: number;
      key: string;
      copyIndex: number;
      routeCopies: number;
    }> = [];
    for (let i = 0; i < movingLimit && usableRoutes.length; i++) {
      const route = usableRoutes[i % usableRoutes.length];
      const seed = placementSeed(route.points[0], route.points[1], i + 101);
      const routeCopies = Math.ceil(movingLimit / usableRoutes.length);
      const copyIndex = Math.floor(i / usableRoutes.length);
      const targetSpeed = 6.3 + hash01(seed + 5) * 5.8;
      const key = trafficKey(route, copyIndex);
      routeSpecs.push({ route, seed, targetSpeed, key, copyIndex, routeCopies });
    }
    const specsByKey = new Map(routeSpecs.map((spec) => [spec.key, spec]));
    const retainedTrafficKeys = new Set<string>();
    for (const previous of previousTraffic.values()) {
      if (this.trafficVehicles.length >= this.budget.movingVehicles) break;
      if ((previous.x - camX) ** 2 + (previous.z - camZ) ** 2 > retentionRadiusSq) continue;
      const spec = specsByKey.get(previous.key);
      if (spec) {
        previous.traffic.route = spec.route;
        previous.traffic.targetSpeed = spec.targetSpeed;
        previous.traffic.laneOffset = Math.min(
          2.8,
          Math.max(1.2, spec.route.width * 0.22),
        );
      }
      previous.shadowIndex = this.vehicles.length;
      this.vehicles.push(previous);
      this.trafficVehicles.push(previous);
      addOccupant(vehicleCells, vehicleCellSize, previous.x, previous.z);
      retainedTrafficKeys.add(previous.key);
    }
    const movingTarget = Math.max(movingLimit, this.trafficVehicles.length);
    for (const spec of routeSpecs) {
      if (
        this.trafficVehicles.length >= movingTarget
        || this.trafficVehicles.length >= this.budget.movingVehicles
        || retainedTrafficKeys.has(spec.key)
      ) continue;
      const { route, seed, targetSpeed, key, copyIndex, routeCopies } = spec;
      const colorIndex = Math.floor(hash01(seed + 3) * CAR_COLORS.length);
      const rawDistance = (
        route.length * ((copyIndex + hash01(seed + 11) * 0.35) / routeCopies)
        + nowSeconds * targetSpeed
      ) % Math.max(1, route.length * (route.oneWay ? 1 : 2));
      const initialDirection: 1 | -1 = !route.oneWay && rawDistance > route.length ? -1 : 1;
      const initialDistance = initialDirection < 0
        ? route.length * 2 - rawDistance
        : rawDistance;
      const vehicle: VehiclePlacement & { traffic: TrafficState } = {
        key,
        x: route.points[0],
        z: route.points[1],
        yaw: 0,
        color: new THREE.Color(CAR_COLORS[colorIndex]),
        kind: hash01(seed + 7) < 0.28 ? 'suv' : 'sedan',
        traffic: {
          route,
          distance: initialDistance,
          speed: targetSpeed,
          targetSpeed,
          laneOffset: Math.min(2.8, Math.max(1.2, route.width * 0.22)),
          laneSign: initialDirection,
          direction: initialDirection,
          finished: false,
          key,
          lastVisualAt: nowSeconds,
        },
        shadowIndex: this.vehicles.length,
      };
      const footprint = this.trafficFootprint(vehicle);
      vehicle.x = footprint.x;
      vehicle.z = footprint.z;
      vehicle.yaw = Math.atan2(-footprint.fz, footprint.fx);
      if (
        overlapsOccupant(
          vehicleCells,
          vehicleCellSize,
          footprint.x,
          footprint.z,
          5.2,
        )
        || this.trafficObstacles.some((obstacle) => (
          trafficFootprintsOverlap(footprint, obstacle, 0.45)
        ))
      ) continue;
      this.vehicles.push(vehicle);
      this.trafficVehicles.push(vehicle);
      addOccupant(vehicleCells, vehicleCellSize, vehicle.x, vehicle.z);
    }

    const retainedPeopleKeys = new Set<string>();
    for (const { person, wasNear } of previousPeople) {
      const sample = this.pedestrianSample(person, nowSeconds);
      const distanceSq = (sample.x - camX) ** 2 + (sample.z - camZ) ** 2;
      if (distanceSq > retentionRadiusSq) continue;
      const nearThreshold = wasNear
        ? this.budget.nearRadius + 16
        : Math.max(12, this.budget.nearRadius - 12);
      const near = distanceSq <= nearThreshold * nearThreshold;
      const target = near ? this.peopleNear : this.peopleFar;
      const capacity = near
        ? this.budget.pedestriansNear
        : this.budget.pedestriansFar;
      if (target.length >= capacity) continue;
      target.push(person);
      addOccupant(personCells, personCellSize, sample.x, sample.z);
      retainedPeopleKeys.add(person.key);
    }

    peopleCandidates.sort((a, b) => b.score - a.score || a.seed - b.seed);
    for (const candidate of peopleCandidates) {
      const key = `pedestrian:${candidate.seed >>> 0}`;
      if (retainedPeopleKeys.has(key)) continue;
      const segment = candidate.segment;
      const speed = 0.75 + hash01(candidate.seed + 89) * 0.9;
      const phase = hash01(candidate.seed + 97) * Math.PI * 2;
      const person: PedestrianPlacement = {
        key,
        segment,
        distance: candidate.distance + hash01(candidate.seed + 91) * segment.length,
        speed,
        side: candidate.side,
        phase,
        color: new THREE.Color(
          PERSON_COLORS[Math.floor(hash01(candidate.seed + 101) * PERSON_COLORS.length)],
        ),
        skinColor: new THREE.Color(
          SKIN_COLORS[Math.floor(hash01(candidate.seed + 103) * SKIN_COLORS.length)],
        ),
        scale: 0.92 + hash01(candidate.seed + 107) * 0.14,
        shadowIndex: -1,
      };
      const animated = this.pedestrianSample(person, nowSeconds);
      const animatedX = animated.x;
      const animatedZ = animated.z;
      if (
        overlapsOccupant(
          personCells,
          personCellSize,
          animatedX,
          animatedZ,
          0.72,
        )
      ) continue;
      const near = (animatedX - camX) ** 2 + (animatedZ - camZ) ** 2 <= nearRadiusSq;
      const target = near ? this.peopleNear : this.peopleFar;
      const limit = near ? nearPeopleLimit : farPeopleLimit;
      if (target.length >= limit) continue;
      if (near) person.shadowIndex = this.vehicles.length + this.peopleNear.length;
      target.push(person);
      addOccupant(personCells, personCellSize, animatedX, animatedZ);
      if (this.peopleNear.length >= nearPeopleLimit && this.peopleFar.length >= farPeopleLimit) break;
    }
    for (let i = 0; i < this.peopleNear.length; i++) {
      this.peopleNear[i].shadowIndex = this.vehicles.length + i;
    }

    activityCandidates.sort((a, b) => b.score - a.score || a.seed - b.seed);
    const selectedActivities: Candidate[] = [];
    for (const kind of ['construction', 'trash'] as const) {
      const candidate = activityCandidates.find((item) => item.activityKind === kind);
      if (candidate) selectedActivities.push(candidate);
    }
    for (const candidate of activityCandidates) {
      if (selectedActivities.length >= activityLimit) break;
      if (!selectedActivities.includes(candidate)) selectedActivities.push(candidate);
    }
    for (const candidate of selectedActivities) {
      const segment = candidate.segment;
      const offset = segment.width * 0.5 + 2.9;
      const x = segment.ax + segment.dx * candidate.distance - segment.dz * offset * candidate.side;
      const z = segment.az + segment.dz * candidate.distance + segment.dx * offset * candidate.side;
      const kind = candidate.activityKind ?? 'vendor';
      const construction = kind === 'construction';
      const trash = kind === 'trash';
      this.activities.push({
        x,
        y: heightAt(x, z),
        z,
        yaw: Math.atan2(-segment.dz, segment.dx) + (candidate.side < 0 ? Math.PI : 0),
        color: new THREE.Color(construction
          ? 0xef6c22
          : trash
            ? 0x32383a
            : ACTIVITY_COLORS[Math.floor(hash01(candidate.seed + 103) * ACTIVITY_COLORS.length)]),
        scaleX: construction ? 1.8 : trash ? 0.38 : kind === 'cafe' ? 0.82 : 1,
        scaleY: construction ? 0.42 : trash ? 0.34 : kind === 'cafe' ? 0.78 : 1,
        scaleZ: construction ? 0.38 : trash ? 0.42 : kind === 'cafe' ? 0.82 : 1,
        activityKind: kind,
      });
    }

    const cycleRoutes = this.graph.cycleRoutes.length
      ? this.graph.cycleRoutes
      : this.graph.trafficRoutes.filter((route) => {
        const sample = sampleLaneRoute(route, route.length * 0.5);
        return this.density.sample(sample.x, sample.z).cycling > 0.28;
      });
    for (let i = 0; i < cyclistLimit && cycleRoutes.length; i++) {
      const route = cycleRoutes[i % cycleRoutes.length];
      const seed = placementSeed(route.points[0], route.points[1], i + 211);
      const onBikeLane = this.graph.cycleRoutes.includes(route);
      this.cyclists.push({
        route,
        distance: hash01(seed + 107) * route.length,
        speed: 3.4 + hash01(seed + 109) * 2.8,
        laneOffset: onBikeLane ? 0 : Math.max(1.2, route.width * 0.5 - 1.3),
        color: new THREE.Color(PERSON_COLORS[Math.floor(hash01(seed + 113) * PERSON_COLORS.length)]),
        shadowIndex: this.vehicles.length + this.peopleNear.length + i,
      });
    }

    for (const junction of junctions.values()) {
      if (this.signals.length >= this.budget.signals || junction.dirs.length < 3) continue;
      const [dx, dz] = junction.dirs[0];
      const nx = -dz;
      const nz = dx;
      const offset = junction.width * 0.5 + 2.1;
      const x = junction.x + nx * offset - dx * 1.2;
      const z = junction.z + nz * offset - dz * 1.2;
      this.signals.push({
        x,
        y: heightAt(x, z),
        z,
        yaw: Math.atan2(dx, dz),
      });
    }

    this.writeStaticVehicles();
    this.writeStaticMeshes();
    this.updateTraffic(camX, camZ, nowSeconds, true);
    this.updateNearPedestrians(nowSeconds);
    this.updateFarPedestrians(camX, camZ, nowSeconds);
    this.updateCyclists(nowSeconds);
    this.lastTrafficStep = nowSeconds;
    this.lastNearUpdate = nowSeconds;
    this.lastFarUpdate = nowSeconds;
  }

  private writeVehicle(
    index: number,
    vehicle: VehiclePlacement,
    x: number,
    z: number,
    yaw: number,
  ): void {
    const y = heightAt(x, z) + 0.055;
    const [sx, sy, sz] = VEHICLE_SCALES[vehicle.kind];
    vehicle.x = x;
    vehicle.z = z;
    vehicle.yaw = yaw;
    this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    this.matrix.compose(this.position.set(x, y, z), this.yawQ, this.scale.set(sx, sy, sz));
    this.body.setMatrixAt(index, this.matrix);
    this.cabin.setMatrixAt(index, this.matrix);
    this.vehicleDetails.setMatrixAt(index, this.matrix);
    this.body.setColorAt(index, vehicle.color);
    this.cabin.setColorAt(index, this.glassTint);
    this.matrixWrites += 3;

    this.wheelQ.copy(this.yawQ).multiply(this.wheelTurn);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (let wheel = 0; wheel < 4; wheel++) {
      const localX = WHEEL_OFFSETS[wheel][0] * sx;
      const localZ = WHEEL_OFFSETS[wheel][1] * sz;
      const wx = x + localX * c + localZ * s;
      const wz = z - localX * s + localZ * c;
      this.matrix.compose(
        this.position.set(wx, y + 0.36 * sy, wz),
        this.wheelQ,
        this.scale.set(sx, sy, sz),
      );
      this.wheels.setMatrixAt(index * 4 + wheel, this.matrix);
      this.matrixWrites++;
    }

    this.yawQ.identity();
    this.matrix.compose(
      this.position.set(x, heightAt(x, z) + 0.035, z),
      this.yawQ,
      this.scale.set(1.8 * sx, 1, 0.75 * sz),
    );
    this.contactShadows.setMatrixAt(vehicle.shadowIndex, this.matrix);
    this.matrixWrites++;
  }

  private writeStaticVehicles(): void {
    for (let i = 0; i < this.vehicles.length; i++) {
      const vehicle = this.vehicles[i];
      if (!vehicle.traffic) this.writeVehicle(i, vehicle, vehicle.x, vehicle.z, vehicle.yaw);
    }
    this.body.count = this.cabin.count = this.vehicles.length;
    this.vehicleDetails.count = this.vehicles.length;
    this.wheels.count = this.vehicles.length * 4;
    this.contactShadows.count =
      this.vehicles.length + this.peopleNear.length + this.cyclists.length;
    this.markVehicleBuffers();
  }

  private markVehicleBuffers(): void {
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.vehicleDetails.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.cabin.instanceColor) this.cabin.instanceColor.needsUpdate = true;
  }

  private trafficFootprint(
    vehicle: VehiclePlacement & { traffic: TrafficState },
  ): TrafficFootprint {
    const traffic = vehicle.traffic;
    const sample = sampleLaneRoute(traffic.route, traffic.distance);
    const fx = sample.dx * traffic.direction;
    const fz = sample.dz * traffic.direction;
    const laneBlend = traffic.laneSign;
    const [sx, , sz] = VEHICLE_SCALES[vehicle.kind];
    return {
      key: `car:${traffic.key}`,
      x: sample.x + sample.dz * traffic.laneOffset * laneBlend,
      z: sample.z - sample.dx * traffic.laneOffset * laneBlend,
      fx,
      fz,
      halfLength: 2.3 * sx,
      halfWidth: 0.94 * sz,
      speed: traffic.speed,
    };
  }

  private updateTraffic(
    camX: number,
    camZ: number,
    nowSeconds: number,
    farDue: boolean,
  ): void {
    const dt = Number.isFinite(this.lastTrafficStep)
      ? Math.max(0, Math.min(0.2, nowSeconds - this.lastTrafficStep))
      : 0;
    this.lastTrafficStep = nowSeconds;
    const before = new Map<
      VehiclePlacement & { traffic: TrafficState },
      { distance: number; direction: 1 | -1; finished: boolean; laneSign: number }
    >();
    const current = new Map<
      VehiclePlacement & { traffic: TrafficState },
      TrafficFootprint
    >();
    for (const vehicle of this.trafficVehicles) {
      before.set(vehicle, {
        distance: vehicle.traffic.distance,
        direction: vehicle.traffic.direction,
        finished: vehicle.traffic.finished,
        laneSign: vehicle.traffic.laneSign,
      });
      current.set(vehicle, this.trafficFootprint(vehicle));
    }

    for (const vehicle of this.trafficVehicles) {
      const traffic = vehicle.traffic;
      const footprint = current.get(vehicle)!;
      let leaderGap = Number.POSITIVE_INFINITY;
      let leaderSpeed = traffic.targetSpeed;
      for (const other of this.trafficVehicles) {
        if (other === vehicle) continue;
        const obstacle = current.get(other)!;
        const dx = obstacle.x - footprint.x;
        const dz = obstacle.z - footprint.z;
        const along = dx * footprint.fx + dz * footprint.fz;
        const lateral = Math.abs(dx * -footprint.fz + dz * footprint.fx);
        const headingDot = footprint.fx * obstacle.fx + footprint.fz * obstacle.fz;
        if (headingDot > 0.72 && along > 0 && lateral < 2.8 && along < leaderGap) {
          leaderGap = along;
          leaderSpeed = obstacle.speed;
        }
      }
      if (traffic.finished) continue;
      let desired = leaderGap < 13
        ? Math.max(0, leaderSpeed * Math.max(0, (leaderGap - 4.8) / 6.2))
        : traffic.targetSpeed;
      for (const obstacle of current.values()) {
        desired = constrainTrafficSpeed(footprint, obstacle, desired);
      }
      for (const obstacle of this.trafficObstacles) {
        desired = constrainTrafficSpeed(footprint, obstacle, desired);
      }
      const response = desired < traffic.speed ? 4.5 : 1.2;
      traffic.speed += (desired - traffic.speed) * Math.min(1, dt * response);
      advanceLaneProgress(traffic, traffic.route, traffic.speed * dt);
      if (traffic.finished) traffic.speed = 0;
      traffic.laneSign += (
        traffic.direction - traffic.laneSign
      ) * Math.min(1, dt * 2.8);
    }

    // Prediction handles braking; this exact final-body pass is the invariant.
    // If a large/slow frame would still penetrate another body, roll the stable
    // yielding vehicle back to its prior route state instead of hiding either.
    for (let pass = 0; pass < 2; pass++) {
      const final = new Map(
        this.trafficVehicles.map((vehicle) => [vehicle, this.trafficFootprint(vehicle)]),
      );
      for (const vehicle of this.trafficVehicles) {
        const footprint = final.get(vehicle)!;
        let blocker: TrafficFootprint | null = null;
        for (const obstacle of this.trafficObstacles) {
          if (trafficFootprintsOverlap(footprint, obstacle, 0.18)) {
            blocker = obstacle;
            break;
          }
        }
        if (!blocker) {
          for (const other of this.trafficVehicles) {
            if (other === vehicle) continue;
            const obstacle = final.get(other)!;
            if (
              yieldsTo(footprint, obstacle)
              && trafficFootprintsOverlap(footprint, obstacle, 0.12)
            ) {
              blocker = obstacle;
              break;
            }
          }
        }
        if (!blocker) continue;
        const state = before.get(vehicle)!;
        vehicle.traffic.distance = state.distance;
        vehicle.traffic.direction = state.direction;
        vehicle.traffic.finished = state.finished;
        vehicle.traffic.laneSign = state.laneSign;
        vehicle.traffic.speed = 0;
      }
    }

    for (let i = 0; i < this.vehicles.length; i++) {
      const vehicle = this.vehicles[i];
      if (!vehicle.traffic) continue;
      const footprint = this.trafficFootprint(
        vehicle as VehiclePlacement & { traffic: TrafficState },
      );
      const x = footprint.x;
      const z = footprint.z;
      vehicle.x = x;
      vehicle.z = z;
      vehicle.yaw = Math.atan2(-footprint.fz, footprint.fx);
      const near = (x - camX) ** 2 + (z - camZ) ** 2 <= this.budget.nearRadius ** 2;
      if (!near && !farDue) continue;
      this.writeVehicle(i, vehicle, x, z, vehicle.yaw);
      vehicle.traffic.lastVisualAt = nowSeconds;
    }
    this.markVehicleBuffers();
  }

  private pedestrianSample(
    pedestrian: PedestrianPlacement,
    nowSeconds: number,
  ): RouteSample {
    const segment = pedestrian.segment;
    const period = Math.max(1, segment.length * 2);
    let distance = (
      pedestrian.distance + nowSeconds * pedestrian.speed + pedestrian.phase * 0.37
    ) % period;
    let direction = 1;
    if (distance > segment.length) {
      distance = period - distance;
      direction = -1;
    }
    const offset = segment.width * 0.5 + 1.45;
    this.pedestrianPosition.x =
      segment.ax + segment.dx * distance - segment.dz * offset * pedestrian.side;
    this.pedestrianPosition.z =
      segment.az + segment.dz * distance + segment.dx * offset * pedestrian.side;
    this.pedestrianPosition.dx = segment.dx * direction;
    this.pedestrianPosition.dz = segment.dz * direction;
    return this.pedestrianPosition;
  }

  private updateNearPedestrians(nowSeconds: number): void {
    const phases = this.pedestriansNear.geometry.getAttribute('instancePhase');
    const skinPhases = this.pedestrianSkin.geometry.getAttribute('instancePhase');
    for (let i = 0; i < this.peopleNear.length; i++) {
      const pedestrian = this.peopleNear[i];
      const sample = this.pedestrianSample(pedestrian, nowSeconds);
      const y = heightAt(sample.x, sample.z) + 0.04;
      this.yawQ.setFromAxisAngle(
        THREE.Object3D.DEFAULT_UP,
        Math.atan2(-sample.dz, sample.dx),
      );
      this.matrix.compose(
        this.position.set(sample.x, y, sample.z),
        this.yawQ,
        this.scale.set(pedestrian.scale, pedestrian.scale, pedestrian.scale),
      );
      this.pedestriansNear.setMatrixAt(i, this.matrix);
      this.pedestrianSkin.setMatrixAt(i, this.matrix);
      this.pedestriansNear.setColorAt(i, pedestrian.color);
      this.pedestrianSkin.setColorAt(i, pedestrian.skinColor);
      (phases as THREE.InstancedBufferAttribute).setX(i, pedestrian.phase);
      (skinPhases as THREE.InstancedBufferAttribute).setX(i, pedestrian.phase);
      this.matrixWrites += 2;

      this.yawQ.identity();
      this.matrix.compose(
        this.position.set(sample.x, y + 0.005, sample.z),
        this.yawQ,
        this.scale.set(0.34, 1, 0.22),
      );
      this.contactShadows.setMatrixAt(pedestrian.shadowIndex, this.matrix);
      this.matrixWrites++;
    }
    this.pedestriansNear.count = this.peopleNear.length;
    this.pedestrianSkin.count = this.peopleNear.length;
    this.pedestriansNear.instanceMatrix.needsUpdate = true;
    this.pedestrianSkin.instanceMatrix.needsUpdate = true;
    if (this.pedestriansNear.instanceColor) this.pedestriansNear.instanceColor.needsUpdate = true;
    if (this.pedestrianSkin.instanceColor) this.pedestrianSkin.instanceColor.needsUpdate = true;
    phases.needsUpdate = true;
    skinPhases.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
  }

  private updateFarPedestrians(camX: number, camZ: number, nowSeconds: number): void {
    for (let i = 0; i < this.peopleFar.length; i++) {
      const pedestrian = this.peopleFar[i];
      const sample = this.pedestrianSample(pedestrian, nowSeconds);
      const y = heightAt(sample.x, sample.z) + 0.04;
      const yaw = Math.atan2(-sample.dz, sample.dx);
      this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      this.matrix.compose(
        this.position.set(sample.x, y, sample.z),
        this.yawQ,
        this.scale.set(pedestrian.scale, pedestrian.scale, pedestrian.scale),
      );
      this.pedestriansFar.setMatrixAt(i, this.matrix);
      this.pedestriansFar.setColorAt(i, pedestrian.color);
      this.matrixWrites++;
    }
    this.pedestriansFar.count = this.peopleFar.length;
    this.pedestriansFar.instanceMatrix.needsUpdate = true;
    if (this.pedestriansFar.instanceColor) this.pedestriansFar.instanceColor.needsUpdate = true;
  }

  private updateCyclists(nowSeconds: number): void {
    for (let i = 0; i < this.cyclists.length; i++) {
      const cyclist = this.cyclists[i];
      const period = cyclist.route.length * 2;
      let routeDistance = (
        cyclist.distance + nowSeconds * cyclist.speed
      ) % Math.max(1, period);
      let direction = 1;
      if (routeDistance > cyclist.route.length) {
        routeDistance = period - routeDistance;
        direction = -1;
      }
      const sample = sampleLaneRoute(
        cyclist.route,
        routeDistance,
        this.routeSample,
      );
      const travelDx = sample.dx * direction;
      const travelDz = sample.dz * direction;
      const turnaroundBlend = Math.min(
        1,
        routeDistance / 7,
        (cyclist.route.length - routeDistance) / 7,
      );
      const signedOffset = cyclist.laneOffset * direction * Math.max(0, turnaroundBlend);
      const x = sample.x + sample.dz * signedOffset;
      const z = sample.z - sample.dx * signedOffset;
      const y = heightAt(x, z) + 0.04;
      this.yawQ.setFromAxisAngle(
        THREE.Object3D.DEFAULT_UP,
        Math.atan2(-travelDz, travelDx),
      );
      this.matrix.compose(
        this.position.set(x, y, z),
        this.yawQ,
        this.scale.set(1, 1, 1),
      );
      this.cyclistMesh.setMatrixAt(i, this.matrix);
      this.cyclistMesh.setColorAt(i, cyclist.color);
      this.matrixWrites++;

      this.yawQ.identity();
      this.matrix.compose(
        this.position.set(x, y + 0.005, z),
        this.yawQ,
        this.scale.set(0.7, 1, 0.22),
      );
      this.contactShadows.setMatrixAt(cyclist.shadowIndex, this.matrix);
      this.matrixWrites++;
    }
    this.cyclistMesh.count = this.cyclists.length;
    this.cyclistMesh.instanceMatrix.needsUpdate = true;
    if (this.cyclistMesh.instanceColor) this.cyclistMesh.instanceColor.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
  }

  private writeStaticMeshes(): void {
    const write = (
      mesh: THREE.InstancedMesh,
      placements: StaticPlacement[],
      color = false,
    ) => {
      const count = Math.min(mesh.instanceMatrix.count, placements.length);
      for (let i = 0; i < count; i++) {
        const placement = placements[i];
        this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, placement.yaw);
        this.matrix.compose(
          this.position.set(placement.x, placement.y, placement.z),
          this.yawQ,
          this.scale.set(
            placement.scaleX ?? 1,
            placement.scaleY ?? 1,
            placement.scaleZ ?? 1,
          ),
        );
        mesh.setMatrixAt(i, this.matrix);
        if (color && placement.color) mesh.setColorAt(i, placement.color);
        this.matrixWrites++;
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (color && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    write(this.lampPoles, this.lamps);
    write(this.lampArms, this.lamps);
    write(this.lampHeads, this.lamps);
    write(this.signalPoles, this.signals);
    write(this.signalHeads, this.signals);
    write(this.signalLights, this.signals);
    write(this.activityMesh, this.activities, true);
  }

  destroy(): void {
    this.group.removeFromParent();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
  }
}
