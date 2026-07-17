import * as THREE from 'three';
import { mergeByMaterial, disposeGroup } from './EntranceManager';
import { heightAt } from './terrain';
import type { BusHud } from './bus/types';

/**
 * Roosevelt Island Tramway — a rideable aerial shuttle from Tramway Plaza
 * (2nd Ave / E 59th) over the East River to Roosevelt Island, parallel to the
 * Queensboro Bridge. Two counter-phased cabins (like the real funicular pair):
 * one dwells at Manhattan while the other dwells at the island.
 *
 * Sim is pure math and always runs; meshes build when the player comes within
 * range of the line and dispose beyond it (bus/bike pattern). Boarding is
 * grade-level: the engine has no floor collision on system meshes, so the
 * cable dips low at each terminal and the cabin floor meets a thin paved pad.
 *
 * The ride handle is structurally compatible with BusRideHandle — World's
 * mode-'bus' machinery drives the whole ride; the extra fields (interior,
 * floorY, eye, doorBothSides) describe the cabin instead of the bus.
 */

const M_TERM = { x: 1792, z: -394.5, name: '59 ST & 2 AV' };
const RI_TERM = { x: 2707, z: 72, name: 'ROOSEVELT ISLAND' };
const TRAM_COLOR = '#c8102e';

const DWELL = 22; // s at each terminal
const TRAVEL = 75; // s per crossing
const CYCLE = 2 * (DWELL + TRAVEL);
const DOOR_RAMP = 1.2; // s to open
const CLOSING = 2; // doors shut this long before departure
const HANG = 5.2; // cabin floor below the cable
const CABIN = { hx: 2.3, hz: 1.2, wallH: 2.6 } as const;
const INTERIOR = { minX: -1.7, maxX: 1.7, minZ: -0.85, maxZ: 0.85 } as const;

// module-level shared materials (never disposed)
const RED = new THREE.MeshLambertMaterial({ color: TRAM_COLOR });
const RED_DARK = new THREE.MeshLambertMaterial({ color: '#8e1220' });
const STEEL = new THREE.MeshStandardMaterial({ color: '#8f959b', metalness: 0.75, roughness: 0.4 });
const DARK = new THREE.MeshLambertMaterial({ color: '#2b2e33' });
const PAVE = new THREE.MeshLambertMaterial({ color: '#9a9d9f' });
const CEIL = new THREE.MeshBasicMaterial({ color: '#fff3dd' }); // emissive cabin ceiling
const FLOOR_MAT = new THREE.MeshLambertMaterial({ color: '#4a4d52' });

function bx(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, seg = 6): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, seg), mat);
  const len = a.distanceTo(b);
  m.scale.set(1, len, 1);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

interface CabinState {
  key: string;
  phase: number; // offset into the cycle, seconds
  s: number; // arc position along the path
  x: number; z: number; floorY: number; yaw: number;
  state: 'dwell' | 'closing' | 'moving';
  atTerm: 0 | 1 | null; // which terminal while dwelling/closing
  toTerm: 0 | 1; // travel destination (also the "approaching" terminal)
  doorT: number;
}

export interface TramRideHandle {
  readonly model: { group: THREE.Group };
  readonly hud: BusHud;
  readonly canExit: boolean;
  readonly atEnd: boolean;
  readonly pos: { x: number; z: number; yaw: number };
  readonly active: boolean;
  readonly interior: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly floorY: number;
  readonly eye: number;
  readonly doorBothSides: boolean;
  exitPos(): [number, number];
  end(): void;
}

export class TramSystem {
  private scene: THREE.Scene;
  private clockS = 0; // sim clock, seconds
  private pathXZ: [number, number][] = []; // fine polyline
  private pathY: number[] = [];
  private cum: number[] = []; // cumulative arc length
  private total = 0;
  private termS: [number, number] = [0, 0]; // arc positions of the terminals
  private ready = false;
  private built = false;
  private statics: THREE.Group | null = null;
  private cabinGroups: THREE.Group[] = [];
  private cabinLeaves: THREE.Mesh[][] = []; // per cabin door leaves
  private cabins: CabinState[] = [
    { key: 'A', phase: 0, s: 0, x: M_TERM.x, z: M_TERM.z, floorY: 0, yaw: 0, state: 'dwell', atTerm: 0, toTerm: 1, doorT: 0 },
    { key: 'B', phase: CYCLE / 2, s: 0, x: RI_TERM.x, z: RI_TERM.z, floorY: 0, yaw: 0, state: 'dwell', atTerm: 1, toTerm: 0, doorT: 0 },
  ];
  private ride: { cabin: CabinState; handle: TramRideHandle } | null = null;
  private rideMoved = false; // the ridden cabin has traveled since boarding — arrival dwells count as "end"

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Path depends on terrain height at the terminals — build lazily on the
   * first update, after loadTerrain has resolved. */
  private ensurePath() {
    if (this.ready) return;
    this.ready = true;
    const dx = RI_TERM.x - M_TERM.x, dz = RI_TERM.z - M_TERM.z;
    const len = Math.hypot(dx, dz);
    const gM = heightAt(M_TERM.x, M_TERM.z), gRI = heightAt(RI_TERM.x, RI_TERM.z);
    // hang points: cable dips to ground+5.7 at the terminals (grade boarding),
    // rises over the pylons and the shipping channel
    const hang: [number, number][] = [
      [0, gM + 5.7], [0.16, 48], [0.42, 78], [0.86, 36], [1, gRI + 5.7],
    ];
    for (let i = 0; i + 1 < hang.length; i++) {
      const [tA, yA] = hang[i], [tB, yB] = hang[i + 1];
      const spanLen = (tB - tA) * len;
      const sag = Math.min(8, spanLen * 0.05);
      const steps = Math.max(4, Math.round(spanLen / 4));
      for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
        const u = k / steps, t = tA + (tB - tA) * u;
        this.pathXZ.push([M_TERM.x + dx * t, M_TERM.z + dz * t]);
        this.pathY.push(yA + (yB - yA) * u - sag * 4 * u * (1 - u));
      }
    }
    this.cum = [0];
    for (let i = 1; i < this.pathXZ.length; i++) {
      const [ax, az] = this.pathXZ[i - 1], [bxx, bz] = this.pathXZ[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(bxx - ax, bz - az, this.pathY[i] - this.pathY[i - 1]));
    }
    this.total = this.cum[this.cum.length - 1];
    this.termS = [0, this.total];
  }

  /** Position + tangent yaw at arc length s (yaw for travel toward +s). */
  private at(s: number): { x: number; z: number; y: number; yaw: number } {
    const cl = Math.max(0, Math.min(this.total, s));
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.cum[mid] <= cl) lo = mid; else hi = mid - 1; }
    const i = Math.min(lo, this.cum.length - 2);
    const span = this.cum[i + 1] - this.cum[i] || 1;
    const u = (cl - this.cum[i]) / span;
    const [ax, az] = this.pathXZ[i], [bxx, bz] = this.pathXZ[i + 1];
    const x = ax + (bxx - ax) * u, z = az + (bz - az) * u;
    const y = this.pathY[i] + (this.pathY[i + 1] - this.pathY[i]) * u;
    // cabin local +x = forward: rotation.y maps +x onto (cos yaw, -sin yaw)
    const yaw = Math.atan2(-(bz - az), bxx - ax);
    return { x, z, y, yaw };
  }

  private stepCabin(c: CabinState) {
    const u = ((this.clockS + c.phase) % CYCLE + CYCLE) % CYCLE;
    let s: number, moving = false, toTerm: 0 | 1;
    if (u < DWELL) { s = 0; toTerm = 1; c.atTerm = 0; }
    else if (u < DWELL + TRAVEL) {
      const p = (u - DWELL) / TRAVEL;
      const e = p * p * (3 - 2 * p); // smoothstep ease both ends
      s = e * this.total; moving = true; toTerm = 1; c.atTerm = null;
    } else if (u < 2 * DWELL + TRAVEL) { s = this.total; toTerm = 0; c.atTerm = 1; }
    else {
      const p = (u - 2 * DWELL - TRAVEL) / TRAVEL;
      const e = p * p * (3 - 2 * p);
      s = (1 - e) * this.total; moving = true; toTerm = 0; c.atTerm = null;
    }
    c.toTerm = toTerm;
    c.s = s;
    const dwellElapsed = u < DWELL ? u : u < 2 * DWELL + TRAVEL && u >= DWELL + TRAVEL ? u - DWELL - TRAVEL : -1;
    if (moving) { c.state = 'moving'; c.doorT = 0; }
    else if (dwellElapsed >= DWELL - CLOSING) { c.state = 'closing'; c.doorT = Math.max(0, (DWELL - dwellElapsed) / CLOSING); }
    else { c.state = 'dwell'; c.doorT = Math.min(1, dwellElapsed / DOOR_RAMP); }
    const p = this.at(s);
    c.x = p.x; c.z = p.z; c.floorY = p.y - HANG;
    // keep the last travel yaw while dwelling so the cabin doesn't snap around
    if (moving) c.yaw = c.toTerm === 1 ? p.yaw : Math.atan2(Math.sin(p.yaw + Math.PI), Math.cos(p.yaw + Math.PI));
  }

  update(x: number, z: number, dt: number) {
    this.ensurePath();
    this.clockS += dt;
    for (const c of this.cabins) this.stepCabin(c);
    if (this.ride && this.ride.cabin.state === 'moving') this.rideMoved = true;

    // mesh streaming: the line's midpoint is the interest anchor
    const mid = { x: (M_TERM.x + RI_TERM.x) / 2, z: (M_TERM.z + RI_TERM.z) / 2 };
    const d = Math.hypot(x - mid.x, z - mid.z);
    if (!this.built && d < 1500) this.build();
    else if (this.built && d > 1800 && !this.ride) this.teardown();

    if (this.built) {
      for (let i = 0; i < this.cabins.length; i++) {
        const c = this.cabins[i], g = this.cabinGroups[i];
        g.position.set(c.x, c.floorY, c.z);
        g.rotation.y = c.yaw;
        for (const leaf of this.cabinLeaves[i]) {
          const sign = Math.sign(leaf.position.x) || 1;
          leaf.position.x = leaf.userData.x0 + sign * 0.85 * c.doorT;
        }
      }
    }
  }

  // ---- meshes ---------------------------------------------------------------

  private buildCabin(): { group: THREE.Group; leaves: THREE.Mesh[] } {
    const g = new THREE.Group(); // origin at the FLOOR center
    const { hx, hz, wallH } = CABIN;
    const stat = new THREE.Group();
    stat.add(bx(hx * 2, 0.12, hz * 2, FLOOR_MAT, 0, -0.06, 0)); // floor plate
    stat.add(bx(hx * 2, 0.1, hz * 2, RED, 0, wallH + 0.05, 0)); // roof
    stat.add(bx(hx * 2 + 0.1, 0.25, hz * 2 + 0.1, RED_DARK, 0, wallH + 0.22, 0)); // roof cap
    // sill walls all around (windows above are OPENINGS — no glass, no sorting)
    for (const sz of [-1, 1]) stat.add(bx(hx * 2, 1.0, 0.08, RED, 0, 0.5, sz * (hz - 0.04)));
    for (const sxx of [-1, 1]) stat.add(bx(0.08, 1.0, hz * 2, RED, sxx * (hx - 0.04), 0.5, 0));
    // corner pillars + window-band header
    for (const sxx of [-1, 1]) for (const sz of [-1, 1]) stat.add(bx(0.14, wallH, 0.14, RED_DARK, sxx * (hx - 0.07), wallH / 2, sz * (hz - 0.07)));
    for (const sz of [-1, 1]) stat.add(bx(hx * 2, 0.18, 0.08, RED, 0, wallH - 0.09, sz * (hz - 0.04)));
    for (const sxx of [-1, 1]) stat.add(bx(0.08, 0.18, hz * 2, RED, sxx * (hx - 0.04), wallH - 0.09, 0));
    // end-wall glazing bars (front/back stay enclosed above the sill)
    for (const sxx of [-1, 1]) for (const zz of [-0.6, 0, 0.6]) stat.add(bx(0.06, wallH - 1.2, 0.1, RED_DARK, sxx * (hx - 0.03), 1.0 + (wallH - 1.2) / 2, zz));
    // benches + warm ceiling (interiors read black in daylight without it)
    for (const sxx of [-1, 1]) stat.add(bx(0.9, 0.45, hz * 2 - 0.5, RED_DARK, sxx * (hx - 0.6), 0.22, 0));
    stat.add(bx(hx * 2 - 0.5, 0.04, hz * 2 - 0.5, CEIL, 0, wallH - 0.03, 0));
    // roof arm to the cable carriage
    stat.add(bx(0.3, HANG - 0.6, 0.3, STEEL, 0, wallH + (HANG - 0.6) / 2, 0));
    stat.add(bx(1.6, 0.5, 0.6, DARK, 0, HANG - 0.2, 0)); // wheel carriage
    g.add(mergeByMaterial(stat));
    // sliding door leaves on BOTH sides (dynamic)
    const leaves: THREE.Mesh[] = [];
    for (const sz of [-1, 1]) {
      for (const sxx of [-1, 1]) {
        const leaf = bx(0.85, wallH - 0.3, 0.06, RED_DARK, sxx * 0.43, (wallH - 0.3) / 2, sz * (hz + 0.02));
        leaf.userData.x0 = leaf.position.x;
        g.add(leaf);
        leaves.push(leaf);
      }
    }
    return { group: g, leaves };
  }

  private buildPylon(x: number, z: number, top: number, yaw: number): THREE.Group {
    const g = new THREE.Group();
    const ground = heightAt(x, z);
    const h = top - ground;
    const baseHalf = 3.4, topHalf = 1.6;
    const base = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (const [ux, uz] of base) {
      g.add(tube(
        new THREE.Vector3(ux * baseHalf, 0, uz * baseHalf * 0.7),
        new THREE.Vector3(ux * topHalf, h, uz * topHalf * 0.7), 0.24, STEEL));
    }
    const levels = Math.max(3, Math.round(h / 12));
    for (let i = 1; i <= levels; i++) {
      const f = i / levels, half = baseHalf + (topHalf - baseHalf) * f;
      g.add(bx(half * 2, 0.24, half * 1.4, STEEL, 0, h * f, 0));
    }
    g.add(bx(7.2, 0.7, 1.2, DARK, 0, h + 0.35, 0)); // saddle beam across the tracks
    g.position.set(x, ground, z);
    g.rotation.y = yaw;
    return g;
  }

  private build() {
    this.built = true;
    const statics = new THREE.Group();
    const dx = RI_TERM.x - M_TERM.x, dz = RI_TERM.z - M_TERM.z;
    const len = Math.hypot(dx, dz);
    const yawLine = Math.atan2(-dz, dx);
    const perp = { x: -dz / len, z: dx / len }; // horizontal normal to the line

    // pylons at the hang fractions (skip terminals)
    for (const [t, top] of [[0.16, 48], [0.42, 78], [0.86, 36]] as const) {
      statics.add(this.buildPylon(M_TERM.x + dx * t, M_TERM.z + dz * t, top, yawLine));
    }
    // two cable tracks offset either side of the line, cylinders every ~25m
    for (const off of [-2.6, 2.6]) {
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i < this.pathXZ.length; i += 6) {
        const [px, pz] = this.pathXZ[i];
        const v = new THREE.Vector3(px + perp.x * off, this.pathY[i], pz + perp.z * off);
        if (prev) statics.add(tube(prev, v, 0.07, DARK));
        prev = v;
      }
      const [ex, ez] = this.pathXZ[this.pathXZ.length - 1];
      const end = new THREE.Vector3(ex + perp.x * off, this.pathY[this.pathY.length - 1], ez + perp.z * off);
      if (prev && !prev.equals(end)) statics.add(tube(prev, end, 0.07, DARK));
    }
    // grade-level terminal pads + canopies + boards
    for (const term of [M_TERM, RI_TERM]) {
      const g = heightAt(term.x, term.z);
      const pad = new THREE.Group();
      pad.add(bx(16, 0.15, 8, PAVE, 0, 0.075, 0));
      for (const [cx, cz] of [[-6.5, -3], [6.5, -3], [-6.5, 3], [6.5, 3]] as const)
        pad.add(bx(0.3, 6.6, 0.3, STEEL, cx, 3.3, cz));
      pad.add(bx(15, 0.3, 7.4, RED_DARK, 0, 6.7, 0)); // canopy
      pad.add(bx(6.5, 1.0, 0.15, DARK, 0, 5.9, -3.4)); // name board (blank plate)
      pad.position.set(term.x, g, term.z);
      pad.rotation.y = yawLine;
      statics.add(pad);
    }
    this.statics = mergeByMaterial(statics);
    this.scene.add(this.statics);

    for (let i = 0; i < this.cabins.length; i++) {
      const { group, leaves } = this.buildCabin();
      this.scene.add(group);
      this.cabinGroups.push(group);
      this.cabinLeaves.push(leaves);
    }
  }

  private teardown() {
    this.built = false;
    if (this.statics) { this.scene.remove(this.statics); disposeGroup(this.statics); this.statics = null; }
    for (const g of this.cabinGroups) { this.scene.remove(g); disposeGroup(g); }
    this.cabinGroups = [];
    this.cabinLeaves = [];
  }

  // ---- boarding -------------------------------------------------------------

  boardable(x: number, z: number): { key: string; dest: string; door: [number, number] } | null {
    if (!this.ready || !this.built || this.ride) return null;
    for (const c of this.cabins) {
      if (c.state !== 'dwell' || c.doorT < 0.6) continue;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < 3.2) {
        return { key: c.key, dest: c.toTerm === 1 ? RI_TERM.name : M_TERM.name, door: [c.x, c.z] };
      }
    }
    return null;
  }

  nearestStation(x: number, z: number, r: number): { name: string; seconds: number } | null {
    if (!this.ready) return null;
    for (let t = 0; t < 2; t++) {
      const term = t === 0 ? M_TERM : RI_TERM;
      if (Math.hypot(x - term.x, z - term.z) > r) continue;
      // seconds until a cabin next OPENS at this terminal
      let best = Infinity;
      for (const c of this.cabins) {
        const u = ((this.clockS + c.phase) % CYCLE + CYCLE) % CYCLE;
        const dwellStart = t === 0 ? 0 : DWELL + TRAVEL;
        if (c.atTerm === t && c.state === 'dwell') return { name: term.name, seconds: 0 };
        let wait = (dwellStart - u + CYCLE) % CYCLE;
        best = Math.min(best, wait);
      }
      return { name: term.name, seconds: best };
    }
    return null;
  }

  board(key: string): TramRideHandle | null {
    if (!this.built || this.ride) return null;
    const idx = this.cabins.findIndex((c) => c.key === key);
    if (idx < 0) return null;
    const cabin = this.cabins[idx];
    if (cabin.state !== 'dwell') return null;
    const group = this.cabinGroups[idx];
    const sys = this;
    this.rideMoved = false; // fresh ride: the origin dwell is not an "end"
    const handle: TramRideHandle = {
      model: { group },
      get hud(): BusHud {
        const dest = cabin.toTerm === 1 ? RI_TERM.name : M_TERM.name;
        const here = cabin.atTerm === null ? dest : cabin.atTerm === 0 ? M_TERM.name : RI_TERM.name;
        return {
          route: 'TRAM', color: TRAM_COLOR, sbs: false, dest,
          state: cabin.state,
          thisStop: cabin.state === 'moving' ? dest : here,
          nextStop: null,
          // ARRIVAL dwells only — reporting atEnd at the origin dwell would let
          // World's 6s auto-step-off eject riders before departure
          atEnd: cabin.state !== 'moving' && sys.rideMoved,
        };
      },
      get canExit() { return cabin.state === 'dwell' && cabin.doorT > 0.7; },
      get atEnd() { return cabin.state !== 'moving' && sys.rideMoved; },
      get pos() { return { x: cabin.x, z: cabin.z, yaw: cabin.yaw }; },
      get active() { return true; },
      interior: INTERIOR,
      floorY: 0,
      eye: 1.58,
      doorBothSides: true,
      exitPos(): [number, number] {
        // step onto the terminal pad, biased inland (away from the river)
        const t = cabin.atTerm ?? cabin.toTerm;
        const inland = t === 0 ? -1 : 1;
        const dx = RI_TERM.x - M_TERM.x, dz = RI_TERM.z - M_TERM.z;
        const len = Math.hypot(dx, dz);
        return [cabin.x + (dx / len) * inland * 3.2, cabin.z + (dz / len) * inland * 3.2];
      },
      end() { sys.ride = null; },
    };
    this.ride = { cabin, handle };
    return handle;
  }

  /** Terminal pads for the minimap. */
  stationPositions(): [number, number][] {
    return [[M_TERM.x, M_TERM.z], [RI_TERM.x, RI_TERM.z]];
  }

  destroy() {
    this.teardown();
  }
}
