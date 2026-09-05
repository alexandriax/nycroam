// Animated NYC subway train: stainless cars with sliding doors, bogies,
// headlights/marker lights, and a route roll-sign, cycling through an
// arrive -> dwell -> depart loop along the local +x axis.
import * as THREE from 'three';
import { routeColor, bulletTextColor } from './types';
import { BLACK, LED } from '../fonts';
import { canvas2d } from '../canvas2d';
import { quality } from '../quality';
import { TrainTimeline, type TrainPhase } from './trainTiming';
import { carDims, wallSegments, trainDoorFrame, TRAIN_FLOOR_ABOVE_RAIL, type CarDims } from './trainGeometry';
import { transitFinish, transitGlass } from '../transitMaterials';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface TrainOpts {
  division: string;
  routes: string[];
  carCount?: number;
  /**
   * The car's LOCAL z-sign that faces the platform (+1 or -1). The scheduler
   * computes it from the track/rotation. Only this side opens its doors;
   * both sides have glazed windows and complete closed leaves. Default +1.
   */
  platformSide?: 1 | -1;
  /**
   * Where the train is headed, e.g. "Uptown & The Bronx" or
   * "Grand Central–42 St". Baked (once per train) into the exterior side
   * signs next to the route bullet, and — space permitting — under the front
   * cab's roll sign. Signs show the bullet alone when omitted.
   */
  dirLabel?: string;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const FLOOR_Y = TRAIN_FLOOR_ABOVE_RAIL; // car floor height above rail-top (y=0)
const CAR_GAP = 0.35; // gap between coupled car bodies
const DOOR_SLIDE_DISTANCE = 0.67;

// Three IRT or four B-division door bays cut real openings into both sides.
const WALL_THK = 0.08;
const DOOR_TOP_H = 1.9; // door/opening height above the car floor

// Glazed window openings between stainless sill and header panels.
const WIN_SILL = 0.95; // window bottom above the car floor
const WIN_HEAD = 1.62; // window top above the car floor
const BELOW_H = WIN_SILL; // solid below-window panel height
const ABOVE_H = DOOR_TOP_H - WIN_HEAD; // solid above-window panel height
const BAND_H = WIN_HEAD - WIN_SILL; // open window-row height
const FRAME_DEPTH = WALL_THK + 0.03; // frame bars sit a touch proud of the wall
const LIP_H = 0.07; // sill / head frame-lip thickness (black band edges, R160-style)
const MULLION_W = 0.06; // vertical mullion / band-post thickness
// Panes per wall segment: a wide segment gets vertical mullions so it reads as
// two or three separate windows (real R-cars) instead of one long slot.
function panesFor(w: number): number {
  return Math.max(2, Math.round(w / 1.6));
}

// ---------------------------------------------------------------------------
// Shared materials (module scope: every Train instance reuses these).
// ---------------------------------------------------------------------------
const BODY_MATERIAL = transitFinish(new THREE.MeshStandardMaterial({ color: '#bdc2c4', metalness: .72, roughness: .39 }), 'steel');
// Matte near-black for the R160 window band: the window sill/head lips, the
// vertical mullions and the band side-posts are drawn in this so the platform-
// side window row reads as a dark band with light openings, not bright framing.
const BAND_MATERIAL = new THREE.MeshLambertMaterial({ color: '#141618' });
const ROOF_MATERIAL = new THREE.MeshStandardMaterial({ color: '#797f83', metalness: .6, roughness: .57 });
const UNDERCARRIAGE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#111214' });
const BOGIE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#161719' });
const WHEEL_MATERIAL = new THREE.MeshLambertMaterial({ color: '#3a3b3d' });
const DOOR_MATERIAL = transitFinish(new THREE.MeshStandardMaterial({ color: '#afb5b8', metalness: .62, roughness: .42 }), 'steel');
const WINDOW_MATERIAL = transitGlass();
// Black cab masking / anticlimber / sign backing.
const END_CAP_MATERIAL = new THREE.MeshLambertMaterial({ color: '#0d0d0d', side: THREE.DoubleSide });
// Dark front-cab glass (operator + storm-door windows): near-black, faintly
// reflective, opaque so it never mis-sorts against the interior behind it.
const CAB_GLASS_MATERIAL = new THREE.MeshStandardMaterial({ color: '#0d1116', metalness: 0.35, roughness: 0.2 });
const HEADLIGHT_MATERIAL = new THREE.MeshLambertMaterial({ color: '#fff8e0', emissive: '#fff8e0', emissiveIntensity: 1.2 });
const MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: '#ff2222', emissive: '#ff2222', emissiveIntensity: 1.0 });
// Shared interior finishes contrast with the stainless exterior.
const INTERIOR_FLOOR_MATERIAL = new THREE.MeshLambertMaterial({ color: '#35322d' });
const INTERIOR_CEILING_MATERIAL = new THREE.MeshLambertMaterial({ color: '#3b3c40' });
const CEILING_LIGHT_MATERIAL = new THREE.MeshBasicMaterial({ color: '#fff3d6' });
const BENCH_MATERIAL = new THREE.MeshLambertMaterial({ color: '#2b4d8c' });
const POLE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#b9bdc2', metalness: 0.8, roughness: 0.25 });

// ---------------------------------------------------------------------------
// Shared geometries (fixed-size, so shared across both divisions)
// ---------------------------------------------------------------------------
const WHEEL_GEO = new THREE.CylinderGeometry(0.39, 0.39, 0.10, 12);
const BOGIE_GEO = new THREE.BoxGeometry(1.6, 0.3, 1.9);
// Complete steel leaf and thin glazing share fixed geometry across divisions.
const DOOR_LOWER_GEO = trainDoorFrame();
const DOOR_UPPER_GEO = new THREE.PlaneGeometry(.50, .80).translate(0, 1.21, 0);
const WINDOW_GEO = new THREE.PlaneGeometry(1, 1);
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

// Exterior side sign: an R160-style orange LED destination display baked into
// one canvas (see makeSideSignTexture) — a rounded black panel with the route
// letter, a gap, then the destination, all in the LED (VT323) face glowing
// orange. Mapped onto one compact single-sided panel shared by every sign mesh
// on the train (one PlaneGeometry, positioned/rotated per instance — never
// DoubleSide, so each panel only renders from the side it's meant to face). The
// leading LED_ROUTE_FRAC of the canvas width holds the route letter; the rest
// holds the destination (the front cab crops to just that destination region).
const SIDE_SIGN_TEX_W = 512;
const SIDE_SIGN_TEX_H = 120;
const LED_ROUTE_FRAC = 0.22; // fraction of canvas width reserved for the route letter
const SIDE_SIGN_WIDTH = 1.1; // meters — reads like the real R160 LED at platform distance
const SIDE_SIGN_HEIGHT = (SIDE_SIGN_WIDTH * SIDE_SIGN_TEX_H) / SIDE_SIGN_TEX_W; // ~0.26m, matches canvas aspect
const SIDE_SIGN_GEO = new THREE.PlaneGeometry(SIDE_SIGN_WIDTH, SIDE_SIGN_HEIGHT);

// Small front-cab destination crop: same texture as the side signs, but a
// separate (module-scope, shared) plane whose UVs sample only the
// destination-text portion of that canvas, so the front cab can show
// "bullet (existing roll sign) + orange LED destination" without baking a
// second texture per train.
const FRONT_DEST_WIDTH = 0.34;
const FRONT_DEST_HEIGHT = 0.1;
const FRONT_DEST_GEO = new THREE.PlaneGeometry(FRONT_DEST_WIDTH, FRONT_DEST_HEIGHT);
{
  const uv = FRONT_DEST_GEO.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, LED_ROUTE_FRAC + uv.getX(i) * (1 - LED_ROUTE_FRAC));
  }
  uv.needsUpdate = true;
}

// Car-number + US-flag decal. One canvas per TRAIN bakes every car's number as
// its own horizontal row (flag on the left, four white digits to its right);
// each car's decal plane is a per-car CLONE of this geometry with its UV.y
// remapped to its own row, so all cars share the single texture (see
// makeNumberFlagTexture / addNumberDecal).
const NUMBER_ATLAS_W = 192; // px per row
const NUMBER_ROW_H = 64; // px per row (height = NUMBER_ROW_H * carCount)
const NUMBER_DECAL_W = 0.85; // meters — flag + digits at real decal scale
const NUMBER_DECAL_H = (NUMBER_DECAL_W * NUMBER_ROW_H) / NUMBER_ATLAS_W; // matches one row's aspect
const NUMBER_DECAL_GEO = new THREE.PlaneGeometry(NUMBER_DECAL_W, NUMBER_DECAL_H);

interface CarGeometrySet {
  roof: THREE.BufferGeometry;
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
  ceilingLiner: THREE.BoxGeometry; // dark ceiling panel flanking the lit strip
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
    const endSegW = wallSegments(dims)[0].w; // outer segment: car end -> first bay
    const midSegW = wallSegments(dims)[1].w; // inner segment: between two bays
    set = {
      roof: new RoundedBoxGeometry(L, .24, W * .96, 2, .10),
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
      ceilingLiner: new THREE.BoxGeometry(L * 0.9, 0.05, W * 0.82),
      bench: new THREE.BoxGeometry(midSegW * .86, .10, .42),
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
  const { cv: canvas, ctx } = canvas2d(size, size);
  drawRouteBullet(ctx, size, route);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Shrink `text` until it fits `maxWidth` in `family`, mirroring signage.ts's
// fitFontSize (train.ts can't import that module, so this is a small local
// duplicate). Faces here (Archivo Black, VT323) are drawn WITHOUT synthetic bold.
function fitFontSize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startPx: number, family: string): number {
  let size = startPx;
  ctx.font = `${size}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && size > 12) {
    size -= 2;
    ctx.font = `${size}px ${family}`;
  }
  return size;
}

/**
 * The destination shown on the LED signs, derived from a free-form dirLabel:
 * take the part after the last "&" (so "Uptown & Astoria" -> "ASTORIA"), then
 * drop any cross-street suffix after a dash (so "Grand Central–42 St" ->
 * "GRAND CENTRAL"), upper-cased. Empty label -> empty destination.
 */
function deriveDestination(dirLabel: string): string {
  let s = dirLabel.trim();
  if (!s) return '';
  const amp = s.lastIndexOf('&');
  if (amp >= 0) s = s.slice(amp + 1);
  const dash = s.search(/[–—-]/);
  if (dash > 0) s = s.slice(0, dash);
  return s.trim().toUpperCase();
}

// Rounded-rect path helper (some canvas backends lack ctx.roundRect).
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * The exterior side-sign texture: an R160 orange-LED destination display on a
 * rounded black panel with transparent corners (so the panel reads as a black
 * box sitting on the silver body). Layout: the route letter centered in the
 * leading LED_ROUTE_FRAC of the width, then the destination left-aligned in the
 * remainder — both in the VT323 LED face, glowing orange. One of these is baked
 * per TRAIN (every car + both sides share it, same route + direction).
 */
function makeSideSignTexture(route: string, destination: string): THREE.CanvasTexture {
  const w = SIDE_SIGN_TEX_W;
  const h = SIDE_SIGN_TEX_H;
  const { cv: canvas, ctx } = canvas2d(w, h);
  ctx.clearRect(0, 0, w, h); // transparent corners outside the rounded panel
  roundRectPath(ctx, 0, 0, w, h, h * 0.22);
  ctx.fillStyle = '#0a0b0c';
  ctx.fill();

  const orange = '#f59f2a';
  ctx.fillStyle = orange;
  ctx.shadowColor = orange;
  ctx.shadowBlur = 7;
  ctx.textBaseline = 'middle';
  const midY = h / 2 + h * 0.03;

  // route letter, centered in the leading region
  const routeRegion = LED_ROUTE_FRAC * w;
  ctx.textAlign = 'center';
  const routeSize = fitFontSize(ctx, route, routeRegion - h * 0.2, Math.round(h * 0.74), LED);
  ctx.font = `${routeSize}px ${LED}`;
  ctx.fillText(route, routeRegion * 0.52, midY);

  // destination, left-aligned in the remaining region
  if (destination) {
    ctx.textAlign = 'left';
    const destX = routeRegion + h * 0.08;
    const destSize = fitFontSize(ctx, destination, w - destX - h * 0.12, Math.round(h * 0.64), LED);
    ctx.font = `${destSize}px ${LED}`;
    ctx.fillText(destination, destX, midY);
  }

  ctx.shadowBlur = 0;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A tiny US flag (13 stripes + blue canton) drawn into a rect. Stars are omitted
// — invisible at decal scale — but the canton reads correctly.
function drawUSFlag(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const stripeH = h / 13;
  for (let s = 0; s < 13; s++) {
    ctx.fillStyle = s % 2 === 0 ? '#b22234' : '#ffffff';
    ctx.fillRect(x, y + s * stripeH, w, stripeH + 0.5);
  }
  ctx.fillStyle = '#3c3b6e';
  ctx.fillRect(x, y, w * 0.42, stripeH * 7);
}

/**
 * Car-number + flag atlas: one canvas per TRAIN, one horizontal row per car
 * (US flag then the four-digit number in silver-white). Each car's decal plane
 * samples its own row via a UV remap (see addNumberDecal), so the whole train
 * shares this single texture rather than baking one per car.
 */
function makeNumberFlagTexture(numbers: number[]): THREE.CanvasTexture {
  const rows = numbers.length;
  const w = NUMBER_ATLAS_W;
  const rowH = NUMBER_ROW_H;
  const { cv: canvas, ctx } = canvas2d(w, rowH * rows);
  ctx.clearRect(0, 0, w, rowH * rows);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let i = 0; i < rows; i++) {
    const y0 = i * rowH;
    const flagH = rowH * 0.6; // the flag is the decal's dominant element, like the real cars
    drawUSFlag(ctx, 8, y0 + (rowH - flagH) / 2, flagH * 1.8, flagH);
    ctx.font = `${Math.round(rowH * 0.52)}px ${BLACK}`;
    ctx.fillStyle = '#e8eaed';
    ctx.fillText(String(numbers[i]), 8 + flagH * 1.8 + 12, y0 + rowH / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// State machine timing
// ---------------------------------------------------------------------------
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
  private readonly windowMesh: THREE.InstancedMesh;
  private readonly frameMesh: THREE.InstancedMesh; // all window sill/head lips + mullions, one draw call
  private readonly doorLowerMesh: THREE.InstancedMesh;
  private readonly doorUpperMesh: THREE.InstancedMesh;
  private readonly doorClosedX: number[] = [];
  private readonly doorZ: number[] = [];
  private readonly doorSign: number[] = []; // slide direction (±x) of each leaf
  private readonly doorLeafSide: number[] = []; // local z-sign of the wall each leaf belongs to
  private readonly platformSide: 1 | -1; // local z-sign facing the platform
  private readonly rollSignTexture: THREE.CanvasTexture;
  private readonly rollSignMaterial: THREE.MeshLambertMaterial;
  private readonly sideSignTexture: THREE.CanvasTexture; // exterior side signs + front-cab dest crop share this
  private readonly sideSignMaterial: THREE.MeshLambertMaterial;
  private readonly numberFlagTexture: THREE.CanvasTexture; // per-train atlas of every car's number + flag
  private readonly numberFlagMaterial: THREE.MeshLambertMaterial;
  private readonly numberDecalGeos: THREE.PlaneGeometry[] = []; // per-car UV-remapped clones of NUMBER_DECAL_GEO
  private readonly mergedStaticGeometries: THREE.BufferGeometry[] = [];
  private contactShadow: THREE.InstancedMesh | null = null;

  private fromX = 0;
  private stopX = 0;
  private toX = 0;

  private readonly timeline = new TrainTimeline();
  private get state() { return this.timeline.phase; }
  private get stateTime() { return this.timeline.elapsed; }
  private get stateDuration() { return this.timeline.duration; }
  private doorOffset = 0;

  constructor(opts: TrainOpts) {
    this.platformSide = opts.platformSide === -1 ? -1 : 1;
    const dims = carDims(opts.division);
    const defaultCount = opts.division === 'IRT' ? 10 : 8;
    const carCount = Math.max(1, Math.floor(opts.carCount ?? defaultCount));
    const carPitch = dims.length + CAR_GAP;
    const geo = getCarGeometry(opts.division);
    const L = dims.length;
    const segs = wallSegments(dims);

    this.group = new THREE.Group();
    this.group.visible = false;

    this.wheelMesh = new THREE.InstancedMesh(WHEEL_GEO, WHEEL_MATERIAL, carCount * 8);
    this.group.add(this.wheelMesh);

    // Both sides share one framing draw and one glazing draw per train.
    let framePerSide = 0;
    for (const seg of segs) framePerSide += 2 + (panesFor(seg.w) - 1) + 2;
    this.frameMesh = new THREE.InstancedMesh(FRAME_BAR_GEO, BAND_MATERIAL, carCount * framePerSide * 2);
    this.windowMesh = new THREE.InstancedMesh(WINDOW_GEO, WINDOW_MATERIAL, carCount * segs.reduce((n, seg) => n + panesFor(seg.w), 0) * 2);
    this.group.add(this.windowMesh);
    this.group.add(this.frameMesh);

    const route = opts.routes[0] ?? 'S';
    const dirLabel = (opts.dirLabel ?? '').trim();
    const destination = deriveDestination(dirLabel);
    this.rollSignTexture = makeRollSignTexture(route);
    this.rollSignMaterial = new THREE.MeshLambertMaterial({
      map: this.rollSignTexture,
      color: '#ffffff',
      side: THREE.DoubleSide,
    });
    // Exterior side signs: single-sided (never DoubleSide) so each panel only
    // renders from the face it's rotated to point at. Transparent so the rounded
    // black LED panel's corners show the body behind them.
    this.sideSignTexture = makeSideSignTexture(route, destination);
    this.sideSignMaterial = new THREE.MeshLambertMaterial({
      map: this.sideSignTexture,
      color: '#ffffff',
      alphaTest: 0.25,
    });

    // Per-train car-number + flag atlas. Numbers start from a route-derived base
    // (deterministic across rebuilds — no Math.random) so a given train keeps its
    // numbers; each car is base + its index. One decal geometry per car remaps
    // its UV.y onto its own atlas row (all cars share the one texture).
    let routeCharSum = 0;
    const routeSrc = opts.routes.join('') || route;
    for (let c = 0; c < routeSrc.length; c++) routeCharSum += routeSrc.charCodeAt(c);
    const numberBase = 8000 + ((routeCharSum * 7) % 900);
    const carNumbers: number[] = [];
    for (let i = 0; i < carCount; i++) carNumbers.push(numberBase + i);
    this.numberFlagTexture = makeNumberFlagTexture(carNumbers);
    this.numberFlagMaterial = new THREE.MeshLambertMaterial({
      map: this.numberFlagTexture,
      color: '#ffffff',
      alphaTest: 0.25,
    });
    for (let i = 0; i < carCount; i++) {
      const g = NUMBER_DECAL_GEO.clone();
      const uv = g.attributes.uv;
      for (let k = 0; k < uv.count; k++) {
        uv.setY(k, 1 - (i + 1) / carCount + uv.getY(k) / carCount);
      }
      uv.needsUpdate = true;
      this.numberDecalGeos.push(g);
    }

    let wheelIndex = 0;
    const wheelMatrix = new THREE.Matrix4();
    const wheelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    const wheelPos = new THREE.Vector3();

    let frameIndex = 0;
    let windowIndex = 0;
    const frameMatrix = new THREE.Matrix4();
    const framePos = new THREE.Vector3();
    const frameScale = new THREE.Vector3();
    const winCenterY = FLOOR_Y + (WIN_SILL + WIN_HEAD) / 2;

    for (let i = 0; i < carCount; i++) {
      const localX = i * carPitch;
      const isFront = i === carCount - 1;
      const isRear = i === 0;

      this.addBodyShell(localX, dims, geo, segs);
      this.addCarDetails(localX, dims, segs, isFront, isRear);
      this.addSideSigns(localX, dims, segs);
      this.addNumberDecal(localX, dims, segs, i);

      // Black sill/head lips, mullions and side-posts surround each pane.
      for (const side of [-1, 1]) {
        const fz = side * (dims.width / 2 - WALL_THK / 2);
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
          for (let pane = 0; pane < panes; pane++) {
            framePos.set(sx - seg.w / 2 + seg.w * (pane + .5) / panes, winCenterY, fz);
            frameScale.set(seg.w / panes - MULLION_W, BAND_H - LIP_H, 1);
            frameMatrix.compose(framePos, IDENTITY_QUAT, frameScale);
            this.windowMesh.setMatrixAt(windowIndex++, frameMatrix);
          }
          for (let k = 1; k < panes; k++) {
            const mx = localX + seg.cx - seg.w / 2 + (seg.w * k) / panes;
            framePos.set(mx, winCenterY, fz);
            frameScale.set(MULLION_W, BAND_H, FRAME_DEPTH);
            frameMatrix.compose(framePos, IDENTITY_QUAT, frameScale);
            this.frameMesh.setMatrixAt(frameIndex++, frameMatrix);
          }
          // band side-posts at both segment edges (close the black band frame,
          // separating the window group from the adjoining door bays)
          for (const edge of [-1, 1]) {
            framePos.set(sx + edge * (seg.w / 2), winCenterY, fz);
            frameScale.set(MULLION_W, BAND_H, FRAME_DEPTH);
            frameMatrix.compose(framePos, IDENTITY_QUAT, frameScale);
            this.frameMesh.setMatrixAt(frameIndex++, frameMatrix);
          }
        }
      }

      const roof = new THREE.Mesh(geo.roof, ROOF_MATERIAL);
      roof.position.set(localX, FLOOR_Y + dims.height - .04, 0);
      // The roof is the train's deliberately coarse station-shadow proxy.
      // Scheduler enables only these 8–10 meshes on desktop instead of making
      // every door, mullion, bogie and interior detail submit a shadow draw.
      roof.userData.trainShadowCaster = true;
      this.group.add(roof);

      const undercarriage = new THREE.Mesh(geo.undercarriage, UNDERCARRIAGE_MATERIAL);
      undercarriage.position.set(localX, .81, 0);
      this.group.add(undercarriage);

      const bogieOffset = dims.length * 0.3;
      for (const bx of [-bogieOffset, bogieOffset]) {
        const bogie = new THREE.Mesh(BOGIE_GEO, BOGIE_MATERIAL);
        bogie.position.set(localX + bx, .53, 0);
        this.group.add(bogie);

        for (const wx of [-0.5, 0.5]) {
          for (const wz of [-1, 1]) {
            wheelPos.set(localX + bx + wx, .39, wz * .72);
            wheelMatrix.compose(wheelPos, wheelQuat, UNIT_SCALE);
            this.wheelMesh.setMatrixAt(wheelIndex++, wheelMatrix);
          }
        }
      }

      const doorXs = dims.doors;
      const halfGap = .325;
      for (const sideZ of [-1, 1]) {
        const z = sideZ * (dims.width / 2 + 0.004);
        for (const dx of doorXs) {
          this.addDoorLeaf(localX + dx - halfGap, z, -1, sideZ);
          this.addDoorLeaf(localX + dx + halfGap, z, 1, sideZ);
        }
      }

      if (isFront) this.addCarEnd(localX, dims, geo, 1, dirLabel);
      if (isRear) this.addCarEnd(localX, dims, geo, -1, dirLabel);
    }

    this.wheelMesh.instanceMatrix.needsUpdate = true;
    this.frameMesh.instanceMatrix.needsUpdate = true;
    this.windowMesh.instanceMatrix.needsUpdate = true;

    // Every leaf still gets its own live x offset, but two InstancedMeshes
    // replace the old two Mesh submissions per leaf (192 draws on an 8-car
    // train). updateDoors rewrites these matrices with the same choreography.
    this.doorLowerMesh = new THREE.InstancedMesh(
      DOOR_LOWER_GEO,
      DOOR_MATERIAL,
      this.doorClosedX.length,
    );
    this.doorUpperMesh = new THREE.InstancedMesh(
      DOOR_UPPER_GEO,
      WINDOW_MATERIAL,
      this.doorClosedX.length,
    );
    this.doorLowerMesh.name = 'train-door-frame-instances';
    this.doorUpperMesh.name = 'train-door-glass-instances';
    this.doorLowerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.doorUpperMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.doorLowerMesh, this.doorUpperMesh);
    this.updateDoorInstances(0);

    if (!quality().stationShadows) {
      this.contactShadow = this.buildContactShadow(carCount, carPitch, dims);
      this.group.add(this.contactShadow);
    }
    this.mergeStaticCarMeshes();
  }

  /** One mobile draw for soft contact under every car; no shadow map required. */
  private buildContactShadow(
    carCount: number,
    carPitch: number,
    dims: CarDims,
  ): THREE.InstancedMesh {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      uniforms: { opacity: { value: 0.34 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform float opacity;
        void main() {
          vec2 d = (vUv - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.06, dot(d, d)) * opacity;
          gl_FragColor = vec4(0.015, 0.012, 0.01, a);
        }`,
    });
    material.name = 'train-mobile-contact-shadow';
    const shadow = new THREE.InstancedMesh(geometry, material, carCount);
    shadow.name = 'train-contact-shadows';
    shadow.userData.mobileContactShadow = true;
    shadow.renderOrder = 2;
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < carCount; i++) {
      matrix.compose(
        new THREE.Vector3(i * carPitch, 0.02, 0),
        quaternion,
        new THREE.Vector3(dims.length * 0.92, dims.width * 1.16, 1),
      );
      shadow.setMatrixAt(i, matrix);
    }
    shadow.instanceMatrix.needsUpdate = true;
    shadow.computeBoundingBox();
    shadow.computeBoundingSphere();
    return shadow;
  }

  /** Batched thresholds, seat divisions, roof equipment and couplers. */
  private addCarDetails(localX: number, dims: CarDims, segs: {cx:number; w:number; mid:boolean}[], front: boolean, rear: boolean): void {
    const box = (material: THREE.Material, w:number, h:number, d:number, x:number, y:number, z:number) => {
      const mesh = new THREE.Mesh(FRAME_BAR_GEO, material);
      mesh.scale.set(w,h,d); mesh.position.set(localX+x, FLOOR_Y+y, z); this.group.add(mesh);
    };
    for (const side of [-1,1]) {
      for (const door of dims.doors) {
        box(POLE_MATERIAL, 1.36, .035, .18, door, .018, side*(dims.width/2-.035));
        for (const edge of [-1,1]) box(BAND_MATERIAL, .035, 1.91, .045, door+edge*.67, .955, side*(dims.width/2));
      }
      for (const segment of segs.filter(segment => segment.mid)) {
        box(BENCH_MATERIAL, segment.w*.86, .38, .075, segment.cx, .69, side*(dims.width/2-.115));
        for (let x=segment.cx-segment.w*.35; x<segment.cx+segment.w*.4; x+=.46) {
          box(BAND_MATERIAL, .016, .085, .39, x, .48, side*(dims.width/2-.23));
        }
      }
      box(POLE_MATERIAL, dims.length*.78, .032, .032, 0, 2.14, side*.65);
    }
    for (const end of [-1,1]) {
      if ((end===1 && front) || (end===-1 && rear)) continue;
      box(BODY_MATERIAL, .075, dims.height, dims.width*.95, end*dims.length/2, dims.height/2, 0);
      box(BAND_MATERIAL, .09, 1.95, .78, end*(dims.length/2+.008), .99, 0);
      box(DOOR_MATERIAL, .10, .9, .69, end*(dims.length/2+.014), .49, 0);
      box(CAB_GLASS_MATERIAL, .11, .65, .43, end*(dims.length/2+.02), 1.34, 0);
      box(UNDERCARRIAGE_MATERIAL, .36, .15, .24, end*(dims.length/2+.1), -.31, 0);
    }
    for (const x of [-dims.length*.22, dims.length*.22]) {
      box(ROOF_MATERIAL, 2.6, .14, 1.15, x, dims.height+.05, 0);
      for (let vent=-1; vent<=1; vent+=.2) box(BAND_MATERIAL, .032, .015, .8, x+vent, dims.height+.126, 0);
    }
  }

  private addBodyShell(localX: number, dims: CarDims, geo: CarGeometrySet, segs: { cx: number; w: number; mid: boolean }[]): void {
    const { length: L, width: W, height: H } = dims;
    const wallZ = W / 2 - WALL_THK / 2; // outer face flush with the old body skin (±W/2)
    const lowerY = FLOOR_Y + BELOW_H / 2;
    const upperY = FLOOR_Y + WIN_HEAD + ABOVE_H / 2;
    for (const sideZ of [-1, 1]) {
      const z = sideZ * wallZ;
      for (const segment of segs) {
        const lower = new THREE.Mesh(segment.mid ? geo.sideMidLower : geo.sideEndLower, BODY_MATERIAL);
        lower.position.set(localX + segment.cx, lowerY, z); this.group.add(lower);
        const upper = new THREE.Mesh(segment.mid ? geo.sideMidUpper : geo.sideEndUpper, BODY_MATERIAL);
        upper.position.set(localX + segment.cx, upperY, z); this.group.add(upper);
      }
      // header: continuous wall above the doors (the roof-line band)
      const header = new THREE.Mesh(geo.header, BODY_MATERIAL);
      header.position.set(localX, FLOOR_Y + DOOR_TOP_H + (H - DOOR_TOP_H) / 2, z);
      this.group.add(header);
      // longitudinal benches in the two inter-door bays (below the window line)
      for (const bx of segs.filter(segment => segment.mid).map(segment => segment.cx)) {
        const bench = new THREE.Mesh(geo.bench, BENCH_MATERIAL);
        bench.position.set(localX + bx, FLOOR_Y + .46, sideZ * (W / 2 - WALL_THK - 0.17));
        this.group.add(bench);
      }
    }
    const floor = new THREE.Mesh(geo.floor, INTERIOR_FLOOR_MATERIAL);
    floor.position.set(localX, FLOOR_Y - 0.04, 0);
    this.group.add(floor);
    // dark ceiling panel set just above/behind the lit strip, so the roof tone
    // around the light reads dark rather than as bright body metal.
    const ceilingLiner = new THREE.Mesh(geo.ceilingLiner, INTERIOR_CEILING_MATERIAL);
    ceilingLiner.position.set(localX, FLOOR_Y + H - 0.11, 0);
    this.group.add(ceilingLiner);
    const ceiling = new THREE.Mesh(geo.ceiling, CEILING_LIGHT_MATERIAL);
    ceiling.position.set(localX, FLOOR_Y + H - 0.16, 0);
    this.group.add(ceiling);
    for (const px of segs.filter(segment => segment.mid).map(segment => segment.cx)) {
      const pole = new THREE.Mesh(geo.pole, POLE_MATERIAL);
      pole.position.set(localX + px, FLOOR_Y + (H - 0.25) / 2, 0);
      this.group.add(pole);
    }
  }

  /** Store immutable leaf placements; only the platform-side instances slide. */
  private addDoorLeaf(x: number, z: number, sign: number, sideZ: number): void {
    this.doorClosedX.push(x);
    this.doorZ.push(z);
    this.doorSign.push(sign);
    this.doorLeafSide.push(sideZ);
  }

  private updateDoorInstances(normalizedOpen: number): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    for (let i = 0; i < this.doorClosedX.length; i++) {
      const offset = this.doorLeafSide[i] === this.platformSide
        ? normalizedOpen * DOOR_SLIDE_DISTANCE
        : 0;
      const x = this.doorClosedX[i] + this.doorSign[i] * offset;
      position.set(x, FLOOR_Y, this.doorZ[i] - this.doorLeafSide[i] * offset / DOOR_SLIDE_DISTANCE * .075);
      matrix.compose(position, IDENTITY_QUAT, UNIT_SCALE);
      this.doorLowerMesh.setMatrixAt(i, matrix);
      position.y = FLOOR_Y;
      matrix.compose(position, IDENTITY_QUAT, UNIT_SCALE);
      this.doorUpperMesh.setMatrixAt(i, matrix);
    }
    this.doorLowerMesh.instanceMatrix.needsUpdate = true;
    this.doorUpperMesh.instanceMatrix.needsUpdate = true;
    this.doorLowerMesh.computeBoundingSphere();
    this.doorUpperMesh.computeBoundingSphere();
  }

  /**
   * Cars repeat the same immutable shell, interior and signage geometry.
   * Merge those pieces once per live train/material while leaving the two door
   * instance buffers, wheels and window-frame instances dynamic. Shared module
   * geometries are never disposed here; merged outputs are train-owned.
   */
  private mergeStaticCarMeshes(): void {
    this.group.updateWorldMatrix(true, true);
    const batches = new Map<string, { material: THREE.Material; meshes: THREE.Mesh[] }>();
    this.group.traverse((object) => {
      if (
        !(object instanceof THREE.Mesh)
        || object instanceof THREE.InstancedMesh
        || object instanceof THREE.SkinnedMesh
        || Array.isArray(object.material)
        || object.material.transparent
        || object.userData.noTrainMerge
        || object.morphTargetInfluences
        || Object.keys(object.geometry.morphAttributes).length > 0
      ) return;
      const attributes = Object.keys(object.geometry.attributes).sort().map((name) => {
        const attribute = object.geometry.getAttribute(name);
        return `${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}`;
      }).join(',');
      const key = [
        object.material.uuid,
        object.geometry.index ? 'i' : 'n',
        attributes,
        object.renderOrder,
        object.layers.mask,
      ].join('|');
      const batch = batches.get(key);
      if (batch) batch.meshes.push(object);
      else batches.set(key, { material: object.material, meshes: [object] });
    });

    for (const batch of batches.values()) {
      if (batch.meshes.length < 2) continue;
      const geometries = batch.meshes.map((mesh) =>
        mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const replacement = new THREE.Mesh(merged, batch.material);
      replacement.name = `train-batch:${batch.material.name || batch.material.type}`;
      replacement.renderOrder = batch.meshes[0].renderOrder;
      replacement.layers.mask = batch.meshes[0].layers.mask;
      if (batch.material === ROOF_MATERIAL) replacement.userData.trainShadowCaster = true;
      for (const mesh of batch.meshes) mesh.removeFromParent();
      this.group.add(replacement);
      this.mergedStaticGeometries.push(merged);
    }
  }

  /**
   * The orange-LED destination sign, one per side of the car. Placed over the
   * SOLID above-window panel of a mid segment (between two door bays) at the top
   * of the window band, so — like the reference — the LED sits IN the black band
   * between windows and beside a door, never over a window or door opening (that
   * panel is solid stainless, so the opaque LED display has no interior showing
   * through behind it). Each panel is a single-sided plane rotated to face
   * outward on its own side only (never DoubleSide, per repo convention),
   * sitting ~0.01m proud of the wall skin.
   */
  private addSideSigns(localX: number, dims: CarDims, segs: { cx: number; w: number; mid: boolean }[]): void {
    const { width: W } = dims;
    // TWO signs per car side, like the real cars: one on each MID segment (the
    // solid band panels between the door bays), so they space evenly along the
    // car and can never sit over a door or window opening.
    const signY = FLOOR_Y + WIN_HEAD + ABOVE_H / 2; // top-of-band solid panel center
    for (const seg of [segs[1], segs[segs.length - 2]]) {
      const signX = localX + seg.cx;
      for (const sideZ of [-1, 1] as const) {
        const sign = new THREE.Mesh(SIDE_SIGN_GEO, this.sideSignMaterial);
        // proud of the band frame lips (which sit ~0.015 past the wall skin)
        sign.position.set(signX, signY, sideZ * (W / 2 + 0.02));
        if (sideZ === -1) sign.rotation.y = Math.PI; // flip the single-sided plane to face -z
        this.group.add(sign);
      }
    }
  }

  /**
   * The car-number + US-flag decal, one per side, near the +x end of the car on
   * the SOLID above-window panel of the end segment (same top-of-band height as
   * the LED sign, but at the car end, and on a different segment so the two never
   * overlap). The plane is this car's own UV-remapped clone of NUMBER_DECAL_GEO,
   * sampling its row of the shared per-train number/flag atlas; single-sided and
   * rotated to face outward on its own side only.
   */
  private addNumberDecal(localX: number, dims: CarDims, segs: { cx: number; w: number; mid: boolean }[], carIndex: number): void {
    const { width: W } = dims;
    const seg = segs[segs.length - 1]; // +x end segment (solid above the window row)
    const g = this.numberDecalGeos[carIndex];
    const x = localX + seg.cx;
    const y = FLOOR_Y + WIN_HEAD + ABOVE_H / 2;
    for (const sideZ of [-1, 1] as const) {
      const decal = new THREE.Mesh(g, this.numberFlagMaterial);
      decal.position.set(x, y, sideZ * (W / 2 + 0.022));
      if (sideZ === -1) decal.rotation.y = Math.PI;
      this.group.add(decal);
    }
  }

  /**
   * A car end. `dir` = +1 builds the lead-car FRONT (flat R-series cab: black
   * window band with a center storm-door window flanked by two operator
   * windows, a lit route sign up top, low white headlights + red taillights,
   * and a black anticlimber/coupler at the bottom). `dir` = -1 builds the
   * trailing REAR: the same cab face + storm/flank windows so it isn't an open
   * hole, the existing red marker pair up high, and a low red taillight pair.
   */
  private addCarEnd(localX: number, dims: CarDims, geo: CarGeometrySet, dir: 1 | -1, dirLabel: string): void {
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
      // destination text under the roll sign, cropped from the same side-sign
      // texture used for the exterior panels (no extra bake) — skipped when
      // there's no dirLabel to show.
      if (dirLabel) {
        const dest = new THREE.Mesh(FRONT_DEST_GEO, this.sideSignMaterial);
        dest.rotation.y = Math.PI / 2;
        dest.position.set(outX(0.06), FLOOR_Y + H * 0.86 - 0.16, 0);
        this.group.add(dest);
      }
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

  /** Where in the arrive -> dwell -> depart cycle this train is. */
  get phase(): TrainPhase {
    return this.state;
  }

  /**
   * INTERNAL seconds until this train is DWELLING at the platform, for the
   * platform countdown clocks (the scheduler divides by the slot's timeScale to
   * get real seconds): 0 while dwelling, the remaining approach time while
   * approaching, and — crucially — the remaining hidden time PLUS the fixed
   * approach that follows while still hidden, so the estimate keeps descending
   * smoothly from before the train is even visible right into its approach
   * instead of reading Infinity and snapping (the board bug where the row counts
   * to "now", jumps back up, and only THEN a train appears). Departing returns
   * Infinity — that train is leaving, so the scheduler anchors on the next one.
   */
  get secondsToArrival(): number { return this.timeline.secondsToDoors; }
  get secondsToCycleEnd(): number { return this.timeline.secondsToCycleEnd; }
  get acceptingPassengers(): boolean { return this.timeline.acceptingPassengers; }

  /** INTERNAL seconds left in the current phase. The scheduler reads this while
   *  a train departs (adds the recycle + spawn budget) to time the NEXT train. */
  get stateRemaining(): number {
    return Math.max(0, this.stateDuration - this.stateTime);
  }

  /** Advance the arrive -> dwell -> depart cycle by dt seconds. */
  update(dt: number): void {
    this.timeline.update(dt);

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

  /**
   * Force this train into an immediate doors-OPEN dwell parked at the platform
   * stop, holding the doors open for `openInternal` more (internal) seconds
   * before they close and it departs on the normal cycle. Used when the player
   * steps off a ride: the train they rode is re-seeded standing at the platform,
   * doors open, ready to re-board, then closes up and pulls out like any other.
   */
  forceDwell(openInternal: number): void {
    this.timeline.forceDwell(openInternal);
    this.group.visible = true;
    this.group.position.x = this.stopX;
    this.updateDoors();
  }

  private updateDoors(): void {
    const normalizedOpen = this.timeline.doorFraction;
    if (Math.abs(this.doorOffset - normalizedOpen * DOOR_SLIDE_DISTANCE) < 1e-7) return;
    this.doorOffset = normalizedOpen * DOOR_SLIDE_DISTANCE;
    // Only the platform-side leaves slide; the opposite paired frames stay shut.
    this.updateDoorInstances(normalizedOpen);
  }

  /** Release this instance's own GPU resources (shared geometries/materials are left intact). */
  dispose(): void {
    this.group.removeFromParent();
    if (this.contactShadow) {
      this.contactShadow.geometry.dispose();
      (this.contactShadow.material as THREE.Material).dispose();
      this.contactShadow.dispose();
      this.contactShadow = null;
    }
    this.doorLowerMesh.dispose();
    this.doorUpperMesh.dispose();
    this.wheelMesh.dispose();
    this.frameMesh.dispose();
    this.windowMesh.dispose();
    this.rollSignTexture.dispose();
    this.rollSignMaterial.dispose();
    this.sideSignTexture.dispose();
    this.sideSignMaterial.dispose();
    this.numberFlagTexture.dispose();
    this.numberFlagMaterial.dispose();
    for (const g of this.numberDecalGeos) g.dispose();
    for (const g of this.mergedStaticGeometries) g.dispose();
  }
}
