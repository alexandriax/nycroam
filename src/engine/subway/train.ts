// Animated NYC subway train: stainless cars with sliding doors, bogies,
// headlights/marker lights, and a route roll-sign, cycling through an
// arrive -> dwell -> depart loop along the local +x axis.
import * as THREE from 'three';
import { routeColor, bulletTextColor } from './types';
import { BLACK } from '../fonts';

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

// Side-wall segmentation. Door bays sit at x = ±0.27*length and 0; each bay
// opening is 2*BAY_HALF wide. Instead of one solid body box, each side is cut
// into solid stainless segments BETWEEN the bays (leaving real openings), so a
// sliding door reveals the lit interior rather than a blank wall behind it.
const WALL_THK = 0.08;
const BAY_HALF = 0.65; // half-width of a door bay opening (halfGap 0.34 + leaf half 0.31)
const DOOR_TOP_H = 1.9; // door/opening height above the car floor

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
// Dark glass that reads as a lit subway window: near-black so it never looks
// like a hole, with a warm emissive lift so it glows like the lit interior
// behind it. Opaque (no transparency sort) and double-sided so a single
// instanced plane works on either wall face and inside a door leaf.
const WINDOW_GLASS_MATERIAL = new THREE.MeshLambertMaterial({ color: '#1a1d20', emissive: '#5a5240', emissiveIntensity: 0.4, side: THREE.DoubleSide });
const ROOF_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0a0a0a' });
const UNDERCARRIAGE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#111214' });
const BOGIE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#161719' });
const WHEEL_MATERIAL = new THREE.MeshLambertMaterial({ color: '#3a3b3d' });
const DOOR_MATERIAL = new THREE.MeshLambertMaterial({ color: '#8d9094', side: THREE.DoubleSide });
const END_CAP_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0d0d0d', side: THREE.DoubleSide });
const HEADLIGHT_MATERIAL = new THREE.MeshLambertMaterial({ color: '#fff8e0', emissive: '#fff8e0', emissiveIntensity: 1.2 });
const MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: '#ff2222', emissive: '#ff2222', emissiveIntensity: 1.0 });
// Interior seen through the open doors. Kept to a handful of shared materials.
const INTERIOR_FLOOR_MATERIAL = new THREE.MeshLambertMaterial({ color: '#33363b' });
const CEILING_LIGHT_MATERIAL = new THREE.MeshBasicMaterial({ color: '#fff3d6' });
const BENCH_MATERIAL = new THREE.MeshLambertMaterial({ color: '#2b4d8c' });
const POLE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#b9bdc2', metalness: 0.8, roughness: 0.25 });

// ---------------------------------------------------------------------------
// Shared geometries
// ---------------------------------------------------------------------------
const WHEEL_GEO = new THREE.CylinderGeometry(0.21, 0.21, 0.08, 8);
const BOGIE_GEO = new THREE.BoxGeometry(1.6, 0.3, 1.9);
const DOOR_LEAF_GEO = new THREE.PlaneGeometry(0.62, 1.9);
// Discrete windows (fixed size, so shared across both divisions like the door
// leaf): a wide pane for the wall segments between bays, and a small pane set
// into each sliding door leaf.
const WALL_WINDOW_GEO = new THREE.PlaneGeometry(1.0, 0.8);
const DOOR_WINDOW_GEO = new THREE.PlaneGeometry(0.4, 0.66);
const ROLL_SIGN_GEO = new THREE.PlaneGeometry(0.5, 0.22);
const LIGHT_SPHERE_GEO = new THREE.SphereGeometry(0.06, 6, 4);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

interface CarGeometrySet {
  roof: THREE.BoxGeometry;
  undercarriage: THREE.BoxGeometry;
  endCap: THREE.PlaneGeometry;
  sideEnd: THREE.BoxGeometry; // solid wall segment between a car end and the outer bay
  sideMid: THREE.BoxGeometry; // solid wall segment between two adjacent bays
  header: THREE.BoxGeometry; // full-length upper wall spanning above the doors
  floor: THREE.BoxGeometry; // interior floor
  ceiling: THREE.BoxGeometry; // lit ceiling strip
  bench: THREE.BoxGeometry; // longitudinal bench block
  pole: THREE.CylinderGeometry; // grab pole
}

const carGeometryCache = new Map<string, CarGeometrySet>();

/** Division-keyed geometry cache: only two shapes ever exist (IRT / other). */
function getCarGeometry(division: string): CarGeometrySet {
  const key = division === 'IRT' ? 'IRT' : 'OTHER';
  let set = carGeometryCache.get(key);
  if (!set) {
    const dims = carDims(division);
    const L = dims.length;
    const W = dims.width;
    const H = dims.height;
    const wallHalf = L * 0.49;
    const endSegW = wallHalf - L * 0.27 - BAY_HALF; // outer segment: car end -> first bay
    const midSegW = L * 0.27 - 2 * BAY_HALF; // inner segment: between two bays
    set = {
      roof: new THREE.BoxGeometry(L, 0.08, W * 0.96),
      undercarriage: new THREE.BoxGeometry(L * 0.8, 0.2, W * 0.7),
      endCap: new THREE.PlaneGeometry(W * 0.9, H * 0.7),
      sideEnd: new THREE.BoxGeometry(endSegW, DOOR_TOP_H, WALL_THK),
      sideMid: new THREE.BoxGeometry(midSegW, DOOR_TOP_H, WALL_THK),
      header: new THREE.BoxGeometry(L * 0.98, H - DOOR_TOP_H, WALL_THK),
      floor: new THREE.BoxGeometry(L * 0.92, 0.08, W - 2 * WALL_THK - 0.02),
      ceiling: new THREE.BoxGeometry(L * 0.85, 0.06, W * 0.5),
      bench: new THREE.BoxGeometry(midSegW * 0.9, 0.42, 0.34),
      pole: new THREE.CylinderGeometry(0.022, 0.022, H - 0.25, 6),
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
  ctx.font = `${Math.round(r * 1.1)}px ${BLACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(route, cx, cy + r * 0.04);
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
  private readonly windowMesh: THREE.InstancedMesh; // all wall windows, one draw call
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

    // Wall-window layout: two windows centered in each of the four solid wall
    // segments between the door bays (never over a bay), matching the segment
    // geometry built in addBodyShell. Height sits inside the door-height wall.
    const L = dims.length;
    const endSegW = L * 0.22 - BAY_HALF; // outer segment width (car end -> first bay)
    const midSegW = L * 0.27 - 2 * BAY_HALF; // inner segment width (between two bays)
    const segEndCx = (L * 0.76 + BAY_HALF) / 2; // outer segment center magnitude
    const windowY = FLOOR_Y + DOOR_TOP_H * 0.68; // window height inside the wall segment
    const winSegs: { cx: number; w: number }[] = [
      { cx: -segEndCx, w: endSegW },
      { cx: -L * 0.135, w: midSegW },
      { cx: L * 0.135, w: midSegW },
      { cx: segEndCx, w: endSegW },
    ];

    this.group = new THREE.Group();
    this.group.visible = false;

    this.wheelMesh = new THREE.InstancedMesh(WHEEL_GEO, WHEEL_MATERIAL, carCount * 8);
    this.group.add(this.wheelMesh);

    // 16 wall windows per car (2 per segment x 4 segments x 2 sides), all in a
    // single shared InstancedMesh so window count is one draw call per train.
    this.windowMesh = new THREE.InstancedMesh(WALL_WINDOW_GEO, WINDOW_GLASS_MATERIAL, carCount * 16);
    this.group.add(this.windowMesh);

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

    let windowIndex = 0;
    const windowMatrix = new THREE.Matrix4();
    const windowPos = new THREE.Vector3();
    const windowQuat = new THREE.Quaternion(); // identity: DoubleSide plane needs no facing

    for (let i = 0; i < carCount; i++) {
      const localX = i * carPitch;
      const isFront = i === carCount - 1;
      const isRear = i === 0;

      this.addBodyShell(localX, dims, geo);

      // Discrete wall windows: two per solid segment, on both sides, mounted
      // just proud of the outer wall face (±W/2). Nothing is placed over a door
      // bay, so there is no dark band spanning the doorways.
      for (const sideZ of [-1, 1]) {
        const wz = sideZ * (dims.width / 2 + 0.006);
        for (const seg of winSegs) {
          const spread = seg.w * 0.22; // window offset from the segment center
          for (const sx of [-spread, spread]) {
            windowPos.set(localX + seg.cx + sx, windowY, wz);
            windowMatrix.compose(windowPos, windowQuat, UNIT_SCALE);
            this.windowMesh.setMatrixAt(windowIndex++, windowMatrix);
          }
        }
      }

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
    this.windowMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Segmented stainless shell + a minimal lit interior, replacing the single
   * solid body box. The side walls are cut into solid segments between the door
   * bays, leaving real openings that the sliding doors cover; behind an OPEN
   * door a player on the platform now sees floor, benches, poles, the far
   * interior wall and a warm ceiling strip instead of a blank silver wall.
   * All geometry is shared (division-cached) and all materials are module-scope.
   */
  private addBodyShell(localX: number, dims: CarDims, geo: CarGeometrySet): void {
    const { length: L, width: W, height: H } = dims;
    const wallZ = W / 2 - WALL_THK / 2; // outer face flush with the old body skin (±W/2)
    const segEndCx = (L * 0.49 + L * 0.27 + BAY_HALF) / 2; // center of the outer wall segments
    const segs: { g: THREE.BoxGeometry; cx: number }[] = [
      { g: geo.sideEnd, cx: -segEndCx },
      { g: geo.sideMid, cx: -L * 0.135 },
      { g: geo.sideMid, cx: L * 0.135 },
      { g: geo.sideEnd, cx: segEndCx },
    ];
    for (const sideZ of [-1, 1]) {
      const z = sideZ * wallZ;
      // lower wall: solid segments between the door bays (openings left at bays)
      for (const s of segs) {
        const wall = new THREE.Mesh(s.g, BODY_MATERIAL);
        wall.position.set(localX + s.cx, FLOOR_Y + DOOR_TOP_H / 2, z);
        this.group.add(wall);
      }
      // header: continuous wall above the doors (no opening — the roof-line band)
      const header = new THREE.Mesh(geo.header, BODY_MATERIAL);
      header.position.set(localX, FLOOR_Y + DOOR_TOP_H + (H - DOOR_TOP_H) / 2, z);
      this.group.add(header);
      // longitudinal benches in the two inter-door bays (clear of the doorways)
      for (const bx of [-L * 0.135, L * 0.135]) {
        const bench = new THREE.Mesh(geo.bench, BENCH_MATERIAL);
        bench.position.set(localX + bx, FLOOR_Y + 0.21, sideZ * (W / 2 - WALL_THK - 0.17));
        this.group.add(bench);
      }
    }
    const floor = new THREE.Mesh(geo.floor, INTERIOR_FLOOR_MATERIAL);
    floor.position.set(localX, FLOOR_Y - 0.04, 0);
    this.group.add(floor);
    const ceiling = new THREE.Mesh(geo.ceiling, CEILING_LIGHT_MATERIAL);
    ceiling.position.set(localX, FLOOR_Y + H - 0.16, 0);
    this.group.add(ceiling);
    for (const px of [-L * 0.135, L * 0.135]) {
      const pole = new THREE.Mesh(geo.pole, POLE_MATERIAL);
      pole.position.set(localX + px, FLOOR_Y + (H - 0.25) / 2, 0);
      this.group.add(pole);
    }
  }

  private addDoorLeaf(x: number, z: number, sign: number): void {
    const leaf = new THREE.Mesh(DOOR_LEAF_GEO, DOOR_MATERIAL);
    leaf.position.set(x, FLOOR_Y + 0.95, z);
    // Small window in the (opaque) leaf, parented so it slides with the door.
    // Local axes match world (leaf is unrotated); nudge it proud of the outer
    // leaf face so it never z-fights, at the same height as the wall windows.
    const doorWindow = new THREE.Mesh(DOOR_WINDOW_GEO, WINDOW_GLASS_MATERIAL);
    doorWindow.position.set(0, 0.4, Math.sign(z) * 0.006);
    leaf.add(doorWindow);
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
    this.windowMesh.dispose();
    this.rollSignTexture.dispose();
    this.rollSignMaterial.dispose();
  }
}
