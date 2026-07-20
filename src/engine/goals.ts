// Goals / achievements tracker. Pure logic + localStorage — no Three.js, no DOM
// beyond `window.localStorage`. World feeds it discrete transit events and a
// per-frame spatial/motion sample; the HUD reads snapshot() and subscribes to
// onChange (modal refresh) and onProgress (flash messages).
//
// State model (coordinator revision): every goal owns INDEPENDENT state so a
// per-goal reset has clean semantics. "Use every mode of transit" keeps its own
// `modes` set, fed by the same board/mount/fly events that flip the individual
// ride goals — resetting one never disturbs the other.
import { dataUrl } from './dataver';
import { LANDMARKS_REG } from './landmarks/registry';
import { lonLatToXZ } from './geo';

const STORAGE_KEY = 'nycroam-goals';
const STORE_V = 2;

// Jackie Kennedy Onassis Reservoir, Central Park (world meters).
const RES_X = 1975, RES_Z = -3054;
const RES_MIN = 180, RES_MAX = 620; // the runnable annulus around the water
const RUN_SPEED = 8;   // m/s — between walk (5.2) and sprint (10.9)
const RUN_HOLD = 2.5;  // s continuous to "break into a run"
const HELI_ALT = 12;   // m above ground to count as airborne
const HELI_HOLD = 2;   // s airborne to "fly in a helicopter"
const LANDMARK_R2 = 120 * 120; // squared visit radius, meters
const SWEEP_DT = 0.5;  // s between spatial sweeps
const SAVE_MIN_MS = 2000; // throttle floor between localStorage writes
const TWO_PI = Math.PI * 2;
const RES_MILESTONES = [25, 50, 75];

export interface GoalItem { name: string; done: boolean }
export interface Goal {
  id: string;
  label: string;
  done: boolean;
  count?: { have: number; total: number }; // x/y goals
  items?: GoalItem[];                       // expandable sub-lists
  hint?: string;                            // right-aligned extra (reservoir %)
  resettable?: boolean;                     // show the per-goal ↺ control
}

type Mode = 'subway' | 'bus' | 'tram' | 'bike' | 'heli';

interface Ring { pts: [number, number][]; minX: number; minZ: number; maxX: number; maxZ: number }
interface Area { id: string; name: string; rings: Ring[]; minX: number; minZ: number; maxX: number; maxZ: number }
interface Anchor { id: string; name: string; x: number; z: number }

function mkArea(raw: { id: string; name: string; rings: [number, number][][] }): Area {
  let aMinX = Infinity, aMinZ = Infinity, aMaxX = -Infinity, aMaxZ = -Infinity;
  const rings: Ring[] = raw.rings.map((pts) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (minX < aMinX) aMinX = minX; if (maxX > aMaxX) aMaxX = maxX;
    if (minZ < aMinZ) aMinZ = minZ; if (maxZ > aMaxZ) aMaxZ = maxZ;
    return { pts, minX, minZ, maxX, maxZ };
  });
  return { id: raw.id, name: raw.name, rings, minX: aMinX, minZ: aMinZ, maxX: aMaxX, maxZ: aMaxZ };
}

function pointInRing(x: number, z: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export class GoalTracker {
  // ---- independent goal state ----
  private subway = false;
  private bus = false;
  private bike = false;
  private run = false;
  private heli = false;
  private transfer = false;
  private modes = new Set<Mode>();           // "use every mode" — its own set
  private visitedHoods = new Set<string>();
  private visitedParks = new Set<string>();
  private visitedLandmarks = new Set<string>();
  private reservoirProgress = 0;             // signed radians, net
  private reservoirDone = false;
  private firedMilestones = new Set<number>();

  // ---- transient (not persisted) ----
  private runAccum = 0;
  private heliAccum = 0;
  private resLastAngle: number | null = null;
  private pending = false;      // walked off a train, still in the station
  private lastRoute: string | null = null;
  private sweepAccum = 0;

  // ---- data ----
  private neighborhoods: Area[] = [];
  private parks: Area[] = [];
  private readonly landmarks: Anchor[];
  private dataReady = false;

  // ---- subscriptions + save bookkeeping ----
  private changeCbs = new Set<() => void>();
  private progressCbs = new Set<(text: string) => void>();
  private completed = new Set<string>(); // goal ids that have already toasted "complete"
  private justCompleted = false;
  private dirty = false;
  private lastSave = 0;

  constructor() {
    this.landmarks = LANDMARKS_REG
      .filter((l) => !l.aliasOf)
      .map((l) => { const [x, z] = lonLatToXZ(l.lon, l.lat); return { id: l.id, name: l.name, x, z }; })
      .sort((a, b) => a.name.localeCompare(b.name));
    this.loadState();
    this.seedCompleted(); // absorb prior-session completions so no toast on boot
    void this.loadData();
  }

  // ---- persistence ----

  private loadState() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || s.v !== STORE_V) return; // ignore foreign/old shapes
      this.subway = !!s.subway; this.bus = !!s.bus; this.bike = !!s.bike;
      this.run = !!s.run; this.heli = !!s.heli; this.transfer = !!s.transfer;
      if (Array.isArray(s.modes)) this.modes = new Set(s.modes);
      if (Array.isArray(s.neighborhoods)) this.visitedHoods = new Set(s.neighborhoods);
      if (Array.isArray(s.parks)) this.visitedParks = new Set(s.parks);
      if (Array.isArray(s.landmarks)) this.visitedLandmarks = new Set(s.landmarks);
      if (typeof s.reservoirProgress === 'number') this.reservoirProgress = s.reservoirProgress;
      this.reservoirDone = !!s.reservoirDone;
      if (Array.isArray(s.reservoirMilestones)) this.firedMilestones = new Set(s.reservoirMilestones);
    } catch { /* SSR, private-mode throw, or corrupt JSON — start fresh */ }
  }

  private write() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: STORE_V,
        subway: this.subway, bus: this.bus, bike: this.bike,
        run: this.run, heli: this.heli, transfer: this.transfer,
        modes: [...this.modes],
        neighborhoods: [...this.visitedHoods],
        parks: [...this.visitedParks],
        landmarks: [...this.visitedLandmarks],
        reservoirProgress: this.reservoirProgress,
        reservoirDone: this.reservoirDone,
        reservoirMilestones: [...this.firedMilestones],
      }));
    } catch { /* quota / private mode — the run just won't persist */ }
  }

  /** Write now if a completion happened, else throttle to >=2s apart. */
  private flush(immediate: boolean) {
    if (!this.dirty) return;
    const now = Date.now();
    if (!immediate && now - this.lastSave < SAVE_MIN_MS) return;
    this.write();
    this.lastSave = now;
    this.dirty = false;
  }

  private async loadData() {
    try {
      const res = await fetch(dataUrl('/geo/goalsdata.json'));
      if (!res.ok) return;
      const j = await res.json();
      this.neighborhoods = (j.neighborhoods ?? []).map(mkArea);
      this.parks = (j.parks ?? []).map(mkArea);
      this.dataReady = true;
      this.seedCompleted();               // a prior session may already own them
      for (const cb of this.changeCbs) cb(); // totals are live now
    } catch { /* offline / blocked — spatial goals just stay at 0 this run */ }
  }

  // ---- subscriptions ----

  /** Fired when the snapshot changes (a visit, a flag flip, a reset). */
  onChange(cb: () => void): () => void { this.changeCbs.add(cb); return () => this.changeCbs.delete(cb); }
  /** Fired for every flash message (progress + completion). */
  onProgress(cb: (text: string) => void): () => void { this.progressCbs.add(cb); return () => this.progressCbs.delete(cb); }

  private emit(text: string) { for (const cb of this.progressCbs) cb(text); }

  /** Mark all currently-done goals as already-toasted (no flash on load). */
  private seedCompleted() { for (const g of this.snapshot()) if (g.done) this.completed.add(g.id); }

  /** Fire "Goal complete —" flashes for any goal newly done since last check. */
  private emitCompletions() {
    for (const g of this.snapshot()) {
      if (g.done && !this.completed.has(g.id)) {
        this.completed.add(g.id);
        this.justCompleted = true;
        this.emit(`Goal complete: ${g.label}`);
      }
    }
  }

  /** After a state change: fire completions, notify listeners, persist. */
  private touch() {
    this.emitCompletions();
    for (const cb of this.changeCbs) cb();
    this.dirty = true;
    this.flush(this.justCompleted);
    this.justCompleted = false;
  }

  private addMode(mode: Mode, verb: string): boolean {
    if (this.modes.has(mode)) return false;
    this.modes.add(mode);
    this.emit(`${verb} · Transit modes ${this.modes.size}/5`);
    return true;
  }

  // ---- transit events (called by World) ----

  onTrainBoard(route: string) {
    let ch = false;
    if (!this.subway) { this.subway = true; ch = true; }
    if (this.addMode('subway', 'Rode the subway')) ch = true;
    if (this.pending) {
      if (route !== this.lastRoute) {                 // boarded a DIFFERENT route
        if (!this.transfer) { this.transfer = true; ch = true; }
        this.pending = false;
        this.lastRoute = route;
      }
      // same route again: keep pending alive, change nothing
    } else {
      this.lastRoute = route;
    }
    if (ch) this.touch();
  }

  /** Stepped off a train but still inside a station — a transfer is now armed. */
  onTrainWalkOff() { if (this.lastRoute !== null) this.pending = true; }

  /** Left the station to the street — any armed transfer is cancelled. */
  onStationLeave() { this.pending = false; }

  onBusBoard() {
    let ch = false;
    if (!this.bus) { this.bus = true; ch = true; }
    if (this.addMode('bus', 'Rode the bus')) ch = true;
    if (ch) this.touch();
  }

  onTramBoard() { if (this.addMode('tram', 'Rode the tram')) this.touch(); }

  onBikeMount() {
    let ch = false;
    if (!this.bike) { this.bike = true; ch = true; }
    if (this.addMode('bike', 'Rode a Citi Bike')) ch = true;
    if (ch) this.touch();
  }

  // ---- per-frame sample ----

  update(dt: number, x: number, z: number, s: { onFoot: boolean; speed: number; flying: boolean; altAboveGround: number }) {
    let changed = false;

    // "Break into a run": >=8 m/s on foot, held 2.5s continuously.
    if (s.onFoot && s.speed >= RUN_SPEED) {
      this.runAccum += dt;
      if (this.runAccum >= RUN_HOLD && !this.run) { this.run = true; changed = true; }
    } else this.runAccum = 0;

    // "Fly in a helicopter": airborne >=12m, held 2s.
    if (s.flying && s.altAboveGround >= HELI_ALT) {
      this.heliAccum += dt;
      if (this.heliAccum >= HELI_HOLD) {
        if (!this.heli) { this.heli = true; changed = true; }
        if (this.addMode('heli', 'Flew a helicopter')) changed = true;
      }
    } else this.heliAccum = 0;

    // "Lap the reservoir": accumulate signed angle while running the annulus.
    const dxr = x - RES_X, dzr = z - RES_Z;
    const dist = Math.hypot(dxr, dzr);
    if (s.onFoot && s.speed >= RUN_SPEED && dist >= RES_MIN && dist <= RES_MAX) {
      const ang = Math.atan2(dzr, dxr);
      if (this.resLastAngle !== null) {
        let d = ang - this.resLastAngle;
        if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
        if (Math.abs(d) <= 0.5) {                     // skip teleport-sized jumps
          this.reservoirProgress += d;
          this.dirty = true;
          if (!this.reservoirDone) {
            const pct = (Math.abs(this.reservoirProgress) / TWO_PI) * 100;
            for (const m of RES_MILESTONES) {
              if (pct >= m && !this.firedMilestones.has(m)) {
                this.firedMilestones.add(m);
                this.emit(`Reservoir lap ${m}%`);
              }
            }
            if (pct >= 100) { this.reservoirDone = true; this.firedMilestones.clear(); changed = true; }
          }
        }
      }
      this.resLastAngle = ang;
    } else {
      this.resLastAngle = null; // pause (progress persists; drop the anchor)
    }

    // Spatial visits — throttled sweep.
    this.sweepAccum += dt;
    if (this.sweepAccum >= SWEEP_DT) {
      this.sweepAccum = 0;
      if (this.sweep(x, z)) changed = true;
    }

    if (changed) this.touch();
    else this.flush(false); // persist reservoir progress within the throttle window
  }

  private countIn(list: Area[] | Anchor[], set: Set<string>): number {
    let n = 0;
    for (const a of list) if (set.has(a.id)) n++;
    return n;
  }

  private inArea(x: number, z: number, a: Area): boolean {
    if (x < a.minX || x > a.maxX || z < a.minZ || z > a.maxZ) return false;
    for (const r of a.rings) {
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      if (pointInRing(x, z, r.pts)) return true; // inside ANY ring counts
    }
    return false;
  }

  private sweep(x: number, z: number): boolean {
    let changed = false;
    for (const a of this.neighborhoods) {
      if (this.visitedHoods.has(a.id)) continue;
      if (this.inArea(x, z, a)) {
        this.visitedHoods.add(a.id); changed = true;
        this.emit(`Visited ${a.name} · Neighborhoods ${this.countIn(this.neighborhoods, this.visitedHoods)}/${this.neighborhoods.length}`);
      }
    }
    for (const a of this.parks) {
      if (this.visitedParks.has(a.id)) continue;
      if (this.inArea(x, z, a)) {
        this.visitedParks.add(a.id); changed = true;
        this.emit(`Visited ${a.name} · Parks ${this.countIn(this.parks, this.visitedParks)}/${this.parks.length}`);
      }
    }
    for (const l of this.landmarks) {
      if (this.visitedLandmarks.has(l.id)) continue;
      const dx = x - l.x, dz = z - l.z;
      if (dx * dx + dz * dz <= LANDMARK_R2) {
        this.visitedLandmarks.add(l.id); changed = true;
        this.emit(`Visited ${l.name} · Landmarks ${this.countIn(this.landmarks, this.visitedLandmarks)}/${this.landmarks.length}`);
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  // ---- reads for the UI ----

  snapshot(): Goal[] {
    const modeItems: GoalItem[] = [
      { name: 'Subway', done: this.modes.has('subway') },
      { name: 'Bus', done: this.modes.has('bus') },
      { name: 'Tram', done: this.modes.has('tram') },
      { name: 'Citi Bike', done: this.modes.has('bike') },
      { name: 'Helicopter', done: this.modes.has('heli') },
    ];
    const modeHave = modeItems.filter((i) => i.done).length;
    const hoodItems = this.neighborhoods.map((a) => ({ name: a.name, done: this.visitedHoods.has(a.id) }));
    const parkItems = this.parks.map((a) => ({ name: a.name, done: this.visitedParks.has(a.id) }));
    const lmItems = this.landmarks.map((l) => ({ name: l.name, done: this.visitedLandmarks.has(l.id) }));
    const have = (it: GoalItem[]) => it.filter((i) => i.done).length;
    const allDone = (it: GoalItem[]) => it.length > 0 && it.every((i) => i.done);
    const resPct = Math.round(Math.min(1, Math.abs(this.reservoirProgress) / TWO_PI) * 100);

    return [
      { id: 'subway', label: 'Take the subway', done: this.subway, resettable: this.subway },
      { id: 'bus', label: 'Ride a bus', done: this.bus, resettable: this.bus },
      { id: 'bike', label: 'Ride a Citi Bike', done: this.bike, resettable: this.bike },
      { id: 'run', label: 'Break into a run', done: this.run, resettable: this.run },
      { id: 'heli', label: 'Fly in a helicopter', done: this.heli, resettable: this.heli },
      { id: 'transfer', label: 'Make a subway transfer', done: this.transfer, resettable: this.transfer },
      {
        id: 'neighborhoods', label: 'Visit every neighborhood', done: allDone(hoodItems),
        count: { have: have(hoodItems), total: hoodItems.length }, items: hoodItems, resettable: have(hoodItems) > 0,
      },
      {
        id: 'every-mode', label: 'Use every mode of transit', done: modeHave === 5,
        count: { have: modeHave, total: 5 }, items: modeItems, resettable: modeHave > 0,
      },
      {
        id: 'reservoir', label: 'Lap the Jackie O reservoir', done: this.reservoirDone,
        hint: this.reservoirDone || resPct === 0 ? undefined : `${resPct}%`,
        resettable: this.reservoirDone || this.reservoirProgress !== 0 || this.firedMilestones.size > 0,
      },
      {
        id: 'parks', label: 'Visit every park', done: allDone(parkItems),
        count: { have: have(parkItems), total: parkItems.length }, items: parkItems, resettable: have(parkItems) > 0,
      },
      {
        id: 'landmarks', label: 'Visit every landmark', done: allDone(lmItems),
        count: { have: have(lmItems), total: lmItems.length }, items: lmItems, resettable: have(lmItems) > 0,
      },
    ];
  }

  /** True when every goal is complete (for the golden trophy tint). */
  allComplete(): boolean { return this.snapshot().every((g) => g.done); }

  // ---- resets ----

  /** Reset a single goal so it can be earned again. No confirmation. */
  resetGoal(id: string) {
    switch (id) {
      case 'subway': this.subway = false; break;
      case 'bus': this.bus = false; break;
      case 'bike': this.bike = false; break;
      case 'run': this.run = false; this.runAccum = 0; break;
      case 'heli': this.heli = false; this.heliAccum = 0; break;
      case 'transfer': this.transfer = false; this.pending = false; this.lastRoute = null; break;
      case 'neighborhoods': this.visitedHoods.clear(); break;
      case 'every-mode': this.modes.clear(); break;
      case 'reservoir':
        this.reservoirProgress = 0; this.reservoirDone = false;
        this.firedMilestones.clear(); this.resLastAngle = null; break;
      case 'parks': this.visitedParks.clear(); break;
      case 'landmarks': this.visitedLandmarks.clear(); break;
      default: return;
    }
    this.completed.delete(id); // let it re-toast when re-earned
    this.dirty = true;
    for (const cb of this.changeCbs) cb();
    this.flush(true);
  }

  /** Wipe all goal progress. */
  resetAll() {
    this.subway = this.bus = this.bike = this.run = this.heli = this.transfer = false;
    this.runAccum = this.heliAccum = 0;
    this.pending = false; this.lastRoute = null; this.resLastAngle = null;
    this.modes.clear();
    this.visitedHoods.clear(); this.visitedParks.clear(); this.visitedLandmarks.clear();
    this.reservoirProgress = 0; this.reservoirDone = false; this.firedMilestones.clear();
    this.completed.clear();
    this.dirty = true;
    for (const cb of this.changeCbs) cb();
    this.flush(true);
  }
}
