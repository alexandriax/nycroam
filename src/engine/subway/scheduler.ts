import * as THREE from 'three';
import { Train } from './train';
import { directionLabel } from './directions';
import type { StationSpec, TrackInfo, NetworkData, Arrival } from './types';
import { quality } from '../quality';

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
  wasApproaching: boolean; // rising-edge latch for onArrive
}

// Internal seconds for a freshly-spawned train to go hidden->approach->dwell
// (BASE_DURATION.hidden 12 + approach 7; both deterministic now, see train.ts) —
// divided by the slot's timeScale to estimate the countdown for a track with no
// train on it yet. Kept in lockstep with the live train's own phase clock so the
// "no train yet" projection hands off seamlessly the instant a train spawns.
const SPAWN_TO_DWELL = 19;

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
  /** Fires when a boardable (non-express) train first pulls in, so the world
   *  can play a "train arriving" sound. */
  onArrive: (() => void) | null = null;

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
        flip: false,
        wasApproaching: false,
      });
    }
  }

  update(dt: number) {
    for (const s of this.slots) {
      if (s.train) {
        s.train.update(dt * s.timeScale);
        s.trainAge += dt;
        s.everVisible = s.everVisible || s.train.group.visible;
        // rising edge into 'approach' on a platform track = a train pulling in
        const approaching = s.train.phase === 'approach';
        if (approaching && !s.wasApproaching && !s.passThrough) this.onArrive?.();
        s.wasApproaching = approaching;
        // recycle once the cycle wraps back to hidden AFTER having run.
        // Deterministic spacing: the countdown boards project future arrivals
        // at exact `headway` intervals, and a ±20% jittered respawn made every
        // projected time visibly wrong (rows jumped when the real train
        // spawned). Real headways are metronomic; the boards now are too.
        if (s.everVisible && !s.train.group.visible && s.trainAge > 5) {
          this.parent.remove(s.train.group);
          s.train.dispose();
          s.train = null;
          s.cooldown = Math.max(2, this.headway - 30);
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
    s.trainAge = 0;
    s.everVisible = false;
    s.wasApproaching = false;
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
   * "R … 12 MIN" as separate rows instead of mashing "N/R". Per slot the imminent
   * train leads with a phase-accurate ETA read off the live train's own clock
   * (see the `anchor` note below), then the route ROTATION is projected forward
   * from that same anchor at headway spacing — so a row counts down monotonically
   * and reads "now" only while a train is genuinely pulling in or dwelling, never
   * the old ideal-headway projection that hit 0 before a train even existed. Up
   * to 3 per slot, sorted by the consumer.
   */
  arrivals(): Arrival[] {
    const out: Arrival[] = [];
    const respawn = Math.max(2, this.headway - 30); // recycle cooldown (see update())
    for (const s of this.slots) {
      if (s.passThrough) continue;
      const len = s.routes.length;
      const ts = s.timeScale;
      // `anchor` = REAL seconds until this slot's imminent train has its doors
      // open, read off the SAME clock that spawns and moves trains — never the
      // old ideal-headway projection that hit 0 before a train even existed.
      // `first` = which rotation slot that imminent train is. A live train stays
      // the anchor smoothly through hidden -> approach -> dwell (secondsToArrival
      // folds the hidden phase in); a DEPARTING train hands off to the next spawn
      // (the same recycle + hidden + approach budget update() will actually run);
      // an empty slot counts its cooldown down to the fixed spawn->dwell travel.
      // All three branches meet at equal values on their boundaries, so a board
      // row descends monotonically to "now" exactly as a train pulls in, then
      // rolls up to the next train the moment this one departs.
      let anchor: number, first: number;
      if (s.train && s.train.phase !== 'depart') {
        anchor = s.train.secondsToArrival / ts;
        first = s.routeIdx - 1; // spawn() already advanced routeIdx past the live train
      } else if (s.train) {
        anchor = s.train.stateRemaining / ts + respawn + SPAWN_TO_DWELL / ts;
        first = s.routeIdx;
      } else {
        anchor = Math.max(0, s.cooldown) + SPAWN_TO_DWELL / ts;
        first = s.routeIdx;
      }
      for (let k = 0; out.length < 64 && k < 3; k++) {
        const idx = (((first + k) % len) + len) % len;
        out.push({ dirSign: s.dirSign, routes: [s.routes[idx]], seconds: anchor + k * this.headway });
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
      this.parent.remove(slot.train.group);
      slot.train.dispose();
      slot.train = null;
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
      if (s.train) {
        this.parent.remove(s.train.group);
        s.train.dispose();
        s.train = null;
      }
    }
  }
}
