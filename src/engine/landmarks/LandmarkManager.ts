import * as THREE from 'three';
import { dataUrl } from '../dataver';
import { LANDMARKS_PLACED, type Landmark } from './registry';
import { mergeByMaterial, disposeGroup } from '../EntranceManager';
import { heightAt } from '../terrain';
import type { CollisionData } from '../tileTypes';
import type { LandmarkCtx } from './kit';

type BuilderMap = Record<string, (ctx: LandmarkCtx) => THREE.Group>;

/**
 * A SOLID extruded mass carries its true plan in the 2D shape it was extruded
 * from. When that shape has been stood up so the extrusion axis is vertical (a
 * tower shaft, a laid-flat prism), its outline is the building's footprint —
 * recover it so collision hugs e.g. a triangular tower instead of a bounding box
 * that would swallow the crosswalks and sidewalks wrapping around it.
 *
 * Returns the outline as x,z pairs in the group's LOCAL frame (same frame the
 * box path uses, rotated into world together with everything else at emit time)
 * plus its polygon area, or null when the outline is NOT a horizontal footprint:
 * a vertical gable/pediment (edge-on, ~zero area), or a prism whose stand-up
 * rotation was baked into the geometry rather than the mesh matrix (matrixWorld
 * can't see it). The caller then falls back to the mesh AABB, which for those
 * cases is either a thin wall (fine) or elevated (harmless at street level).
 */
const _efPoint = new THREE.Vector3();
function extrudeFootprintLocal(mesh: THREE.Mesh): { pts: number[]; area: number } | null {
  const params = (mesh.geometry as THREE.ExtrudeGeometry).parameters as unknown as
    { shapes?: THREE.Shape | THREE.Shape[]; options?: { curveSegments?: number } } | undefined;
  if (!params?.shapes) return null;
  const shapes = Array.isArray(params.shapes) ? params.shapes : [params.shapes];
  const curveSeg = params.options?.curveSegments ?? 12;
  let best: number[] | null = null, bestArea = 0;
  for (const shape of shapes) {
    const outline = shape.extractPoints(curveSeg).shape; // 2D outline in the shape's XY plane
    if (outline.length < 3) continue;
    // shape XY (local z=0) -> mesh world matrix -> the group's LOCAL frame (x,z).
    // matrixWorld holds any rotation put on the MESH (a stood-up shaft), so a
    // horizontal shape lands as a horizontal footprint here.
    const local: number[] = [];
    for (const p of outline) {
      _efPoint.set(p.x, p.y, 0).applyMatrix4(mesh.matrixWorld);
      local.push(_efPoint.x, _efPoint.z);
    }
    // extractPoints closes the loop with a copy of the first point; drop it so a
    // triangle stays 3 vertices (and the <=12 decimation counts real corners).
    const m = local.length;
    if (m >= 6 && Math.abs(local[0] - local[m - 2]) < 1e-4 && Math.abs(local[1] - local[m - 1]) < 1e-4) {
      local.length -= 2;
    }
    // shoelace area in x,z (the later rot into world preserves it). Near-zero
    // means the outline is edge-on — a vertical wall, not a footprint.
    const n = local.length / 2;
    let a2 = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      a2 += local[j * 2] * local[i * 2 + 1] - local[i * 2] * local[j * 2 + 1];
    }
    const area = Math.abs(a2) / 2;
    if (area > bestArea) { bestArea = area; best = local; }
  }
  if (!best || bestArea < 1.0) return null; // no usable horizontal footprint
  // keep the ring small: evenly decimate a high-vertex outline to <= 12 points
  const n = best.length / 2;
  if (n > 12) {
    const step = Math.ceil(n / 12);
    const simp: number[] = [];
    for (let i = 0; i < n; i += step) simp.push(best[i * 2], best[i * 2 + 1]);
    best = simp;
  }
  return { pts: best, area: bestArea };
}

/**
 * Coarse collision derived from a landmark's raw primitive tree (before the
 * per-material merge flattens it): each solid primitive becomes a rotated
 * footprint ring with base/top heights, so walls push the player out, roofs are
 * landable, and elevated spans stay walkable underneath. Box/round masses use
 * their world AABB; SOLID extruded masses derive an accurate N-gon footprint
 * from the extrude outline (a triangular shaft blocks as a triangle, not a
 * street-swallowing box). Thin or low pieces (struts, benches, panels) are
 * skipped, as are arch walls (userData.passable) — an arch's footprint would
 * seal the very opening you're meant to walk under.
 *
 * Rings are variable-length (ringStart indexes per-ring vertex counts), so a
 * 4-corner box and an N-gon footprint coexist in one pack.
 */
function deriveCollision(
  raw: THREE.Group, px: number, gy: number, pz: number, rot: number,
): CollisionData | null {
  raw.updateMatrixWorld(true);
  // each kept primitive -> a LOCAL x,z polygon (variable length) + base/top/area
  const rings: { pts: number[]; base: number; top: number; area: number }[] = [];
  const b3 = new THREE.Box3();
  raw.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // arch openings stay walk-under: their footprint would seal the span you
    // walk through (Washington Sq arch, church portals, market arcades).
    if (o.userData.passable) return;
    const geoType = (o.geometry as THREE.BufferGeometry).type;
    b3.setFromObject(o);
    if (b3.isEmpty()) return;
    const h = b3.max.y - b3.min.y;
    if (h < 2.0) return; // too low to stop a standing player (steps, benches, parapets)
    // near-ground volumes read as grounded: a wall rising from a low stepped
    // plinth (the plinth itself filtered as "low") must still block at street
    // level, while genuinely elevated spans (arch lintels, decks) stay open
    const base = b3.min.y < 3.0 ? b3.min.y - 3 : b3.min.y;
    const top = b3.max.y;

    // SOLID extruded mass: prefer its true plan over the AABB. A triangular
    // Flatiron-style shaft must block ITS triangle, not a bounding box that
    // would wall off the surrounding traffic island and crosswalks.
    if (geoType === 'ExtrudeGeometry') {
      const fp = extrudeFootprintLocal(o);
      if (fp) { rings.push({ pts: fp.pts, base, top, area: fp.area }); return; }
      // outline wasn't a horizontal footprint (vertical gable, or baked stand-up
      // rotation) -> fall through: treat it like a flat wall via its AABB.
    }

    const w = b3.max.x - b3.min.x, d = b3.max.z - b3.min.z;
    // Wall-vs-strut test, split by geometry kind. A landmark's mass is built from
    // box() walls (and extruded gables) that are PANEL-THIN in one axis but wide
    // in the other (facades, slabs, gable fills); keep those, drop only genuine
    // posts. Round/organic pieces (cyl/lathe): a diagonal strut's AABB inflates
    // to a big empty box, but it's still thin in one axis — the min-dim test
    // drops struts/cables while keeping fat columns, domes, round towers.
    const wallLike = geoType === 'BoxGeometry' || geoType === 'ExtrudeGeometry';
    if (wallLike) {
      if (Math.max(w, d) < 0.6) return; // thin in BOTH horizontal axes = a post
    } else {
      if (Math.min(w, d) < 0.5) return;
    }
    rings.push({
      pts: [b3.min.x, b3.min.z, b3.max.x, b3.min.z, b3.max.x, b3.max.z, b3.min.x, b3.max.z],
      base, top, area: w * d,
    });
  });
  if (!rings.length) return null;
  // biggest volumes first; cap so a strut-heavy build can't bloat the pack
  rings.sort((a, b) => b.area - a.area);
  if (rings.length > 48) rings.length = 48;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  let total = 0;
  for (const r of rings) total += r.pts.length / 2;
  const starts = new Uint32Array(rings.length + 1);
  const pts = new Float32Array(total * 2);
  const aabb = new Float32Array(rings.length * 4);
  const top = new Float32Array(rings.length);
  const base = new Float32Array(rings.length);
  let o = 0; // running point index — rings vary in length, so accumulate
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    starts[i] = o;
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (let c = 0; c < r.pts.length; c += 2) {
      const lx = r.pts[c], lz = r.pts[c + 1];
      // local -> world by the landmark's rot about its anchor (matches the
      // group.rotation.y = rot / position (px,pz) the manager applies to the mesh)
      const wx = px + lx * cos + lz * sin;
      const wz = pz - lx * sin + lz * cos;
      pts[o * 2] = wx; pts[o * 2 + 1] = wz;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      o++;
    }
    aabb[i * 4] = minX; aabb[i * 4 + 1] = minZ; aabb[i * 4 + 2] = maxX; aabb[i * 4 + 3] = maxZ;
    top[i] = gy + r.top;
    base[i] = gy + r.base;
  }
  starts[rings.length] = o;
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
  private compile: ((g: THREE.Object3D) => Promise<void>) | null;
  private placed = new Map<string, THREE.Group>();
  private building = new Set<string>();
  // All builds run through one serial chain, and each build yields the frame
  // between its heavy phases (builder -> collision -> merge). A bespoke
  // landmark is thousands of primitives merged into a handful of meshes;
  // doing two of those back-to-back inside a single frame was the biggest
  // traversal stutter in the game. Serialized + phase-sliced, no frame ever
  // absorbs more than one heavy phase (~a few ms each).
  private buildChain: Promise<void> = Promise.resolve();
  private sets = new Map<string, Promise<BuilderMap | null>>();
  private colSets = new Map<string, { data: CollisionData; x0: number; z0: number; x1: number; z1: number }>();
  private timer = 0;
  private initialPlaced = false;
  private fits: Record<string, Fit> | null = null;
  private fitsLoading: Promise<void> | null = null;
  /** Fired after a landmark's collision registers: (id, solid bounds). */
  onBuilt: ((id: string, x0: number, z0: number, x1: number, z1: number) => void) | null = null;

  constructor(
    scene: THREE.Scene,
    roadEject: RoadEject | null = null,
    compile: ((g: THREE.Object3D) => Promise<void>) | null = null,
  ) {
    this.scene = scene;
    this.roadEject = roadEject;
    this.compile = compile;
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

  /** Queue a build on the serial chain (callers must have claimed `building`). */
  private enqueueBuild(lm: Landmark) {
    if (this.building.has(lm.id) || this.placed.has(lm.id)) return;
    this.building.add(lm.id);
    this.buildChain = this.buildChain.then(() => this.build(lm));
  }

  /** Yield the rest of this frame so build phases land in separate frames. */
  private yieldFrame(): Promise<void> {
    return new Promise((res) => setTimeout(res, 0));
  }

  private async build(lm: Landmark) {
    if (this.placed.has(lm.id)) return;
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
      await this.yieldFrame(); // builder allocated the primitive tree; give the frame back
      // collision comes from the raw primitive tree — the merge below
      // collapses everything into one geometry per material
      const collision = deriveCollision(raw, px, gy, pz, rot);
      await this.yieldFrame(); // collision walked the whole tree; merge in a fresh frame
      const group = mergeByMaterial(raw);
      group.position.set(px, gy, pz);
      group.rotation.y = rot;
      // Claim the slot + register collision synchronously so the landmark is
      // solid and won't be rebuilt, but defer the VISIBLE add until its shaders
      // are pre-warmed off the render frame. A bespoke landmark introduces new
      // materials (bronze glass, curtain wall) that otherwise compile inside the
      // first render that shows it (measured ~52ms for the Empire State build).
      // If the player left range while the compile was in flight the update()
      // evictor has disposed and removed it from `placed`; skip the add.
      this.placed.set(lm.id, group);
      if (this.compile) {
        void this.compile(group).then(() => {
          if (this.placed.get(lm.id) === group) this.scene.add(group);
        });
      } else {
        this.scene.add(group);
      }
      if (collision) {
        let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
        for (let i = 0; i < collision.aabb.length; i += 4) {
          if (collision.aabb[i] < x0) x0 = collision.aabb[i];
          if (collision.aabb[i + 1] < z0) z0 = collision.aabb[i + 1];
          if (collision.aabb[i + 2] > x1) x1 = collision.aabb[i + 2];
          if (collision.aabb[i + 3] > z1) z1 = collision.aabb[i + 3];
        }
        this.colSets.set(lm.id, { data: collision, x0, z0, x1, z1 });
        // functional street kits (subway entrances, bus stops, bike docks)
        // placed BEFORE this build never saw its walls — let the world evict
        // and re-seat anything inside the new solid bounds
        this.onBuilt?.(lm.id, x0, z0, x1, z1);
      }
    } catch (error) {
      // A single failed landmark must never take the frame loop down, but keep
      // development failures observable instead of silently leaving a hole.
      if (process.env.NODE_ENV !== 'production') console.warn(`Landmark build failed: ${lm.id}`, error);
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
      for (const lm of LANDMARKS_PLACED) if (lm.alwaysOn) this.enqueueBuild(lm);
    }

    let started = 0;
    for (const lm of LANDMARKS_PLACED) {
      if (lm.alwaysOn) continue;
      const dx = lm.x - x, dz = lm.z - z;
      const d2 = dx * dx + dz * dz;
      const has = this.placed.has(lm.id);
      if (!has && d2 < lm.r * lm.r) {
        // stagger builds so approaching a dense district doesn't hitch a frame
        // (the serial chain then spaces their heavy phases across frames)
        if (started < 2 && !this.building.has(lm.id)) {
          started++;
          this.enqueueBuild(lm);
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

  /** True once a named premium build and its collision have completed. */
  isBuilt(id: string) { return this.placed.has(id); }

  destroy() {
    for (const g of this.placed.values()) {
      this.scene.remove(g);
      disposeGroup(g);
    }
    this.placed.clear();
    this.colSets.clear();
  }
}
