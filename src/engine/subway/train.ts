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

// Window band, measured above the car floor. The wall (and each door leaf) is a
// solid panel from floor -> WIN_SILL and from WIN_HEAD -> door-top, leaving the
// WIN_SILL..WIN_HEAD row as a real OPENING that shows the lit interior straight
// through (no transparent glass to mis-sort), exactly like an open door.
const WIN_SILL = 0.95; // window bottom above the car floor
const WIN_HEAD = 1.62; // window top above the car floor
const BELOW_H = WIN_SILL; // solid below-window panel height
const ABOVE_H = DOOR_TOP_H - WIN_HEAD; // solid above-window panel height
const BAND_H = WIN_HEAD - WIN_SILL; // open window-row height
const FRAME_DEPTH = WALL_THK + 0.03; // frame bars sit a touch proud of the wall
const LIP_H = 0.05; // sill / head frame-lip thickness
const MULLION_W = 0.06; // vertical mullion thickness
const DOOR_LEAF_W = 0.62;

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

// The four solid wall segments between the door bays (shared by the shell, the
// window framing and the interior placement so they always line up).
function wallSegments(L: number): { cx: number; w: number; mid: boolean }[] {
  const endSegW = L * 0.22 - BAY_HALF; // outer segment: car end -> first bay
  const midSegW = L * 0.27 - 2 * BAY_HALF; // inner segment: between two bays
  const endCx = (L * 0.76 + BAY_HALF) / 2; // outer segment center magnitude
  const midCx = L * 0.135; // inner segment center magnitude
  return [
    { cx: -endCx, w: endSegW, mid: false },
    { cx: -midCx, w: midSegW, mid: true },
    { cx: midCx, w: midSegW, mid: true },
    { cx: endCx, w: endSegW, mid: false },
  ];
}

// Panes per wall segment: a wide segment gets vertical mullions so it reads as
// two or three separate windows (real R-cars) instead of one long slot.
function panesFor(w: number): number {
  return Math.max(2, Math.round(w / 1.35));
}

// ---------------------------------------------------------------------------
// Shared materials (module scope: every Train instance reuses these).
// ---------------------------------------------------------------------------
const BODY_MATERIAL = new THREE.MeshStandardMaterial({ color: '#c3c6c9', metalness: 0.75, roughness: 0.35 });
const ROOF_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0a0a0a' });
const UNDERCARRIAGE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#111214' });
const BOGIE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#161719' });
const WHEEL_MATERIAL = new THREE.MeshLambertMaterial({ color: '#3a3b3d' });
const DOOR_MATERIAL = new THREE.MeshLambertMaterial({ color: '#8d9094', side: THREE.DoubleSide });
// Black cab masking / anticlimber / sign backing.
const END_CAP_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0d0d0d', side: THREE.DoubleSide });
// Dark front-cab glass (operator + storm-door windows): near-black, faintly
// reflective, opaque so it never mis-sorts against the interior behind it.
const CAB_GLASS_MATERIAL = new THREE.MeshStandardMaterial({ color: '#0d1116', metalness: 0.35, roughness: 0.2 });
const HEADLIGHT_MATERIAL = new THREE.MeshLambertMaterial({ color: '#fff8e0', emissive: '#fff8e0', emissiveIntensity: 1.2 });
const MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: '#ff2222', emissive: '#ff2222', emissiveIntensity: 1.0 });
// Interior seen through the open doors/windows. Kept to a handful of shared
// materials. The floor is a warm mid-gray so it reads as lit, not a dark void.
const INTERIOR_FLOOR_MATERIAL = new THREE.MeshLambertMaterial({ color: '#4a4640' });
const CEILING_LIGHT_MATERIAL = new THREE.MeshBasicMaterial({ color: '#fff3d6' });
const BENCH_MATERIAL = new THREE.MeshLambertMaterial({ color: '#2b4d8c' });
const POLE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#b9bdc2', metalness: 0.8, roughness: 0.25 });

// ---------------------------------------------------------------------------
// Shared geometries (fixed-size, so shared across both divisions)
// ---------------------------------------------------------------------------
const WHEEL_GEO = new THREE.CylinderGeometry(0.21, 0.21, 0.08, 8);
const BOGIE_GEO = new THREE.BoxGeometry(1.6, 0.3, 1.9);
// Door leaf split into a solid panel below the window and above the window,
// leaving the window row open. Fixed leaf width, so shared across divisions.
const DOOR_LOWER_GEO = new THREE.BoxGeometry(DOOR_LEAF_W, BELOW_H, 0.05);
const DOOR_UPPER_GEO = new THREE.BoxGeometry(DOOR_LEAF_W, ABOVE_H, 0.05);
// Unit cube scaled per-instance to make every window sill/head lip and mullion
// in one InstancedMesh (one draw call for all window framing on the train).
const FRAME_BAR_GEO = new THREE.BoxGeometry(1, 1, 1);
// Front-cab detail (fixed sizes).
const CAB_STORM_WIN_GEO = new THREE.BoxGeometry(0.05, 0.72, 0.44); // center storm-door window
const CAB_SIDE_WIN_GEO = new THREE.BoxGeometry(0.05, 0.52, 0.6); // operator / flanking window
const SIGN_PANEL_GEO = new THREE.BoxGeometry(0.04, 0.32, 0.72); // black backing behind the route sign
const COUPLER_GEO = new THREE.BoxGeometry(0.34, 0.18, 0.2);
const ROLL_SIGN_GEO = new THREE.PlaneGeometry(0.5, 0.22);
const LIGHT_SPHERE_GEO = new THREE.SphereGeometry(0.06, 6, 4);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const IDENTITY_QUAT = new THREE.Quaternion();

interface CarGeometrySet {
  roof: THREE.BoxGeometry;
  undercarriage: THREE.BoxGeometry;
  cabFace: THREE.BoxGeometry; // flat end wall closing a car end
  cabMask: THREE.BoxGeometry; // black band the cab windows sit in
  anticlimber: THREE.BoxGeometry; // black striker plate at the car end bottom
  sideEndLower: THREE.BoxGeometry; // outer wall segment, floor -> sill
  sideEndUpper: THREE.BoxGeometry; // outer wall segment, head -> door-top
  sideMidLower: THREE.BoxGeometry; // inner wall segment, floor -> sill
  sideMidUpper: THREE.BoxGeometry; // inner wall segment, head -> door-top
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
    const endSegW = L * 0.22 - BAY_HALF; // outer segment: car end -> first bay
    const midSegW = L * 0.27 - 2 * BAY_HALF; // inner segment: between two bays
    set = {
      roof: new THREE.BoxGeometry(L, 0.08, W * 0.96),
      undercarriage: new THREE.BoxGeometry(L * 0.8, 0.2, W * 0.7),
      cabFace: new THREE.BoxGeometry(0.08, H, W * 0.96),
      cabMask: new THREE.BoxGeometry(0.04, 0.9, W * 0.86),
      anticlimber: new THREE.BoxGeometry(0.16, 0.16, W * 0.92),
      sideEndLower: new THREE.BoxGeometry(endSegW, BELOW_H, WALL_THK),
      sideEndUpper: new THREE.BoxGeometry(endSegW, ABOVE_H, WALL_THK),
      sideMidLower: new THREE.BoxGeometry(midSegW, BELOW_H, WALL_THK),
      sideMidUpper: new THREE.BoxGeometry(midSegW, ABOVE_H, WALL_THK),
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
  private readonly frameMesh: THREE.InstancedMesh; // all window sill/head lips + mullions, one draw call
  private readonly doorLeaves: THREE.Object3D[] = [];
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
    const L = dims.length;
    const segs = wallSegments(L);

    this.group = new THREE.Group();
    this.group.visible = false;

    this.wheelMesh = new THREE.InstancedMesh(WHEEL_GEO, WHEEL_MATERIAL, carCount * 8);
    this.group.add(this.wheelMesh);

    // Window framing: 2 lips (sill + head) plus (panes-1) mullions per wall
    // segment, on both sides of every car, all in a single InstancedMesh so the
    // whole train's window detail is one draw call.
    let framePerSide = 0;
    for (const seg of segs) framePerSide += 2 + (panesFor(seg.w) - 1);
    this.frameMesh = new THREE.InstancedMesh(FRAME_BAR_GEO, BODY_MATERIAL, carCount * 2 * framePerSide);
    this.group.add(this.frameMesh);

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

    let frameIndex = 0;
    const frameMatrix = new THREE.Matrix4();
    const framePos = new THREE.Vector3();
    const frameScale = new THREE.Vector3();
    const winCenterY = FLOOR_Y + (WIN_SILL + WIN_HEAD) / 2;

    for (let i = 0; i < carCount; i++) {
      const localX = i * carPitch;
      const isFront = i === carCount - 1;
      const isRear = i === 0;

      this.addBodyShell(localX, dims, geo, segs);

      // Window framing on both wall faces, mounted flush with the wall skin.
      for (const sideZ of [-1, 1]) {
        const fz = sideZ * (dims.width / 2 - WALL_THK / 2);
        for (const seg of segs) {
          const sx = localX + seg.cx;
          // sill lip
          framePos.set(sx, FLOOR_Y + WIN_SILL, fz);
          frameScale.set(seg.w, LIP_H, FRAME_DEPTH);
          frameMatrix.compose(framePos, IDENTITY_QUAT, frameScale);
          this.frameMesh.setMatrixAt(frameIndex++, frameMatrix);
          // head lip
          framePos.set(sx, FLOOR_Y + WIN_HEAD, fz);
          frameScale.set(seg.w, LIP_H, FRAME_DEPTH);
          frameMatrix.compose(framePos, IDENTITY_QUAT, frameScale);
          this.frameMesh.setMatrixAt(frameIndex++, frameMatrix);
          // vertical mullions dividing the opening into panes
          const panes = panesFor(seg.w);
          for (let k = 1; k < panes; k++) {
            const mx = localX + seg.cx - seg.w / 2 + (seg.w * k) / panes;
            framePos.set(mx, winCenterY, fz);
            frameScale.set(MULLION_W, BAND_H, FRAME_DEPTH);
            frameMatrix.compose(framePos, IDENTITY_QUAT, frameScale);
            this.frameMesh.setMatrixAt(frameIndex++, frameMatrix);
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

      if (isFront) this.addCarEnd(localX, dims, geo, 1);
      if (isRear) this.addCarEnd(localX, dims, geo, -1);
    }

    this.wheelMesh.instanceMatrix.needsUpdate = true;
    this.frameMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Segmented stainless shell + a minimal lit interior, replacing the single
   * solid body box. Each side wall is cut into solid segments between the door
   * bays, and each segment is further split into a below-window panel (floor ->
   * sill) and an above-window panel (head -> door-top). The WIN_SILL..WIN_HEAD
   * row is left as a real OPENING, so from the platform you see the lit floor,
   * benches, poles and far interior straight through the window — the same view
   * you already get through an open door, with no glass to mis-sort. The door
   * bays stay open (covered only by the sliding leaves). All geometry is shared
   * (division-cached) and all materials are module-scope.
   */
  private addBodyShell(localX: number, dims: CarDims, geo: CarGeometrySet, segs: { cx: number; w: number; mid: boolean }[]): void {
    const { length: L, width: W, height: H } = dims;
    const wallZ = W / 2 - WALL_THK / 2; // outer face flush with the old body skin (±W/2)
    const lowerY = FLOOR_Y + BELOW_H / 2;
    const upperY = FLOOR_Y + WIN_HEAD + ABOVE_H / 2;
    for (const sideZ of [-1, 1]) {
      const z = sideZ * wallZ;
      // below- and above-window solid panels for each segment (window row open)
      for (const s of segs) {
        const lower = new THREE.Mesh(s.mid ? geo.sideMidLower : geo.sideEndLower, BODY_MATERIAL);
        lower.position.set(localX + s.cx, lowerY, z);
        this.group.add(lower);
        const upper = new THREE.Mesh(s.mid ? geo.sideMidUpper : geo.sideEndUpper, BODY_MATERIAL);
        upper.position.set(localX + s.cx, upperY, z);
        this.group.add(upper);
      }
      // header: continuous wall above the doors (the roof-line band)
      const header = new THREE.Mesh(geo.header, BODY_MATERIAL);
      header.position.set(localX, FLOOR_Y + DOOR_TOP_H + (H - DOOR_TOP_H) / 2, z);
      this.group.add(header);
      // longitudinal benches in the two inter-door bays (below the window line)
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

  /**
   * One sliding door leaf, built as a Group of a below-window panel and an
   * above-window panel so the leaf has its own see-through window opening
   * (matching the wall windows). The Group is what slides; updateDoors moves
   * `.position.x`, so doorClosedX/doorSign semantics are unchanged.
   */
  private addDoorLeaf(x: number, z: number, sign: number): void {
    const leaf = new THREE.Group();
    leaf.position.set(x, FLOOR_Y, z); // origin at the car floor
    const lower = new THREE.Mesh(DOOR_LOWER_GEO, DOOR_MATERIAL);
    lower.position.set(0, BELOW_H / 2, 0);
    leaf.add(lower);
    const upper = new THREE.Mesh(DOOR_UPPER_GEO, DOOR_MATERIAL);
    upper.position.set(0, WIN_HEAD + ABOVE_H / 2, 0);
    leaf.add(upper);
    this.group.add(leaf);
    this.doorLeaves.push(leaf);
    this.doorClosedX.push(x);
    this.doorSign.push(sign);
  }

  /**
   * A car end. `dir` = +1 builds the lead-car FRONT (flat R-series cab: black
   * window band with a center storm-door window flanked by two operator
   * windows, a lit route sign up top, low white headlights + red taillights,
   * and a black anticlimber/coupler at the bottom). `dir` = -1 builds the
   * trailing REAR: the same cab face + storm/flank windows so it isn't an open
   * hole, the existing red marker pair up high, and a low red taillight pair.
   */
  private addCarEnd(localX: number, dims: CarDims, geo: CarGeometrySet, dir: 1 | -1): void {
    const { width: W, height: H } = dims;
    const faceX = localX + dir * (dims.length / 2 + 0.01);
    const outX = (d: number) => faceX + dir * d; // proud toward the car end

    // flat cab face closing the car end
    const face = new THREE.Mesh(geo.cabFace, BODY_MATERIAL);
    face.position.set(faceX, FLOOR_Y + H / 2, 0);
    this.group.add(face);

    // black band the cab windows sit in
    const mask = new THREE.Mesh(geo.cabMask, END_CAP_MATERIAL);
    mask.position.set(outX(0.02), FLOOR_Y + 1.55, 0);
    this.group.add(mask);

    // center storm-door window (dark glass)
    const storm = new THREE.Mesh(CAB_STORM_WIN_GEO, CAB_GLASS_MATERIAL);
    storm.position.set(outX(0.05), FLOOR_Y + 1.5, 0);
    this.group.add(storm);

    // two flanking operator/cab windows (dark glass)
    for (const wz of [-1, 1]) {
      const sideWin = new THREE.Mesh(CAB_SIDE_WIN_GEO, CAB_GLASS_MATERIAL);
      sideWin.position.set(outX(0.05), FLOOR_Y + 1.6, wz * (W * 0.26));
      this.group.add(sideWin);
    }

    // black anticlimber + coupler at the bottom
    const anticlimber = new THREE.Mesh(geo.anticlimber, END_CAP_MATERIAL);
    anticlimber.position.set(outX(0.06), FLOOR_Y - 0.02, 0);
    this.group.add(anticlimber);
    const coupler = new THREE.Mesh(COUPLER_GEO, UNDERCARRIAGE_MATERIAL);
    coupler.position.set(outX(0.2), FLOOR_Y - 0.05, 0);
    this.group.add(coupler);

    if (dir === 1) {
      // lit route/destination sign up top
      const signPanel = new THREE.Mesh(SIGN_PANEL_GEO, END_CAP_MATERIAL);
      signPanel.position.set(outX(0.03), FLOOR_Y + H * 0.86, 0);
      this.group.add(signPanel);
      const sign = new THREE.Mesh(ROLL_SIGN_GEO, this.rollSignMaterial);
      sign.rotation.y = Math.PI / 2;
      sign.position.set(outX(0.06), FLOOR_Y + H * 0.86, 0);
      this.group.add(sign);
      // low white headlights + red taillights, in corner clusters
      for (const lz of [-1, 1]) {
        const head = new THREE.Mesh(LIGHT_SPHERE_GEO, HEADLIGHT_MATERIAL);
        head.position.set(outX(0.04), FLOOR_Y + 0.34, lz * W * 0.36);
        this.group.add(head);
        const tail = new THREE.Mesh(LIGHT_SPHERE_GEO, MARKER_MATERIAL);
        tail.position.set(outX(0.04), FLOOR_Y + 0.62, lz * W * 0.36);
        this.group.add(tail);
      }
    } else {
      // rear: existing high red marker pair (kept) + a low red taillight pair
      for (const mz of [-0.5, 0.5]) {
        const marker = new THREE.Mesh(LIGHT_SPHERE_GEO, MARKER_MATERIAL);
        marker.position.set(outX(0.04), FLOOR_Y + H * 0.72, mz * dims.width * 0.7);
        this.group.add(marker);
      }
      for (const lz of [-1, 1]) {
        const tail = new THREE.Mesh(LIGHT_SPHERE_GEO, MARKER_MATERIAL);
        tail.position.set(outX(0.04), FLOOR_Y + 0.5, lz * W * 0.36);
        this.group.add(tail);
      }
    }
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
    this.frameMesh.dispose();
    this.rollSignTexture.dispose();
    this.rollSignMaterial.dispose();
  }
}
