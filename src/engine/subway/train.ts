// Animated NYC subway train: stainless cars with sliding doors, bogies,
// headlights/marker lights, and a route roll-sign, cycling through an
// arrive -> dwell -> depart loop along the local +x axis.
import * as THREE from 'three';
import { routeColor, bulletTextColor } from './types';

export interface TrainOpts {
  division: string;
  routes: string[];
  carCount?: number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const FLOOR_Y = 0.25; // car floor height above rail-top (y=0)
const CAR_GAP = 0.35; // gap between coupled car bodies
const DOOR_SLIDE_DISTANCE = 0.65;

interface CarDims {
  length: number;
  width: number;
  height: number;
}

function carDims(division: string): CarDims {
  return division === 'IRT'
    ? { length: 15.5, width: 2.7, height: 3.1 }
    : { length: 18.3, width: 3.0, height: 3.2 };
}

// ---------------------------------------------------------------------------
// Shared materials (module scope: every Train instance reuses these).
// ---------------------------------------------------------------------------
const BODY_MATERIAL = new THREE.MeshStandardMaterial({ color: '#c3c6c9', metalness: 0.75, roughness: 0.35 });
const WINDOW_BAND_MATERIAL = new THREE.MeshLambertMaterial({ color: '#1a1d20', emissive: '#4a4438', emissiveIntensity: 0.3 });
const ROOF_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0a0a0a' });
const UNDERCARRIAGE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#111214' });
const BOGIE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#161719' });
const WHEEL_MATERIAL = new THREE.MeshLambertMaterial({ color: '#3a3b3d' });
const DOOR_MATERIAL = new THREE.MeshLambertMaterial({ color: '#8d9094', side: THREE.DoubleSide });
const END_CAP_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0d0d0d', side: THREE.DoubleSide });
const HEADLIGHT_MATERIAL = new THREE.MeshLambertMaterial({ color: '#fff8e0', emissive: '#fff8e0', emissiveIntensity: 1.2 });
const MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: '#ff2222', emissive: '#ff2222', emissiveIntensity: 1.0 });

// ---------------------------------------------------------------------------
// Shared geometries
// ---------------------------------------------------------------------------
const WHEEL_GEO = new THREE.CylinderGeometry(0.21, 0.21, 0.08, 8);
const BOGIE_GEO = new THREE.BoxGeometry(1.6, 0.3, 1.9);
const DOOR_LEAF_GEO = new THREE.PlaneGeometry(0.62, 1.9);
const ROLL_SIGN_GEO = new THREE.PlaneGeometry(0.5, 0.22);
const LIGHT_SPHERE_GEO = new THREE.SphereGeometry(0.06, 6, 4);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

interface CarGeometrySet {
  body: THREE.BoxGeometry;
  band: THREE.BoxGeometry;
  roof: THREE.BoxGeometry;
  undercarriage: THREE.BoxGeometry;
  endCap: THREE.PlaneGeometry;
}

const carGeometryCache = new Map<string, CarGeometrySet>();

/** Division-keyed geometry cache: only two shapes ever exist (IRT / other). */
function getCarGeometry(division: string): CarGeometrySet {
  const key = division === 'IRT' ? 'IRT' : 'OTHER';
  let set = carGeometryCache.get(key);
  if (!set) {
    const dims = carDims(division);
    set = {
      body: new THREE.BoxGeometry(dims.length * 0.98, dims.height, dims.width),
      band: new THREE.BoxGeometry(dims.length * 0.99, dims.height * 0.32, dims.width + 0.01),
      roof: new THREE.BoxGeometry(dims.length, 0.08, dims.width * 0.96),
      undercarriage: new THREE.BoxGeometry(dims.length * 0.8, 0.2, dims.width * 0.7),
      endCap: new THREE.PlaneGeometry(dims.width * 0.9, dims.height * 0.7),
    };
    carGeometryCache.set(key, set);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Roll-sign canvas texture (route bullet). This file may only import from
// 'three' and './types', so the bullet drawing is a tiny local duplicate of
// signage.ts's drawBullet rather than a cross-import.
// ---------------------------------------------------------------------------
function drawRouteBullet(ctx: CanvasRenderingContext2D, size: number, route: string): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = routeColor(route);
  ctx.fill();
  ctx.fillStyle = bulletTextColor(route);
  ctx.font = `bold ${Math.round(r * 1.15)}px 'Helvetica Neue', Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(route, cx, cy + r * 0.05);
}

function makeRollSignTexture(route: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  drawRouteBullet(ctx, size, route);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// State machine timing
// ---------------------------------------------------------------------------
type TrainState = 'hidden' | 'approach' | 'dwell' | 'depart';

const BASE_DURATION: Record<TrainState, number> = {
  hidden: 12,
  approach: 7,
  dwell: 14,
  depart: 7,
};

const STATE_ORDER: TrainState[] = ['hidden', 'approach', 'dwell', 'depart'];

function randomizedDuration(base: number): number {
  return base * (0.8 + Math.random() * 0.4);
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function easeInQuad(t: number): number {
  return t * t;
}

/**
 * A single animated subway train. Add `.group` to the scene, call
 * `setTravel` with the portal x-positions once known, then `update(dt)`
 * every frame to drive the arrive -> dwell -> depart cycle.
 *
 * The train always travels toward +x: fromX is the offstage approach start
 * (typically stopX - platformHalf - trainLength), stopX is where it dwells
 * alongside the platform, and toX is the offstage departure end (typically
 * stopX + platformHalf + trainLength). The front (+x end, headlights) leads;
 * the rear (-x end, red markers) trails.
 */
export class Train {
  readonly group: THREE.Group;

  private readonly wheelMesh: THREE.InstancedMesh;
  private readonly doorLeaves: THREE.Mesh[] = [];
  private readonly doorClosedX: number[] = [];
  private readonly doorSign: number[] = [];
  private readonly rollSignTexture: THREE.CanvasTexture;
  private readonly rollSignMaterial: THREE.MeshLambertMaterial;

  private fromX = 0;
  private stopX = 0;
  private toX = 0;

  private state: TrainState = 'hidden';
  private stateTime = 0;
  private stateDuration = randomizedDuration(BASE_DURATION.hidden);
  private doorOffset = 0;

  constructor(opts: TrainOpts) {
    const dims = carDims(opts.division);
    const defaultCount = opts.division === 'IRT' ? 10 : 8;
    const carCount = Math.max(1, Math.floor(opts.carCount ?? defaultCount));
    const carPitch = dims.length + CAR_GAP;
    const geo = getCarGeometry(opts.division);

    this.group = new THREE.Group();
    this.group.visible = false;

    this.wheelMesh = new THREE.InstancedMesh(WHEEL_GEO, WHEEL_MATERIAL, carCount * 8);
    this.group.add(this.wheelMesh);

    const route = opts.routes[0] ?? 'S';
    this.rollSignTexture = makeRollSignTexture(route);
    this.rollSignMaterial = new THREE.MeshLambertMaterial({
      map: this.rollSignTexture,
      color: '#ffffff',
      side: THREE.DoubleSide,
    });

    let wheelIndex = 0;
    const wheelMatrix = new THREE.Matrix4();
    const wheelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    const wheelPos = new THREE.Vector3();

    for (let i = 0; i < carCount; i++) {
      const localX = i * carPitch;
      const isFront = i === carCount - 1;
      const isRear = i === 0;

      const body = new THREE.Mesh(geo.body, BODY_MATERIAL);
      body.position.set(localX, FLOOR_Y + dims.height / 2, 0);
      this.group.add(body);

      const band = new THREE.Mesh(geo.band, WINDOW_BAND_MATERIAL);
      band.position.set(localX, FLOOR_Y + dims.height * 0.68, 0);
      this.group.add(band);

      const roof = new THREE.Mesh(geo.roof, ROOF_MATERIAL);
      roof.position.set(localX, FLOOR_Y + dims.height + 0.04, 0);
      this.group.add(roof);

      const undercarriage = new THREE.Mesh(geo.undercarriage, UNDERCARRIAGE_MATERIAL);
      undercarriage.position.set(localX, 0.15, 0);
      this.group.add(undercarriage);

      const bogieOffset = dims.length * 0.3;
      for (const bx of [-bogieOffset, bogieOffset]) {
        const bogie = new THREE.Mesh(BOGIE_GEO, BOGIE_MATERIAL);
        bogie.position.set(localX + bx, 0.27, 0);
        this.group.add(bogie);

        for (const wx of [-0.5, 0.5]) {
          for (const wz of [-1, 1]) {
            wheelPos.set(localX + bx + wx, 0.21, wz * dims.width * 0.36);
            wheelMatrix.compose(wheelPos, wheelQuat, UNIT_SCALE);
            this.wheelMesh.setMatrixAt(wheelIndex++, wheelMatrix);
          }
        }
      }

      const doorXs = [-dims.length * 0.27, 0, dims.length * 0.27];
      const halfGap = 0.34;
      for (const sideZ of [-1, 1]) {
        const z = sideZ * (dims.width / 2 + 0.004);
        for (const dx of doorXs) {
          this.addDoorLeaf(localX + dx - halfGap, z, -1);
          this.addDoorLeaf(localX + dx + halfGap, z, 1);
        }
      }

      if (isFront) {
        const faceX = localX + dims.length / 2 + 0.01;
        const endCap = new THREE.Mesh(geo.endCap, END_CAP_MATERIAL);
        endCap.rotation.y = Math.PI / 2;
        endCap.position.set(faceX, FLOOR_Y + dims.height * 0.55, 0);
        this.group.add(endCap);

        const sign = new THREE.Mesh(ROLL_SIGN_GEO, this.rollSignMaterial);
        sign.rotation.y = Math.PI / 2;
        sign.position.set(faceX + 0.01, FLOOR_Y + dims.height * 0.92, 0);
        this.group.add(sign);

        for (const hz of [-0.5, 0.5]) {
          const headlight = new THREE.Mesh(LIGHT_SPHERE_GEO, HEADLIGHT_MATERIAL);
          headlight.position.set(faceX + 0.02, FLOOR_Y + 0.2, hz * dims.width * 0.35);
          this.group.add(headlight);
        }
      }

      if (isRear) {
        const faceX = localX - dims.length / 2 - 0.01;
        for (const mz of [-0.5, 0.5]) {
          const marker = new THREE.Mesh(LIGHT_SPHERE_GEO, MARKER_MATERIAL);
          marker.position.set(faceX - 0.02, FLOOR_Y + dims.height * 0.75, mz * dims.width * 0.35);
          this.group.add(marker);
        }
      }
    }

    this.wheelMesh.instanceMatrix.needsUpdate = true;
  }

  private addDoorLeaf(x: number, z: number, sign: number): void {
    const leaf = new THREE.Mesh(DOOR_LEAF_GEO, DOOR_MATERIAL);
    leaf.position.set(x, FLOOR_Y + 0.95, z);
    this.group.add(leaf);
    this.doorLeaves.push(leaf);
    this.doorClosedX.push(x);
    this.doorSign.push(sign);
  }

  /** Portal x-positions: offstage approach start, platform dwell stop, offstage departure end. */
  setTravel(fromX: number, stopX: number, toX: number): void {
    this.fromX = fromX;
    this.stopX = stopX;
    this.toX = toX;
  }

  get doorsOpen(): boolean {
    return this.doorOffset > 0.001;
  }

  /** Advance the arrive -> dwell -> depart cycle by dt seconds. */
  update(dt: number): void {
    this.stateTime += dt;
    while (this.stateTime >= this.stateDuration) {
      this.stateTime -= this.stateDuration;
      this.advanceState();
    }

    switch (this.state) {
      case 'hidden':
        this.group.visible = false;
        break;
      case 'approach': {
        this.group.visible = true;
        const tn = Math.min(1, Math.max(0, this.stateTime / this.stateDuration));
        this.group.position.x = this.fromX + (this.stopX - this.fromX) * easeOutQuad(tn);
        break;
      }
      case 'dwell':
        this.group.visible = true;
        this.group.position.x = this.stopX;
        break;
      case 'depart': {
        this.group.visible = true;
        const tn = Math.min(1, Math.max(0, this.stateTime / this.stateDuration));
        this.group.position.x = this.stopX + (this.toX - this.stopX) * easeInQuad(tn);
        break;
      }
    }

    this.updateDoors();
  }

  private advanceState(): void {
    const idx = STATE_ORDER.indexOf(this.state);
    const next = STATE_ORDER[(idx + 1) % STATE_ORDER.length];
    this.state = next;
    this.stateDuration = randomizedDuration(BASE_DURATION[next]);
    if (next === 'approach') {
      this.group.position.x = this.fromX;
    }
  }

  private updateDoors(): void {
    let normalizedOpen = 0;
    if (this.state === 'dwell') {
      const openStart = 0.7;
      const slideDur = 0.8;
      const closeStart = Math.max(openStart + slideDur, this.stateDuration - 1.2);
      if (this.stateTime < openStart) {
        normalizedOpen = 0;
      } else if (this.stateTime < openStart + slideDur) {
        normalizedOpen = (this.stateTime - openStart) / slideDur;
      } else if (this.stateTime < closeStart) {
        normalizedOpen = 1;
      } else if (this.stateTime < closeStart + slideDur) {
        normalizedOpen = 1 - (this.stateTime - closeStart) / slideDur;
      } else {
        normalizedOpen = 0;
      }
    }
    normalizedOpen = Math.min(1, Math.max(0, normalizedOpen));
    this.doorOffset = normalizedOpen * DOOR_SLIDE_DISTANCE;
    for (let i = 0; i < this.doorLeaves.length; i++) {
      this.doorLeaves[i].position.x = this.doorClosedX[i] + this.doorSign[i] * this.doorOffset;
    }
  }

  /** Release this instance's own GPU resources (shared geometries/materials are left intact). */
  dispose(): void {
    this.group.removeFromParent();
    this.wheelMesh.dispose();
    this.rollSignTexture.dispose();
    this.rollSignMaterial.dispose();
  }
}
