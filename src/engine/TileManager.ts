import * as THREE from 'three';
import { dataUrl } from './dataver';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildResponse, MeshPayload, CollisionData, RoadPaths } from './tileTypes';
import { TILE_SIZE, tileKey } from './geo';
import { hash01 } from './palette';
import {
  makeFacadeMaterial, makeFlatMaterial, makeRoadMaterial, makeWalkMaterial,
  makeMarkingsMaterial, makeWaterMaterial, treeTrunkMaterial, treeCanopyMaterial,
} from './materials';
import { SKY } from './sky';
import { buildSignsMesh, buildHydrants, hydrantMaterial } from './streetFurniture';

interface TileRecord {
  key: string;
  tx: number;
  tz: number;
  state: 'queued' | 'building' | 'ready' | 'empty';
  group: THREE.Group | null;
  collision: CollisionData | null;
  roadPaths: RoadPaths | null;
  trees: Float32Array | null; // [x,y,z,scale,hue] for canopy-safe teleport arrivals
  signs: BuildResponse['signs']; // kept for the "current street" HUD lookup
  geometries: THREE.BufferGeometry[];
  textures: THREE.Texture[];
  lod: number; // current detail bucket (0 = full .. 3 = buildings only)
  facade: THREE.Mesh | null;
  facadeDetailed: boolean;
}

export interface TileStats {
  loaded: number;
  pending: number;
  total: number;
}

export class TileManager {
  private scene: THREE.Scene;
  private known = new Set<string>(); // tiles that exist on disk
  private records = new Map<string, TileRecord>();
  private workers: Worker[] = [];
  private inFlight = new Map<string, number>(); // key -> worker idx
  private queue: string[] = [];
  private facadeMat = makeFacadeMaterial();
  private facadeSimpleMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private flatMat = makeFlatMaterial();
  private roadMat = makeRoadMaterial();
  private walkMat = makeWalkMaterial();
  private markingsMat = makeMarkingsMaterial();
  // One shared animated water material for every tile's water (reservoir/lakes/ponds) —
  // same waves/fresnel/glint as World's ocean plane. Its time uniform is advanced once per
  // frame inside update() from performance.now(), so no per-frame plumbing through World is
  // needed. Shared like the other tile materials: never disposed per tile.
  private waterKit = makeWaterMaterial(SKY.fog.clone());
  private lastWaterNow = 0; // performance.now() at the previous update(), for the water dt
  private hydrantMat = hydrantMaterial();
  private trunkMat = treeTrunkMaterial();
  private canopyMat = treeCanopyMaterial();
  private trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 2.4, 5);
  private canopyGeo: THREE.BufferGeometry;
  private pendingAdd: BuildResponse[] = [];
  private prefetched = new Set<string>(); // JSON warmed (or warming) into the HTTP cache
  private prefetchQueue: string[] = [];
  private prefetchInFlight = 0;
  private prefetchPlanX = Number.NaN;
  private prefetchPlanZ = Number.NaN;
  private prefetchPlanRadius = 0;
  private nextPrefetchPlanAt = 0;
  // Candidate discovery, unload checks and LOD transitions are spatial work:
  // rerunning all of them for a sub-pixel camera move wastes the main thread.
  // Visible integration + worker dispatch remain per-frame in update().
  private lastSpatialX = Number.NaN;
  private lastSpatialY = Number.NaN;
  private lastSpatialZ = Number.NaN;
  private lastSpatialRadius = 0;
  private lastSpatialAt = 0;
  private destroyed = false;
  private compile: ((g: THREE.Object3D) => Promise<void>) | null;
  loadRadius = 1100;
  unloadRadius = 1400;
  ready = false;

  constructor(scene: THREE.Scene, workerCount = 2, compile: ((g: THREE.Object3D) => Promise<void>) | null = null) {
    this.scene = scene;
    this.compile = compile;
    // organic canopy: main crown + offset lobe, vertices displaced by hash noise
    const crown = new THREE.IcosahedronGeometry(1.5, 1);
    crown.scale(1, 1.2, 1);
    const lobe = new THREE.IcosahedronGeometry(0.95, 1);
    lobe.translate(0.85, -0.45, 0.35);
    const merged = mergeGeometries([crown, lobe], false)!;
    crown.dispose();
    lobe.dispose();
    const pos = merged.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = hash01(Math.round(v.x * 37.1) + Math.round(v.y * 17.7) * 131 + Math.round(v.z * 23.3) * 977);
      const s = 1 + (n - 0.5) * 0.42;
      pos.setXYZ(i, v.x * s, v.y * s, v.z * s);
    }
    merged.computeVertexNormals();
    merged.translate(0, 3.15, 0);
    this.canopyGeo = merged;
    this.trunkGeo.translate(0, 1.2, 0);
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url));
      w.onmessage = (ev: MessageEvent<BuildResponse>) => this.onBuilt(ev.data, i);
      this.workers.push(w);
    }
  }

  async init(): Promise<void> {
    const res = await fetch(dataUrl('/tiles/index.json'));
    if (!res.ok) throw new Error(`tiles/index.json missing (${res.status}): run npm run data:all`);
    const idx = await res.json();
    for (const k of idx.tiles as string[]) this.known.add(k);
    this.ready = true;
  }

  stats(): TileStats {
    let loaded = 0;
    for (const r of this.records.values()) if (r.state === 'ready' || r.state === 'empty') loaded++;
    return { loaded, pending: this.queue.length + this.inFlight.size, total: this.known.size };
  }

  /**
   * True once every tile around (x,z) that CAN hold data (per the manifest)
   * has integrated — i.e. collisionNear() coverage is complete here. Tiles
   * absent from the manifest never load and count as ready.
   */
  readyAround(x: number, z: number): boolean {
    const tx = Math.floor(x / TILE_SIZE), tz = Math.floor(z / TILE_SIZE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = tileKey(tx + dx, tz + dz);
        if (!this.known.has(key)) continue;
        const r = this.records.get(key);
        if (!r || (r.state !== 'ready' && r.state !== 'empty')) return false;
      }
    }
    return true;
  }

  /** Collision rings for tiles near a point (the tile containing it + 8 neighbors). */
  collisionNear(x: number, z: number): CollisionData[] {
    const tx = Math.floor(x / TILE_SIZE), tz = Math.floor(z / TILE_SIZE);
    const out: CollisionData[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const r = this.records.get(tileKey(tx + dx, tz + dz));
        if (r?.collision) out.push(r.collision);
      }
    }
    return out;
  }

  /** Road centerlines for tiles within `tileR` tiles of (x,z) — minimap streets. */
  roadPathsNear(x: number, z: number, tileR = 2): RoadPaths[] {
    const tx = Math.floor(x / TILE_SIZE), tz = Math.floor(z / TILE_SIZE);
    const out: RoadPaths[] = [];
    for (let dx = -tileR; dx <= tileR; dx++) {
      for (let dz = -tileR; dz <= tileR; dz++) {
        const r = this.records.get(tileKey(tx + dx, tz + dz));
        if (r?.roadPaths) out.push(r.roadPaths);
      }
    }
    return out;
  }

  /**
   * True when a street point sits inside a loaded tree's visible crown.
   * Trees deliberately have no physics collision, but a landmark presentation
   * should never place the camera inside opaque leaves. Called only while
   * resolving a teleport, not per frame.
   */
  treeCanopyNear(x: number, z: number, padding = 1.5): boolean {
    const tx = Math.floor(x / TILE_SIZE), tz = Math.floor(z / TILE_SIZE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const trees = this.records.get(tileKey(tx + dx, tz + dz))?.trees;
        if (!trees) continue;
        for (let i = 0; i < trees.length; i += 5) {
          const scale = trees[i + 3];
          // The irregular canopy geometry reaches ~2.5 scale units from its
          // trunk after its displaced crown and offset lobe are merged.
          const r = 2.5 * scale + padding;
          if ((trees[i] - x) ** 2 + (trees[i + 2] - z) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  }

  /** Street-sign assemblies (names + blade bearings) around (x,z) — 3×3 tiles. */
  signsNear(x: number, z: number): NonNullable<BuildResponse['signs']> {
    const tx = Math.floor(x / TILE_SIZE), tz = Math.floor(z / TILE_SIZE);
    const out: NonNullable<BuildResponse['signs']> = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const r = this.records.get(tileKey(tx + dx, tz + dz));
        if (r?.signs) out.push(...r.signs);
      }
    }
    return out;
  }

  update(camX: number, camZ: number, camY = 0) {
    // Advance the shared water material's animation. update() is called every frame (in
    // every mode), so this keeps tile water rippling in lockstep with the ocean without
    // World having to drive it. Clamp dt so a backgrounded tab / first frame can't jump it.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.lastWaterNow) this.waterKit.update(Math.min(0.1, (now - this.lastWaterNow) / 1000));
    this.lastWaterNow = now;

    if (!this.ready) return;
    // Eight metres is far below one 256m tile and the 30m LOD hysteresis band,
    // but avoids repeating hundreds of Map/string lookups for tiny camera
    // movements. The 250ms deadline still catches a player standing still
    // while data finishes around them.
    const spatialMoveSq = (camX - this.lastSpatialX) ** 2 + (camZ - this.lastSpatialZ) ** 2;
    const spatialDue = !Number.isFinite(spatialMoveSq)
      || spatialMoveSq >= 8 * 8
      || Math.abs(camY - this.lastSpatialY) >= 24
      || Math.abs(this.loadRadius - this.lastSpatialRadius) >= 16
      || now - this.lastSpatialAt >= 250;
    if (spatialDue) {
      this.refreshSpatial(camX, camY, camZ);
      this.lastSpatialX = camX;
      this.lastSpatialY = camY;
      this.lastSpatialZ = camZ;
      this.lastSpatialRadius = this.loadRadius;
      this.lastSpatialAt = now;
    }

    // Worker dispatch and visible integration remain per-frame: completed
    // geometry should never wait for the lower-frequency spatial refresh.
    while (this.queue.length && this.inFlight.size < this.workers.length * 3) {
      const key = this.queue.shift()!;
      const rec = this.records.get(key);
      if (!rec || rec.state !== 'queued') continue;
      rec.state = 'building';
      const wi = this.pickWorker();
      this.inFlight.set(key, wi);
      this.workers[wi].postMessage({ type: 'build', key, tx: rec.tx, tz: rec.tz, url: dataUrl(`/tiles/${key}.json`) });
    }

    // Main-thread integration wraps transferred arrays in GPU geometries,
    // builds signs/instances, and starts shader pre-warming. One tile per
    // rendered frame is still vastly faster than max-speed travel consumes
    // 256m tiles, while preventing two allocation spikes from stacking in a
    // single frame. Worker completion order is nondeterministic, so spend that
    // frame's budget on the result nearest the velocity-led stream center.
    const nextBuilt = this.takeNearestBuilt(camX, camZ);
    if (nextBuilt) this.integrate(nextBuilt);

    // Cache warming is deliberately network-idle work. The former two-per-
    // rendered-frame loop could launch ~120 requests/s at 60fps and contend
    // with visible tiles. A planned queue plus 1–2 fetches is genuinely idle.
    if (this.queue.length === 0 && this.inFlight.size === 0) {
      const planMoveSq = (camX - this.prefetchPlanX) ** 2 + (camZ - this.prefetchPlanZ) ** 2;
      const planStale = !Number.isFinite(planMoveSq)
        || planMoveSq >= (TILE_SIZE * 0.5) ** 2
        || Math.abs(this.loadRadius - this.prefetchPlanRadius) >= 128;
      if (planStale || (this.prefetchQueue.length === 0 && now >= this.nextPrefetchPlanAt)) {
        this.planPrefetch(camX, camZ);
        this.nextPrefetchPlanAt = now + 1000;
      }
      this.pumpPrefetch();
    }
  }

  /** Refresh work whose result changes only after meaningful camera movement. */
  private refreshSpatial(camX: number, camY: number, camZ: number) {
    const ctx = Math.floor(camX / TILE_SIZE), ctz = Math.floor(camZ / TILE_SIZE);
    const rTiles = Math.ceil(this.loadRadius / TILE_SIZE);
    const loadRadiusSq = this.loadRadius * this.loadRadius;

    // enqueue in-range unknown tiles
    for (let dx = -rTiles; dx <= rTiles; dx++) {
      for (let dz = -rTiles; dz <= rTiles; dz++) {
        const tx = ctx + dx, tz = ctz + dz;
        const key = tileKey(tx, tz);
        if (!this.known.has(key) || this.records.has(key)) continue;
        const cx = (tx + 0.5) * TILE_SIZE, cz = (tz + 0.5) * TILE_SIZE;
        if ((cx - camX) ** 2 + (cz - camZ) ** 2 > loadRadiusSq) continue;
        this.records.set(key, {
          key, tx, tz, state: 'queued', group: null, collision: null, roadPaths: null,
          trees: null, signs: null, geometries: [], textures: [], lod: 0, facade: null,
          facadeDetailed: true,
        });
        this.queue.push(key);
      }
    }

    // Squared distance preserves ordering and avoids a square root per compare.
    if (this.queue.length > 1) {
      this.queue.sort((a, b) => this.distSqOf(a, camX, camZ) - this.distSqOf(b, camX, camZ));
    }

    // unload far tiles
    const unloadRadiusSq = this.unloadRadius * this.unloadRadius;
    for (const [key, rec] of this.records) {
      const cx = (rec.tx + 0.5) * TILE_SIZE, cz = (rec.tz + 0.5) * TILE_SIZE;
      if ((cx - camX) ** 2 + (cz - camZ) ** 2 > unloadRadiusSq) {
        this.dispose(rec);
        this.records.delete(key);
      }
    }

    // ---- distance LOD: shed far tiles' detail draw calls -------------------
    // Draw calls dominate the frame with a heli-sized radius (~10 meshes per
    // tile x ~130 resident tiles, doubled by the shadow pass). Fog washes far
    // tiles anyway, so beyond scaled thresholds whole tiers stop drawing:
    // markings/signs/hydrants first, then trees/sidewalks, then ground/roads/
    // water, leaving only buildings (whose massing IS the mid-distance view,
    // handing off to the skyline layer past the load radius). Thresholds scale
    // with loadRadius so walk, heli and mobile all shed proportionally; the
    // 30m hysteresis band keeps tiles from flickering at a boundary.
    const t1 = Math.max(420, this.loadRadius * 0.35);
    const t2 = Math.max(700, this.loadRadius * 0.58);
    const t3 = Math.max(1000, this.loadRadius * 0.82);
    const H = 30;
    const grow1 = (t1 + H) ** 2, grow2 = (t2 + H) ** 2, grow3 = (t3 + H) ** 2;
    const shrink1 = (t1 - H) ** 2, shrink2 = (t2 - H) ** 2, shrink3 = (t3 - H) ** 2;
    for (const rec of this.records.values()) {
      this.updateFacadeMaterial(rec, camX, camY, camZ);
      if (!rec.group) continue;
      const cx = (rec.tx + 0.5) * TILE_SIZE, cz = (rec.tz + 0.5) * TILE_SIZE;
      const dSq = (cx - camX) ** 2 + (cz - camZ) ** 2;
      const grow = dSq > grow3 ? 3 : dSq > grow2 ? 2 : dSq > grow1 ? 1 : 0; // moving away
      const shrink = dSq < shrink1 ? 0 : dSq < shrink2 ? 1 : dSq < shrink3 ? 2 : 3; // approaching
      let lod = rec.lod;
      if (grow > lod) lod = grow;
      else if (shrink < lod) lod = shrink;
      if (lod === rec.lod) continue;
      rec.lod = lod;
      for (const child of rec.group.children) {
        const tier = child.userData.lodTier as number | undefined;
        if (tier) child.visible = tier > lod;
      }
    }
  }

  /**
   * Premium façade shading is useful only while its windows span real pixels.
   * Switch per tile using the distance to the actual merged-geometry bounds:
   * nearby/tall buildings keep reflections + relief, while distant low blocks
   * seen from a helicopter become cheap vertex-colored massing. The 140m band
   * prevents material chatter at the boundary, and the premium shader has
   * already faded almost to its base color there, hiding the handoff.
   */
  private updateFacadeMaterial(rec: TileRecord, camX: number, camY: number, camZ: number) {
    let dSq: number;
    const bounds = rec.facade?.geometry.boundingBox;
    if (bounds) {
      const dx = camX < bounds.min.x ? bounds.min.x - camX : camX > bounds.max.x ? camX - bounds.max.x : 0;
      const dy = camY < bounds.min.y ? bounds.min.y - camY : camY > bounds.max.y ? camY - bounds.max.y : 0;
      const dz = camZ < bounds.min.z ? bounds.min.z - camZ : camZ > bounds.max.z ? camZ - bounds.max.z : 0;
      dSq = dx * dx + dy * dy + dz * dz;
    } else {
      // Before integration, conservatively approximate a tile-sized 250m-tall
      // envelope; integrate() reruns this with exact bounds before reveal.
      const cx = (rec.tx + 0.5) * TILE_SIZE, cz = (rec.tz + 0.5) * TILE_SIZE;
      const dx = Math.max(0, Math.abs(camX - cx) - TILE_SIZE * 0.55);
      const dy = Math.max(0, camY - 250);
      const dz = Math.max(0, Math.abs(camZ - cz) - TILE_SIZE * 0.55);
      dSq = dx * dx + dy * dy + dz * dz;
    }
    const threshold = rec.facadeDetailed ? 900 : 760;
    const detailed = dSq < threshold * threshold;
    if (detailed === rec.facadeDetailed) return;
    rec.facadeDetailed = detailed;
    if (rec.facade) rec.facade.material = detailed ? this.facadeMat : this.facadeSimpleMat;
  }

  /** Build a nearest-first list for the one ring just beyond resident tiles. */
  private planPrefetch(camX: number, camZ: number) {
    const ctx = Math.floor(camX / TILE_SIZE), ctz = Math.floor(camZ / TILE_SIZE);
    const pr = this.loadRadius + 400;
    const prSq = pr * pr;
    const prTiles = Math.ceil(pr / TILE_SIZE);
    const candidates: { key: string; dSq: number }[] = [];
    for (let dx = -prTiles; dx <= prTiles; dx++) {
      for (let dz = -prTiles; dz <= prTiles; dz++) {
        const key = tileKey(ctx + dx, ctz + dz);
        if (!this.known.has(key) || this.records.has(key) || this.prefetched.has(key)) continue;
        const cx = (ctx + dx + 0.5) * TILE_SIZE, cz = (ctz + dz + 0.5) * TILE_SIZE;
        const dSq = (cx - camX) ** 2 + (cz - camZ) ** 2;
        if (dSq <= prSq) candidates.push({ key, dSq });
      }
    }
    candidates.sort((a, b) => a.dSq - b.dSq);
    this.prefetchQueue = candidates.map((c) => c.key);
    this.prefetchPlanX = camX;
    this.prefetchPlanZ = camZ;
    this.prefetchPlanRadius = this.loadRadius;
  }

  /** Keep prefetch below both the browser's and the worker stream's bandwidth. */
  private pumpPrefetch() {
    const limit = this.workers.length > 2 ? 2 : 1;
    while (
      this.prefetchInFlight < limit
      && !this.destroyed
      && this.prefetchQueue.length
      && this.queue.length === 0
      && this.inFlight.size === 0
    ) {
      const key = this.prefetchQueue.shift()!;
      if (this.records.has(key) || this.prefetched.has(key)) continue;
      this.prefetched.add(key);
      this.prefetchInFlight++;
      void fetch(dataUrl(`/tiles/${key}.json`))
        .then(async (r) => {
          if (!r.ok) throw new Error(`prefetch ${r.status}`);
          await r.arrayBuffer(); // consume the body so it is eligible for HTTP caching
        })
        .catch(() => {
          this.prefetched.delete(key); // transient failures may retry on a later plan
        })
        .finally(() => {
          this.prefetchInFlight--;
          this.pumpPrefetch();
        });
    }
  }

  private distSqOf(key: string, camX: number, camZ: number): number {
    const rec = this.records.get(key);
    if (!rec) return 1e18;
    const dx = (rec.tx + 0.5) * TILE_SIZE - camX;
    const dz = (rec.tz + 0.5) * TILE_SIZE - camZ;
    return dx * dx + dz * dz;
  }

  private takeNearestBuilt(camX: number, camZ: number): BuildResponse | null {
    let best = -1;
    let bestDistSq = Infinity;
    for (let i = this.pendingAdd.length - 1; i >= 0; i--) {
      const res = this.pendingAdd[i];
      const rec = this.records.get(res.key);
      if (!rec) {
        // The camera outran/unloaded this tile after its worker completed.
        this.pendingAdd.splice(i, 1);
        continue;
      }
      const dx = (rec.tx + 0.5) * TILE_SIZE - camX;
      const dz = (rec.tz + 0.5) * TILE_SIZE - camZ;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = i;
      }
    }
    if (best < 0) return null;
    return this.pendingAdd.splice(best, 1)[0];
  }

  private pickWorker(): number {
    const counts = this.workers.map(() => 0);
    for (const wi of this.inFlight.values()) counts[wi]++;
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
    return best;
  }

  private onBuilt(res: BuildResponse, _wi: number) {
    this.inFlight.delete(res.key);
    const rec = this.records.get(res.key);
    if (!rec) return; // unloaded while building
    if (res.error) {
      rec.state = 'empty';
      return;
    }
    this.pendingAdd.push(res);
  }

  private integrate(res: BuildResponse) {
    const rec = this.records.get(res.key);
    if (!rec || rec.state === 'ready') return;
    const group = new THREE.Group();

    // Distance tiers (userData.lodTier): update() hides a tier once the whole
    // tile is far enough that its content is fog-washed or sub-pixel. Draw
    // calls are the dominant frame cost with a heli-sized load radius (~10
    // meshes x 130 resident tiles, twice with the shadow pass); most of those
    // tiles are far, so most of their meshes never need to be drawn at all.
    //   tier 1: lane markings, street signs, hydrants (sub-pixel first)
    //   tier 2: trees, sidewalks
    //   tier 3: ground areas, roads, water (leaves buildings = the silhouette)
    const addMesh = (
      payload: MeshPayload | null,
      mat: THREE.Material,
      opts?: { cast?: boolean; receive?: boolean; order?: number; tier?: number; bounds?: boolean },
    ): THREE.Mesh | null => {
      if (!payload) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(payload.position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(payload.normal, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(payload.color, 3));
      if (payload.uv) geo.setAttribute('uv', new THREE.BufferAttribute(payload.uv, 2));
      if (payload.style) geo.setAttribute('aStyle', new THREE.BufferAttribute(payload.style, 1));
      geo.setIndex(new THREE.BufferAttribute(payload.index, 1));
      geo.computeBoundingSphere();
      if (opts?.bounds) geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = opts?.cast ?? false;
      mesh.receiveShadow = opts?.receive ?? false;
      if (opts?.order !== undefined) mesh.renderOrder = opts.order;
      if (opts?.tier) mesh.userData.lodTier = opts.tier;
      group.add(mesh);
      rec.geometries.push(geo);
      return mesh;
    };

    rec.facade = addMesh(
      res.buildings,
      rec.facadeDetailed ? this.facadeMat : this.facadeSimpleMat,
      { cast: true, receive: true, bounds: true },
    );
    if (rec.facade) this.updateFacadeMaterial(rec, this.lastSpatialX, this.lastSpatialY, this.lastSpatialZ);
    addMesh(res.areas, this.flatMat, { receive: true, tier: 3 });
    // Water surface sits ~0.25m above the highest interior terrain (baked), so it draws
    // over the park polygon that covers a reservoir/lake. Shared material, no shadow — mirrors
    // the ocean plane. The BufferGeometry is per-tile and disposed on unload; the material isn't.
    addMesh(res.water, this.waterKit.mat, { tier: 3 });
    addMesh(res.roads, this.roadMat, { receive: true, tier: 3 });
    addMesh(res.walks, this.walkMat, { receive: true, tier: 2 });
    addMesh(res.markings, this.markingsMat, { receive: true, order: 1, tier: 1 });

    if (res.signs && res.signs.length) {
      const { mesh, texture } = buildSignsMesh(res.signs);
      mesh.userData.lodTier = 1;
      group.add(mesh);
      rec.geometries.push(mesh.geometry);
      rec.textures.push(texture);
    }
    if (res.hydrants && res.hydrants.length >= 4) {
      const hyd = buildHydrants(res.hydrants, this.hydrantMat);
      hyd.userData.lodTier = 1;
      group.add(hyd);
    }

    if (res.trees && res.trees.length >= 5) {
      const count = res.trees.length / 5;
      const trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, count);
      const canopies = new THREE.InstancedMesh(this.canopyGeo, this.canopyMat, count);
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      for (let i = 0; i < count; i++) {
        const x = res.trees[i * 5], y = res.trees[i * 5 + 1], z = res.trees[i * 5 + 2];
        const s = res.trees[i * 5 + 3], hue = res.trees[i * 5 + 4];
        m.makeScale(s, s, s).setPosition(x, y, z);
        trunks.setMatrixAt(i, m);
        canopies.setMatrixAt(i, m);
        c.setHSL(0.29 + hue * 0.06, 0.38, 0.3 + hue * 0.12);
        canopies.setColorAt(i, c);
      }
      trunks.instanceMatrix.needsUpdate = true;
      canopies.instanceMatrix.needsUpdate = true;
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
      canopies.castShadow = true;
      trunks.castShadow = true;
      trunks.userData.lodTier = 2;
      canopies.userData.lodTier = 2;
      group.add(trunks, canopies);
    }

    rec.group = group;
    rec.collision = res.collision;
    rec.roadPaths = res.roadPaths;
    rec.trees = res.trees;
    rec.signs = res.signs;
    rec.state = 'ready';
    // Collision / readiness are set above so gameplay never waits on the GPU;
    // only the VISIBLE add is deferred. The first frame a fresh material combo
    // is drawn otherwise compiles its shader programs synchronously inside
    // renderer.render() (measured ~82ms for the opening tile ring). Pre-warm the
    // programs off the render frame, then reveal. If the tile unloaded while the
    // compile was in flight (the player kept moving), drop it — dispose() has
    // already freed the geometry, so skipping the add leaks nothing.
    if (this.compile) {
      const key = res.key;
      void this.compile(group).then(() => {
        if (this.records.get(key) === rec && rec.group === group) this.scene.add(group);
      });
    } else {
      this.scene.add(group);
    }
  }

  private dispose(rec: TileRecord) {
    if (rec.group) {
      this.scene.remove(rec.group);
      for (const g of rec.geometries) g.dispose();
      for (const t of rec.textures) t.dispose();
      rec.group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
        if (o instanceof THREE.Mesh && (o.material as THREE.MeshLambertMaterial).map instanceof THREE.CanvasTexture) {
          (o.material as THREE.Material).dispose(); // per-tile sign material
        }
      });
    }
  }

  destroy() {
    this.destroyed = true;
    this.queue.length = 0;
    this.prefetchQueue.length = 0;
    this.pendingAdd.length = 0;
    for (const w of this.workers) w.terminate();
    for (const rec of this.records.values()) this.dispose(rec);
    this.records.clear();
  }
}
