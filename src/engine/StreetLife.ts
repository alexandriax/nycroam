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
  x: number;
  z: number;
  yaw: number;
  color: THREE.Color;
  kind: VehicleKind;
  traffic?: TrafficState;
  shadowIndex: number;
}

interface PedestrianPlacement {
  segment: GraphSegment;
  distance: number;
  speed: number;
  side: -1 | 1;
  phase: number;
  color: THREE.Color;
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

function buildPedestrianGeometry(): THREE.BufferGeometry {
  const parts = [
    { geometry: placedBox(0.48, 0.72, 0.3, 0, 1.2, 0), id: 0 },
    { geometry: placedBox(0.34, 0.34, 0.32, 0, 1.73, 0), id: 0 },
    { geometry: placedBox(0.17, 0.75, 0.19, -0.13, 0.54, 0), id: 1 },
    { geometry: placedBox(0.17, 0.75, 0.19, 0.13, 0.54, 0), id: 2 },
  ];
  for (const part of parts) {
    part.geometry.setAttribute(
      'skinPart',
      new THREE.BufferAttribute(
        new Float32Array(part.geometry.getAttribute('position').count).fill(part.id),
        1,
      ),
    );
  }
  return mergePlaced(parts.map((part) => part.geometry));
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
 * of one of fourteen shared geometries; placement comes from streamed OSM road
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
  private readonly lampPoles: THREE.InstancedMesh;
  private readonly lampArms: THREE.InstancedMesh;
  private readonly lampHeads: THREE.InstancedMesh;
  private readonly signalPoles: THREE.InstancedMesh;
  private readonly signalHeads: THREE.InstancedMesh;
  private readonly signalLights: THREE.InstancedMesh;
  private readonly pedestriansNear: THREE.InstancedMesh;
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
  private populationScale = 1;
  private rebuildCount = 0;
  private matrixWrites = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly yawQ = new THREE.Quaternion();
  private readonly wheelQ = new THREE.Quaternion();
  private readonly cabinColor = new THREE.Color();
  private readonly glassTint = new THREE.Color(0x78909a);
  private readonly routeSample: RouteSample = { x: 0, z: 0, dx: 1, dz: 0 };
  private readonly pedestrianPosition: RouteSample = { x: 0, z: 0, dx: 1, dz: 0 };
  private readonly wheelTurn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2,
  );
  private pedestrianShader: THREE.WebGLProgramParametersWithUniforms | null = null;

  constructor(scene: THREE.Scene, level: QualityLevel) {
    this.level = level;
    this.budget = POPULATION_BUDGETS[level];

    const bodyGeo = new THREE.BoxGeometry(4.25, 0.62, 1.78);
    bodyGeo.translate(0, 0.5, 0);
    const cabinGeo = new THREE.BoxGeometry(2.25, 0.58, 1.52);
    cabinGeo.translate(-0.15, 1.06, 0);
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 8);
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
    const pedestrianFarGeo = new THREE.PlaneGeometry(0.7, 1.8);
    pedestrianFarGeo.translate(0, 0.9, 0);
    const contactGeo = new THREE.CircleGeometry(1, 12);
    contactGeo.rotateX(-Math.PI / 2);
    const cyclistGeo = buildCyclistGeometry();
    const activityGeo = buildActivityGeometry();

    const expectedTriangles: Array<[THREE.BufferGeometry, number, string]> = [
      [bodyGeo, POPULATION_TRIANGLES.vehicleBody, 'vehicle body'],
      [cabinGeo, POPULATION_TRIANGLES.vehicleCabin, 'vehicle cabin'],
      [wheelGeo, POPULATION_TRIANGLES.vehicleWheels / 4, 'vehicle wheel'],
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
    });
    const cabinMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0,
    });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.88 });
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
    personMat.onBeforeCompile = (shader) => {
      shader.uniforms.populationTime = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float skinPart;\nattribute float instancePhase;\nuniform float populationTime;',
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          if (skinPart > 0.5) {
            float direction = skinPart < 1.5 ? 1.0 : -1.0;
            float angle = sin(populationTime * 7.4 + instancePhase) * 0.34 * direction;
            vec2 leg = vec2(transformed.x, transformed.y - 0.91);
            float c = cos(angle);
            float s = sin(angle);
            transformed.x = leg.x * c - leg.y * s;
            transformed.y = leg.x * s + leg.y * c + 0.91;
          }`,
        );
      this.pedestrianShader = shader;
    };
    personMat.customProgramCacheKey = () => 'street-life-pedestrian-v1';
    const farPersonMat = new THREE.MeshBasicMaterial({
      color: 0x4e5360,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.82,
      depthWrite: true,
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
      this.pedestriansNear,
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
    this.pedestriansNear.receiveShadow = true;
    this.activityMesh.receiveShadow = true;
    this.body.castShadow = level === 'high' || level === 'ultra';
    this.pedestriansNear.castShadow = level === 'ultra';

    for (const mesh of [
      this.body,
      this.cabin,
      this.wheels,
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
      this.pedestriansNear,
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
      this.lampPoles,
      this.lampArms,
      this.lampHeads,
      this.signalPoles,
      this.signalHeads,
      this.signalLights,
      this.pedestriansNear,
      this.pedestriansFar,
      this.contactShadows,
      this.cyclistMesh,
      this.activityMesh,
    );
    scene.add(this.group);

    // The layer remains useful immediately with landmark anchors; compact
    // station/park/bike context fills in asynchronously and triggers a rebuild.
    void this.density.load().then(() => {
      this.lastBuildAt = Number.NEGATIVE_INFINITY;
    });
  }

  update(
    camX: number,
    camZ: number,
    paths: RoadPaths[] | (() => RoadPaths[]),
    nowSeconds: number,
  ): void {
    this.matrixWrites = 0;
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
      !Number.isFinite(movedSq)
      || movedSq > rebuildDistance * rebuildDistance
      || nowSeconds - this.lastBuildAt > 3
    ) {
      const resolvedPaths = typeof paths === 'function' ? paths() : paths;
      this.rebuild(camX, camZ, resolvedPaths, nowSeconds);
      this.lastBuildX = camX;
      this.lastBuildZ = camZ;
      this.lastBuildAt = nowSeconds;
    }

    if (this.pedestrianShader) {
      this.pedestrianShader.uniforms.populationTime.value = nowSeconds;
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
    const previousTraffic = new Map<string, TrafficState>();
    for (const vehicle of this.trafficVehicles) {
      previousTraffic.set(vehicle.traffic.key, vehicle.traffic);
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
    for (const candidate of parkedCandidates.slice(0, parkedLimit)) {
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
      this.vehicles.push({
        x,
        z,
        yaw: Math.atan2(-segment.dz, segment.dx) + (candidate.side < 0 ? Math.PI : 0),
        color: new THREE.Color(kind === 'taxi' ? 0xf2bd1d : CAR_COLORS[colorIndex]),
        kind,
        shadowIndex: this.vehicles.length,
      });
    }

    const usableRoutes = this.graph.trafficRoutes;
    for (let i = 0; i < movingLimit && usableRoutes.length; i++) {
      const route = usableRoutes[i % usableRoutes.length];
      const seed = placementSeed(route.points[0], route.points[1], i + 101);
      const colorIndex = Math.floor(hash01(seed + 3) * CAR_COLORS.length);
      const routeCopies = Math.ceil(movingLimit / usableRoutes.length);
      const copyIndex = Math.floor(i / usableRoutes.length);
      const targetSpeed = 6.3 + hash01(seed + 5) * 5.8;
      const key = trafficKey(route, copyIndex);
      const previous = previousTraffic.get(key);
      const rawDistance = (
        route.length * ((copyIndex + hash01(seed + 11) * 0.35) / routeCopies)
        + nowSeconds * targetSpeed
      ) % Math.max(1, route.length * (route.oneWay ? 1 : 2));
      const initialDirection: 1 | -1 = !route.oneWay && rawDistance > route.length ? -1 : 1;
      const initialDistance = initialDirection < 0
        ? route.length * 2 - rawDistance
        : rawDistance;
      const vehicle: VehiclePlacement & { traffic: TrafficState } = {
        x: route.points[0],
        z: route.points[1],
        yaw: 0,
        color: new THREE.Color(CAR_COLORS[colorIndex]),
        kind: hash01(seed + 7) < 0.28 ? 'suv' : 'sedan',
        traffic: {
          route,
          distance: previous?.distance ?? initialDistance,
          speed: previous?.speed ?? targetSpeed,
          targetSpeed,
          laneOffset: Math.min(2.8, Math.max(1.2, route.width * 0.22)),
          laneSign: previous?.laneSign ?? initialDirection,
          direction: previous?.direction ?? initialDirection,
          finished: previous?.finished ?? false,
          key,
          lastVisualAt: nowSeconds,
        },
        shadowIndex: this.vehicles.length,
      };
      this.vehicles.push(vehicle);
      this.trafficVehicles.push(vehicle);
    }

    peopleCandidates.sort((a, b) => b.score - a.score || a.seed - b.seed);
    for (const candidate of peopleCandidates) {
      const segment = candidate.segment;
      const speed = 0.75 + hash01(candidate.seed + 89) * 0.9;
      const phase = hash01(candidate.seed + 97) * Math.PI * 2;
      const person: PedestrianPlacement = {
        segment,
        distance: candidate.distance + hash01(candidate.seed + 91) * segment.length,
        speed,
        side: candidate.side,
        phase,
        color: new THREE.Color(
          PERSON_COLORS[Math.floor(hash01(candidate.seed + 101) * PERSON_COLORS.length)],
        ),
        shadowIndex: -1,
      };
      const animated = this.pedestrianSample(person, nowSeconds);
      const near = (animated.x - camX) ** 2 + (animated.z - camZ) ** 2 <= nearRadiusSq;
      const target = near ? this.peopleNear : this.peopleFar;
      const limit = near ? nearPeopleLimit : farPeopleLimit;
      if (target.length >= limit) continue;
      if (near) person.shadowIndex = this.vehicles.length + this.peopleNear.length;
      target.push(person);
      if (this.peopleNear.length >= nearPeopleLimit && this.peopleFar.length >= farPeopleLimit) break;
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
    this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    this.matrix.compose(this.position.set(x, y, z), this.yawQ, this.scale.set(sx, sy, sz));
    this.body.setMatrixAt(index, this.matrix);
    this.cabin.setMatrixAt(index, this.matrix);
    this.body.setColorAt(index, vehicle.color);
    this.cabin.setColorAt(
      index,
      this.cabinColor.copy(vehicle.color).multiplyScalar(0.72).lerp(this.glassTint, 0.46),
    );
    this.matrixWrites += 2;

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
    this.wheels.count = this.vehicles.length * 4;
    this.contactShadows.count =
      this.vehicles.length + this.peopleNear.length + this.cyclists.length;
    this.markVehicleBuffers();
  }

  private markVehicleBuffers(): void {
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.cabin.instanceColor) this.cabin.instanceColor.needsUpdate = true;
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
    for (const vehicle of this.trafficVehicles) {
      const traffic = vehicle.traffic;
      let leaderGap = Number.POSITIVE_INFINITY;
      let leaderSpeed = traffic.targetSpeed;
      for (const other of this.trafficVehicles) {
        if (
          other === vehicle
          || other.traffic.route !== traffic.route
          || other.traffic.direction !== traffic.direction
        ) continue;
        const gap = traffic.direction > 0
          ? other.traffic.distance - traffic.distance
          : traffic.distance - other.traffic.distance;
        if (gap > 0 && gap < leaderGap) {
          leaderGap = gap;
          leaderSpeed = other.traffic.speed;
        }
      }
      if (traffic.finished) continue;
      const desired = leaderGap < 11
        ? Math.max(0, leaderSpeed * Math.max(0, (leaderGap - 4.8) / 6.2))
        : traffic.targetSpeed;
      const response = desired < traffic.speed ? 4.5 : 1.2;
      traffic.speed += (desired - traffic.speed) * Math.min(1, dt * response);
      advanceLaneProgress(traffic, traffic.route, traffic.speed * dt);
      if (traffic.finished) traffic.speed = 0;
      traffic.laneSign += (
        traffic.direction - traffic.laneSign
      ) * Math.min(1, dt * 2.8);
    }

    for (let i = 0; i < this.vehicles.length; i++) {
      const vehicle = this.vehicles[i];
      if (!vehicle.traffic) continue;
      const sample = sampleLaneRoute(
        vehicle.traffic.route,
        vehicle.traffic.distance,
        this.routeSample,
      );
      const travelDx = sample.dx * vehicle.traffic.direction;
      const travelDz = sample.dz * vehicle.traffic.direction;
      // NYC right-hand traffic: +dz/-dx is the right normal of travel.
      // laneSign eases through zero at a streamed two-way endpoint so the
      // turnaround crosses the road instead of popping laterally.
      const x = sample.x + sample.dz * vehicle.traffic.laneOffset * vehicle.traffic.laneSign;
      const z = sample.z - sample.dx * vehicle.traffic.laneOffset * vehicle.traffic.laneSign;
      const near = (x - camX) ** 2 + (z - camZ) ** 2 <= this.budget.nearRadius ** 2;
      if (!near && !farDue) continue;
      this.writeVehicle(i, vehicle, x, z, Math.atan2(-travelDz, travelDx));
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
        this.scale.set(1, 1, 1),
      );
      this.pedestriansNear.setMatrixAt(i, this.matrix);
      this.pedestriansNear.setColorAt(i, pedestrian.color);
      (phases as THREE.InstancedBufferAttribute).setX(i, pedestrian.phase);
      this.matrixWrites++;

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
    this.pedestriansNear.instanceMatrix.needsUpdate = true;
    if (this.pedestriansNear.instanceColor) this.pedestriansNear.instanceColor.needsUpdate = true;
    phases.needsUpdate = true;
    this.contactShadows.instanceMatrix.needsUpdate = true;
  }

  private updateFarPedestrians(camX: number, camZ: number, nowSeconds: number): void {
    for (let i = 0; i < this.peopleFar.length; i++) {
      const pedestrian = this.peopleFar[i];
      const sample = this.pedestrianSample(pedestrian, nowSeconds);
      const y = heightAt(sample.x, sample.z) + 0.04;
      const yaw = Math.atan2(camX - sample.x, camZ - sample.z);
      this.yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      this.matrix.compose(
        this.position.set(sample.x, y, sample.z),
        this.yawQ,
        this.scale.set(1, 1, 1),
      );
      this.pedestriansFar.setMatrixAt(i, this.matrix);
      this.matrixWrites++;
    }
    this.pedestriansFar.count = this.peopleFar.length;
    this.pedestriansFar.instanceMatrix.needsUpdate = true;
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
