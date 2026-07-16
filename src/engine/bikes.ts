import * as THREE from 'three';
import { mergeByMaterial, disposeGroup } from './EntranceManager';
import { heightAt } from './terrain';
import { hash01 } from './palette';

/**
 * Public bike docks at real NYC bike-share locations (public/geo/bikes.json,
 * baked by scripts/fetch-bikes.mjs). Unbranded: blue bikes on gray docks.
 *
 * Game invariant — every dock always keeps at least one bike AND one empty
 * slot: counts initialize in [2, slots-2], grabbing needs bikes >= 2 and
 * docking needs bikes <= slots-2, so no interaction can drain or fill one.
 */

interface DockSpec {
  n: string;
  c: number; // real capacity
  p: [number, number];
}

export interface PlacedDock {
  idx: number;
  spec: DockSpec;
  slots: number; // rendered docking points (capacity, visually capped)
  group: THREE.Group;
  pos: [number, number];
  rotY: number;
}

const FRAME_BLUE = new THREE.MeshLambertMaterial({ color: '#1e63c8' });
const RUBBER = new THREE.MeshLambertMaterial({ color: '#1a1b1f' });
const STEEL = new THREE.MeshLambertMaterial({ color: '#8f959b' });
const PLATFORM = new THREE.MeshLambertMaterial({ color: '#63676c' });
const POST = new THREE.MeshLambertMaterial({ color: '#43474c' });

const SLOT_PITCH = 0.78;
const MAX_VISUAL_SLOTS = 18;

/** Cylinder stretched between two points (frame tubes, forks, stays). */
function tube(unit: THREE.CylinderGeometry, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.Mesh {
  const m = new THREE.Mesh(unit, mat);
  const len = a.distanceTo(b);
  m.scale.set(r, len, r);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

/** Low-poly step-through bike, ~1.7m long, facing local +z, origin at ground. */
function buildBike(unit: THREE.CylinderGeometry, wheelGeo: THREE.TorusGeometry): THREE.Group {
  const g = new THREE.Group();
  const rear = new THREE.Vector3(0, 0.34, -0.55);
  const front = new THREE.Vector3(0, 0.34, 0.55);
  const bb = new THREE.Vector3(0, 0.30, -0.02); // bottom bracket
  const seatTop = new THREE.Vector3(0, 0.92, -0.32);
  const headTop = new THREE.Vector3(0, 0.98, 0.42);
  const headLow = new THREE.Vector3(0, 0.62, 0.50);

  for (const c of [rear, front]) {
    const w = new THREE.Mesh(wheelGeo, RUBBER);
    w.position.copy(c);
    g.add(w);
  }
  const V = (v: THREE.Vector3) => v;
  g.add(tube(unit, FRAME_BLUE, V(bb), V(seatTop), 0.028));            // seat tube
  g.add(tube(unit, FRAME_BLUE, V(bb), V(headLow), 0.032));            // down tube
  g.add(tube(unit, FRAME_BLUE, V(seatTop), V(headTop), 0.026));       // top tube (step-through-ish)
  g.add(tube(unit, FRAME_BLUE, V(bb), V(rear), 0.02));                // chain stay
  g.add(tube(unit, FRAME_BLUE, V(seatTop), V(rear), 0.02));           // seat stay
  g.add(tube(unit, STEEL, V(headTop), V(front), 0.022));              // fork
  const barL = new THREE.Vector3(-0.24, 1.02, 0.42);
  const barR = new THREE.Vector3(0.24, 1.02, 0.42);
  g.add(tube(unit, STEEL, barL, barR, 0.02));                         // handlebar
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.26), RUBBER);
  seat.position.set(0, 0.96, -0.34);
  g.add(seat);
  return g;
}

/** One dock station: platform, per-slot posts, and `bikes` docked bikes. */
function buildDockKit(slots: number, bikes: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  const unit = new THREE.CylinderGeometry(1, 1, 1, 6);
  const wheelGeo = new THREE.TorusGeometry(0.31, 0.036, 6, 14);
  wheelGeo.rotateY(Math.PI / 2);
  const len = slots * SLOT_PITCH + 0.5;

  const platform = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 1.9), PLATFORM);
  platform.position.y = 0.07;
  g.add(platform);

  // deterministic occupied-slot pattern: shuffle slot indices by hash
  const order = [...Array(slots).keys()].sort((a, b) => hash01(seed * 131 + a * 7) - hash01(seed * 131 + b * 7));
  const occupied = new Set(order.slice(0, bikes));

  const postGeo = new THREE.BoxGeometry(0.10, 0.72, 0.34);
  for (let i = 0; i < slots; i++) {
    const x = -len / 2 + 0.55 + i * SLOT_PITCH;
    const post = new THREE.Mesh(postGeo, POST);
    post.position.set(x, 0.5, -0.55);
    g.add(post);
    if (occupied.has(i)) {
      const bike = buildBike(unit, wheelGeo);
      bike.position.set(x, 0.14, 0.18);
      g.add(bike);
    }
  }
  return g;
}

export class BikeManager {
  private scene: THREE.Scene;
  private data: DockSpec[] | null = null;
  private placed = new Map<number, PlacedDock>();
  private bikeCounts = new Map<number, number>(); // session state, per dock index
  private timer = 0;
  private placeRadius = 380;
  private eject: ((x: number, z: number) => [number, number] | null) | null;
  private wallDir: ((x: number, z: number) => [number, number] | null) | null;

  constructor(
    scene: THREE.Scene,
    eject: ((x: number, z: number) => [number, number] | null) | null = null,
    wallDir: ((x: number, z: number) => [number, number] | null) | null = null,
  ) {
    this.scene = scene;
    this.eject = eject;
    this.wallDir = wallDir;
  }

  async init(): Promise<boolean> {
    try {
      const res = await fetch('/geo/bikes.json');
      if (!res.ok) return false;
      const json = await res.json();
      this.data = json.docks ?? null;
      return !!this.data;
    } catch {
      return false;
    }
  }

  private slotsFor(spec: DockSpec): number {
    return Math.min(MAX_VISUAL_SLOTS, Math.max(8, spec.c));
  }

  private countFor(idx: number, slots: number): number {
    let n = this.bikeCounts.get(idx);
    if (n === undefined) {
      n = Math.max(2, Math.min(slots - 2, 2 + Math.floor(hash01(idx * 13 + 5) * (slots - 3))));
      this.bikeCounts.set(idx, n);
    }
    return n;
  }

  update(x: number, z: number, dt: number) {
    if (!this.data) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.7;

    const r2 = this.placeRadius * this.placeRadius;
    for (let i = 0; i < this.data.length; i++) {
      const d = this.data[i];
      const dx = d.p[0] - x, dz = d.p[1] - z;
      const inRange = dx * dx + dz * dz < r2;
      const existing = this.placed.get(i);
      if (inRange && !existing) {
        let pos: [number, number] = [d.p[0], d.p[1]];
        if (this.eject) {
          let deferred = false;
          for (let k = 0; k < 3; k++) {
            const adj = this.eject(pos[0], pos[1]);
            if (adj === null) { deferred = true; break; }
            pos = adj;
          }
          if (deferred) continue;
        }
        const slots = this.slotsFor(d);
        const bikes = this.countFor(i, slots);
        // platform runs ALONG the nearest building line (curbside rack)
        const w = this.wallDir ? this.wallDir(pos[0], pos[1]) : null;
        const rotY = w ? Math.atan2(-w[1], w[0]) : hash01(i * 31 + 7) * Math.PI;
        this.placed.set(i, this.build(i, d, slots, bikes, pos, rotY));
      } else if (!inRange && existing) {
        this.scene.remove(existing.group);
        disposeGroup(existing.group);
        this.placed.delete(i);
      }
    }
  }

  private build(idx: number, spec: DockSpec, slots: number, bikes: number, pos: [number, number], rotY: number): PlacedDock {
    const group = mergeByMaterial(buildDockKit(slots, bikes, idx));
    group.position.set(pos[0], heightAt(pos[0], pos[1]) - 0.03, pos[1]);
    group.rotation.y = rotY;
    this.scene.add(group);
    return { idx, spec, slots, group, pos, rotY };
  }

  /** Rebuild a dock's meshes after its bike count changed. */
  private refresh(p: PlacedDock) {
    this.scene.remove(p.group);
    disposeGroup(p.group);
    this.placed.set(p.idx, this.build(p.idx, p.spec, p.slots, this.bikeCounts.get(p.idx)!, p.pos, p.rotY));
  }

  nearest(x: number, z: number, dist: number): { dock: PlacedDock; d: number; canGrab: boolean; canDock: boolean } | null {
    let best: PlacedDock | null = null;
    let bestD2 = dist * dist;
    for (const p of this.placed.values()) {
      const dx = p.pos[0] - x, dz = p.pos[1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    if (!best) return null;
    const bikes = this.countFor(best.idx, best.slots);
    return {
      dock: best,
      d: Math.sqrt(bestD2),
      canGrab: bikes >= 2,
      canDock: bikes <= best.slots - 2,
    };
  }

  grab(p: PlacedDock): boolean {
    const bikes = this.countFor(p.idx, p.slots);
    if (bikes < 2) return false;
    this.bikeCounts.set(p.idx, bikes - 1);
    this.refresh(this.placed.get(p.idx)!);
    return true;
  }

  dockBike(p: PlacedDock): boolean {
    const bikes = this.countFor(p.idx, p.slots);
    if (bikes > p.slots - 2) return false;
    this.bikeCounts.set(p.idx, bikes + 1);
    this.refresh(this.placed.get(p.idx)!);
    return true;
  }

  /** All dock positions, island-wide (minimap layer). */
  dockPositions(): [number, number][] {
    return this.data ? this.data.map((d) => d.p) : [];
  }

  destroy() {
    for (const p of this.placed.values()) {
      this.scene.remove(p.group);
      disposeGroup(p.group);
    }
    this.placed.clear();
  }
}
