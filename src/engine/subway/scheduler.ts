import * as THREE from 'three';
import { Train } from './train';
import { directionLabel } from './directions';
import type { StationSpec, TrackInfo, NetworkData, Arrival } from './types';

/** Express partner shown blasting through local stations' center tracks. */
const EXPRESS_PARTNER: Record<string, string> = {
  '6': '5', '1': '2', C: 'A', E: 'A', R: 'N', W: 'Q', F: 'B', M: 'D', B: 'A', D: 'A',
};

export interface BoardableTrain {
  route: string;
  dirSign: 1 | -1; // +1 = uptown (north)
  trackZ: number;
}

interface Slot {
  trackZ: number;
  dirSign: 1 | -1;
  routes: string[]; // rotation
  routeIdx: number;
  train: Train | null;
  trainAge: number;
  everVisible: boolean;
  timeScale: number;
  cooldown: number; // seconds until next spawn
  passThrough: boolean;
  platformSide: 1 | -1; // train-LOCAL z-sign facing the platform (doors open here)
  flip: boolean; // travels opposite to dirSign-along-+x (TrackInfo.trackFlips)
}

// Rough real seconds for a freshly-spawned train to go hidden->approach->dwell,
// before the timeScale compression is applied — used to estimate the countdown
// for a track with no train on it yet.
const SPAWN_TO_DWELL = 19;

/**
 * Runs arrivals on a station's tracks: one train per track at a time, cycling
 * the routes that serve the station, timed so a train serves each direction
 * roughly every `headway` seconds. Exposes dwelling trains for boarding.
 *
 * Attaches trains to any parent Object3D — a whole scene (classic single-line
 * StationWorld) or one group node of a ComplexStationWorld, whose rotation
 * carries the trains into that group's world frame. All positions here are the
 * parent's LOCAL frame. When `info.trackRoutes` is present each stopping track
 * runs exactly those routes (real local/express assignments); `info.stubEnd`
 * makes the group a terminal: trains arrive from the open end and reverse out.
 */
export class TrainScheduler {
  private parent: THREE.Object3D;
  private spec: StationSpec;
  private info: TrackInfo;
  private slots: Slot[] = [];
  private headway: number;

  constructor(parent: THREE.Object3D, spec: StationSpec, info: TrackInfo, network: NetworkData | null, headway = 30) {
    this.parent = parent;
    this.spec = spec;
    this.info = info;
    this.headway = headway;

    // routes that can actually be ridden (present in the network) come first
    const rideable = spec.routes.filter((r) => !network || network.routes[r]);
    const routes = rideable.length ? rideable : spec.routes;
    // prefer rideable routes within an explicit per-track rotation too
    const prefRideable = (rs: string[]): string[] => {
      const ok = rs.filter((r) => !network || network.routes[r]);
      return ok.length ? ok : rs;
    };

    const stopping = info.trackZs;
    stopping.forEach((tz, i) => {
      const dirSign: 1 | -1 = info.trackDirs?.[i] ?? (i % 2 === 0 ? 1 : -1);
      // Explicit per-track routes (complex specs) win. Otherwise: ≤2 stopping
      // tracks rotate all routes; 4 tracks split first route to the outer pair
      // and the rest to the inner pair (locals out, express in).
      let assigned = info.trackRoutes?.[i] ? prefRideable(info.trackRoutes[i]) : routes;
      if (!info.trackRoutes?.[i] && stopping.length >= 4) {
        const outer = i === 0 || i === stopping.length - 1;
        assigned = outer ? [routes[0]] : routes.slice(1);
        if (!assigned.length) assigned = routes;
      }
      // Doors/openings face the platform. The train group is rotated 180° when
      // it travels toward local -x (downtown normally; the ARRIVING leg at a
      // stub terminal; flipped tracks reverse it), which flips its local
      // z-axis, so the LOCAL platform side is the world side times that flip.
      const flip = info.trackFlips?.[i] ?? false;
      const travelSign = info.stubEnd ?? ((flip ? -dirSign : dirSign) as 1 | -1);
      const worldSide = info.platformSides?.[i] ?? 1;
      const platformSide: 1 | -1 = (worldSide * (travelSign === -1 ? -1 : 1)) as 1 | -1;
      this.slots.push({
        trackZ: tz,
        dirSign,
        routes: assigned,
        routeIdx: Math.floor(Math.random() * assigned.length),
        train: null,
        trainAge: 0,
        everVisible: false,
        timeScale: 1.35, // compresses the ~40s internal cycle to ~30s
        cooldown: Math.random() * headway, // stagger initial arrivals
        passThrough: false,
        platformSide,
        flip,
      });
    });

    for (const [j, tz] of (info.passTrackZs ?? []).entries()) {
      const explicit = info.passTrackRoutes?.[j];
      const ex = explicit?.length
        ? explicit
        : [EXPRESS_PARTNER[spec.routes[0]] ?? spec.routes[0]];
      this.slots.push({
        trackZ: tz,
        dirSign: info.passTrackDirs?.[j] ?? (j % 2 === 0 ? -1 : 1),
        routes: ex,
        routeIdx: 0,
        train: null,
        trainAge: 0,
        everVisible: false,
        timeScale: 0.45, // slows the fixed approach duration to a realistic blast-through
        cooldown: 10 + Math.random() * 25,
        passThrough: true,
        platformSide: 1, // express blows through; doors never open
        flip: false,
      });
    }
  }

  update(dt: number) {
    for (const s of this.slots) {
      if (s.train) {
        s.train.update(dt * s.timeScale);
        s.trainAge += dt;
        s.everVisible = s.everVisible || s.train.group.visible;
        // recycle once the cycle wraps back to hidden AFTER having run
        if (s.everVisible && !s.train.group.visible && s.trainAge > 5) {
          this.parent.remove(s.train.group);
          s.train.dispose();
          s.train = null;
          s.cooldown = Math.max(2, this.headway * (0.8 + Math.random() * 0.4) - 30);
        }
        continue;
      }
      s.cooldown -= dt;
      if (s.cooldown <= 0) this.spawn(s);
    }
  }

  private spawn(s: Slot) {
    const route = s.routes[s.routeIdx % s.routes.length];
    s.routeIdx++;
    const train = new Train({
      division: this.spec.division,
      routes: [route],
      platformSide: s.platformSide,
      dirLabel: directionLabel([route], s.dirSign, this.spec.name),
    });
    train.group.position.set(0, this.info.railY, s.trackZ);
    // Orientation follows the direction of TRAVEL through the station: the
    // service direction normally (mirrored on flipped tracks), the inbound leg
    // at a stub terminal (where the train then reverses out with its rear cab
    // leading, like a real relay).
    const stub = this.info.stubEnd;
    const travelSign = stub ?? (s.flip ? -s.dirSign : s.dirSign);
    if (travelSign === -1) train.group.rotation.y = Math.PI;
    const bb = new THREE.Box3().setFromObject(train.group);
    const portal = this.info.portal;
    if (s.passThrough) {
      train.setTravel(-portal - bb.max.x, portal + 30 - bb.min.x, portal + 120 - bb.min.x);
    } else if (stub) {
      // terminal: in from the open (-stub) portal, dwell centered on the
      // platform, then back out the same portal (interp runs stop -> to, so a
      // `to` on the arrival side plays as a reverse move)
      const from = stub === 1 ? -portal - bb.max.x : portal - bb.min.x;
      train.setTravel(from, -(bb.min.x + bb.max.x) / 2, from);
    } else {
      train.setTravel(-portal - bb.max.x, -(bb.min.x + bb.max.x) / 2, portal - bb.min.x);
    }
    train.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.parent.add(train.group);
    s.train = train;
    s.trainAge = 0;
    s.everVisible = false;
  }

  /** A dwelling, doors-open train the player (at parent-local x,z) can board. */
  boardable(px: number, pz: number): BoardableTrain | null {
    for (const s of this.slots) {
      if (s.passThrough || !s.train || !s.train.doorsOpen) continue;
      const dz = Math.abs(pz - s.trackZ);
      if (dz < 4.2 && Math.abs(px) < this.info.half * 0.95) {
        const route = s.routes[(s.routeIdx - 1 + s.routes.length) % s.routes.length];
        return { route, dirSign: s.dirSign, trackZ: s.trackZ };
      }
    }
    return null;
  }

  get trainStates() {
    return this.slots
      .filter((s) => s.train)
      .map((s) => ({ x: Math.round(s.train!.group.position.x * 10) / 10, doors: s.train!.doorsOpen }));
  }

  /**
   * Upcoming trains for the platform countdown displays, ONE ENTRY PER TRAIN
   * (each with a single route) so the boards can list "N … 2 MIN" and
   * "R … 12 MIN" as separate rows instead of mashing "N/R". Per slot: the
   * inbound train (if any) leads with its live time-to-dwell, then the route
   * ROTATION is projected forward at ~headway spacing — so the same order the
   * scheduler will actually spawn. Up to 3 per slot, sorted by the consumer.
   */
  arrivals(): Arrival[] {
    const out: Arrival[] = [];
    for (const s of this.slots) {
      if (s.passThrough) continue;
      const len = s.routes.length;
      let base: number; // seconds until the FIRST of the projected spawns dwells
      if (s.train) {
        const eta = s.train.secondsToArrival;
        if (eta !== Infinity) {
          // inbound/dwelling train: it is routes[routeIdx-1] (spawn incremented)
          out.push({ dirSign: s.dirSign, routes: [s.routes[(s.routeIdx - 1 + len) % len]], seconds: eta / s.timeScale });
        }
        // next spawn comes after this train's remaining cycle + recycle cooldown
        base = (eta === Infinity ? 0 : eta / s.timeScale) + this.headway;
      } else {
        base = Math.max(0, s.cooldown) + SPAWN_TO_DWELL / s.timeScale;
      }
      for (let k = 0; out.length < 64 && k < 3; k++) {
        out.push({ dirSign: s.dirSign, routes: [s.routes[(s.routeIdx + k) % len]], seconds: base + k * this.headway });
      }
    }
    return out;
  }

  dispose() {
    for (const s of this.slots) {
      if (s.train) {
        this.parent.remove(s.train.group);
        s.train.dispose();
        s.train = null;
      }
    }
  }
}
