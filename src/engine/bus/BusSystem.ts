import * as THREE from 'three';
import { dataUrl } from '../dataver';
import { disposeGroup } from '../EntranceManager';
import { heightAt } from '../terrain';
import { hash01 } from '../palette';
import { quality } from '../quality';
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
import {
  findTrafficLateralEscape,
  findStalledTrafficEscape,
  trafficFootprintsOverlap,
  trafficForwardClearance,
  trafficLateralEscape,
  trafficMotionConflicts,
  trafficMotionClearsObstacles,
  trafficPairMotionsConflict,
  trafficPairKey,
  type TrafficFootprint,
  type TrafficMotion,
} from '../population/trafficSafety';
import {
  BUS_DEADLOCK_ESCAPE_AFTER,
  BUS_DEADLOCK_RETIRE_AFTER,
  breakBusLeaderCycles,
  busDeadlockEscapeReady,
  busMeshCap,
  busRecoveryWins,
  busScheduleDensity,
  busYieldsAtConflict,
} from './flow';

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
const DWELL_POSITION_EPS = 2.0; // timetable dwell is real only at its physical stop
const DWELL_LATERAL_EPS = 0.65; // doors stay closed while passing/berthing off lane
const PHYSICAL_STOP_ARRIVAL_EPS = 0.35;
const WORLD_TIME_START = 7200;

// ---- streaming / culling constants ----
const STOP_PLACE_R2 = 300 * 300;
const STOP_REMOVE_R2 = 340 * 340;
const STOP_CAP = 120;
const BUS_MESH_R2 = 250 * 250;
const BUS_CULL_R2 = 285 * 285;
const STOP_DETAIL_R2 = 86 * 86;
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
const DEADLOCK_LAT_SPEED = 3.2; // deliberate low-speed lane change around a stopped chain
const DEADLOCK_LAT_MAX = 4.4;   // at most one adjacent lane from the authored route
// cross-traffic yield (intersections): a bus never drives its nose into another
// bus's body regardless of heading; the one closer to the conflict proceeds, the
// other holds back like waiting at the light.
const CROSS_LOOK = 16;     // look this far ahead (m) for a body blocking the lane
const CROSS_STOP_GAP = 1.6;// hold this much daylight short of the blocking body (m)
// lateral safety net
const SEP_TRIG = 13.5;     // consider a pair only within this center distance (m)
const SEP_STREET_COS = 0.6;// only same-street pairs (|cos|>this); perpendicular crossings are out of scope
const SEP_MARGIN = 1.0;    // daylight beyond footprint contact (m) — the net now
                           // carries all terminal/shared-stop berthing (the old
                           // backward-yield that used to open those gaps is gone),
                           // so a fuller meter keeps co-dwelling buses clearly apart
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
  parkS: Float64Array;
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
  flipRS: number;   // rendered arc-length when the forward last tracked the tangent
  y: number;        // smoothed ground height
  yaw: number;      // smoothed heading
  lastRS: number;   // last RENDERED arc-length (measured speed → wheels stop when held)
  lastNextStop: string | null | undefined; // undefined = never pushed
  lastStopReq: boolean;
  init: boolean;
  // ---- car-following scratch, recomputed each frame (see stepMeshed) ----
  sDes: number;     // desired arc-length from the timetable
  lat: number;      // curb offset this frame (m, right-of-travel)
  committedLat: number; // last transaction-accepted route-frame curb offset
  desX: number;     // desired on-lane world x (centerline + curb)
  desZ: number;     // desired on-lane world z
  fx: number;       // travel forward x (unit tangent)
  fz: number;       // travel forward z
  leaderIdx: number; // nearest same-lane bus ahead (index in the per-frame array; -1 none)
  // ---- persistent smoothed anti-overlap state ----
  rs: number;       // RENDERED arc-length (eased toward the capped target; never jumps)
  finishing: boolean; // run's schedule is over; drive to the terminal, then despawn
  runDeadline: number; // absolute generation end; cannot rebase on timetable wrap
  nextPhysicalStopIdx: number; // first unserved stop ahead of committed rs
  physicalDwellRemaining: number; // -1 not started, 0 served, >0 open-stop seconds
  physicalLat: number; // smoothed carried-stop curb offset, NaN when inactive
  sepX: number;     // smoothed lateral safety offset (world m)
  sepZ: number;
  renderSpeed: number; // actual committed body speed, not timetable intent
  blockedFor: number;  // seconds rejected by the collision transaction
  escapeSide: number;  // remembered local lateral sign while working out of a jam
  escapeBlockerKey: string | null; // body being passed; release only after tail clearance
  serviceDwell: boolean; // ordinary scheduled stop, never treated as a deadlock
  serviceDoorT: number; // actual committed door command, not timetable intent
  serviceStopIdx: number; // physical stop currently being served, or -1
  // Pre-stage service snapshot. PASS 1 proposes curb/dwell/door state before
  // the collision transaction accepts the matching body motion; rejected or
  // unadmitted proposals restore these allocation-free scratch values.
  beforePhysicalLat: number;
  beforePhysicalDwellRemaining: number;
  beforeNextPhysicalStopIdx: number;
  beforeServiceDwell: boolean;
  beforeServiceDoorT: number;
  beforeServiceStopIdx: number;
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
  private unpin: () => void;
  public mb: MeshedBus;
  public dir: DirRT;
  constructor(
    unpin: () => void,
    mb: MeshedBus,
    dir: DirRT,
    route: RouteRT,
  ) {
    this.unpin = unpin;
    this.mb = mb;
    this.dir = dir;
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
  private readonly meshCap = busMeshCap(quality().level);
  /**
   * Which side of each other a meshed PAIR berthed to, keyed by their two
   * keyNums. See the tie-break in separateMeshed: derived fresh from the current
   * offset it is a feedback loop, so it is decided once and kept.
   */
  private sepSide = new Map<string, number>();
  /** One persistent token prevents incompatible lane changes in one streamed area. */
  private recoveryOwnerKey: string | null = null;
  /** A retired gridlock loser stays out for one cycle instead of popping back in. */
  private suppressedUntil = new Map<string, number>();
  private externalTrafficObstacles: readonly TrafficFootprint[] = [];
  private readonly committedTrafficMotions: TrafficMotion[] = [];
  private placedStops = new Map<string, PlacedStop>();
  private stopTemplates = new Map<string, THREE.Group>();
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
    const schedule = busScheduleDensity(
      T,
      routeIdx,
      dirIdx,
      sbs,
    );
    const H = schedule.headway;
    const N = schedule.slots;
    const C = schedule.cycle;
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
      stopIds, stopNames, stopS, parkS, dwellStart, curbPull, nStops,
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
  update(
    px: number,
    pz: number,
    dt: number,
    externalTrafficObstacles: readonly TrafficFootprint[] = [],
  ) {
    if (!this.data) return;
    this.externalTrafficObstacles = externalTrafficObstacles;
    this.worldTime += dt;

    this.stopTimer -= dt;
    if (this.stopTimer <= 0) { this.stopTimer = STOP_TICK; this.streamStops(px, pz); }

    this.busTimer -= dt;
    if (this.busTimer <= 0) { this.busTimer = BUS_TICK; this.maintainBuses(px, pz); }

    // per-frame: transform every meshed bus (newly built ones included)
    this.stepMeshed(px, pz, dt);
    if (this.ride) this.refreshRide();
  }

  private stepMeshed(px: number, pz: number, dt: number) {
    this.committedTrafficMotions.length = 0;
    // PASS 1 — timetable: each in-service meshed bus's DESIRED on-lane pose, plus
    // its purely-scheduled outputs (doors, next-stop sign). The anti-overlap pass
    // then decides where it actually renders.
    const staged: MeshedBus[] = [];
    for (const mb of this.meshed.values()) {
      mb.beforePhysicalLat = mb.physicalLat;
      mb.beforePhysicalDwellRemaining = mb.physicalDwellRemaining;
      mb.beforeNextPhysicalStopIdx = mb.nextPhysicalStopIdx;
      mb.beforeServiceDwell = mb.serviceDwell;
      mb.beforeServiceDoorT = mb.serviceDoorT;
      mb.beforeServiceStopIdx = mb.serviceStopIdx;
      const dir = mb.dir;
      const tau = this.tau(dir, mb.k);
      // When the schedule says the run is over, DON'T vanish in place — keep the
      // bus visible and drive it to its terminal (target = the route's final s);
      // finalize removes it once it renders there. The ridden bus is pinned
      // (World ends the ride via ride.active=false), so leave its schedule alone.
      const finishing = mb.finishing || this.worldTime >= mb.runDeadline;
      mb.finishing = finishing;
      let s: number;
      let scheduledDoorT = 0;
      let scheduledDwell = false;
      if (finishing) {
        s = dir.segSEnd[dir.nSeg - 1]; // the terminal
        mb.lat = BASE_LAT;
      } else {
        this.state(dir, tau >= dir.T ? dir.T - 1e-3 : tau, _st);
        s = _st.s;
        mb.lat = _st.lat;
        scheduledDwell = _st.state !== 'moving';
        scheduledDoorT = _st.doorT;
      }

      // Timetable intent can move past a stop while collision-safe committed
      // motion is delayed. Cap at the first unserved physical stop and carry a
      // real dwell there; an on-time dwell overlaps the timetable dwell, while
      // a late bus still opens at the stop instead of skipping it.
      const timetableLat = mb.lat;
      let carriedDwell = false;
      const finalStopIdx = dir.nStops - 1;
      if (
        finishing
        && mb.key === this.riddenKey
        && mb.nextPhysicalStopIdx >= dir.nStops
        && mb.init
        && Math.abs(mb.rs - dir.parkS[finalStopIdx]) <= DWELL_POSITION_EPS
      ) {
        // Boarding late in the scheduled terminal dwell initially marks that
        // stop served. If its timetable expires before the rider steps off,
        // reopen a physical terminal dwell instead of stranding them behind
        // closed doors in a pinned, already-finished generation.
        mb.nextPhysicalStopIdx = finalStopIdx;
        mb.physicalDwellRemaining = Number.POSITIVE_INFINITY;
      }
      while (
        mb.nextPhysicalStopIdx < dir.nStops
        && mb.physicalDwellRemaining === 0
      ) {
        mb.physicalDwellRemaining = -1;
        mb.nextPhysicalStopIdx++;
      }
      let targetedStopIdx = -1;
      if (mb.nextPhysicalStopIdx < dir.nStops) {
        const stopIdx = mb.nextPhysicalStopIdx;
        const parkS = dir.parkS[stopIdx];
        if (
          mb.physicalDwellRemaining > 0
          || s >= parkS - PHYSICAL_STOP_ARRIVAL_EPS
        ) {
          targetedStopIdx = stopIdx;
          s = Math.min(s, parkS);
        }
      }
      if (targetedStopIdx >= 0) {
        if (!Number.isFinite(mb.physicalLat)) {
          // Begin the carried pull-in at the body that is actually on screen.
          // Timetable expiry changes `lat` intent to BASE_LAT immediately; using
          // that proposal as the seed would jump a terminal bus several metres
          // sideways before the physical-lat smoothing even began.
          mb.physicalLat = mb.init ? mb.committedLat : mb.lat;
        }
        const targetLat = dir.curbPull[targetedStopIdx];
        const latStep = Math.min(
          Math.abs(targetLat - mb.physicalLat),
          DEADLOCK_LAT_SPEED * dt,
        );
        mb.physicalLat += Math.sign(targetLat - mb.physicalLat) * latStep;
        mb.lat = mb.physicalLat;
      } else if (Number.isFinite(mb.physicalLat)) {
        const latStep = Math.min(
          Math.abs(timetableLat - mb.physicalLat),
          DEADLOCK_LAT_SPEED * dt,
        );
        mb.physicalLat += Math.sign(timetableLat - mb.physicalLat) * latStep;
        mb.lat = mb.physicalLat;
        if (Math.abs(timetableLat - mb.physicalLat) < 1e-3) {
          mb.physicalLat = Number.NaN;
        }
      }
      const lateralAligned =
        Math.hypot(mb.sepX, mb.sepZ) <= DWELL_LATERAL_EPS
        && (
          targetedStopIdx < 0
          || Math.abs(mb.lat - dir.curbPull[targetedStopIdx])
            <= DWELL_LATERAL_EPS
        );
      if (targetedStopIdx >= 0) {
        const parkS = dir.parkS[targetedStopIdx];
        const atBerth = mb.init
          && mb.rs >= parkS - PHYSICAL_STOP_ARRIVAL_EPS
          && Math.abs(mb.rs - parkS) <= DWELL_POSITION_EPS;
        if (
          mb.physicalDwellRemaining < 0
          && atBerth
          && lateralAligned
        ) {
          mb.physicalDwellRemaining = (
            finishing
            && mb.key === this.riddenKey
            && targetedStopIdx === dir.nStops - 1
          )
            ? Number.POSITIVE_INFINITY
            : (
              targetedStopIdx === dir.nStops - 1
                ? LAST_DWELL
                : DWELL
            );
        }
        if (
          mb.physicalDwellRemaining > 0
          && atBerth
          && lateralAligned
        ) {
          carriedDwell = true;
          mb.physicalDwellRemaining = Math.max(
            0,
            mb.physicalDwellRemaining - dt,
          );
        }
      }
      const scheduledStopMatchesPhysicalTarget = targetedStopIdx < 0
        || targetedStopIdx === _st.stopIdx;
      const scheduledPhysicalDwell = scheduledDwell
        && scheduledStopMatchesPhysicalTarget
        && (
          !mb.init
          || Math.abs(mb.rs - dir.parkS[_st.stopIdx])
            <= DWELL_POSITION_EPS
        );
      const carriedPhysicalDwell = carriedDwell && mb.init;
      mb.serviceDwell = lateralAligned
        && (scheduledPhysicalDwell || carriedPhysicalDwell);
      mb.serviceDoorT = mb.serviceDwell
        ? (
          carriedPhysicalDwell
            ? (scheduledPhysicalDwell ? scheduledDoorT : 1)
            : scheduledDoorT
        )
        : 0;
      mb.serviceStopIdx = mb.serviceDwell
        ? (
          carriedPhysicalDwell
            ? mb.nextPhysicalStopIdx
            : _st.stopIdx
        )
        : -1;
      const physicalDisplayStopIdx = mb.serviceStopIdx >= 0
        ? mb.serviceStopIdx
        : (
          mb.nextPhysicalStopIdx < dir.nStops
            ? mb.nextPhysicalStopIdx
            : -1
        );
      const nx = physicalDisplayStopIdx >= 0
        ? (dir.stopNames[physicalDisplayStopIdx] ?? null)
        : null;
      if (nx !== mb.lastNextStop) {
        mb.model.setNextStop(nx);
        mb.lastNextStop = nx;
      }
      const physicalStopReq = (
        !mb.serviceDwell
        && physicalDisplayStopIdx >= 0
        && dir.parkS[physicalDisplayStopIdx] - mb.rs <= 30
      );
      if (physicalStopReq !== mb.lastStopReq) {
        mb.model.setStopRequested(physicalStopReq);
        mb.lastStopReq = physicalStopReq;
      }
      mb.model.setDoors(mb.serviceDoorT);
      this.pointAt(dir, s, _pt);
      this.tangentAt(dir, s, _tan);
      const rnx = -_tan.z, rnz = _tan.x; // unit right-of-travel normal
      mb.sDes = s;
      mb.desX = _pt.x + rnx * mb.lat;    // desired on-lane world position
      mb.desZ = _pt.z + rnz * mb.lat;
      mb.fx = _tan.x; mb.fz = _tan.z;    // travel forward = shape tangent
      staged.push(mb);
    }

    // A just-streamed mesh has no committed safe pose to roll back to. Admit it
    // only when its first body is clear of StreetLife and every already-visible
    // bus; deferred meshes remain hidden and retry on the next frame without
    // influencing leader or separation passes.
    const vis: MeshedBus[] = [];
    const admittedNew: TrafficFootprint[] = [];
    const hL = BUS.length / 2;
    const hW = BUS.width / 2;
    for (const mb of staged) {
      if (mb.init) {
        vis.push(mb);
        continue;
      }
      const candidate: TrafficFootprint = {
        key: `bus:${mb.key}`,
        x: mb.desX,
        z: mb.desZ,
        fx: mb.fx,
        fz: mb.fz,
        halfLength: hL,
        halfWidth: hW,
        speed: 0,
        priority: true,
      };
      let occupied = this.externalTrafficObstacles.some((obstacle) => (
        trafficFootprintsOverlap(candidate, obstacle, 0.08)
      ));
      if (!occupied) {
        occupied = staged.some((other) => {
          if (!other.init) return false;
          const yaw = other.yaw;
          return trafficFootprintsOverlap(candidate, {
            key: `bus:${other.key}`,
            x: other.model.group.position.x,
            z: other.model.group.position.z,
            fx: Math.cos(yaw),
            fz: -Math.sin(yaw),
            halfLength: hL,
            halfWidth: hW,
            speed: other.renderSpeed,
            priority: true,
          }, 0.08);
        });
      }
      if (!occupied) {
        occupied = admittedNew.some((other) => (
          trafficFootprintsOverlap(candidate, other, 0.08)
        ));
      }
      if (occupied) {
        mb.model.group.visible = false;
        this.restoreStagedService(mb);
        mb.renderSpeed = 0;
        mb.model.setSpeed(0, dt);
        continue;
      }
      admittedNew.push(candidate);
      vis.push(mb);
    }
    const finished = this.clampSeparate(vis, dt, px, pz);
    for (const mb of finished) this.removeMeshed(mb);
  }

  private restoreStagedService(mb: MeshedBus): void {
    mb.physicalLat = mb.beforePhysicalLat;
    mb.physicalDwellRemaining = mb.beforePhysicalDwellRemaining;
    mb.nextPhysicalStopIdx = mb.beforeNextPhysicalStopIdx;
    mb.serviceDwell = mb.beforeServiceDwell;
    mb.serviceDoorT = mb.beforeServiceDoorT;
    mb.serviceStopIdx = mb.beforeServiceStopIdx;
    mb.model.setDoors(mb.serviceDoorT);
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
  private clampSeparate(vis: MeshedBus[], dt: number, px: number, pz: number): MeshedBus[] {
    const n = vis.length;
    if (n === 0) return [];
    const rx = new Float64Array(n), rz = new Float64Array(n);   // rendered pose
    const rfx = new Float64Array(n), rfz = new Float64Array(n);
    const done = new Uint8Array(n), onStack = new Uint8Array(n);
    // Full committed snapshots. A failed proposal must restore every persistent
    // motion filter, not only position/arc-length, or the rejected tangent and
    // separation impulses leak into the next frame as a visible jump.
    const priorInit = new Uint8Array(n);
    const priorX = new Float64Array(n), priorZ = new Float64Array(n);
    const priorY = new Float64Array(n), priorYaw = new Float64Array(n);
    const priorRS = new Float64Array(n), priorLastRS = new Float64Array(n);
    const priorSfx = new Float64Array(n), priorSfz = new Float64Array(n);
    const priorFlipRS = new Float64Array(n);
    const priorSepX = new Float64Array(n), priorSepZ = new Float64Array(n);
    const priorRenderSpeed = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      priorInit[i] = a.init ? 1 : 0;
      priorX[i] = a.model.group.position.x;
      priorZ[i] = a.model.group.position.z;
      priorY[i] = a.y;
      priorYaw[i] = a.yaw;
      priorRS[i] = a.rs;
      priorLastRS[i] = a.lastRS;
      priorSfx[i] = a.sfx;
      priorSfz[i] = a.sfz;
      priorFlipRS[i] = a.flipRS;
      priorSepX[i] = a.sepX;
      priorSepZ[i] = a.sepZ;
      priorRenderSpeed[i] = a.renderSpeed;
    }

    // (1) nearest same-lane leader AHEAD, on committed positions. Timetable
    // intent may be hundreds of metres ahead during congestion; using it here
    // makes a physically adjacent bus disappear from LOOKAHEAD and leaves the
    // exact collision transaction to freeze both actors indefinitely.
    // A bus only ever holds behind something in FRONT of it — the follower waits,
    // a leader is never moved by what trails it, and no bus is ever driven
    // backward. (A prior "terminal hand-off" let the more-advanced bus YIELD to
    // one BEHIND it — literally reversing a finishing/ridden bus off a shared
    // terminal. That reverse is the leapfrog/shove the rider reported, so it's
    // gone. The finishing-on-originating stack is now resolved with zero backward
    // motion: the stationary originating bus is the natural follower and simply
    // holds its ground, and the lateral safety net (3) berths the pair apart.)
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      const fx = priorInit[i] ? a.sfx : a.fx;
      const fz = priorInit[i] ? a.sfz : a.fz;
      const xi = priorInit[i] ? priorX[i] : a.desX;
      const zi = priorInit[i] ? priorZ[i] : a.desZ;
      const ki = a.keyNum;
      let bestAhead = -1, bestAlong = Infinity, bestColoc = -1, bestColocKey = -Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = vis[j];
        const bx = priorInit[j] ? priorX[j] : b.desX;
        const bz = priorInit[j] ? priorZ[j] : b.desZ;
        const bfx = priorInit[j] ? b.sfx : b.fx;
        const bfz = priorInit[j] ? b.sfz : b.fz;
        const ddx = bx - xi, ddz = bz - zi;
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
        const latJ = ddx * bfz - ddz * bfx;
        const laneTol = LANE_HALF + LANE_FAN * Math.min(Math.max(0, along), 30);
        if (Math.min(Math.abs(lat), Math.abs(latJ)) >= laneTol) continue;
        const cosH = fx * bfx + fz * bfz;
        if (cosH <= SAME_DIR_COS) continue; // only queue behind same travel heading
        if (along > CO_EPS) { if (along < bestAlong) { bestAlong = along; bestAhead = j; } }
        else if (along > -CO_EPS && b.keyNum < ki) { if (b.keyNum > bestColocKey) { bestColocKey = b.keyNum; bestColoc = j; } }
      }
      // an exactly-co-located lower-key bus (two bunched on the same shape) leads
      // so the pair queues nose-to-tail; otherwise the nearest bus ahead. Both are
      // ahead-or-here, never behind — a follower can only be held, not shoved back.
      a.leaderIdx = bestColoc >= 0 ? bestColoc : bestAhead;
    }
    const leaders = Int32Array.from(vis.map((bus) => bus.leaderIdx));
    breakBusLeaderCycles(leaders, vis.map((bus) => bus.keyNum));
    for (let i = 0; i < n; i++) vis[i].leaderIdx = leaders[i];

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
    const routeHeld = new Uint8Array(n);
    noseCapRS.fill(Infinity);
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      const afx = priorInit[i] ? a.sfx : a.fx;
      const afz = priorInit[i] ? a.sfz : a.fz;
      const ax = priorInit[i] ? priorX[i] : a.desX;
      const az = priorInit[i] ? priorZ[i] : a.desZ;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = vis[j];
        const bx = priorInit[j] ? priorX[j] : b.desX;
        const bz = priorInit[j] ? priorZ[j] : b.desZ;
        const bfx = priorInit[j] ? b.sfx : b.fx;
        const bfz = priorInit[j] ? b.sfz : b.fz;
        const ddx = bx - ax, ddz = bz - az;
        const along = ddx * afx + ddz * afz;             // b's centre ahead of a
        if (along <= 0 || along > CROSS_LOOK) continue;   // only near hazards ahead
        const lat = ddx * -afz + ddz * afx;
        // b's half-extent projected on a's forward (E) and a's lateral (latExt)
        const c1 = Math.abs(afx * bfx + afz * bfz);       // |cos| between forwards
        const c2 = Math.abs(afx * -bfz + afz * bfx);      // |sin|
        const E = c1 * hLb + c2 * hWb;
        const latExt = c2 * hLb + c1 * hWb;
        if (Math.abs(lat) >= hWb + latExt) continue;      // b not across a's lane
        const dA = along - E - hLb - CROSS_STOP_GAP;      // a's room before contact
        // A total order is required here. Pairwise "closer to the conflict"
        // comparisons can form A→B→C→A at a busy junction and stop everybody.
        // Let a bus already clearing the box continue; stable key order resolves
        // a fully stopped tie and therefore always leaves one winner.
        const aYields = busYieldsAtConflict(a, b);
        if (!aYields) continue;
        const cap = priorInit[i] ? a.rs + dA : a.sDes + dA;
        if (cap < noseCapRS[i]) noseCapRS[i] = cap;
        if (
          b.renderSpeed <= 0.15
          && !b.serviceDwell
          && cap <= a.rs + 0.05
        ) {
          routeHeld[i] = 1;
        }
      }
    }

    // (1c) prior committed StreetLife snapshot. Pedestrians are priority bodies
    // with a generous stopping gap; moving cars get a shorter hard guard because
    // their current-frame resolver yields to a moving bus. This two-phase handoff
    // prevents either system from committing into the other's last safe body.
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      const initialized = a.init;
      const x = initialized ? a.model.group.position.x : a.desX;
      const z = initialized ? a.model.group.position.z : a.desZ;
      const fx = initialized ? a.sfx : a.fx;
      const fz = initialized ? a.sfz : a.fz;
      const mover: TrafficFootprint = {
        key: `bus:${a.key}`,
        x,
        z,
        fx,
        fz,
        halfLength: hLb,
        halfWidth: hWb,
        speed: a.renderSpeed,
        priority: a.renderSpeed > 0.15,
      };
      for (const obstacle of this.externalTrafficObstacles) {
        const centerAlong = (obstacle.x - x) * fx + (obstacle.z - z) * fz;
        const lookahead = obstacle.priority ? 24 : 6;
        if (centerAlong <= 0 || centerAlong > lookahead + hLb) continue;
        const clearance = trafficForwardClearance(
          mover,
          obstacle,
          obstacle.immovable ? 0.08 : 0.25,
        );
        if (clearance === null || clearance > lookahead) continue;
        const stopGap = obstacle.priority ? 1.2 : 0.35;
        const allowed = Math.max(0, clearance - stopGap);
        const cap = initialized ? a.rs + allowed : a.sDes + Math.min(0, clearance - stopGap);
        if (cap < noseCapRS[i]) noseCapRS[i] = cap;
        if (
          initialized
          && obstacle.speed <= 0.15
          && !obstacle.key.startsWith('ped:')
          && cap <= a.rs + 0.05
        ) {
          routeHeld[i] = 1;
        }
      }
    }

    // Pairwise recovery ownership is not enough at a compact junction: several
    // independently legal lane changes can occupy every escape corridor. Keep
    // one persistent token across the streamed bus set so all other buses hold
    // exact committed poses while the elected actor completes or times out.
    let recoveryOwner = this.recoveryOwnerKey
      ? vis.find((bus) => bus.key === this.recoveryOwnerKey)
      : undefined;
    if (
      recoveryOwner
      && recoveryOwner.escapeSide === 0
      && !busDeadlockEscapeReady(recoveryOwner.blockedFor)
    ) {
      this.recoveryOwnerKey = null;
      recoveryOwner = undefined;
    }
    if (!recoveryOwner) {
      const ready = vis.filter((bus) => (
        !bus.serviceDwell
        && busDeadlockEscapeReady(bus.blockedFor)
      ));
      ready.sort((a, b) => (
        Number(b.key === this.riddenKey) - Number(a.key === this.riddenKey)
        || a.keyNum - b.keyNum
      ));
      recoveryOwner = ready[0];
      this.recoveryOwnerKey = recoveryOwner?.key ?? null;
    }

    // (2) topological resolve: each follower's persistent rendered arc-length
    // eases (rate-capped) toward min(timetable, leader − MIN_GAP), floored at 0.
    const resolve = (i: number): void => {
      if (done[i]) return;
      if (onStack[i]) { done[i] = 1; return; } // cycle: leader already resolving upstack
      onStack[i] = 1;
      const a = vis[i];
      // Target arc-length: timetable intent capped by how much physical road is
      // actually open ahead of the committed body. Desired-position math is
      // invalid once a queue has delayed a bus away from its schedule.
      let target = a.sDes;
      const L = a.leaderIdx;
      if (L >= 0) {
        resolve(L);
        const ax = priorInit[i] ? priorX[i] : a.desX;
        const az = priorInit[i] ? priorZ[i] : a.desZ;
        const afx = priorInit[i] ? a.sfx : a.fx;
        const afz = priorInit[i] ? a.sfz : a.fz;
        const gap = (rx[L] - ax) * afx + (rz[L] - az) * afz;
        const capped = (priorInit[i] ? a.rs : a.sDes)
          + Math.max(0, gap - MIN_GAP);
        if (capped < target) target = capped;
        if (
          vis[L].renderSpeed <= 0.15
          && !vis[L].serviceDwell
          && target <= a.rs + 0.05
        ) {
          routeHeld[i] = 1;
        }
      }
      // cross-traffic hold: never advance the nose into a blocking body (2 §1b)
      if (noseCapRS[i] < target) target = noseCapRS[i];
      if (target < 0) target = 0;
      // ease rs toward target with a per-frame speed cap → smooth accel/decel,
      // never a snap. Seed exactly on mesh-in so a fresh bus doesn't glide in.
      // INVARIANT: rs is MONOTONIC non-decreasing — a bus never renders backward.
      // Every cap above (leader gap, cross-traffic nose, route-start floor) can
      // only LOWER `target`; a target behind the current arc means "hold here and
      // wait", never "reverse". That is what makes a trailing bus queue like real
      // traffic instead of shoving the bus ahead — or the one you're riding —
      // backward. A finished run only ever resets its arc by despawning and
      // re-meshing fresh at its origin, never by sliding rs down.
      if (!a.init) {
        a.rs = target;
      } else {
        let step = (target - a.rs) * Math.min(1, dt * FOLLOW_K);
        const cap = V_MAX * dt;
        if (step > cap) step = cap; else if (step < 0) step = 0;
        a.rs += step;
      }
      this.pointAt(a.dir, a.rs, _pt);
      this.tangentAt(a.dir, a.rs, _tan);
      // Smoothed, flip-rejecting forward: a near-duplicate shape vertex can
      // momentarily REVERSE the raw tangent, flipping the curb offset to the far
      // side (a ~2·lat position jump). Only a NEAR-180° flip is a data cusp —
      // real street turns run up to ~120° (avenue→crosstown corners), and
      // rejecting those froze the heading for the whole next segment: the bus
      // drove hundreds of meters broadside. So: ease toward the tangent through
      // any genuine turn, hold only near-reversals — and if a "reversal"
      // persists while the bus keeps advancing, it's real geometry (a terminal
      // hairpin), so adopt it rather than driving backwards-faced.
      if (!a.init) { a.sfx = _tan.x; a.sfz = _tan.z; a.flipRS = a.rs; }
      else if (_tan.x * a.sfx + _tan.z * a.sfz > -0.7) {
        const tk = Math.min(1, dt * 10);
        a.sfx += (_tan.x - a.sfx) * tk; a.sfz += (_tan.z - a.sfz) * tk;
        const l = Math.hypot(a.sfx, a.sfz) || 1; a.sfx /= l; a.sfz /= l;
        a.flipRS = a.rs;
      } else if (a.rs - a.flipRS > 6) {
        a.sfx = _tan.x; a.sfz = _tan.z;
        a.flipRS = a.rs;
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
    // Parked vehicles are hard curb geometry, not participants in right-of-way.
    // Give each bus a smooth lateral target away from the strongest obstruction;
    // the longitudinal guard above holds it short until this merge clears.
    for (let i = 0; i < n; i++) {
      const a = vis[i];
      const mover: TrafficFootprint = {
        key: `bus:${a.key}`,
        x: rx[i],
        z: rz[i],
        fx: rfx[i],
        fz: rfz[i],
        halfLength: hL,
        halfWidth: hW,
        speed: a.renderSpeed,
        priority: true,
      };
      let escape = 0;
      for (const obstacle of this.externalTrafficObstacles) {
        const candidate = trafficLateralEscape(mover, obstacle);
        if (Math.abs(candidate) > Math.abs(escape)) escape = candidate;
      }
      const sideX = -rfz[i], sideZ = rfx[i];
      sepTx[i] += sideX * escape;
      sepTz[i] += sideZ * escape;
    }
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
          // Split direction. Normally follow the existing offset sign(proj). But a
          // near-coincident stack — two buses dwelling on ONE shared stop, centres
          // ~0 apart — has a DEGENERATE sign: proj is pure render noise that flips
          // frame-to-frame, so the offset averages to zero and they never unstack
          // (monotonic rs won't let the rear one slide back into a nose-to-tail
          // gap). Break that tie deterministically by the key-sorted pass order (i
          // precedes j), so the pair berths to stable opposite sides instead of
          // oscillating on top of each other.
          // Split direction, decided ONCE per pair and remembered.
          //
          // Deriving it from the CURRENT offset each frame is a feedback loop:
          // proj is measured from positions that already carry last frame's
          // smoothed push, so the pair chases its own correction. Measured on
          // two buses of different routes sharing a stop at Herald Square --
          // locked at the same arc position (along pinned at 0.76 m, headings
          // exactly parallel) with their lateral offsets swinging 0 -> 2.24 m
          // -> 0 on a repeating cycle, overlapping for up to 5 frames at a time.
          // That reads as a bus shimmying sideways next to another bus.
          //
          // The old code recognised the degenerate case but only when the
          // centres were within 1 cm, which is far narrower than the range over
          // which proj is unreliable. Keyed memory covers the whole of it, and
          // is deterministic: the same pair always berths the same way.
          const ki = vis[i].keyNum, kj = vis[j].keyNum;
          const pairKey = trafficPairKey(ki, kj);
          const flip = ki > kj;                 // store the side in low-key order
          let stored = this.sepSide.get(pairKey) ?? 0;
          if (stored === 0) {
            stored = proj > 1e-2 ? 1 : proj < -1e-2 ? -1 : 1;
            if (flip) stored = -stored;
            this.sepSide.set(pairKey, stored);
          }
          const sgn = flip ? -stored : stored;
          const half = (overlap / 2) * sgn;
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
      // A deadlock escape is a persistent lane-change state, not a one-frame
      // separation impulse. Releasing it toward zero here creates an equilibrium
      // below one lane width, so the bus can wiggle forever without clearing the
      // blocker. Hold the committed offset until the rear clears it (or it pulls
      // safely away); the exact transaction below still validates every step.
      if (
        a.escapeSide !== 0
        && busDeadlockEscapeReady(a.blockedFor)
      ) {
        sepTx[i] = a.sepX;
        sepTz[i] = a.sepZ;
      }
      if (!a.init) { a.sepX = sepTx[i]; a.sepZ = sepTz[i]; }
      else {
        let ex = (sepTx[i] - a.sepX) * kS, ez = (sepTz[i] - a.sepZ) * kS;
        const m = Math.hypot(ex, ez);
        if (m > latCap) { ex *= latCap / m; ez *= latCap / m; }
        a.sepX += ex; a.sepZ += ez;
      }
      rx[i] += a.sepX; rz[i] += a.sepZ;
    }

    // Finalize in stable key order as a sequential collision transaction. Each
    // proposal must clear StreetLife, already-accepted bus proposals, and the
    // still-committed poses of later buses. This prevents two clear endpoints
    // from swapping through one another and covers perpendicular buses that the
    // lateral comfort pass intentionally ignores.
    const yawK = Math.min(1, dt * 6), yK = Math.min(1, dt * 8);
    const finished: MeshedBus[] = [];
    const accepted: Array<TrafficFootprint | null> = new Array(n).fill(null);
    const priorBodies: Array<TrafficFootprint | null> = vis.map((a, i) => (
      priorInit[i]
        ? {
          key: `bus:${a.key}`,
          x: priorX[i],
          z: priorZ[i],
          fx: Math.cos(priorYaw[i]),
          fz: -Math.sin(priorYaw[i]),
          halfLength: hL,
          halfWidth: hW,
          speed: priorRenderSpeed[i],
          priority: true,
        }
        : null
    ));
    for (const i of order) {
      const a = vis[i], g = a.model.group;
      const rawYaw = Math.atan2(-rfz[i], rfx[i]);
      let nextYaw = priorInit[i]
        ? angLerp(priorYaw[i], rawYaw, yawK)
        : rawYaw;
      let committedSpeed = dt > 0
        ? Math.max(0, a.rs - priorLastRS[i]) / dt
        : 0;
      const candidate: TrafficFootprint = {
        key: `bus:${a.key}`,
        x: rx[i],
        z: rz[i],
        fx: Math.cos(nextYaw),
        fz: -Math.sin(nextYaw),
        halfLength: hL,
        halfWidth: hW,
        speed: committedSpeed,
        priority: committedSpeed > 0.15,
      };
      const startBody = priorBodies[i];
      const conflictsFixed = (obstacle: TrafficFootprint): boolean => (
        startBody
          ? trafficMotionConflicts(startBody, candidate, obstacle, 0.08)
          : trafficFootprintsOverlap(candidate, obstacle, 0.08)
      );
      let blocked = this.externalTrafficObstacles.some(conflictsFixed);
      if (blocked && startBody) {
        const escape = findTrafficLateralEscape(
          startBody,
          candidate,
          this.externalTrafficObstacles,
          LAT_CAP * dt,
          0.08,
        );
        if (escape) {
          if (escape.heldRoute) {
            a.rs = priorRS[i];
            a.lastRS = priorLastRS[i];
            a.sfx = priorSfx[i];
            a.sfz = priorSfz[i];
            a.flipRS = priorFlipRS[i];
            a.sepX = priorSepX[i] + escape.shiftX;
            a.sepZ = priorSepZ[i] + escape.shiftZ;
            nextYaw = priorYaw[i];
          } else {
            a.sepX += escape.shiftX;
            a.sepZ += escape.shiftZ;
          }
          rx[i] = escape.end.x;
          rz[i] = escape.end.z;
          candidate.x = escape.end.x;
          candidate.z = escape.end.z;
          candidate.fx = escape.end.fx;
          candidate.fz = escape.end.fz;
          committedSpeed = Math.max(
            escape.heldRoute ? 0 : committedSpeed,
            dt > 0 ? Math.hypot(escape.shiftX, escape.shiftZ) / dt : 0,
          );
          candidate.speed = committedSpeed;
          candidate.priority = committedSpeed > 0.15;
          blocked = false;
        }
      }
      // The ordinary transaction only needs the first conflict. Avoid allocating
      // O(n²) motion wrappers every frame; full obstacle collection is reserved
      // for the rare bus that has remained stalled long enough to recover.
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const acceptedEnd = accepted[j];
        const otherStart = priorBodies[j];
        const otherBody = acceptedEnd ?? otherStart;
        if (!otherBody) continue;
        if (
          trafficPairMotionsConflict(
            startBody ?? candidate,
            candidate,
            otherStart ?? otherBody,
            acceptedEnd ?? otherBody,
            0.08,
          )
        ) {
          blocked = true;
          break;
        }
      }
      if (
        (blocked || routeHeld[i] === 1)
        && startBody
        && busDeadlockEscapeReady(a.blockedFor)
        && a.key === this.recoveryOwnerKey
      ) {
        const busObstacles: TrafficFootprint[] = [];
        const recoverableBusKeys = new Set<string>();
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const otherBody = accepted[j] ?? priorBodies[j];
          if (!otherBody) continue;
          busObstacles.push(otherBody);
          if (busRecoveryWins(
            {
              keyNum: a.keyNum,
              ridden: a.key === this.riddenKey,
            },
            {
              keyNum: vis[j].keyNum,
              ridden: vis[j].key === this.riddenKey,
            },
          )) {
            recoverableBusKeys.add(otherBody.key);
          }
        }
        const stalledObstacles = this.externalTrafficObstacles.length > 0
          ? [...this.externalTrafficObstacles, ...busObstacles]
          : busObstacles;
        const remainingLateral = Math.max(
          0,
          DEADLOCK_LAT_MAX - Math.hypot(a.sepX, a.sepZ),
        );
        const maxShift = Math.min(
          remainingLateral,
          DEADLOCK_LAT_SPEED * dt,
          0.18,
        );
        const sideX = -startBody.fz;
        const sideZ = startBody.fx;
        // The authored route is a street centerline and BASE_LAT places traffic
        // on its right. Recover toward the center/adjacent lane, never farther
        // curbward onto the sidewalk.
        const rememberedSide = -1;
        const recoveryProposal = routeHeld[i] === 1 && !blocked
          ? {
            ...candidate,
            x: startBody.x + startBody.fx * 0.75,
            z: startBody.z + startBody.fz * 0.75,
            speed: Math.max(candidate.speed, 0.75 / Math.max(dt, 1e-3)),
          }
          : candidate;
        const escape = findStalledTrafficEscape(
          startBody,
          recoveryProposal,
          stalledObstacles,
          maxShift,
          0.08,
          rememberedSide,
          routeHeld[i] === 1 && !blocked,
          0.25,
          (obstacle) => (
            !obstacle.key.startsWith('bus:')
            || recoverableBusKeys.has(obstacle.key)
          ),
        );
        let escapeIsSafe = Boolean(escape) && trafficMotionClearsObstacles(
          startBody,
          escape!.end,
          this.externalTrafficObstacles,
          [],
          0.08,
        );
        if (escape && escapeIsSafe) {
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const acceptedEnd = accepted[j];
            const otherStart = priorBodies[j];
            const otherBody = acceptedEnd ?? otherStart;
            if (
              otherBody
              && trafficPairMotionsConflict(
                startBody,
                escape.end,
                otherStart ?? otherBody,
                acceptedEnd ?? otherBody,
                0.08,
              )
            ) {
              escapeIsSafe = false;
              break;
            }
          }
        }
        if (escape && escapeIsSafe) {
          if (escape.heldRoute) {
            a.rs = priorRS[i];
            a.lastRS = priorLastRS[i];
            a.sfx = priorSfx[i];
            a.sfz = priorSfz[i];
            a.flipRS = priorFlipRS[i];
            a.sepX = priorSepX[i] + escape.shiftX;
            a.sepZ = priorSepZ[i] + escape.shiftZ;
            nextYaw = priorYaw[i];
          } else {
            a.sepX += escape.shiftX;
            a.sepZ += escape.shiftZ;
          }
          a.escapeSide = Math.sign(
            escape.shiftX * sideX + escape.shiftZ * sideZ,
          ) || a.escapeSide;
          a.escapeBlockerKey = escape.blockerKey;
          rx[i] = escape.end.x;
          rz[i] = escape.end.z;
          candidate.x = escape.end.x;
          candidate.z = escape.end.z;
          candidate.fx = escape.end.fx;
          candidate.fz = escape.end.fz;
          committedSpeed = Math.max(
            escape.heldRoute ? 0 : committedSpeed,
            dt > 0 ? Math.hypot(escape.shiftX, escape.shiftZ) / dt : 0,
          );
          candidate.speed = committedSpeed;
          candidate.priority = committedSpeed > 0.15;
          blocked = false;
        }
      }
      if (blocked && !priorInit[i]) {
        // A freshly streamed bus has no prior safe pose to restore. Defer its
        // mesh-in until the occupied scheduled position clears.
        g.visible = false;
        this.restoreStagedService(a);
        a.renderSpeed = 0;
        a.model.setSpeed(0, dt);
        continue;
      }
      if (blocked) {
        a.blockedFor += dt;
        a.rs = priorRS[i];
        a.lastRS = priorLastRS[i];
        a.sfx = priorSfx[i];
        a.sfz = priorSfz[i];
        a.flipRS = priorFlipRS[i];
        a.sepX = priorSepX[i];
        a.sepZ = priorSepZ[i];
        a.renderSpeed = 0;
        a.y = priorY[i];
        a.yaw = priorYaw[i];
        this.restoreStagedService(a);
        a.init = true;
        g.visible = true;
        g.position.set(priorX[i], priorY[i], priorZ[i]);
        g.rotation.y = priorYaw[i];
        accepted[i] = priorBodies[i];
        this.committedTrafficMotions.push({
          start: priorBodies[i]!,
          end: priorBodies[i]!,
        });
        a.model.setViewerDistanceSq?.(
          (priorX[i] - px) ** 2 + (priorZ[i] - pz) ** 2,
          a.key === this.riddenKey,
        );
        a.model.setSpeed(0, dt);
        continue;
      }
      g.visible = true;
      const gy = heightAt(rx[i], rz[i]);
      if (!priorInit[i]) {
        a.y = gy;
        a.yaw = nextYaw;
        a.lastRS = a.rs;
        a.renderSpeed = 0;
        a.init = true;
      } else {
        a.y = priorY[i] + (gy - priorY[i]) * yK;
        a.yaw = nextYaw;
        a.lastRS = a.rs;
        a.renderSpeed = committedSpeed;
      }
      a.committedLat = a.lat;
      let escapeBlocker: TrafficFootprint | undefined;
      if (a.escapeBlockerKey) {
        escapeBlocker = this.externalTrafficObstacles.find(
          (obstacle) => obstacle.key === a.escapeBlockerKey,
        );
        if (!escapeBlocker) {
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const other = accepted[j] ?? priorBodies[j];
            if (other?.key === a.escapeBlockerKey) {
              escapeBlocker = other;
              break;
            }
          }
        }
      }
      const escapeActive = a.escapeSide !== 0 && a.escapeBlockerKey !== null;
      const blockerAlong = escapeBlocker
        ? (
          (escapeBlocker.x - candidate.x) * candidate.fx
          + (escapeBlocker.z - candidate.z) * candidate.fz
        )
        : 0;
      const blockerClearance = escapeBlocker
        ? (
          candidate.halfLength
          + Math.hypot(escapeBlocker.halfLength, escapeBlocker.halfWidth)
          + 0.6
        )
        : 0;
      const escapeComplete = escapeActive && (
        !escapeBlocker
        || blockerAlong < -blockerClearance
        || blockerAlong > blockerClearance
      );
      if (escapeActive && !escapeComplete) {
        // Keep the lane-change offset and recovery eligibility through the
        // entire pass. Returning after the first few centimetres of progress
        // merely collides with the same body and restarts the timeout.
        a.blockedFor = a.rs > priorRS[i] + 1e-4
          ? Math.max(a.blockedFor, BUS_DEADLOCK_ESCAPE_AFTER)
          : a.blockedFor + dt;
      } else if (escapeComplete) {
        // The blocker is behind our tail, has disappeared, or has pulled a full
        // body gap ahead. Release toward the authored lane gradually; each
        // return step still goes through the exact sweep transaction.
        a.blockedFor = 0;
        a.escapeSide = 0;
        a.escapeBlockerKey = null;
        if (this.recoveryOwnerKey === a.key) this.recoveryOwnerKey = null;
      } else if (a.rs > priorRS[i] + 1e-4) {
        a.blockedFor = 0;
        a.escapeSide = 0;
        a.escapeBlockerKey = null;
        if (this.recoveryOwnerKey === a.key) this.recoveryOwnerKey = null;
      } else if (routeHeld[i] === 1) {
        a.blockedFor += dt;
      } else {
        a.blockedFor = 0;
        a.escapeSide = 0;
        a.escapeBlockerKey = null;
      }
      if (
        a.serviceDoorT > 0
        && Math.hypot(a.sepX, a.sepZ) > DWELL_LATERAL_EPS
      ) {
        a.physicalDwellRemaining = a.beforePhysicalDwellRemaining;
        a.serviceDwell = false;
        a.serviceDoorT = 0;
        a.serviceStopIdx = -1;
        a.model.setDoors(0);
      }
      g.position.set(rx[i], a.y, rz[i]);
      g.rotation.y = a.yaw;
      candidate.speed = a.renderSpeed;
      candidate.priority = a.renderSpeed > 0.15;
      accepted[i] = candidate;
      this.committedTrafficMotions.push({
        start: priorBodies[i] ?? candidate,
        end: candidate,
      });
      a.model.setViewerDistanceSq?.(
        (rx[i] - px) ** 2 + (rz[i] - pz) ** 2,
        a.key === this.riddenKey,
      );
      a.model.setSpeed(a.renderSpeed, dt);
      if (
        a.finishing
        && a.key !== this.riddenKey
        && a.nextPhysicalStopIdx >= a.dir.nStops
        && a.rs >= a.dir.parkS[a.dir.nStops - 1] - END_EPS
      ) finished.push(a);
    }
    const timedOutOwner = this.recoveryOwnerKey
      ? vis.find((bus) => bus.key === this.recoveryOwnerKey)
      : undefined;
    if (
      timedOutOwner
      && timedOutOwner.blockedFor >= BUS_DEADLOCK_RETIRE_AFTER
    ) {
      const namedBlocker = timedOutOwner.escapeBlockerKey
        ? vis.find(
          (bus) => `bus:${bus.key}` === timedOutOwner.escapeBlockerKey,
        )
        : undefined;
      // Prefer removing the automated body sealing the owner's corridor. If
      // that body is external or ridden, retire the automated owner instead.
      // This is a last resort after 45 seconds of exact no-progress, and its
      // timetable slot is suppressed for a full cycle to prevent a pop-in loop.
      const retired = namedBlocker && namedBlocker.key !== this.riddenKey
        ? namedBlocker
        : timedOutOwner;
      if (
        retired
        && retired.key !== this.riddenKey
        && !finished.includes(retired)
      ) {
        this.suppressedUntil.set(
          retired.key,
          this.worldTime + retired.dir.C,
        );
        finished.push(retired);
      }
      if (retired?.key === this.recoveryOwnerKey) {
        this.recoveryOwnerKey = null;
      }
    }
    return finished;
  }

  private buildMeshed(dir: DirRT, k: number, key: string): MeshedBus {
    const route = this.routes[dir.routeIdx];
    const model = this.makeModel({ route: route.id, dest: dir.dest, color: route.color, sbs: route.sbs });
    this.scene.add(model.group);
    const tau = this.tau(dir, k);
    const stateTau = Math.min(tau, dir.T - 1e-3);
    this.state(dir, stateTau, _st);
    // `stopIdx` is the stop currently being served or approached. Arc-position
    // alone cannot decide completion: a bus can first stream in centimetres
    // before a berth and then be held until the timetable has passed it.
    const nextPhysicalStopIdx = _st.stopIdx;
    let physicalDwellRemaining = -1;
    if (_st.state !== 'moving') {
      const segIdx = lastLE(dir.segT0, dir.nSeg, stateTau);
      physicalDwellRemaining = Math.max(
        1e-3,
        dir.segT0[segIdx] + dir.segDur[segIdx] - stateTau,
      );
    }
    const mb: MeshedBus = {
      key, keyNum: dir.routeIdx * 1e6 + dir.dirIdx * 1e5 + k, dir, k, model,
      sfx: 1, sfz: 0, flipRS: 0, y: 0, yaw: 0, lastRS: 0,
      lastNextStop: undefined, lastStopReq: false, init: false,
      sDes: 0, lat: 0, committedLat: 0,
      desX: 0, desZ: 0, fx: 1, fz: 0, leaderIdx: -1,
      rs: 0, finishing: false,
      runDeadline: this.worldTime + Math.max(0, dir.T - tau),
      nextPhysicalStopIdx,
      physicalDwellRemaining,
      physicalLat: Number.NaN,
      sepX: 0, sepZ: 0, renderSpeed: 0,
      blockedFor: 0, escapeSide: 0, escapeBlockerKey: null,
      serviceDwell: false, serviceDoorT: 0, serviceStopIdx: -1,
      beforePhysicalLat: Number.NaN,
      beforePhysicalDwellRemaining: physicalDwellRemaining,
      beforeNextPhysicalStopIdx: nextPhysicalStopIdx,
      beforeServiceDwell: false,
      beforeServiceDoorT: 0,
      beforeServiceStopIdx: -1,
    };
    this.meshed.set(key, mb);
    return mb;
  }

  private removeMeshed(mb: MeshedBus) {
    // drop this bus's remembered berth sides so the map cannot grow unbounded
    // over a long session (keys are pair-scoped, so they are dead once either
    // bus is gone)
    if (this.sepSide.size) {
      for (const k of this.sepSide.keys()) {
        const [low, high] = k.split(':').map(Number);
        if (low === mb.keyNum || high === mb.keyNum) this.sepSide.delete(k);
      }
    }
    this.scene.remove(mb.model.group);
    mb.model.dispose();
    this.meshed.delete(mb.key);
    if (this.recoveryOwnerKey === mb.key) this.recoveryOwnerKey = null;
  }

  /** Every ~0.35 s: cull far/despawned meshes, add at most one near mesh. */
  private maintainBuses(px: number, pz: number) {
    for (const [key, until] of this.suppressedUntil) {
      if (until <= this.worldTime) this.suppressedUntil.delete(key);
    }
    // cull (never the ridden bus)
    for (const mb of Array.from(this.meshed.values())) {
      if (mb.key === this.riddenKey) continue;
      const tau = this.tau(mb.dir, mb.k);
      // An initialized bus whose schedule expired remains until stepMeshed drives
      // its persistent rendered pose through the terminal. Removing it here made
      // the finish path unreachable and could recycle the same slot into a fresh
      // run while its delayed predecessor was still clearing a queue.
      if (tau >= mb.dir.T && !mb.init) {
        this.removeMeshed(mb);
        continue;
      }
      if (mb.init) {
        _pt.x = mb.model.group.position.x;
        _pt.z = mb.model.group.position.z;
      } else {
        this.pointAt(mb.dir, this.sAt(mb.dir, tau), _pt);
      }
      const dx = _pt.x - px, dz = _pt.z - pz;
      if (dx * dx + dz * dz > BUS_CULL_R2) this.removeMeshed(mb);
    }
    if (this.meshed.size >= this.meshCap) return;
    // find the single nearest un-meshed active slot within mesh range
    let bestKey = '', bestDir: DirRT | null = null, bestK = 0, bestD2 = BUS_MESH_R2;
    for (const rt of this.routes) {
      for (const dir of rt.dirs) {
        for (let k = 0; k < dir.N; k++) {
          const tau = this.tau(dir, k);
          if (tau >= dir.T) continue;
          const key = `${dir.routeIdx}:${dir.dirIdx}:${k}`;
          const suppressedUntil = this.suppressedUntil.get(key);
          if (
            suppressedUntil !== undefined
            && suppressedUntil > this.worldTime
          ) continue;
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

  /**
   * Evict placed stop kits inside a world-space box so the next stream tick
   * re-places them — called when a premium landmark finishes building over
   * one; resolvePlacement then sees the landmark's collision and re-seats
   * the kit outside its walls.
   */
  evictStopsWithin(x0: number, z0: number, x1: number, z1: number) {
    let evicted = false;
    for (const ps of Array.from(this.placedStops.values())) {
      if (ps.x < x0 || ps.x > x1 || ps.z < z0 || ps.z > z1) continue;
      this.scene.remove(ps.group);
      disposeGroup(ps.group);
      this.placedStops.delete(ps.id);
      evicted = true;
    }
    if (evicted) this.stopTimer = 0; // only re-scan if a landmark actually covered a stop
  }

  /** Every ~0.7 s: place stop kits within 300 m, remove beyond 340 m. */
  private streamStops(px: number, pz: number) {
    // removals first (frees the cap)
    for (const ps of Array.from(this.placedStops.values())) {
      const dx = ps.x - px, dz = ps.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > STOP_REMOVE_R2) {
        this.scene.remove(ps.group);
        disposeGroup(ps.group);
        this.placedStops.delete(ps.id);
      } else {
        // Keep the blue flag readable down the block; shelter panels, bench,
        // guide box and trim switch on only where their geometry resolves.
        const detailed = d2 <= STOP_DETAIL_R2;
        for (const child of ps.group.children) {
          child.visible = detailed || child.userData.busStopLodAnchor === true;
        }
      }
    }
    // placements — amortized: at most 2 stop kits actually seated per pass
    // (each is a resolvePlacement footprint solve + kit merge). A backlog resumes
    // next frame (stopTimer 0) rather than seating the whole radius in one burst.
    let placed = 0;
    for (const st of this.allStops) {
      if (this.placedStops.size >= STOP_CAP) break;
      if (this.placedStops.has(st.id)) continue;
      const dx = st.x - px, dz = st.z - pz;
      if (dx * dx + dz * dz > STOP_PLACE_R2) continue;
      if (this.placeStop(st) && ++placed >= 2) { this.stopTimer = 0; return; }
    }
  }

  private placeStop(st: { id: string; x: number; z: number; seed: number }): boolean {
    // pull the raw GTFS point onto the sidewalk (off roadways/buildings). null =
    // tiles not loaded here yet → defer; the next scan tick retries this stop.
    let sx = st.x, sz = st.z;
    if (this.resolvePlacement) {
      const rp = this.resolvePlacement(st.x, st.z);
      if (rp === null) return false;
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
    const templateKey = `${shelter ? 1 : 0}|${badges
      .map((badge) => `${badge.id}:${badge.color}:${badge.sbs ? 1 : 0}`)
      .sort()
      .join(',')}`;
    let template = this.stopTemplates.get(templateKey);
    if (!template) {
      template = this.makeStop(badges, st.seed, shelter);
      template.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (child.userData.shared !== true) child.userData.stopTemplateOwned = true;
        child.userData.shared = true;
      });
      this.stopTemplates.set(templateKey, template);
    }
    const group = template.clone(true);
    group.name = 'Bus Stop';
    group.position.set(sx, heightAt(sx, sz), sz);
    group.rotation.y = yaw;
    this.scene.add(group);
    this.placedStops.set(st.id, { id: st.id, group, x: sx, z: sz });
    return true;
  }

  // ---- boarding / riding ----

  /** A meshed, dwelling, doors-open bus whose front door is within 6 m. */
  boardable(px: number, pz: number): { key: string; route: string; dest: string; color: string; sbs: boolean; door: [number, number] } | null {
    let best: MeshedBus | null = null;
    let bestDoor: [number, number] = [0, 0];
    let bestD2 = 6 * 6;
    for (const mb of this.meshed.values()) {
      if (!mb.init || !mb.model.group.visible || mb.finishing) continue;
      if (!mb.serviceDwell || mb.serviceDoorT <= DOOR_OPEN) continue;
      const door = this.localXZToWorld(mb, BUS.doorX.front, BUS.width / 2);
      const dx = door[0] - px, dz = door[1] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = mb; bestDoor = door; }
    }
    if (!best) return null;
    const rt = this.routes[best.dir.routeIdx];
    return { key: best.key, route: rt.id, dest: best.dir.dest, color: rt.color, sbs: rt.sbs, door: bestDoor };
  }

  /** Snapshot of the ridden run for deep links (null when not riding). */
  get rideShare(): { route: string; dirIdx: number; k: number; tau: number } | null {
    if (!this.ride) return null;
    const mb = this.ride.mb;
    return {
      route: this.routes[mb.dir.routeIdx].id,
      dirIdx: mb.dir.dirIdx,
      k: mb.k,
      tau: Math.round(
        mb.finishing
          ? Math.max(0, mb.dir.T - 1)
          : this.tau(mb.dir, mb.k),
      ),
    };
  }

  /**
   * Rebuild the exact shared bus run: buses are pure timetable math
   * (position = f(worldTime)), so shifting worldTime puts run (dir, k) at the
   * shared τ — every other bus just materializes at a consistent other point
   * of its own cycle, which is invisible on a fresh load. Returns the boarded
   * handle, or null if the route/run doesn't exist in this data.
   */
  restoreRide(routeId: string, dirIdx: number, k: number, tau: number): BusRideHandle | null {
    const rt = this.routesById.get(routeId);
    const dir = rt?.dirs.find((d) => d.dirIdx === dirIdx);
    if (!rt || !dir) return null;
    const kk = Math.max(0, Math.min(dir.N - 1, Math.round(k)));
    const t = Math.max(0, Math.min(dir.T - 5, tau)); // clamp inside the live run
    this.worldTime = t - dir.routePhase + kk * dir.H;
    return this.board(`${rt.idx}:${dirIdx}:${kk}`);
  }

  board(key: string): BusRideHandle | null {
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    const routeIdx = +parts[0], dirIdx = +parts[1], k = +parts[2];
    const rt = this.routes[routeIdx];
    const dir = rt?.dirs.find((d) => d.dirIdx === dirIdx);
    if (!dir) return null;
    const existing = this.meshed.get(key);
    if (existing?.finishing) return null;
    if (this.tau(dir, k) >= dir.T) return null; // run already despawned
    const suppressedUntil = this.suppressedUntil.get(key);
    if (
      suppressedUntil !== undefined
      && suppressedUntil > this.worldTime
    ) return null;
    let mb = existing;
    const builtForBoarding = !mb;
    if (!mb) mb = this.buildMeshed(dir, k, key);
    if (!this.stepOneMeshed(mb)) {
      if (builtForBoarding) this.removeMeshed(mb);
      return null;
    }
    // end() unpins so the bus resumes normal culling (it stays in service)
    const ride: BusRide = new BusRide(() => {
      ride.active = false;
      if (this.ride === ride) {
        // The terminal dwell is intentionally infinite only while a rider is
        // pinned to this generation. Once they step off, mark it served so the
        // automated bus can leave the berth/despawn on the next safe update.
        if (mb.physicalDwellRemaining === Number.POSITIVE_INFINITY) {
          mb.physicalDwellRemaining = 0;
          mb.serviceDwell = false;
          mb.serviceDoorT = 0;
          mb.serviceStopIdx = -1;
          mb.model.setDoors(0);
        }
        this.riddenKey = null;
        this.ride = null;
      }
    }, mb, dir, rt);
    this.riddenKey = key;
    this.ride = ride;
    this.refreshRide();
    return ride;
  }

  /** Position a single meshed bus immediately (used at board time). Uses the raw
   *  timetable pose — car-following refines it on the next stepMeshed. */
  private stepOneMeshed(mb: MeshedBus): boolean {
    if (mb.init) return mb.model.group.visible;
    const dir = mb.dir;
    const tau = this.tau(dir, mb.k);
    if (tau >= dir.T) return false;
    this.state(dir, tau, _st);
    this.pointAt(dir, _st.s, _pt);
    this.tangentAt(dir, _st.s, _tan);
    const wx = _pt.x - _tan.z * _st.lat;
    const wz = _pt.z + _tan.x * _st.lat;
    const rawYaw = Math.atan2(-_tan.z, _tan.x);
    const candidate: TrafficFootprint = {
      key: `bus:${mb.key}`,
      x: wx,
      z: wz,
      fx: _tan.x,
      fz: _tan.z,
      halfLength: BUS.length / 2,
      halfWidth: BUS.width / 2,
      speed: 0,
      priority: true,
    };
    const occupied = this.externalTrafficObstacles.some((obstacle) => (
      trafficFootprintsOverlap(candidate, obstacle, 0.08)
    )) || Array.from(this.meshed.values()).some((other) => {
      if (
        other === mb
        || !other.init
        || !other.model.group.visible
      ) return false;
      const yaw = other.yaw;
      return trafficFootprintsOverlap(candidate, {
        key: `bus:${other.key}`,
        x: other.model.group.position.x,
        z: other.model.group.position.z,
        fx: Math.cos(yaw),
        fz: -Math.sin(yaw),
        halfLength: BUS.length / 2,
        halfWidth: BUS.width / 2,
        speed: other.renderSpeed,
        priority: true,
      }, 0.08);
    });
    if (occupied) {
      mb.model.group.visible = false;
      return false;
    }
    mb.model.group.visible = true;
    mb.y = heightAt(wx, wz);
    mb.yaw = rawYaw;
    mb.rs = _st.s;
    mb.lastRS = _st.s;
    mb.sfx = _tan.x;
    mb.sfz = _tan.z;
    mb.flipRS = _st.s;
    mb.sepX = 0;
    mb.sepZ = 0;
    mb.lat = _st.lat;
    mb.committedLat = _st.lat;
    mb.renderSpeed = 0;
    mb.init = true;
    mb.model.group.position.set(wx, mb.y, wz);
    mb.model.group.rotation.y = mb.yaw;
    return true;
  }

  private refreshRide() {
    const ride = this.ride!;
    const dir = ride.dir;
    // A delayed rider remains attached to the boarded generation until an
    // explicit exit. Timetable expiry/wrap must never eject the player in the
    // road or rebase the pinned bus onto the next scheduled run.
    ride.active = true;
    const serviceStopIdx = ride.mb.serviceStopIdx;
    ride.canExit = ride.mb.serviceDoorT > DOOR_OPEN;
    ride.atEnd = ride.canExit && serviceStopIdx === dir.nStops - 1;
    ride.pos.x = ride.mb.model.group.position.x;
    ride.pos.z = ride.mb.model.group.position.z;
    ride.pos.yaw = ride.mb.yaw;
    if (ride.mb.finishing) {
      const terminalHud = ride.hud;
      const displayStopIdx = serviceStopIdx >= 0
        ? serviceStopIdx
        : Math.min(ride.mb.nextPhysicalStopIdx, dir.nStops - 1);
      terminalHud.state = ride.mb.serviceDwell ? 'dwell' : 'moving';
      terminalHud.thisStop = dir.stopNames[displayStopIdx] ?? '';
      terminalHud.nextStop = displayStopIdx + 1 < dir.nStops
        ? dir.stopNames[displayStopIdx + 1]
        : null;
      terminalHud.atEnd = ride.atEnd;
      return;
    }
    const physicalStopIdx = serviceStopIdx >= 0
      ? serviceStopIdx
      : Math.min(ride.mb.nextPhysicalStopIdx, dir.nStops - 1);
    const h = ride.hud;
    h.state = ride.mb.serviceDwell ? 'dwell' : 'moving';
    h.thisStop = dir.stopNames[physicalStopIdx] ?? '';
    h.nextStop = physicalStopIdx + 1 < dir.nStops
      ? dir.stopNames[physicalStopIdx + 1]
      : null;
    h.atEnd = ride.atEnd;
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

  /**
   * Rendered nearby buses as physical traffic obstacles. StreetLife consumes
   * this already-streamed set rather than scanning the island-wide timetable,
   * so cars yield to the exact smoothed bus bodies the player can see.
   */
  trafficObstacles(): TrafficFootprint[] {
    const out: TrafficFootprint[] = [];
    for (const mb of this.meshed.values()) {
      if (!mb.init || !mb.model.group.visible) continue;
      out.push({
        key: `bus:${mb.key}`,
        x: mb.model.group.position.x,
        z: mb.model.group.position.z,
        fx: Math.cos(mb.yaw),
        fz: -Math.sin(mb.yaw),
        halfLength: BUS.length * 0.5,
        halfWidth: BUS.width * 0.5,
        // Publish committed render speed, not timetable intent. A bus stopped
        // for a crossing actor relinquishes the tie so that actor can clear;
        // once moving, transit regains deterministic right of way.
        speed: mb.renderSpeed,
        priority: mb.renderSpeed > 0.15,
      });
    }
    return out;
  }

  /** Start→end bodies committed in the latest frame for synchronized sweeps. */
  trafficMotions(): readonly TrafficMotion[] {
    return this.committedTrafficMotions;
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
    for (const template of this.stopTemplates.values()) {
      template.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.stopTemplateOwned === true) {
          child.geometry.dispose();
        }
      });
    }
    this.stopTemplates.clear();
    this.sepSide.clear();
    this.suppressedUntil.clear();
    this.recoveryOwnerKey = null;
    this.riddenKey = null;
    this.ride = null;
  }
}
