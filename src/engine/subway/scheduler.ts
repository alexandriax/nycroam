import * as THREE from 'three';
import { Train } from './train';
import type { StationSpec, TrackInfo, NetworkData } from './types';

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
}

/**
 * Runs arrivals on a station's tracks: one train per track at a time, cycling
 * the routes that serve the station, timed so a train serves each direction
 * roughly every `headway` seconds. Exposes dwelling trains for boarding.
 */
export class TrainScheduler {
  private scene: THREE.Scene;
  private spec: StationSpec;
  private info: TrackInfo;
  private slots: Slot[] = [];
  private headway: number;

  constructor(scene: THREE.Scene, spec: StationSpec, info: TrackInfo, network: NetworkData | null, headway = 30) {
    this.scene = scene;
    this.spec = spec;
    this.info = info;
    this.headway = headway;

    // routes that can actually be ridden (present in the network) come first
    const rideable = spec.routes.filter((r) => !network || network.routes[r]);
    const routes = rideable.length ? rideable : spec.routes;

    const stopping = info.trackZs;
    stopping.forEach((tz, i) => {
      const dirSign: 1 | -1 = i % 2 === 0 ? 1 : -1;
      // ≤2 stopping tracks: all routes rotate on each. 4 tracks: first route on
      // the outer pair, the rest on the inner pair (locals out, express in).
      let assigned = routes;
      if (stopping.length >= 4) {
        const outer = i === 0 || i === stopping.length - 1;
        assigned = outer ? [routes[0]] : routes.slice(1);
        if (!assigned.length) assigned = routes;
      }
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
      });
    });

    for (const [j, tz] of (info.passTrackZs ?? []).entries()) {
      const ex = EXPRESS_PARTNER[spec.routes[0]] ?? spec.routes[0];
      this.slots.push({
        trackZ: tz,
        dirSign: j % 2 === 0 ? -1 : 1,
        routes: [ex],
        routeIdx: 0,
        train: null,
        trainAge: 0,
        everVisible: false,
        timeScale: 0.45, // slows the fixed approach duration to a realistic blast-through
        cooldown: 10 + Math.random() * 25,
        passThrough: true,
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
          this.scene.remove(s.train.group);
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
    const train = new Train({ division: this.spec.division, routes: [route] });
    train.group.position.set(0, this.info.railY, s.trackZ);
    if (s.dirSign === -1) train.group.rotation.y = Math.PI;
    const bb = new THREE.Box3().setFromObject(train.group);
    const portal = this.info.portal;
    if (s.passThrough) {
      train.setTravel(-portal - bb.max.x, portal + 30 - bb.min.x, portal + 120 - bb.min.x);
    } else {
      train.setTravel(-portal - bb.max.x, -(bb.min.x + bb.max.x) / 2, portal - bb.min.x);
    }
    this.scene.add(train.group);
    s.train = train;
    s.trainAge = 0;
    s.everVisible = false;
  }

  /** A dwelling, doors-open train the player (at station-local x,z) can board. */
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

  dispose() {
    for (const s of this.slots) {
      if (s.train) {
        this.scene.remove(s.train.group);
        s.train.dispose();
        s.train = null;
      }
    }
  }
}
