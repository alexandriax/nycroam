import * as THREE from 'three';
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
  dir: DirRT;
  k: number;
  model: BusModelLike;
  y: number;        // smoothed ground height
  yaw: number;      // smoothed heading
  lastS: number;    // for measured speed
  lastNextStop: string | null | undefined; // undefined = never pushed
  lastStopReq: boolean;
  init: boolean;
  // anti-overlap: on-shape base pos + right-of-travel normal, plus a smoothed
  // lateral offset so two buses sharing an avenue slide into adjacent lanes
  baseX: number;
  baseZ: number;
  rnx: number;
  rnz: number;
  sepOff: number;   // smoothed lateral displacement (m, along the right normal)
  sepT: number;     // per-frame scratch target
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
      const res = await fetch('/geo/buses.json');
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
    data.routes.forEach((r, idx) => {
      const rt: RouteRT = { idx, id: r.id, color: r.color, sbs: r.sbs, name: r.name, dirs: [] };
      const speed = r.sbs ? SPEED_SBS : SPEED_LOCAL;
      r.dirs.forEach((d, dirIdx) => {
        const dir = this.buildDir(data, idx, dirIdx, d.dest, d.shape, d.stops, r.sbs, speed);
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
    const routePhase = hash01(routeIdx * 31 + dirIdx) * C;

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
    const yawK = Math.min(1, dt * 6);
    const yK = Math.min(1, dt * 8);
    for (const mb of this.meshed.values()) {
      const dir = mb.dir;
      const tau = this.tau(dir, mb.k);
      if (tau >= dir.T) {
        // run despawned; ridden bus is pinned (World bails via active=false)
        if (mb.key !== this.riddenKey) mb.model.group.visible = false;
        continue;
      }
      mb.model.group.visible = true;
      this.state(dir, tau, _st);
      this.pointAt(dir, _st.s, _pt);
      this.tangentAt(dir, _st.s, _tan);
      // curb pull-in: slide along the right-of-travel normal while serving a stop
      const rnx = -_tan.z, rnz = _tan.x; // unit right-of-travel normal
      const wx = _pt.x + rnx * _st.lat;
      const wz = _pt.z + rnz * _st.lat;
      const gy = heightAt(wx, wz);
      const rawYaw = Math.atan2(-_tan.z, _tan.x);
      if (!mb.init) {
        mb.y = gy; mb.yaw = rawYaw; mb.lastS = _st.s; mb.init = true;
      } else {
        mb.y += (gy - mb.y) * yK;
        mb.yaw = angLerp(mb.yaw, rawYaw, yawK);
      }
      // stash on-shape pose; final x/z set in the separation pass below
      mb.baseX = wx; mb.baseZ = wz; mb.rnx = rnx; mb.rnz = rnz;
      const g = mb.model.group;
      g.position.y = mb.y;
      g.rotation.y = mb.yaw;

      // measured ground speed (clamp wrap/degenerate to 0)
      let ds = _st.s - mb.lastS;
      if (ds < 0) ds = 0;
      mb.lastS = _st.s;
      mb.model.setSpeed(dt > 0 ? ds / dt : 0, dt);
      mb.model.setDoors(_st.doorT);

      const nx = dir.stopNames[_st.stopIdx] ?? null;
      if (nx !== mb.lastNextStop) { mb.model.setNextStop(nx); mb.lastNextStop = nx; }
      if (_st.stopReq !== mb.lastStopReq) { mb.model.setStopRequested(_st.stopReq); mb.lastStopReq = _st.stopReq; }
    }
    this.separateMeshed(dt);
  }

  /**
   * Keep meshed buses from phasing through each other. Buses are spaced by
   * headway within a route (they never collide same-route), but different routes
   * share avenues and drive merged. Here each visible bus, in a stable priority
   * order (by key), yields laterally to every higher-priority bus it overlaps —
   * sliding into the adjacent lane. Only the lower-priority bus of a pair moves,
   * so there's no oscillation; the offset is smoothed, so it reads as a lane
   * change, not a snap. The ridden bus never yields (the camera rides it).
   */
  private separateMeshed(dt: number) {
    const vis: MeshedBus[] = [];
    for (const mb of this.meshed.values()) if (mb.model.group.visible) vis.push(mb);
    vis.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const TRIGGER2 = 12.5 * 12.5; // bus length + margin: closer than this can overlap
    const SEP_LAT = 3.0;          // desired lateral gap between two buses
    const MAX_OFF = 3.2;          // never slide more than ~one lane off the line
    // Sequential in priority order: each bus's target clears it of every
    // higher-priority bus at that bus's ALREADY-DECIDED offset, so a chain of
    // overlaps resolves into distinct lanes instead of all piling into one.
    for (let j = 0; j < vis.length; j++) {
      const b = vis[j];
      if (b.key === this.riddenKey) { b.sepT = 0; continue; }
      let target = 0;
      for (let i = 0; i < j; i++) {
        const a = vis[i];
        const ax = a.baseX + a.rnx * a.sepT, az = a.baseZ + a.rnz * a.sepT;
        const bx = b.baseX + b.rnx * target, bz = b.baseZ + b.rnz * target;
        const dx = bx - ax, dz = bz - az;
        const d2 = dx * dx + dz * dz;
        if (d2 >= TRIGGER2 || d2 < 1e-8) continue;
        const lat = dx * b.rnx + dz * b.rnz;
        const need = SEP_LAT - Math.abs(lat);
        if (need > 0) target += (lat >= 0 ? 1 : -1) * need;
      }
      b.sepT = target > MAX_OFF ? MAX_OFF : target < -MAX_OFF ? -MAX_OFF : target;
    }
    const k = Math.min(1, dt * 4);
    for (const mb of vis) {
      mb.sepOff += (mb.sepT - mb.sepOff) * k;
      if (Math.abs(mb.sepOff) < 0.01) mb.sepOff = 0;
      const g = mb.model.group;
      g.position.x = mb.baseX + mb.rnx * mb.sepOff;
      g.position.z = mb.baseZ + mb.rnz * mb.sepOff;
    }
  }

  private buildMeshed(dir: DirRT, k: number, key: string): MeshedBus {
    const route = this.routes[dir.routeIdx];
    const model = this.makeModel({ route: route.id, dest: dir.dest, color: route.color, sbs: route.sbs });
    this.scene.add(model.group);
    const mb: MeshedBus = {
      key, dir, k, model, y: 0, yaw: 0, lastS: 0,
      lastNextStop: undefined, lastStopReq: false, init: false,
      baseX: 0, baseZ: 0, rnx: 1, rnz: 0, sepOff: 0, sepT: 0,
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

  /** Position a single meshed bus immediately (used at board time). */
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
    if (!mb.init) { mb.y = heightAt(wx, wz); mb.yaw = rawYaw; mb.lastS = _st.s; mb.init = true; }
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
