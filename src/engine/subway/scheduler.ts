import * as THREE from 'three';
import { Train } from './train';
import { directionLabel } from './directions';
import type { StationSpec, TrackInfo, NetworkData, Arrival } from './types';
import { quality } from '../quality';
import {
  INITIAL_TRAIN_STAGGER_SECONDS, SPAWN_TO_BOARDING, TRAIN_CYCLE_SECONDS,
  TRAIN_HEADWAY_SECONDS, TRAIN_TIME_SCALE,
} from './trainTiming';

/** Express partner shown blasting through local stations' center tracks. */
const EXPRESS_PARTNER: Record<string, string> = {
  '6': '5', '1': '2', C: 'A', E: 'A', R: 'N', W: 'Q', F: 'B', M: 'D', B: 'A', D: 'A',
};

export interface BoardableTrain {
  route: string;
  dirSign: 1 | -1; // +1 = uptown (north)
  trackZ: number;
}

/** A live stopping train and its parent-local platform context. Passenger
 * animation uses the same Train door timeline as player boarding and boards. */
export interface PassengerTrain {
  train: Train;
  trackZ: number;
  platformSide: 1 | -1;
  timeScale: number;
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
  platformWorldSide: 1 | -1; // parent-local z-sign, unaffected by train rotation
  flip: boolean; // travels opposite to dirSign-along-+x (TrackInfo.trackFlips)
  wasApproaching: boolean; // rising-edge latch for onArrive
}

// Real seconds a RE-SEEDED train (the one the player just stepped off) holds its
// doors open for re-boarding before it closes up and departs.
const REBOARD_DWELL_REAL = 8;

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
  private activePassengerTrains: PassengerTrain[] = [];
  /** Fires when a boardable (non-express) train first pulls in, so the world
   *  can play a "train arriving" sound. */
  onArrive: (() => void) | null = null;

  constructor(parent: THREE.Object3D, spec: StationSpec, info: TrackInfo, network: NetworkData | null, headway = TRAIN_HEADWAY_SECONDS) {
    this.parent = parent;
    this.spec = spec;
    this.info = info;
    this.headway = Math.max(
      Number.isFinite(headway) ? headway : TRAIN_HEADWAY_SECONDS,
      TRAIN_CYCLE_SECONDS / TRAIN_TIME_SCALE + 0.05,
    );

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
        timeScale: TRAIN_TIME_SCALE,
        cooldown: Math.random() * Math.min(INITIAL_TRAIN_STAGGER_SECONDS, this.headway),
        passThrough: false,
        platformSide,
        platformWorldSide: worldSide,
        flip,
        wasApproaching: false,
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
        platformWorldSide: 1,
        flip: false,
        wasApproaching: false,
      });
    }
  }

  update(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const s of this.slots) {
      // Consume phase and spawn boundaries exactly. A long frame must not
      // discard its overshoot and quietly push every subsequent train late.
      let remaining = dt;
      while (remaining > 1e-9) {
        if (!s.train) {
          const step = Math.min(remaining, Math.max(0, s.cooldown));
          s.cooldown -= step;
          remaining -= step;
          if (s.cooldown <= 1e-9) this.spawn(s);
          continue;
        }
        const step = Math.min(remaining, s.train.stateRemaining / s.timeScale);
        s.train.update(step * s.timeScale);
        s.trainAge += step;
        remaining -= step;
        s.everVisible ||= s.train.group.visible;
        const approaching = s.train.phase === 'approach';
        if (approaching && !s.wasApproaching && !s.passThrough) this.onArrive?.();
        s.wasApproaching = approaching;
        if (s.everVisible && s.train.phase === 'hidden') {
          this.releaseTrain(s);
          s.cooldown = this.recycleDelay(s);
        }
      }
    }
  }

  private recycleDelay(s: Slot): number {
    return Math.max(0.05, this.headway - TRAIN_CYCLE_SECONDS / s.timeScale);
  }

  private releaseTrain(s: Slot): void {
    if (!s.train) return;
    const index = this.activePassengerTrains.findIndex((entry) => entry.train === s.train);
    if (index >= 0) this.activePassengerTrains.splice(index, 1);
    s.train.group.removeFromParent();
    s.train.dispose();
    s.train = null;
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
    // Portal x for each end, sized so the train sits fully offstage: the south
    // (-x) end and the north (+x) end. Travel direction picks entry/exit ends —
    // an uptown train (+x travel) comes in from the south and leaves north, a
    // downtown train the reverse. (These used to be hardcoded south→north for
    // BOTH directions, so opposite-bound trains approached from the same end.)
    const southX = -portal - bb.max.x;
    const northX = portal - bb.min.x;
    if (s.passThrough) {
      train.setTravel(
        travelSign === 1 ? southX : northX,
        travelSign === 1 ? portal + 30 - bb.min.x : -portal - 30 - bb.max.x,
        travelSign === 1 ? portal + 120 - bb.min.x : -portal - 120 - bb.max.x,
      );
    } else if (stub) {
      // terminal: in from the open (-stub) portal, dwell centered on the
      // platform, then back out the same portal (interp runs stop -> to, so a
      // `to` on the arrival side plays as a reverse move)
      const from = stub === 1 ? southX : northX;
      train.setTravel(from, -(bb.min.x + bb.max.x) / 2, from);
    } else {
      train.setTravel(
        travelSign === 1 ? southX : northX,
        -(bb.min.x + bb.max.x) / 2,
        travelSign === 1 ? northX : southX,
      );
    }
    const dynamicShadows = quality().stationShadows;
    train.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        // A train used to turn every shell panel, door, pole, bogie and decal
        // into its own shadow submission. Roof meshes are the authored coarse
        // proxies; mobile uses the train's one-draw blob contacts instead.
        o.castShadow = dynamicShadows && o.userData.trainShadowCaster === true;
        o.receiveShadow = !o.userData.mobileContactShadow;
      }
    });
    this.parent.add(train.group);
    s.train = train;
    if (!s.passThrough) this.activePassengerTrains.push({
      train,
      trackZ: s.trackZ,
      platformSide: s.platformWorldSide,
      timeScale: s.timeScale,
    });
    s.trainAge = 0;
    s.everVisible = false;
    s.wasApproaching = false;
  }

  /** A dwelling, doors-open train the player (at parent-local x,z) can board. */
  boardable(px: number, pz: number): BoardableTrain | null {
    for (const s of this.slots) {
      if (s.passThrough || !s.train || !s.train.acceptingPassengers) continue;
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

  /** Reused live collection: no per-frame allocation for station crowds.
   * Entries disappear when their train leaves or is replaced after a ride. */
  passengerTrains(): readonly PassengerTrain[] {
    return this.activePassengerTrains;
  }

  /** Project route rotation from the live timeline. Later rows keep counting
   * down throughout dwell; Now appears only while boarding is available. */
  arrivals(): Arrival[] {
    const out: Arrival[] = [];
    for (const s of this.slots) {
      if (s.passThrough) continue;
      const respawn = this.recycleDelay(s);
      const nextSpawnToDoors = respawn + SPAWN_TO_BOARDING / s.timeScale;
      const hasCurrent = s.train && Number.isFinite(s.train.secondsToArrival);
      const next = s.train
        ? s.train.secondsToCycleEnd / s.timeScale + nextSpawnToDoors
        : Math.max(0, s.cooldown) + SPAWN_TO_BOARDING / s.timeScale;
      for (let k = 0; k < 3; k++) {
        const first = hasCurrent ? s.routeIdx - 1 : s.routeIdx;
        const index = ((first + k) % s.routes.length + s.routes.length) % s.routes.length;
        // Later rows keep ticking during dwell, instead of anchoring on a
        // frozen zero and jumping when doors close or a train is recycled.
        const seconds = hasCurrent && k === 0
          ? s.train!.secondsToArrival / s.timeScale
          : next + (k - (hasCurrent ? 1 : 0)) * this.headway;
        out.push({ dirSign: s.dirSign, routes: [s.routes[index]], seconds });
      }
    }
    return out;
  }

  /**
   * Put a doors-OPEN train on the track serving (route, dirSign) right now, so a
   * player who just stepped off a ride finds the train they rode still standing
   * at the platform, re-boardable, before it closes up and pulls out. Keeps the
   * rotation honest: the seeded train becomes this slot's current train (so
   * boardable()/arrivals() report it as "now"), and the normal recycle in
   * update() then spaces the next spawn a headway later — no double train on the
   * track, no permanent hole in the rotation. Returns the seeded track's local z
   * (so the world can drop the player beside it), or null if nothing matches.
   */
  seedDwell(route: string, dirSign: 1 | -1): number | null {
    const slot = this.slots.find((s) => !s.passThrough && s.dirSign === dirSign && s.routes.includes(route))
      ?? this.slots.find((s) => !s.passThrough && s.dirSign === dirSign);
    if (!slot) return null;
    // clear any existing train first so we never stack two on the track
    if (slot.train) {
      this.releaseTrain(slot);
    }
    // align the rotation so spawn() draws `route`, then force the fresh train to
    // an immediate open dwell (internal secs = real x the slot's time compression)
    const ri = slot.routes.indexOf(route);
    if (ri >= 0) slot.routeIdx = ri;
    this.spawn(slot);
    slot.train!.forceDwell(REBOARD_DWELL_REAL * slot.timeScale);
    slot.everVisible = true;
    slot.wasApproaching = false; // dwelling, not approaching — no false arrival roar
    slot.trainAge = 0;
    return slot.trackZ;
  }

  dispose() {
    for (const s of this.slots) {
      this.releaseTrain(s);
    }
  }
}
