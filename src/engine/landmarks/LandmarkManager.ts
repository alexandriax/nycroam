import * as THREE from 'three';
import { dataUrl } from '../dataver';
import { LANDMARKS_PLACED, type Landmark } from './registry';
import { mergeByMaterial, disposeGroup } from '../EntranceManager';
import { heightAt } from '../terrain';
import type { CollisionData } from '../tileTypes';
import type { LandmarkCtx } from './kit';

type BuilderMap = Record<string, (ctx: LandmarkCtx) => THREE.Group>;

/**
 * Coarse collision derived from a landmark's raw primitive tree (before the
 * per-material merge flattens it): each solid primitive's local AABB becomes a
 * rotated footprint ring with base/top heights, so walls push the player out,
 * roofs are landable, and elevated spans stay walkable underneath. Thin or low
 * pieces (struts, benches, fountains, panels) are skipped, as are arch walls —
 * an arch's AABB would seal the very opening you're meant to walk through.
 */
function deriveCollision(
  raw: THREE.Group, px: number, gy: number, pz: number, rot: number,
): CollisionData | null {
  raw.updateMatrixWorld(true);
  const boxes: { x0: number; z0: number; x1: number; z1: number; base: number; top: number; area: number }[] = [];
  const b3 = new THREE.Box3();
  raw.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if ((o.geometry as THREE.BufferGeometry).type === 'ExtrudeGeometry') return;
    b3.setFromObject(o);
    if (b3.isEmpty()) return;
    const h = b3.max.y - b3.min.y;
    const w = b3.max.x - b3.min.x, d = b3.max.z - b3.min.z;
    if (h < 2.2 || Math.min(w, d) < 0.5) return;
    // near-ground volumes read as grounded: a column shaft on a low stepped
    // plinth (steps themselves filtered as "low") must still block at street
    // level, while genuinely elevated spans (arch lintels, decks) stay open
    const base = b3.min.y < 2.5 ? b3.min.y - 3 : b3.min.y;
    boxes.push({ x0: b3.min.x, z0: b3.min.z, x1: b3.max.x, z1: b3.max.z, base, top: b3.max.y, area: w * d });
  });
  if (!boxes.length) return null;
  // biggest volumes first; cap so a strut-heavy build can't bloat the pack
  boxes.sort((a, b) => b.area - a.area);
  if (boxes.length > 48) boxes.length = 48;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const starts = new Uint32Array(boxes.length + 1);
  const pts = new Float32Array(boxes.length * 8);
  const aabb = new Float32Array(boxes.length * 4);
  const top = new Float32Array(boxes.length);
  const base = new Float32Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const bx = boxes[i];
    starts[i] = i * 4;
    const corners: [number, number][] = [[bx.x0, bx.z0], [bx.x1, bx.z0], [bx.x1, bx.z1], [bx.x0, bx.z1]];
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (let c = 0; c < 4; c++) {
      const [lx, lz] = corners[c];
      const wx = px + lx * cos + lz * sin;
      const wz = pz - lx * sin + lz * cos;
      pts[i * 8 + c * 2] = wx;
      pts[i * 8 + c * 2 + 1] = wz;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }
    aabb[i * 4] = minX; aabb[i * 4 + 1] = minZ; aabb[i * 4 + 2] = maxX; aabb[i * 4 + 3] = maxZ;
    top[i] = gy + bx.top;
    base[i] = gy + bx.base;
  }
  starts[boxes.length] = boxes.length * 4;
  return { ringStart: starts, points: pts, aabb, top, base };
}

interface Fit {
  cx: number; cz: number; rot: number;
  w: number; d: number; roofH: number; keptH: number; topW: number; topD: number;
}

/**
 * Streams premium landmark detail by proximity. Each themed set module
 * (./sets/<name>.ts) is a separate webpack chunk, dynamic-imported the first
 * time the player nears one of its landmarks; the built groups are merged
 * per material and disposed once the player leaves (activation radius +
 * 150m hysteresis). Distant districts therefore cost nothing — no bytes,
 * no triangles — and a landmark's cost while inactive is one distance check
 * per second.
 */
type RoadEject = (x: number, z: number, clearance: number) => [number, number] | null;

export class LandmarkManager {
  private scene: THREE.Scene;
  private roadEject: RoadEject | null;
  private placed = new Map<string, THREE.Group>();
  private building = new Set<string>();
  private sets = new Map<string, Promise<BuilderMap | null>>();
  private colSets = new Map<string, { data: CollisionData; x0: number; z0: number; x1: number; z1: number }>();
  private timer = 0;
  private initialPlaced = false;
  private fits: Record<string, Fit> | null = null;
  private fitsLoading: Promise<void> | null = null;

  constructor(scene: THREE.Scene, roadEject: RoadEject | null = null) {
    this.scene = scene;
    this.roadEject = roadEject;
  }

  private loadSet(name: string): Promise<BuilderMap | null> {
    let p = this.sets.get(name);
    if (!p) {
      p = import(`./sets/${name}`).then(
        (m: { builders: BuilderMap }) => m.builders,
        () => null, // a broken/missing set disables its landmarks, not the world
      );
      this.sets.set(name, p);
    }
    return p;
  }

  private loadFits(): Promise<void> {
    if (!this.fitsLoading) {
      this.fitsLoading = fetch(dataUrl('/geo/landmarks-fit.json'))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { this.fits = j?.fits ?? {}; })
        .catch(() => { this.fits = {}; });
    }
    return this.fitsLoading;
  }

  private async build(lm: Landmark) {
    if (this.building.has(lm.id) || this.placed.has(lm.id)) return;
    this.building.add(lm.id);
    try {
      await this.loadFits();
      const builders = await this.loadSet(lm.set);
      const make = builders?.[lm.id];
      if (!make) return;
      // building-attached landmarks snap to the measured host massing: its
      // oriented-bbox center and edge rotation beat any hand-typed anchor
      const fit = this.fits?.[lm.id];
      const px = fit ? fit.cx : lm.x;
      const pz = fit ? fit.cz : lm.z;
      const rot = fit ? fit.rot : (lm.rot ?? 0);
      const cos = Math.cos(rot), sin = Math.sin(rot);
      // road-sensitive landmarks wait for their tiles so clearRoad has data
      if (lm.needsRoads && this.roadEject && this.roadEject(px, pz, 0) === null) return;
      const ctx: LandmarkCtx = {
        // local offset -> world, so builders can terrace onto real terrain
        groundAt: (dx, dz) => heightAt(px + dx * cos + dz * sin, pz - dx * sin + dz * cos),
        fit: fit ? { w: fit.w, d: fit.d, roofH: fit.roofH, keptH: fit.keptH, topW: fit.topW, topD: fit.topD } : undefined,
        clearRoad: (dx, dz, clearance = 1.6) => {
          if (!this.roadEject) return [dx, dz];
          const wx = px + dx * cos + dz * sin;
          const wz = pz - dx * sin + dz * cos;
          const out = this.roadEject(wx, wz, clearance);
          if (!out) return [dx, dz];
          const ex = out[0] - px, ez = out[1] - pz;
          return [ex * cos - ez * sin, ex * sin + ez * cos];
        },
      };
      const raw = make(ctx);
      const gy = heightAt(px, pz);
      // collision comes from the raw primitive tree — the merge below
      // collapses everything into one geometry per material
      const collision = deriveCollision(raw, px, gy, pz, rot);
      const group = mergeByMaterial(raw);
      group.position.set(px, gy, pz);
      group.rotation.y = rot;
      this.scene.add(group);
      this.placed.set(lm.id, group);
      if (collision) {
        let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
        for (let i = 0; i < collision.aabb.length; i += 4) {
          if (collision.aabb[i] < x0) x0 = collision.aabb[i];
          if (collision.aabb[i + 1] < z0) z0 = collision.aabb[i + 1];
          if (collision.aabb[i + 2] > x1) x1 = collision.aabb[i + 2];
          if (collision.aabb[i + 3] > z1) z1 = collision.aabb[i + 3];
        }
        this.colSets.set(lm.id, { data: collision, x0, z0, x1, z1 });
      }
    } catch {
      /* a single failed landmark must never take the frame loop down */
    } finally {
      this.building.delete(lm.id);
    }
  }

  update(x: number, z: number, dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1.0;

    if (!this.initialPlaced) {
      this.initialPlaced = true;
      for (const lm of LANDMARKS_PLACED) if (lm.alwaysOn) void this.build(lm);
    }

    let started = 0;
    for (const lm of LANDMARKS_PLACED) {
      if (lm.alwaysOn) continue;
      const dx = lm.x - x, dz = lm.z - z;
      const d2 = dx * dx + dz * dz;
      const has = this.placed.has(lm.id);
      if (!has && d2 < lm.r * lm.r) {
        // stagger builds so approaching a dense district doesn't hitch a frame
        if (started < 2 && !this.building.has(lm.id)) {
          started++;
          void this.build(lm);
        }
      } else if (has && d2 > (lm.r + 150) * (lm.r + 150)) {
        const g = this.placed.get(lm.id)!;
        this.scene.remove(g);
        disposeGroup(g);
        this.placed.delete(lm.id);
        this.colSets.delete(lm.id);
      }
    }
  }

  /** Collision packs for landmarks whose bounds come near (x,z). */
  collisionNear(x: number, z: number): CollisionData[] {
    const out: CollisionData[] = [];
    for (const c of this.colSets.values()) {
      if (x < c.x0 - 40 || x > c.x1 + 40 || z < c.z0 - 40 || z > c.z1 + 40) continue;
      out.push(c.data);
    }
    return out;
  }

  /** Active landmark count (debug/stats). */
  get activeCount() { return this.placed.size; }

  destroy() {
    for (const g of this.placed.values()) {
      this.scene.remove(g);
      disposeGroup(g);
    }
    this.placed.clear();
    this.colSets.clear();
  }
}
