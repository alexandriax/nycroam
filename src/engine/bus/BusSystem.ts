import * as THREE from 'three';
import { dataUrl } from '../dataver';
import { disposeGroup } from '../EntranceManager';
import { heightAt } from '../terrain';
import { hash01 } from '../palette';
import {
  BUS,
  type BusData,
  type BusModelFactory,
  type BusModelLike,
  type BusStopKitFactory,
  type BusRouteBadge,
  type BusHud,
  type BusArrival,
} from './types';

/**
 * Bus network simulation + street-level manager.
 *
 * Every route direction runs a deterministic cyclic timetable computed at init;
 * buses are pure math (position = f(worldTime)) and only acquire meshes when
 * their focus point (the player, or the ridden bus) comes near. The visual
 * modules (BusModel, buildBusStop) are injected as factories so this file never
 * imports them — it depends on ./types alone.
 *
 * Per direction we precompute:
 *  - shape cumulative segment lengths → pointAt(s)/tangentAt(s) via binary search.
 *  - a keyframe timeline over the stops: dwell(stop 0), drive, dwell, drive, …,
 *    dwell(last, 12 s), despawn. Segments are binary-searchable by start time.
 *  - a cyclic schedule: headway H, slot count N, cycle C = N·H. Slot k is a bus
 *    whose run-time is τ_k = mod(worldTime + routePhase − k·H, C); active while
 *    τ_k < T (the run length). routePhase staggers routes.
 */

// ---- timetable constants ----
const DWELL = 9;          // s at intermediate stops (and the origin terminal)
const LAST_DWELL = 12;    // s at the terminal before despawn
const MIN_DRIVE = 6;      // floor on drive time between adjacent stops
const SPEED_SBS = 11.5;   // m/s cruising speed, Select Bus Service
const SPEED_LOCAL = 9.5;  // m/s cruising speed, local
const DOOR_RAMP = 1.2;    // s for doors to open / close within a dwell
const DOOR_OPEN = 0.6;    // door t threshold for board/exit
const HEADWAY_BASE = 42;
const HEADWAY_SPAN = 30;  // H ∈ [42, 72)
const WORLD_TIME_START = 7200;

// ---- streaming / culling constants ----
const STOP_PLACE_R2 = 300 * 300;
const STOP_REMOVE_R2 = 340 * 340;
const STOP_CAP = 120;
const BUS_MESH_R2 = 420 * 420;
const BUS_CULL_R2 = 460 * 460;
const STOP_TICK = 0.7;
const BUS_TICK = 0.35;

const SEG_DWELL = 0;
const SEG_DRIVE = 1;

// Persistent right-of-travel lane offset (m) from the GTFS shape. The shapes
// are street centerlines and opposite directions often share the SAME line,
// so without this buses run head-on down the middle of two-way streets —
// keeping right puts each direction in its own lane, US-style.
const BASE_LAT = 3.0;

// ---- anti-overlap (longitudinal car-following + lateral safety net) ----
//
// Buses are timetable-driven (position = f(worldTime)); nothing stops a fast
// bus phasing through a slow/dwelling one on a shared street. We fix this the
// way real traffic does — LONGITUDINALLY: each moving bus finds the nearest bus
// AHEAD of it in its lane (any route, same travel heading) and is held a safe
// gap behind it, decelerating to a stop if the leader dwells and resuming when
// it departs. A small LATERAL nudge is kept only as a hard backstop for the few
// geometries queuing can't fix (opposite directions meeting at a turn, two
// routes whose shapes coincide-then-diverge on a curve).
const MIN_GAP = 15.5;      // center-to-center min along a lane (bus 12.2 + gap + curve margin)
const LANE_HALF = 3.4;     // |lateral| below this = same lane (queue candidate)
const LANE_FAN = 0.22;     // widen the lane gate this much per meter ahead (curve tolerance)
const SAME_DIR_COS = 0.5;  // leader must share travel heading (dot of forwards)
const CO_EPS = 0.5;        // |along| below this = co-located (key-ordered tiebreak)
const LOOKAHEAD = 70;      // ignore leaders farther than this along-track (m)
// The rendered arc-length is a PERSISTENT state that eases toward its target
// (min of the timetable position and one MIN_GAP behind the leader) with a
// per-frame speed cap, so a bus decelerates and accelerates SMOOTHLY and its
// position/heading never snap. A backed-up bus just waits (visibly) at s>=0 —
// it never vanishes. FOLLOW_K = approach stiffness; V_MAX caps arc speed so no
// jump is ever visible (buses run up to ~13 m/s; headroom lets a lagging bus
// catch its schedule without teleporting).
const FOLLOW_K = 3.5;      // rendered-position approach rate (1/s)
const V_MAX = 20;          // cap on rendered arc-speed (m/s) — bounds every step
const END_EPS = 2.0;       // despawn a finished run once it renders within this of its terminal
const REL_RATE = 2.5;      // lateral-nudge release smoothing rate (base, per second)
const LAT_CAP = 8;         // max lateral slide speed (m/s) — smooth merge, never a sideways snap
// cross-traffic yield (intersections): a bus never drives its nose into another
// bus's body regardless of heading; the one closer to the conflict proceeds, the
// other holds back like waiting at the light.
const CROSS_LOOK = 16;     // look this far ahead (m) for a body blocking the lane
const CROSS_STOP_GAP = 1.6;// hold this much daylight short of the blocking body (m)
// lateral safety net
const SEP_TRIG = 13.5;     // consider a pair only within this center distance (m)
const SEP_STREET_COS = 0.6;// only same-street pairs (|cos|>this); perpendicular crossings are out of scope
const SEP_MARGIN = 0.5;    // extra daylight beyond footprint contact (m)
const SEP_MAX = 7.0;       // cap on lateral nudge (m)
const SEP_PASSES = 12;     // relaxation passes (resolves 3-way clusters)
const GOLDEN = 0.6180339887498949;

// ---- per-direction runtime (a timetable + geometry) ----
interface DirRT {
  routeIdx: number;
  dirIdx: number;
  dest: string;
  // geometry (filtered polyline)
  px: Float64Array;
  pz: Float64Array;
  cum: Float64Array;
  nPts: number;
  total: number;
  // stops
  stopIds: string[];
  stopNames: string[];
  stopS: Float64Array;
  dwellStart: Float64Array; // run-time a bus begins dwelling at stop i
  /** Curb pull-in, meters toward local +z while serving stop i. The GTFS shape
   *  runs down the roadway; the pole sits on the sidewalk. Pulling over parks
   *  the front door ~2 m from the pole, like a real bus (and inside the
   *  boardable radius). */
  curbPull: Float64Array;
  nStops: number;
  // keyframe timeline
  segT0: Float64Array;
  segDur: Float64Array;
  segType: Uint8Array;
  segStopIdx: Int32Array;   // dwell: i ; drive i→i+1: i+1 (the stop being approached)
  segSStart: Float64Array;
  segSEnd: Float64Array;
  nSeg: number;
  // schedule
  T: number;
  H: number;
  N: number;
  C: number;
  routePhase: number;
}

interface RouteRT {
  idx: number;
  id: string;
  color: string;
  sbs: boolean;
  name: string;
  dirs: DirRT[];
}

interface MeshedBus {
  key: string;
  keyNum: number;   // numeric key for deterministic ordering / co-located tiebreak
  dir: DirRT;
  k: number;
  model: BusModelLike;
  sfx: number;      // smoothed, flip-rejecting forward x (stable curb offset + heading)
  sfz: number;      // smoothed forward z
  y: number;        // smoothed ground height
  yaw: number;      // smoothed heading
  lastRS: number;   // last RENDERED arc-length (measured speed → wheels stop when held)
  lastNextStop: string | null | undefined; // undefined = never pushed
  lastStopReq: boolean;
  init: boolean;
  // ---- car-following scratch, recomputed each frame (see stepMeshed) ----
  sDes: number;     // desired arc-length from the timetable
  lat: number;      // curb offset this frame (m, right-of-travel)
  desX: number;     // desired on-lane world x (centerline + curb)
  desZ: number;     // desired on-lane world z
  fx: number;       // travel forward x (unit tangent)
  fz: number;       // travel forward z
  leaderIdx: number; // nearest same-lane bus ahead (index in the per-frame array; -1 none)
  // ---- persistent smoothed anti-overlap state ----
  rs: number;       // RENDERED arc-length (eased toward the capped target; never jumps)
  finishing: boolean; // run's schedule is over; drive to the terminal, then despawn
  sepX: number;     // smoothed lateral safety offset (world m)
  sepZ: number;
}

interface PlacedStop {
  id: string;
  group: THREE.Group;
  x: number;
  z: number;
}

interface StateS {
  s: number;
  lat: number; // current curb pull-in (m toward local +z)
  doorT: number;
  state: 'moving' | 'dwell' | 'closing';
  stopIdx: number;
  atEnd: boolean;
  stopReq: boolean;
}

export interface BusRideHandle {
  readonly model: BusModelLike;
  readonly hud: BusHud;
  readonly canExit: boolean;
  readonly atEnd: boolean;
  readonly pos: { x: number; z: number; yaw: number };
  readonly active: boolean;
  exitPos(): [number, number];
  end(): void;
}

// ---- helpers ----
function posmod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** Largest index i in [0, n-1] with arr[i] <= v (arr sorted ascending, arr[0] <= v). */
function lastLE(arr: Float64Array, n: number, v: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return lo;
}
/** Shortest-angle interpolation from a toward b by fraction t. */
function angLerp(a: number, b: number, t: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}
/** Do two bus footprints (oriented BUS.length × BUS.width boxes) intersect?
 *  Separating-axis test over the four box edge normals. Forwards are unit. */
function busFootprintsHit(
  ax: number, az: number, afx: number, afz: number,
  bx: number, bz: number, bfx: number, bfz: number,
): boolean {
  const hL = BUS.length / 2, hW = BUS.width / 2;
  const axes = [afx, afz, -afz, afx, bfx, bfz, -bfz, bfx];
  const tx = bx - ax, tz = bz - az;
  for (let a = 0; a < 8; a += 2) {
    const nx = axes[a], nz = axes[a + 1];
    const ra = Math.abs(nx * afx + nz * afz) * hL + Math.abs(nx * -afz + nz * afx) * hW;
    const rb = Math.abs(nx * bfx + nz * bfz) * hL + Math.abs(nx * -bfz + nz * bfx) * hW;
    if (Math.abs(nx * tx + nz * tz) > ra + rb) return false;
  }
  return true;
}

// module-level scratch — reused within single-threaded synchronous passes
const _st: StateS = { s: 0, lat: 0, doorT: 0, state: 'moving', stopIdx: 0, atEnd: false, stopReq: false };
const _pt = { x: 0, z: 0 };
const _tan = { x: 0, z: 0 };

class BusRide implements BusRideHandle {
  model: BusModelLike;
  hud: BusHud;
  canExit = false;
  atEnd = false;
  pos = { x: 0, z: 0, yaw: 0 };
  active = true;
  constructor(
    private unpin: () => void,
    public mb: MeshedBus,
    public dir: DirRT,
    route: RouteRT,
  ) {
    this.model = mb.model;
    this.hud = {
      route: route.id,
      color: route.color,
      sbs: route.sbs,
      dest: dir.dest,
      state: 'dwell',
      thisStop: dir.stopNames[0] ?? '',
      nextStop: dir.nStops > 1 ? dir.stopNames[1] : null,
      atEnd: dir.nStops <= 1,
    };
  }
  /** Front door world point pushed 2.6 m further onto the sidewalk (curb = local +z). */
  exitPos(): [number, number] {
    const { x, z, yaw } = this.pos;
    const lx = BUS.doorX.front, lz = BUS.width / 2 + 2.6;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [x + lx * c + lz * s, z - lx * s + lz * c];
  }
  end(): void {
    this.unpin();
  }
}

export class BusSystem {
  private scene: THREE.Scene;
  private makeModel: BusModelFactory;
  private makeStop: BusStopKitFactory;

  ready = false;
  private data: BusData | null = null;
  private routes: RouteRT[] = [];
  private routesById = new Map<string, RouteRT>();
  private stopIndex = new Map<string, { r: number; d: number; si: number }[]>();
  private allStops: { id: string; x: number; z: number; seed: number }[] = [];
  private _stopPositions: [number, number][] = [];

  private worldTime = WORLD_TIME_START;
  private meshed = new Map<string, MeshedBus>();
  private placedStops = new Map<string, PlacedStop>();
  private stopTimer = 0;
  private busTimer = 0;

  private riddenKey: string | null = null;
  private ride: BusRide | null = null;

  /**
   * Optional curb resolver (set by World). Given a stop's raw GTFS point, returns
   * a sidewalk point clear of roadways + buildings, or null to DEFER placement
   * until the tiles there have loaded. Without it, stops sit at the raw point.
   */
  resolvePlacement: ((x: number, z: number) => [number, number] | null) | null = null;

  constructor(scene: THREE.Scene, makeModel: BusModelFactory, makeStop: BusStopKitFactory) {
    this.scene = scene;
    this.makeModel = makeModel;
    this.makeStop = makeStop;
  }

  async init(): Promise<boolean> {
    try {
      const res = await fetch(dataUrl('/geo/buses.json'));
      if (!res.ok) return false;
      const data = (await res.json()) as BusData;
      this.build(data);
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  // ---- init: build timetables + indexes ----
  private build(data: BusData) {
    this.data = data;
    let dirSeq = 0; // global direction index, for even (low-discrepancy) route phasing
    data.routes.forEach((r, idx) => {
      const rt: RouteRT = { idx, id: r.id, color: r.color, sbs: r.sbs, name: r.name, dirs: [] };
      const speed = r.sbs ? SPEED_SBS : SPEED_LOCAL;
      r.dirs.forEach((d, dirIdx) => {
        const dir = this.buildDir(data, idx, dirIdx, d.dest, d.shape, d.stops, r.sbs, speed, dirSeq++);
        if (dir) rt.dirs.push(dir);
      });
      this.routes.push(rt);
      this.routesById.set(r.id, rt);
    });

    // stopId → [(route,dir,stopIdx)] index and the flat stop list
    for (const rt of this.routes) {
      for (const dir of rt.dirs) {
        for (let si = 0; si < dir.nStops; si++) {
          const id = dir.stopIds[si];
          let arr = this.stopIndex.get(id);
          if (!arr) { arr = []; this.stopIndex.set(id, arr); }
          arr.push({ r: rt.idx, d: dir.dirIdx, si });
        }
      }
    }
    let seed = 0;
    for (const id of Object.keys(data.stops)) {
      const info = data.stops[id];
      this.allStops.push({ id, x: info.p[0], z: info.p[1], seed: seed++ });
      this._stopPositions.push([info.p[0], info.p[1]]);
    }
  }

  private buildDir(
    data: BusData, routeIdx: number, dirIdx: number, dest: string,
    shape: number[], stops: { id: string; s: number }[], sbs: boolean, speed: number,
    dirSeq: number,
  ): DirRT | null {
    if (stops.length < 1 || shape.length < 2) return null;

    // filter degenerate (duplicate) shape points → no zero-length segments
    const xs: number[] = [], zs: number[] = [], cumA: number[] = [];
    let cum = 0;
    for (let i = 0; i < shape.length; i += 2) {
      const x = shape[i], z = shape[i + 1];
      if (xs.length) {
        const dx = x - xs[xs.length - 1], dz = z - zs[zs.length - 1];
        if (dx * dx + dz * dz < 1e-8) continue; // duplicate
        cum += Math.sqrt(dx * dx + dz * dz);
      }
      xs.push(x); zs.push(z); cumA.push(cum);
    }
    const nPts = xs.length;
    const total = cumA[nPts - 1];

    const nStops = stops.length;
    const stopIds = stops.map((s) => s.id);
    const stopNames = stops.map((s) => data.stops[s.id]?.n ?? s.id);
    const stopS = Float64Array.from(stops.map((s) => Math.max(0, Math.min(total, s.s))));

    // park so the FRONT DOOR (local +4.1) stops abeam the pole, not the bus
    // center — the stop's s marks the pole's shape projection
    const parkS = new Float64Array(nStops);
    for (let i = 0; i < nStops; i++) {
      parkS[i] = Math.max(0, Math.min(total, stopS[i] - BUS.doorX.front));
      if (i > 0 && parkS[i] < parkS[i - 1]) parkS[i] = parkS[i - 1];
    }

    // keyframe timeline: dwell, drive, dwell, …, dwell(last)
    const segT0: number[] = [], segDur: number[] = [], segType: number[] = [];
    const segStopIdx: number[] = [], segSStart: number[] = [], segSEnd: number[] = [];
    const dwellStart = new Float64Array(nStops);
    let t = 0;
    for (let i = 0; i < nStops; i++) {
      const dwell = i === nStops - 1 ? LAST_DWELL : DWELL;
      dwellStart[i] = t;
      segT0.push(t); segDur.push(dwell); segType.push(SEG_DWELL);
      segStopIdx.push(i); segSStart.push(parkS[i]); segSEnd.push(parkS[i]);
      t += dwell;
      if (i < nStops - 1) {
        const dist = parkS[i + 1] - parkS[i];
        const drive = Math.max(MIN_DRIVE, dist / speed);
        segT0.push(t); segDur.push(drive); segType.push(SEG_DRIVE);
        segStopIdx.push(i + 1); segSStart.push(parkS[i]); segSEnd.push(parkS[i + 1]);
        t += drive;
      }
    }
    const T = t;
    const H = HEADWAY_BASE + hash01(routeIdx * 17 + dirIdx * 7) * HEADWAY_SPAN;
    const N = Math.max(1, Math.ceil(T / H));
    const C = N * H;
    // Even (low-discrepancy) phase across directions so routes sharing a corridor
    // don't spawn in lockstep and bunch. A golden-ratio sequence over the global
    // direction index spreads phases maximally; a per-route hash perturbation
    // avoids two identical-timetable directions overlaying exactly. Buses WITHIN
    // a direction are already spaced one headway apart (slot k ⇒ −k·H).
    const routePhase = posmod((dirSeq * GOLDEN + hash01(routeIdx * 31 + dirIdx) * 0.13) * C, C);

    // curb pull-in per stop: lateral (right-of-travel) distance from the shape
    // to the pole, minus the door offset and a sidewalk gap. Clamped: never
    // steer left (a wrong-side pole) and never lunge more than 5 m. Floored at
    // the running-lane offset when the pole is far enough out that holding the
    // lane still leaves door clearance — the bus shouldn't swing back toward
    // the centerline just to serve a stop.
    const curbPull = new Float64Array(nStops);
    for (let i = 0; i < nStops; i++) {
      const info = data.stops[stopIds[i]];
      if (!info) continue;
      const s = stopS[i];
      let j = 0;
      // inline pointAt/tangentAt over the raw arrays (the DirRT isn't built yet)
      while (j < nPts - 2 && cumA[j + 1] <= s) j++;
      const segLen = cumA[j + 1] - cumA[j];
      const tt = segLen > 1e-6 ? (s - cumA[j]) / segLen : 0;
      const sx = xs[j] + (xs[j + 1] - xs[j]) * tt;
      const sz = zs[j] + (zs[j + 1] - zs[j]) * tt;
      const dxs = xs[j + 1] - xs[j], dzs = zs[j + 1] - zs[j];
      const len = Math.hypot(dxs, dzs);
      if (len < 1e-6) continue;
      // right-of-travel normal = (-tz, tx); lateral component of pole - shapePt
      const lat = (info.p[0] - sx) * (-dzs / len) + (info.p[1] - sz) * (dxs / len);
      curbPull[i] = Math.max(
        Math.max(0, Math.min(5, lat - 3.1)),
        Math.min(BASE_LAT, lat - 1.8),
      );
    }

    return {
      routeIdx, dirIdx, dest,
      px: Float64Array.from(xs), pz: Float64Array.from(zs), cum: Float64Array.from(cumA), nPts, total,
      stopIds, stopNames, stopS, dwellStart, curbPull, nStops,
      segT0: Float64Array.from(segT0), segDur: Float64Array.from(segDur), segType: Uint8Array.from(segType),
      segStopIdx: Int32Array.from(segStopIdx), segSStart: Float64Array.from(segSStart), segSEnd: Float64Array.from(segSEnd),
      nSeg: segT0.length,
      T, H, N, C, routePhase,
    };
  }

  // ---- geometry ----
  private pointAt(dir: DirRT, s: number, out: { x: number; z: number }) {
    const n = dir.nPts;
    if (n === 1) { out.x = dir.px[0]; out.z = dir.pz[0]; return; }
    if (s < 0) s = 0; else if (s > dir.total) s = dir.total;
    let i = lastLE(dir.cum, n, s);
    if (i >= n - 1) i = n - 2;
    const seg = dir.cum[i + 1] - dir.cum[i];
    const t = seg > 1e-6 ? (s - dir.cum[i]) / seg : 0;
    out.x = dir.px[i] + (dir.px[i + 1] - dir.px[i]) * t;
    out.z = dir.pz[i] + (dir.pz[i + 1] - dir.pz[i]) * t;
  }

  private tangentAt(dir: DirRT, s: number, out: { x: number; z: number }) {
    const n = dir.nPts;
    if (n === 1) { out.x = 1; out.z = 0; return; }
    if (s < 0) s = 0; else if (s > dir.total) s = dir.total;
    let i = lastLE(dir.cum, n, s);
    if (i >= n - 1) i = n - 2;
    const dx = dir.px[i + 1] - dir.px[i], dz = dir.pz[i + 1] - dir.pz[i];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) { out.x = 1; out.z = 0; } else { out.x = dx / len; out.z = dz / len; }
  }

  /** Full timetable state at run-time τ ∈ [0, T). Writes into scratch `o`. */
  private state(dir: DirRT, tau: number, o: StateS) {
    const si = lastLE(dir.segT0, dir.nSeg, tau);
    const t0 = dir.segT0[si], dur = dir.segDur[si], lt = tau - t0;
    o.stopIdx = dir.segStopIdx[si];
    o.atEnd = o.stopIdx === dir.nStops - 1;
    if (dir.segType[si] === SEG_DWELL) {
      o.s = dir.segSStart[si];
      o.lat = dir.curbPull[o.stopIdx];
      const open = clamp01(lt / DOOR_RAMP);
      const close = clamp01((dur - lt) / DOOR_RAMP);
      o.doorT = Math.min(open, close);
      o.state = lt > dur - DOOR_RAMP ? 'closing' : 'dwell';
      o.stopReq = false;
    } else {
      const u = dur > 0 ? clamp01(lt / dur) : 1;
      const e = u * u * (3 - 2 * u);
      o.s = dir.segSStart[si] + e * (dir.segSEnd[si] - dir.segSStart[si]);
      // ease off the previous stop's curb over the first 15% of the drive,
      // pull in toward the next stop's curb over the last 20% — and hold the
      // right-hand running lane (BASE_LAT) for the rest of the block
      if (u < 0.15) {
        const b = 1 - u / 0.15;
        const w = b * b * (3 - 2 * b);
        o.lat = BASE_LAT + (dir.curbPull[o.stopIdx - 1] - BASE_LAT) * w;
      } else if (u > 0.8) {
        const c = (u - 0.8) / 0.2;
        const w = c * c * (3 - 2 * c);
        o.lat = BASE_LAT + (dir.curbPull[o.stopIdx] - BASE_LAT) * w;
      } else {
        o.lat = BASE_LAT;
      }
      o.doorT = 0;
      o.state = 'moving';
      o.stopReq = u > 0.75;
    }
  }

  /** Cheap s-only evaluation (position scans, minimap) — skips door math. */
  private sAt(dir: DirRT, tau: number): number {
    const si = lastLE(dir.segT0, dir.nSeg, tau);
    if (dir.segType[si] === SEG_DWELL) return dir.segSStart[si];
    const dur = dir.segDur[si];
    const u = dur > 0 ? clamp01((tau - dir.segT0[si]) / dur) : 1;
    const e = u * u * (3 - 2 * u);
    return dir.segSStart[si] + e * (dir.segSEnd[si] - dir.segSStart[si]);
  }

  private tau(dir: DirRT, k: number): number {
    return posmod(this.worldTime + dir.routePhase - k * dir.H, dir.C);
  }

  /** World [x,z] of a bus-local point, using its smoothed group pose. */
  private localXZToWorld(mb: MeshedBus, lx: number, lz: number): [number, number] {
    const c = Math.cos(mb.yaw), s = Math.sin(mb.yaw);
    const gx = mb.model.group.position.x, gz = mb.model.group.position.z;
    return [gx + lx * c + lz * s, gz - lx * s + lz * c];
  }

  // ---- update ----
  update(px: number, pz: number, dt: number) {
    if (!this.data) return;
    this.worldTime += dt;

    this.stopTimer -= dt;
    if (this.stopTimer <= 0) { this.stopTimer = STOP_TICK; this.streamStops(px, pz); }

    this.busTimer -= dt;
    if (this.busTimer <= 0) { this.busTimer = BUS_TICK; this.maintainBuses(px, pz); }

    // per-frame: transform every meshed bus (newly built ones included)
    this.stepMeshed(dt);
    if (this.ride) this.refreshRide();
  }

  private stepMeshed(dt: number) {
    // PASS 1 — timetable: each in-service meshed bus's DESIRED on-lane pose, plus
    // its purely-scheduled outputs (doors, next-stop sign). The anti-overlap pass
    // then decides where it actually renders.
    const vis: MeshedBus[] = [];
    for (const mb of this.meshed.values()) {
      const dir = mb.dir;
      const tau = this.tau(dir, mb.k);
      // When the schedule says the run is over, DON'T vanish in place — keep the
      // bus visible and drive it to its terminal (target = the route's final s);
      // finalize removes it once it renders there. The ridden bus is pinned
      // (World ends the ride via ride.active=false), so leave its schedule alone.
      const finishing = tau >= dir.T && mb.key !== this.riddenKey;
      mb.finishing = finishing;
      let s: number;
      if (finishing) {
        s = dir.segSEnd[dir.nSeg - 1]; // the terminal
        mb.lat = BASE_LAT;
        mb.model.setDoors(0);
      } else {
        this.state(dir, tau >= dir.T ? dir.T - 1e-3 : tau, _st);
        s = _st.s;
        mb.lat = _st.lat;
        mb.model.setDoors(_st.doorT);
        const nx = dir.stopNames[_st.stopIdx] ?? null;
        if (nx !== mb.lastNextStop) { mb.model.setNextStop(nx); mb.lastNextStop = nx; }
        if (_st.stopReq !== mb.lastStopReq) { mb.model.setStopRequested(_st.stopReq); mb.lastStopReq = _st.stopReq; }
      }
      this.pointAt(dir, s, _pt);
      this.tangentAt(dir, s, _tan);
      const rnx = -_tan.z, rnz = _tan.x; // unit right-of-travel normal
      mb.sDes = s;
      mb.desX = _pt.x + rnx * mb.lat;    // desired on-lane world position
      mb.desZ = _pt.z + rnz * mb.lat;
      mb.fx = _tan.x; mb.fz = _tan.z;    // travel forward = shape tangent
      vis.push(mb);
    }
    const finished = this.clampSeparate(vis, dt);
    for (const mb of finished) this.removeMeshed(mb);
  }

  /**
   * Anti-overlap: hold every bus a safe gap behind the nearest bus ahead of it in
   * its lane, like real traffic, so a fast bus that catches a slow/dwelling one
   * SLOWS and queues instead of phasing through. This is the primary mechanism
   * (LONGITUDINAL); a small lateral nudge is kept only as a hard backstop.
   *
   *  1. leader: for each bus, the nearest bus AHEAD on a shared centerline within
   *     a lane (any route, same travel heading). Co-located buses are ordered by
   *     key so they queue nose-to-tail rather than stacking.
   *  2. resolve: leader-before-follower. Each bus's RENDERED arc-length `rs` is a
   *     persistent state eased (rate-capped) toward its target = min(timetable
   *     position, one MIN_GAP behind the leader's rendered position), floored at
   *     s=0. Because rs never jumps, position and heading are always smooth — a
   *     bus decelerates to a stop behind a dwelling leader and accelerates away
   *     when it departs, and a fully-backed-up bus WAITS VISIBLY at the terminal
   *     (it is never hidden). Returns buses whose finished run reached the end.
   *  3. lateral net: for the few pairs queuing can't fix — opposite directions
   *     meeting at a turn, shapes that coincide-then-diverge on a curve — nudge the
   *     two apart along the shared street's perpendicular by their footprint
   *     penetration. Fires only on a real oriented-footprint overlap.
   */
  private clampSeparate(vis: MeshedBus[], dt: number): MeshedBus[] {
    const n = vis.length;
    if (n === 0) return [];
    const rx = new Float64Array(n), rz = new Float64Array(n);   // rendered pose
    const rfx = new Float64Array(n), rfz = new Float64Array(n);
    const done = new Uint8Array(n), onStack = new Uint8Array(n);

    // per-bus run advancement: +1 at its terminal (finishing), −1 at its start,
    // 0 mid-route. Many routes share a terminal (Columbus Circle, etc.); a bus
    // ending its run must not dwell on the exact point where another route's bus
    // ORIGINATES — the start bus is floored at s=0 and cannot back up, so the
    // finishing bus is the one that must give way. Advancement drives that.
    const adv = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      adv[i] = a.sDes >= a.dir.total - 2 ? 1 : a.sDes <= 2 ? -1 : 0;
    }

    // (1) nearest same-lane leader ahead, on DESIRED positions (stable, lag-free)
    for (let i = 0; i < n; i++) {
      const a = vis[i], fx = a.fx, fz = a.fz, xi = a.desX, zi = a.desZ, ki = a.keyNum, ai = adv[i];
      let bestAhead = -1, bestAlong = Infinity, bestColoc = -1, bestColocKey = -Infinity;
      let termLeader = -1, termAdv = 2; // most-advanced-below-i wins → nearest in the order
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = vis[j];
        const ddx = b.desX - xi, ddz = b.desZ - zi;
        const along = ddx * fx + ddz * fz;
        if (along > LOOKAHEAD) continue;
        const lat = ddx * -fz + ddz * fx;
        // smaller lateral of the two frames: on shapes that coincide-then-diverge
        // the follower can read the leader out-of-lane in its own rotated frame
        // while the leader reads it in-lane — link if EITHER sees a shared lane.
        // The gate widens with distance ahead (a cone): on a curve — traffic
        // circles (Columbus Circle), bends — a leader one gap ahead sits off to
        // the side in the follower's straight frame, so a fixed width misses it
        // and they overlap. The cone catches it while staying tight up close.
        const latJ = ddx * b.fz - ddz * b.fx;
        const laneTol = LANE_HALF + LANE_FAN * Math.min(Math.max(0, along), 30);
        if (Math.min(Math.abs(lat), Math.abs(latJ)) >= laneTol) continue;
        const cosH = fx * b.fx + fz * b.fz;
        if (cosH <= SAME_DIR_COS) continue; // only queue behind same travel heading
        if (along > CO_EPS) { if (along < bestAlong) { bestAlong = along; bestAhead = j; } }
        else if (along > -CO_EPS && b.keyNum < ki) { if (b.keyNum > bestColocKey) { bestColocKey = b.keyNum; bestColoc = j; } }
        // terminal/start override: if i is strictly MORE advanced than j and they
        // share this spot (within a bus length, ahead OR behind), i yields to j.
        // This is antisymmetric (only the more-advanced side fires), so no
        // deadlock; it catches the finishing-on-originating overlap the ahead/
        // co-located branches miss when the pair straddles the co-located epsilon.
        if (ai > adv[j] && Math.abs(along) < BUS.length && adv[j] < termAdv) {
          termAdv = adv[j]; termLeader = j;
        }
      }
      a.leaderIdx = termLeader >= 0 ? termLeader : bestColoc >= 0 ? bestColoc : bestAhead;
    }

    // (1b) cross-traffic yield: no bus drives its nose into another bus's body,
    // whatever the heading — this is what stops two buses PHASING THROUGH each
    // other where their paths cross (perpendicular streets at an intersection, a
    // merge), which the same-heading queue can't see. For each bus we find the
    // nearest body blocking its lane ahead and the forward distance it may still
    // advance (dA, negative if already too close). The bus that must stop CLOSER
    // to the conflict (smaller d) has right of way and proceeds; the FARTHER one
    // holds a short gap back. keyNum breaks exact ties so the pair never both
    // freeze (no gridlock). Result is an absolute arc-length cap folded into (2).
    const hLb = BUS.length / 2, hWb = BUS.width / 2;
    const noseCapRS = new Float64Array(n);
    noseCapRS.fill(Infinity);
    for (let i = 0; i < n; i++) {
      const a = vis[i], afx = a.fx, afz = a.fz;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = vis[j];
        const ddx = b.desX - a.desX, ddz = b.desZ - a.desZ;
        const along = ddx * afx + ddz * afz;             // b's centre ahead of a
        if (along <= 0 || along > CROSS_LOOK) continue;   // only near hazards ahead
        const lat = ddx * -afz + ddz * afx;
        // b's half-extent projected on a's forward (E) and a's lateral (latExt)
        const c1 = Math.abs(afx * b.fx + afz * b.fz);     // |cos| between forwards
        const c2 = Math.abs(afx * -b.fz + afz * b.fx);    // |sin|
        const E = c1 * hLb + c2 * hWb;
        const latExt = c2 * hLb + c1 * hWb;
        if (Math.abs(lat) >= hWb + latExt) continue;      // b not across a's lane
        const dA = along - E - hLb - CROSS_STOP_GAP;      // a's room before contact
        // symmetric room for b before it hits a → right-of-way (closer proceeds)
        const alongB = -ddx * b.fx - ddz * b.fz;
        const dB = alongB - E - hLb - CROSS_STOP_GAP;
        const aYields = dA > dB + 1e-3 || (Math.abs(dA - dB) <= 1e-3 && a.keyNum > b.keyNum);
        if (!aYields) continue;
        const cap = a.sDes + dA;                          // absolute arc a may reach
        if (cap < noseCapRS[i]) noseCapRS[i] = cap;
      }
    }

    // (2) topological resolve: each follower's persistent rendered arc-length
    // eases (rate-capped) toward min(timetable, leader − MIN_GAP), floored at 0.
    const resolve = (i: number): void => {
      if (done[i]) return;
      if (onStack[i]) { done[i] = 1; return; } // cycle: leader already resolving upstack
      onStack[i] = 1;
      const a = vis[i];
      // target arc-length: the timetable position, capped one MIN_GAP behind the
      // leader's ALREADY-RESOLVED rendered position (measured from a's desired
      // pose, which is stable/lag-free), never before the route start.
      let target = a.sDes;
      const L = a.leaderIdx;
      if (L >= 0) {
        resolve(L);
        const gap = (rx[L] - a.desX) * a.fx + (rz[L] - a.desZ) * a.fz;
        if (gap < MIN_GAP) {
          const capped = a.sDes - (MIN_GAP - gap);
          if (capped < target) target = capped;
        }
      }
      // cross-traffic hold: never advance the nose into a blocking body (2 §1b)
      if (noseCapRS[i] < target) target = noseCapRS[i];
      if (target < 0) target = 0;
      // ease rs toward target with a per-frame speed cap → smooth accel/decel,
      // never a snap. Seed exactly on mesh-in so a fresh bus doesn't glide in.
      if (!a.init) {
        a.rs = target;
      } else {
        let step = (target - a.rs) * Math.min(1, dt * FOLLOW_K);
        const cap = V_MAX * dt;
        if (step > cap) step = cap; else if (step < -cap) step = -cap;
        a.rs += step;
      }
      this.pointAt(a.dir, a.rs, _pt);
      this.tangentAt(a.dir, a.rs, _tan);
      // Smoothed, flip-rejecting forward: a sharp/near-duplicate shape vertex can
      // momentarily REVERSE the raw tangent, flipping the curb offset to the far
      // side (a ~2·lat position jump). A real turn between frames is gradual
      // (dot>0); a cusp flip is ~180° (dot<0) — reject it, keeping the previous
      // forward, and otherwise ease toward the raw tangent. Curb offset + heading
      // both use this, so neither jumps.
      if (!a.init) { a.sfx = _tan.x; a.sfz = _tan.z; }
      else if (_tan.x * a.sfx + _tan.z * a.sfz > 0) {
        const tk = Math.min(1, dt * 10);
        a.sfx += (_tan.x - a.sfx) * tk; a.sfz += (_tan.z - a.sfz) * tk;
        const l = Math.hypot(a.sfx, a.sfz) || 1; a.sfx /= l; a.sfz /= l;
      }
      rx[i] = _pt.x - a.sfz * a.lat; rz[i] = _pt.z + a.sfx * a.lat;
      rfx[i] = a.sfx; rfz[i] = a.sfz;
      onStack[i] = 0; done[i] = 1;
    };
    for (let i = 0; i < n; i++) resolve(i);

    // (3) lateral safety net: symmetric minimum-translation split along the shared
    // street's perpendicular, iterated so 3-way clusters settle. Order by key so
    // it's deterministic. Only fires on a genuine footprint overlap.
    const order = vis.map((_, i) => i).sort((p, q) => vis[p].keyNum - vis[q].keyNum);
    const sepTx = new Float64Array(n), sepTz = new Float64Array(n);
    const hL = BUS.length / 2, hW = BUS.width / 2;
    for (let pass = 0; pass < SEP_PASSES; pass++) {
      for (let r = 0; r < n; r++) {
        const i = order[r];
        const fxi = rfx[i], fzi = rfz[i];
        for (let rj = r + 1; rj < n; rj++) {
          const j = order[rj];
          const fxj = rfx[j], fzj = rfz[j];
          const cosH = fxi * fxj + fzi * fzj;
          if (Math.abs(cosH) < SEP_STREET_COS) continue; // perpendicular crossing: out of scope
          const xi = rx[i] + sepTx[i], zi = rz[i] + sepTz[i];
          const xj = rx[j] + sepTx[j], zj = rz[j] + sepTz[j];
          const dx = xj - xi, dz = zj - zi;
          if (dx * dx + dz * dz >= SEP_TRIG * SEP_TRIG) continue;
          if (!busFootprintsHit(xi, zi, fxi, fzi, xj, zj, fxj, fzj)) continue;
          let sdx = cosH >= 0 ? fxi + fxj : fxi - fxj;
          let sdz = cosH >= 0 ? fzi + fzj : fzi - fzj;
          const sl = Math.hypot(sdx, sdz); if (sl < 1e-3) continue; sdx /= sl; sdz /= sl;
          const px = -sdz, pz = sdx;                 // lane-crossing axis
          const proj = dx * px + dz * pz;
          const ra = Math.abs(px * fxi + pz * fzi) * hL + Math.abs(px * -fzi + pz * fxi) * hW;
          const rb = Math.abs(px * fxj + pz * fzj) * hL + Math.abs(px * -fzj + pz * fxj) * hW;
          const overlap = ra + rb + SEP_MARGIN - Math.abs(proj);
          if (overlap <= 0) continue;
          const half = (overlap / 2) * (proj >= 0 ? 1 : -1);
          sepTx[j] += px * half; sepTz[j] += pz * half;   // push both apart
          sepTx[i] -= px * half; sepTz[i] -= pz * half;
        }
      }
      for (let i = 0; i < n; i++) {
        const m = Math.hypot(sepTx[i], sepTz[i]);
        if (m > SEP_MAX) { sepTx[i] *= SEP_MAX / m; sepTz[i] *= SEP_MAX / m; }
      }
    }
    // smooth the lateral offset BOTH ways with the same per-frame speed cap as
    // the longitudinal follow, so the backstop never snaps a bus sideways (the
    // old "apply in full when live" caused visible ~m jumps). Longitudinal
    // queuing already prevents same-lane overlap, so this fires rarely (crossing
    // turns / coincident-then-diverging curves); easing it in over a few frames
    // there is imperceptible and far smoother than a snap.
    // ease the lateral offset toward its target, bounded by LAT_CAP so the slide
    // is a smooth merge (a bus easing into the next lane), never a sideways snap.
    const kS = Math.min(1, dt * REL_RATE);
    const latCap = LAT_CAP * dt;
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      if (!a.init) { a.sepX = sepTx[i]; a.sepZ = sepTz[i]; }
      else {
        let ex = (sepTx[i] - a.sepX) * kS, ez = (sepTz[i] - a.sepZ) * kS;
        const m = Math.hypot(ex, ez);
        if (m > latCap) { ex *= latCap / m; ez *= latCap / m; }
        a.sepX += ex; a.sepZ += ez;
      }
      rx[i] += a.sepX; rz[i] += a.sepZ;
    }

    // finalize: every bus is visible (none are ever hidden); smooth ground height
    // + heading, place, and drive wheel speed from the RENDERED arc-length (0 when
    // stopped behind a leader). A finished run that has reached its terminal is
    // returned for removal so it drives off rather than blinking out mid-street.
    const yawK = Math.min(1, dt * 6), yK = Math.min(1, dt * 8);
    const finished: MeshedBus[] = [];
    for (let i = 0; i < n; i++) {
      const a = vis[i], g = a.model.group;
      g.visible = true;
      const gy = heightAt(rx[i], rz[i]);
      // rfx/rfz is the smoothed flip-rejecting forward, so both position and yaw
      // are already jump-free; just ease ground height + heading.
      const rawYaw = Math.atan2(-rfz[i], rfx[i]);
      if (!a.init) { a.y = gy; a.yaw = rawYaw; a.lastRS = a.rs; a.init = true; }
      else { a.y += (gy - a.y) * yK; a.yaw = angLerp(a.yaw, rawYaw, yawK); }
      g.position.set(rx[i], a.y, rz[i]);
      g.rotation.y = a.yaw;
      let ds = a.rs - a.lastRS; if (ds < 0) ds = 0;
      a.lastRS = a.rs;
      a.model.setSpeed(dt > 0 ? ds / dt : 0, dt);
      if (a.finishing && a.rs >= a.sDes - END_EPS) finished.push(a);
    }
    return finished;
  }

  private buildMeshed(dir: DirRT, k: number, key: string): MeshedBus {
    const route = this.routes[dir.routeIdx];
    const model = this.makeModel({ route: route.id, dest: dir.dest, color: route.color, sbs: route.sbs });
    this.scene.add(model.group);
    const mb: MeshedBus = {
      key, keyNum: dir.routeIdx * 1e6 + dir.dirIdx * 1e5 + k, dir, k, model,
      sfx: 1, sfz: 0, y: 0, yaw: 0, lastRS: 0,
      lastNextStop: undefined, lastStopReq: false, init: false,
      sDes: 0, lat: 0, desX: 0, desZ: 0, fx: 1, fz: 0, leaderIdx: -1,
      rs: 0, finishing: false, sepX: 0, sepZ: 0,
    };
    this.meshed.set(key, mb);
    return mb;
  }

  private removeMeshed(mb: MeshedBus) {
    this.scene.remove(mb.model.group);
    mb.model.dispose();
    this.meshed.delete(mb.key);
  }

  /** Every ~0.35 s: cull far/despawned meshes, add at most one near mesh. */
  private maintainBuses(px: number, pz: number) {
    // cull (never the ridden bus)
    for (const mb of Array.from(this.meshed.values())) {
      if (mb.key === this.riddenKey) continue;
      const tau = this.tau(mb.dir, mb.k);
      if (tau >= mb.dir.T) { this.removeMeshed(mb); continue; }
      this.pointAt(mb.dir, this.sAt(mb.dir, tau), _pt);
      const dx = _pt.x - px, dz = _pt.z - pz;
      if (dx * dx + dz * dz > BUS_CULL_R2) this.removeMeshed(mb);
    }
    // find the single nearest un-meshed active slot within mesh range
    let bestKey = '', bestDir: DirRT | null = null, bestK = 0, bestD2 = BUS_MESH_R2;
    for (const rt of this.routes) {
      for (const dir of rt.dirs) {
        for (let k = 0; k < dir.N; k++) {
          const tau = this.tau(dir, k);
          if (tau >= dir.T) continue;
          const key = `${dir.routeIdx}:${dir.dirIdx}:${k}`;
          if (this.meshed.has(key)) continue;
          this.pointAt(dir, this.sAt(dir, tau), _pt);
          const dx = _pt.x - px, dz = _pt.z - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; bestKey = key; bestDir = dir; bestK = k; }
        }
      }
    }
    if (bestDir) this.buildMeshed(bestDir, bestK, bestKey);
  }

  /** Every ~0.7 s: place stop kits within 300 m, remove beyond 340 m. */
  private streamStops(px: number, pz: number) {
    // removals first (frees the cap)
    for (const ps of Array.from(this.placedStops.values())) {
      const dx = ps.x - px, dz = ps.z - pz;
      if (dx * dx + dz * dz > STOP_REMOVE_R2) {
        this.scene.remove(ps.group);
        disposeGroup(ps.group);
        this.placedStops.delete(ps.id);
      }
    }
    // placements
    for (const st of this.allStops) {
      if (this.placedStops.size >= STOP_CAP) break;
      if (this.placedStops.has(st.id)) continue;
      const dx = st.x - px, dz = st.z - pz;
      if (dx * dx + dz * dz > STOP_PLACE_R2) continue;
      this.placeStop(st);
    }
  }

  private placeStop(st: { id: string; x: number; z: number; seed: number }) {
    // pull the raw GTFS point onto the sidewalk (off roadways/buildings). null =
    // tiles not loaded here yet → defer; the next scan tick retries this stop.
    let sx = st.x, sz = st.z;
    if (this.resolvePlacement) {
      const rp = this.resolvePlacement(st.x, st.z);
      if (rp === null) return;
      sx = rp[0]; sz = rp[1];
    }
    const info = this.data!.stops[st.id];
    // badges from the stop's serving route ids (skip routes dropped at bake time)
    const badges: BusRouteBadge[] = [];
    for (const rid of info.r) {
      const rt = this.routesById.get(rid);
      if (rt) badges.push({ id: rt.id, color: rt.color, sbs: rt.sbs });
    }
    // orient the kit so its open face (+z: bench, opening) looks AT the
    // roadway: local +z maps to world (sin yaw, cos yaw), aimed at the point
    // on the serving route's shape where the bus actually pulls in. Deriving
    // the facing from the resolved kit position (rather than assuming the kit
    // sits right-of-travel) keeps it correct no matter which side the sidewalk
    // ejection landed on.
    let yaw = hash01(st.seed * 31 + 7) * Math.PI * 2;
    const serving = this.stopIndex.get(st.id);
    if (serving && serving.length) {
      const s0 = serving[0];
      const dir = this.routes[s0.r].dirs.find((d) => d.dirIdx === s0.d);
      if (dir) {
        this.pointAt(dir, dir.stopS[s0.si], _pt);
        const toStreetX = _pt.x - sx, toStreetZ = _pt.z - sz;
        if (Math.hypot(toStreetX, toStreetZ) > 0.5) {
          yaw = Math.atan2(toStreetX, toStreetZ);
        } else {
          // kit landed on the shape itself — fall back to the travel tangent
          this.tangentAt(dir, dir.stopS[s0.si], _tan);
          yaw = Math.atan2(-_tan.z, _tan.x) + Math.PI;
        }
      }
    }
    const shelter = badges.length >= 2 && hash01(st.seed * 13 + 2) < 0.45;
    const group = this.makeStop(badges, st.seed, shelter);
    group.position.set(sx, heightAt(sx, sz), sz);
    group.rotation.y = yaw;
    this.scene.add(group);
    this.placedStops.set(st.id, { id: st.id, group, x: sx, z: sz });
  }

  // ---- boarding / riding ----

  /** A meshed, dwelling, doors-open bus whose front door is within 6 m. */
  boardable(px: number, pz: number): { key: string; route: string; dest: string; color: string; sbs: boolean; door: [number, number] } | null {
    let best: MeshedBus | null = null;
    let bestDoor: [number, number] = [0, 0];
    let bestD2 = 6 * 6;
    for (const mb of this.meshed.values()) {
      const tau = this.tau(mb.dir, mb.k);
      if (tau >= mb.dir.T) continue;
      this.state(mb.dir, tau, _st);
      if (_st.state === 'moving' || _st.doorT <= DOOR_OPEN) continue;
      const door = this.localXZToWorld(mb, BUS.doorX.front, BUS.width / 2);
      const dx = door[0] - px, dz = door[1] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = mb; bestDoor = door; }
    }
    if (!best) return null;
    const rt = this.routes[best.dir.routeIdx];
    return { key: best.key, route: rt.id, dest: best.dir.dest, color: rt.color, sbs: rt.sbs, door: bestDoor };
  }

  board(key: string): BusRideHandle | null {
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    const routeIdx = +parts[0], dirIdx = +parts[1], k = +parts[2];
    const rt = this.routes[routeIdx];
    const dir = rt?.dirs.find((d) => d.dirIdx === dirIdx);
    if (!dir) return null;
    if (this.tau(dir, k) >= dir.T) return null; // run already despawned
    let mb = this.meshed.get(key);
    if (!mb) mb = this.buildMeshed(dir, k, key);
    this.riddenKey = key;
    // end() unpins so the bus resumes normal culling (it stays in service)
    const ride: BusRide = new BusRide(() => {
      if (this.ride === ride) { this.riddenKey = null; this.ride = null; }
    }, mb, dir, rt);
    this.ride = ride;
    this.stepOneMeshed(mb); // ensure a valid pose before the handle is read
    this.refreshRide();
    return ride;
  }

  /** Position a single meshed bus immediately (used at board time). Uses the raw
   *  timetable pose — car-following refines it on the next stepMeshed. */
  private stepOneMeshed(mb: MeshedBus) {
    const dir = mb.dir;
    const tau = this.tau(dir, mb.k);
    if (tau >= dir.T) return;
    mb.model.group.visible = true;
    this.state(dir, tau, _st);
    this.pointAt(dir, _st.s, _pt);
    this.tangentAt(dir, _st.s, _tan);
    const wx = _pt.x - _tan.z * _st.lat;
    const wz = _pt.z + _tan.x * _st.lat;
    const rawYaw = Math.atan2(-_tan.z, _tan.x);
    if (!mb.init) { mb.y = heightAt(wx, wz); mb.yaw = rawYaw; mb.lastRS = _st.s; mb.init = true; }
    mb.model.group.position.set(wx, mb.y, wz);
    mb.model.group.rotation.y = mb.yaw;
  }

  private refreshRide() {
    const ride = this.ride!;
    const dir = ride.dir;
    const tau = this.tau(dir, ride.mb.k);
    ride.active = tau < dir.T;
    if (!ride.active) return; // World reads active=false and bails
    this.state(dir, tau, _st);
    ride.canExit = _st.state !== 'moving' && _st.doorT > DOOR_OPEN;
    ride.atEnd = _st.atEnd;
    ride.pos.x = ride.mb.model.group.position.x;
    ride.pos.z = ride.mb.model.group.position.z;
    ride.pos.yaw = ride.mb.yaw;
    const h = ride.hud;
    h.state = _st.state;
    h.thisStop = dir.stopNames[_st.stopIdx] ?? '';
    h.nextStop = _st.stopIdx + 1 < dir.nStops ? dir.stopNames[_st.stopIdx + 1] : null;
    h.atEnd = _st.atEnd;
  }

  // ---- queries ----

  nearestStop(px: number, pz: number, r: number): { id: string; name: string; badges: BusRouteBadge[]; arrivals: BusArrival[]; d: number; p: [number, number] } | null {
    let best: { id: string; x: number; z: number } | null = null;
    let bestD2 = r * r;
    for (const st of this.allStops) {
      const dx = st.x - px, dz = st.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = st; }
    }
    if (!best) return null;
    const info = this.data!.stops[best.id];
    const badges: BusRouteBadge[] = [];
    for (const rid of info.r) {
      const rt = this.routesById.get(rid);
      if (rt) badges.push({ id: rt.id, color: rt.color, sbs: rt.sbs });
    }
    const arrivals: BusArrival[] = [];
    const serving = this.stopIndex.get(best.id);
    if (serving) {
      for (const s of serving) {
        const rt = this.routes[s.r];
        const dir = rt.dirs.find((d) => d.dirIdx === s.d);
        if (!dir) continue;
        const ds = dir.dwellStart[s.si];
        const base = this.worldTime + dir.routePhase;
        let bestT = Infinity;
        for (let k = 0; k < dir.N; k++) {
          const a = posmod(ds - (base - k * dir.H), dir.C);
          if (a < bestT) bestT = a;
        }
        arrivals.push({ route: rt.id, color: rt.color, dest: dir.dest, seconds: bestT });
      }
    }
    arrivals.sort((a, b) => a.seconds - b.seconds);
    return {
      id: best.id, name: info.n, badges,
      arrivals: arrivals.slice(0, 4),
      d: Math.sqrt(bestD2), p: [best.x, best.z],
    };
  }

  /** Every stop position (minimap static layer). */
  stopPositions(): [number, number][] {
    return this._stopPositions;
  }

  /** Every ACTIVE bus network-wide (minimap live layer; ~4 Hz, brute force). */
  busPositions(): { x: number; z: number; color: string }[] {
    const out: { x: number; z: number; color: string }[] = [];
    for (const rt of this.routes) {
      for (const dir of rt.dirs) {
        for (let k = 0; k < dir.N; k++) {
          const tau = this.tau(dir, k);
          if (tau >= dir.T) continue;
          this.pointAt(dir, this.sAt(dir, tau), _pt);
          out.push({ x: _pt.x, z: _pt.z, color: rt.color });
        }
      }
    }
    return out;
  }

  dispose() {
    for (const mb of this.meshed.values()) {
      this.scene.remove(mb.model.group);
      mb.model.dispose();
    }
    this.meshed.clear();
    for (const ps of this.placedStops.values()) {
      this.scene.remove(ps.group);
      disposeGroup(ps.group);
    }
    this.placedStops.clear();
    this.riddenKey = null;
    this.ride = null;
  }
}
