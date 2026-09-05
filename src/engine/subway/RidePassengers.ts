import * as THREE from 'three';
import { quality } from '../quality';
import { TransitPassengerBatch, passengerRandom } from './transitPassengers';
import { canExchangePassengers } from './passengerNavigation';

export interface RidePassengerState {
  stationId: string; platformSide: 1 | -1; doorOpenAmt: number; state: string;
  /** Real seconds until closing begins. Exchanges are disabled if unavailable. */
  boardingRemaining?: number;
}
interface Rider { x: number; z: number; startX: number; startZ: number; seated: boolean; yaw: number; progress: number; exiting: boolean }

/** A fixed cabin pool: seated riders plus standing riders at door bays. First
 * let riders leave, then a small replacement wave enters from the same visible
 * platform. Center aisle/player spawn stays clear. */
export class RidePassengers {
  readonly batch: TransitPassengerBatch;
  private readonly riders: Rider[] = [];
  private readonly width: number;
  private elapsed = 0;
  private stationId = '';
  private openAge = 0;
  private exchangeStarted = false;
  private exchangeSide: 1 | -1 = 1;

  constructor(parent: THREE.Object3D, length: number, width: number, bays: readonly number[], seed: number) {
    this.width = width;
    const rng = passengerRandom(seed), seats = Math.min(quality().level === 'low' ? 6 : 10, (bays.length - 1) * 4);
    this.batch = new TransitPassengerBatch(parent, seats + 2, seed);
    // Longitudinal seats occupy the wall segments between adjacent openings.
    for (let i = 0; i < seats; i++) {
      const pair = Math.floor(i / 2), gap = pair % (bays.length - 1), side = i % 2 ? 1 : -1;
      const mid = (bays[gap] + bays[gap + 1]) / 2;
      const stagger = pair >= bays.length - 1 ? .65 : -.65;
      const x = Math.max(-length / 2 + 1, Math.min(length / 2 - 1, mid + stagger));
      const z = side * (width / 2 - .31);
      this.riders.push({ x, z, startX: x, startZ: z, seated: true, yaw: side * Math.PI / 2, progress: 0, exiting: false });
    }
    for (const sign of [-1, 1]) {
      const x = sign < 0 ? bays[0] : bays[bays.length - 1], z = sign * .65;
      this.riders.push({ x, z, startX: x, startZ: z, seated: false, yaw: rng() > .5 ? 0 : Math.PI, progress: 0, exiting: false });
    }
    this.render();
  }

  update(dt: number, state: RidePassengerState): void {
    this.elapsed += dt;
    if (state.stationId !== this.stationId) {
      this.stationId = state.stationId; this.openAge = 0; this.exchangeStarted = false;
      this.exchangeSide = state.platformSide;
      // Off-car occupants belong to the station they left at. A replacement
      // waits outside the *new* platform doorway and only enters while open.
      for (const p of this.riders) if (!p.seated && Math.abs(p.z) > this.width / 2) {
        p.z = state.platformSide * (this.width / 2 + 1.35); p.progress = 1; p.exiting = false;
      }
    }
    const fullyOpen = state.doorOpenAmt >= .999 && state.state === 'dwell';
    if (fullyOpen) this.openAge += dt;
    const remaining = state.boardingRemaining ?? 0;
    if (fullyOpen && !this.exchangeStarted && canExchangePassengers(true, remaining, 3.6)) {
      this.exchangeStarted = true; this.exchangeSide = state.platformSide;
      for (const p of this.riders) if (!p.seated) {
        // Standing occupants initially move laterally along the unobstructed
        // door bay, with the first wave using the platform's actual side.
        p.startZ = p.z; p.exiting = Math.abs(p.z) < this.width / 2; p.progress = p.exiting ? 0 : 1;
      }
    }
    for (const p of this.riders) {
      if (p.seated || !this.exchangeStarted) continue;
      if (!fullyOpen) {
        // Resolve a completed exchange before closure. Any rider still outside
        // is retained for the next open dwell, never walking through steel.
        if (Math.abs(p.z) > this.width / 2 - .3) { p.z = this.exchangeSide * (this.width / 2 + 1.35); p.exiting = false; continue; }
        p.exiting = false; p.progress = 3; continue;
      }
      const outsideZ = this.exchangeSide * (this.width / 2 + 1.35);
      if (p.exiting) {
        const delta = outsideZ - p.z, step = Math.min(Math.abs(delta), dt * 1.25);
        p.z += Math.sign(delta) * step; p.yaw = this.exchangeSide > 0 ? -Math.PI / 2 : Math.PI / 2;
        if (Math.abs(delta) <= step) { p.exiting = false; p.progress = 1; }
      } else if (p.progress === 1 && this.openAge > 3 && canExchangePassengers(true, remaining, Math.abs(p.z - this.exchangeSide * .65))) {
        p.progress = 2;
      } else if (p.progress === 2) {
        const insideZ = this.exchangeSide * .65, delta = insideZ - p.z, step = Math.min(Math.abs(delta), dt * 1.25);
        p.z += Math.sign(delta) * step; p.yaw = this.exchangeSide > 0 ? Math.PI / 2 : -Math.PI / 2;
        if (Math.abs(delta) <= step) p.progress = 3;
      }
    }
    this.render();
  }

  private render(): void {
    let count = 0;
    for (let i = 0; i < this.riders.length; i++) {
      const p = this.riders[i];
      // Outside riders belong to the station crowd once clear of the visible
      // threshold. They cannot slide along the outside of a moving car.
      if (Math.abs(p.z) > this.width / 2 + .85) continue;
      this.batch.set(count++, { x: p.x, y: 0, z: p.z, yaw: p.yaw, seated: p.seated,
        walk: !p.seated && (p.exiting || p.progress === 2) ? 1 : 0, identity: i });
    }
    this.batch.update(this.elapsed); this.batch.commit(count);
  }

  dispose(): void { this.batch.dispose(); }
}
