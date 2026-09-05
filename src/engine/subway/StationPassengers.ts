import * as THREE from 'three';
import { quality } from '../quality';
import { TRAIN_FLOOR_ABOVE_RAIL } from './trainGeometry';
import type { Train } from './train';
import type { PassengerTrain } from './scheduler';
import { TransitPassengerBatch, passengerRandom, passengerSeed } from './transitPassengers';
import { PassengerNavigation, canExchangePassengers, pathLength, type PassengerPoint, type PassengerPlatform } from './passengerNavigation';

type Activity = 'waiting' | 'walking' | 'onboard' | 'alighting' | 'boarding' | 'inactive';
interface Person extends PassengerPoint {
  id: number; y: number; yaw: number; platform: number; state: Activity;
  path: PassengerPoint[]; timer: number; seated: boolean;
  train: Train | null; localX: number; localZ: number; safeX: number; safeZ: number;
}
interface Exchange { openAge: number; exchanged: boolean; boarded: number; alighted: number; boardedDoors: Set<number> }
const SPEED = 1.25;

/** Bounded platform life plus riders seen through the windows of live trains.
 * Movement is planned on the authored floor minus stairs/furniture. Doorway
 * crossings use the actual car layout and fully-open live scheduler state. */
export class StationPassengers {
  readonly batch: TransitPassengerBatch;
  readonly people: Person[];
  private readonly platforms: readonly PassengerPlatform[];
  private readonly navigation: PassengerNavigation[];
  private readonly rng: () => number;
  private readonly exchanges = new Map<Train, Exchange>();
  private readonly trainPeople: number;
  private readonly stationaryCount: number;
  private elapsed = 0;
  private decisionTime = 0;

  constructor(parent: THREE.Object3D, platforms: readonly PassengerPlatform[], seed: string, trackCount = 2) {
    this.platforms = platforms;
    this.navigation = platforms.map(p => new PassengerNavigation(p));
    const level = quality().level;
    this.stationaryCount = level === 'low' ? 12 : level === 'medium' ? 18 : 26;
    this.trainPeople = level === 'low' ? 8 : level === 'medium' ? 12 : 16;
    const capacity = this.stationaryCount + this.trainPeople * trackCount + 8;
    this.rng = passengerRandom(passengerSeed(seed));
    this.batch = new TransitPassengerBatch(parent, capacity, passengerSeed(seed));
    this.people = Array.from({ length: capacity }, (_, id): Person => ({
      id, x: 0, y: 0, z: 0, yaw: 0, platform: id % Math.max(1, platforms.length),
      state: 'inactive', path: [], timer: this.rng() * 8, seated: false, train: null, localX: 0, localZ: 0, safeX: 0, safeZ: 0,
    }));
    for (let i = 0; i < this.stationaryCount && platforms.length; i++) {
      const p = this.people[i], nav = this.navigation[p.platform], floor = platforms[p.platform];
      for (let attempt = 0; attempt < 100; attempt++) {
        // More activity near the central cars while retaining people down the
        // platform. The middle walking lane is kept open around the player.
        const centerX = Math.max(floor.minX + .9, Math.min(floor.maxX - .9, 4));
        const minX = Math.max(floor.minX + .9, centerX - 58), maxX = Math.min(floor.maxX - .9, centerX + 58);
        const x = attempt < 3 && i < platforms.length * 2 ? 6.8 + attempt * 2.1 + Math.floor(i / platforms.length) * 4 : minX + this.rng() * (maxX - minX);
        const z = this.rng() > .5 ? floor.minZ + 1.05 : floor.maxZ - 1.05;
        if (!nav.valid({ x, z })) continue;
        p.x = x; p.z = z; p.y = floor.y; p.yaw = z < (floor.minZ + floor.maxZ) / 2 ? Math.PI / 2 : -Math.PI / 2;
        p.state = 'waiting'; break;
      }
    }
    this.render();
  }

  private toParent(train: Train, x: number, z: number): PassengerPoint {
    // Scheduler train groups only rotate around Y; no world-matrix traversal.
    const a = train.group.rotation.y, c = Math.cos(a), s = Math.sin(a);
    return { x: train.group.position.x + x * c + z * s, z: train.group.position.z - x * s + z * c };
  }
  private seedTrain(live: PassengerTrain): void {
    const train = live.train, cars = train.passengerLayout.cars;
    this.exchanges.set(train, { openAge: 0, exchanged: false, boarded: 0, alighted: 0, boardedDoors: new Set() });
    const rotation = Math.cos(train.group.rotation.y) < 0 ? -1 : 1;
    const localSide = live.platformSide * rotation;
    let created = 0;
    for (const p of this.people) {
      if (p.state !== 'inactive') continue;
      const car = cars[Math.floor(created * cars.length / this.trainPeople)];
      if (!car) break;
      p.train = train; p.state = 'onboard'; p.seated = created % 2 === 0;
      p.localX = p.seated ? car.seatX : car.doors[Math.floor(car.doors.length / 2)];
      p.localZ = p.seated ? -localSide * (train.passengerLayout.width / 2 - .35) : localSide * .55;
      p.yaw = p.localZ > 0 ? Math.PI / 2 : -Math.PI / 2;
      p.path.length = 0;
      created++;
      if (created >= this.trainPeople) break;
    }
  }

  private platformFor(live: PassengerTrain): number {
    let best = -1, distance = Infinity;
    this.platforms.forEach((p, i) => {
      if (p.boarding === false || Math.abs(p.y - live.train.group.position.y - TRAIN_FLOOR_ABOVE_RAIL) > .4) return;
      const center = (p.minZ + p.maxZ) / 2;
      if (Math.sign(center - live.trackZ) !== live.platformSide) return;
      const d = Math.abs(center - live.trackZ);
      if (d < distance) { distance = d; best = i; }
    });
    return best;
  }

  private beginExchange(live: PassengerTrain, exchange: Exchange): void {
    const train = live.train, platform = this.platformFor(live);
    if (platform < 0) return;
    const nav = this.navigation[platform], floor = this.platforms[platform];
    const side = live.platformSide, rotation = Math.cos(train.group.rotation.y) < 0 ? -1 : 1;
    const localSide = side * rotation, halfWidth = train.passengerLayout.width / 2;
    const edge = side > 0 ? floor.minZ : floor.maxZ;
    const remaining = train.passengerBoardingRemaining / live.timeScale;
    // Alight first. Pick standing riders at real bays; seated passengers remain
    // seated, so nobody jumps out of a bench or passes through a solid panel.
    if (!exchange.exchanged) {
      exchange.exchanged = true;
      const candidates = this.people.filter(p => p.train === train && p.state === 'onboard' && !p.seated);
      candidates.sort((a, b) => Math.abs(this.toParent(train, a.localX, a.localZ).x - 4) - Math.abs(this.toParent(train, b.localX, b.localZ).x - 4));
      for (const p of candidates) {
        const door = this.toParent(train, p.localX, localSide * halfWidth);
        const landing = { x: door.x, z: edge + side * .75 };
        const finish = { x: door.x + (p.id % 2 ? 1 : -1) * .9, z: edge + side * 1.1 };
        if (!nav.clear(landing, finish)) continue;
        const inside = this.toParent(train, p.localX, p.localZ);
        const path = [door, landing, finish];
        if (!canExchangePassengers(train.acceptingPassengers, remaining, pathLength(inside, path), SPEED)) continue;
        p.x = inside.x; p.z = inside.z; p.y = floor.y; p.path = path;
        p.state = 'alighting'; p.platform = platform; p.safeX = finish.x; p.safeZ = finish.z;
        if (++exchange.alighted >= 2) break;
      }
      exchange.openAge = 0;
      return;
    }
    // Preserve the central doorway for people leaving; board after the first
    // wave has cleared the threshold and only while a whole path will fit.
    if (exchange.openAge < 2.7 || exchange.boarded >= exchange.alighted) return;
    for (const p of this.people) {
      if (p.state !== 'waiting' || p.platform !== platform || p.timer < 1) continue;
      let best: { path: PassengerPoint[]; x: number; z: number; length: number; door: number } | null = null;
      for (const car of train.passengerLayout.cars) for (const dx of car.doors) {
        if (exchange.boardedDoors.has(dx) || this.people.some(rider => rider.train === train && rider.state === 'onboard' && !rider.seated && Math.abs(rider.localX - dx) < .75)) continue;
        const door = this.toParent(train, dx, localSide * halfWidth);
        if (Math.abs(door.x - p.x) > 4) continue;
        const landing = { x: door.x, z: edge + side * .75 };
        const approach = nav.path(p, landing);
        if (!approach) continue;
        const target = this.toParent(train, dx + .2, localSide * .55);
        const path = [...approach, door, target], length = pathLength(p, path);
        if (!canExchangePassengers(train.acceptingPassengers, remaining, length, SPEED)) continue;
        if (!best || length < best.length) best = { path, x: dx + .2, z: localSide * .55, length, door: dx };
      }
      if (!best) continue;
      exchange.boardedDoors.add(best.door);
      p.safeX = p.x; p.safeZ = p.z;
      p.path = best.path; p.train = train; p.localX = best.x; p.localZ = best.z; p.state = 'boarding'; p.seated = false;
      if (++exchange.boarded >= exchange.alighted) break;
    }
  }

  private walk(p: Person, dt: number): void {
    let distance = dt * SPEED;
    while (p.path.length && distance > 0) {
      const target = p.path[0], dx = target.x - p.x, dz = target.z - p.z, length = Math.hypot(dx, dz);
      if (length > 1e-6) p.yaw = Math.atan2(-dz, dx);
      // Briefly yield to nearby waiting commuters instead of passing through
      // them. Door waves already use separate reserved bays.
      if (p.state === 'walking' && length > .1) {
        const stride = Math.min(distance, length), nx = p.x + dx / length * stride, nz = p.z + dz / length * stride;
        if (this.people.some(other => other !== p && other.platform === p.platform && other.state === 'waiting' && Math.hypot(other.x - nx, other.z - nz) < .65)) {
          p.state = 'waiting'; p.path = []; p.timer = 0; return;
        }
      }
      if (length <= distance) { p.x = target.x; p.z = target.z; p.path.shift(); distance -= length; }
      else { p.x += dx / length * distance; p.z += dz / length * distance; distance = 0; }
    }
    if (p.path.length) return;
    if (p.state === 'boarding') { p.state = 'onboard'; p.yaw = p.localZ > 0 ? Math.PI / 2 : -Math.PI / 2; }
    else { p.state = 'waiting'; p.train = null; p.timer = 0; }
  }

  update(dt: number, trains: readonly PassengerTrain[]): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += dt; this.decisionTime += dt;
    const decide = this.decisionTime >= .25;
    if (decide) this.decisionTime = 0;
    // Removing a train only retires its onboard occupants. Commuters who have
    // already reached the platform stay there until a subsequent service.
    for (const train of this.exchanges.keys()) {
      if (trains.some(t => t.train === train)) continue;
      this.exchanges.delete(train);
      for (const p of this.people) if (p.train === train) {
        if (p.state === 'alighting') { p.state = 'waiting'; p.train = null; p.path = []; }
        else { p.state = 'inactive'; p.train = null; p.path = []; }
      }
    }
    for (const live of trains) {
      if (!this.exchanges.has(live.train)) this.seedTrain(live);
      const exchange = this.exchanges.get(live.train)!;
      if (live.train.acceptingPassengers) {
        exchange.openAge += dt;
        if (decide) this.beginExchange(live, exchange);
      }
    }
    for (const p of this.people) {
      if (p.state === 'inactive' || p.state === 'onboard') continue;
      p.timer += dt;
      if (p.path.length) {
        // Large suspended-tab frames cannot carry people across a closed door.
        // Finish them on the side they already reached; never continue through
        // a moving train or leave a person in the track gap.
        if ((p.state === 'boarding' || p.state === 'alighting') && !p.train?.acceptingPassengers) {
          const alreadyInside = p.train && Math.abs(p.z - p.train.group.position.z) < p.train.passengerLayout.width / 2;
          if (p.state === 'boarding' && alreadyInside) { p.state = 'onboard'; p.path = []; }
          else {
            p.x = p.safeX; p.z = p.safeZ;
            p.path = []; p.state = 'waiting'; p.train = null;
          }
          continue;
        }
        this.walk(p, dt);
      } else if (decide && p.timer > 5 + p.id % 9 && p.id % 4 === 0) {
        const nav = this.navigation[p.platform];
        const target = { x: p.x + (this.rng() * 2 - 1) * 9, z: p.z };
        const path = nav.path(p, target);
        if (path) { p.path = path; p.state = 'walking'; }
        p.timer = 0;
      }
    }
    this.render();
  }

  private render(): void {
    let count = 0;
    for (const p of this.people) {
      if (p.state === 'inactive') continue;
      let x = p.x, y = p.y, z = p.z, yaw = p.yaw;
      if (p.state === 'onboard' && p.train) {
        if (!p.train.group.visible) continue;
        const position = this.toParent(p.train, p.localX, p.localZ);
        x = position.x; z = position.z; y = p.train.group.position.y + TRAIN_FLOOR_ABOVE_RAIL;
        yaw += p.train.group.rotation.y;
      }
      this.batch.set(count++, { x, y, z, yaw, seated: p.seated, walk: p.path.length ? 1 : 0, identity: p.id });
    }
    this.batch.update(this.elapsed); this.batch.commit(count);
  }

  dispose(): void { this.batch.dispose(); this.exchanges.clear(); }
}

/** Capture authored prop footprints before architecture batches flatten them.
 * Coordinates remain local to the same node as its scheduler and passengers. */
export function collectPassengerObstacles(parent: THREE.Object3D, floorY: number): import('./passengerNavigation').PassengerRect[] {
  parent.updateWorldMatrix(true, true);
  const inverse = parent.matrixWorld.clone().invert(), box = new THREE.Box3();
  const out: import('./passengerNavigation').PassengerRect[] = [];
  parent.traverse(object => {
    if (!object.userData.stationProp) return;
    box.setFromObject(object).applyMatrix4(inverse);
    if (box.max.y < floorY + .08 || box.min.y > floorY + 1.6) return;
    out.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
  });
  return out;
}
