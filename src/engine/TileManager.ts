import * as THREE from 'three';
import { dataUrl } from './dataver';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildResponse, MeshPayload, CollisionData, RoadPaths, TileBuildDetail } from './tileTypes';
import {
  attachCompiledTileDetailLayer,
  buildResponseByteLength,
  forEachTileDetailLayer,
  installTileDetailLayer,
  retainTileResponseState,
} from './tileTypes';
import { TILE_SIZE, tileKey } from './geo';
import { hash01 } from './palette';
import {
  makeFacadeLodMaterial, makeFacadeMaterial, makeFlatMaterial, makeRoadMaterial, makeWalkMaterial,
  makeMarkingsMaterial, makeWaterMaterial, setFacadeDetailFade, treeTrunkMaterial, treeCanopyMaterial,
} from './materials';
import { facadeDetailLod } from './facadeLod';
import { SKY } from './sky';
import { buildSignsMesh, buildHydrants, hydrantMaterial } from './streetFurniture';
import { disposeOwnedResources } from './performance/resourceLifetime';
import {
  TileStreamingTelemetry,
  type TileStreamingReport,
} from './performance/TileStreamingTelemetry';
import { quality } from './quality';
import { appendRetailAnchorsWithin } from './tileAnchors';
import { treeLodForDistanceSq, type TreeLod } from './vegetationLod';

/** Conservative footprint of the widest deterministic canopy profile. */
const TREE_CANOPY_RADIUS = 3.4;
/** Scale/color families; one asymmetric shared geometry still means one draw. */
const TREE_PROFILES = [
  { x: 1.12, y: 0.94, z: 1.02, hue: 0.29, sat: 0.34, light: 0.215 }, // broad street tree
  { x: 0.76, y: 1.28, z: 0.74, hue: 0.32, sat: 0.3, light: 0.19 }, // columnar
  { x: 1.28, y: 0.82, z: 1.12, hue: 0.255, sat: 0.4, light: 0.23 }, // spreading park tree
  { x: 0.94, y: 1.12, z: 1.06, hue: 0.3, sat: 0.27, light: 0.24 }, // oval crown
] as const;

interface TileRecord {
  key: string;
  tx: number;
  tz: number;
  state: 'queued' | 'building' | 'ready' | 'empty';
  group: THREE.Group | null;
  layerGroups: [THREE.Group | null, THREE.Group | null, THREE.Group | null];
  collision: CollisionData | null;
  roadPaths: RoadPaths | null;
  trees: Float32Array | null; // [x,y,z,scale,hue] for canopy-safe teleport arrivals
  retailAnchors: Float32Array | null; // [x,y,z,category] semantic storefront anchors
  signs: BuildResponse['signs']; // kept for the "current street" HUD lookup
  geometries: THREE.BufferGeometry[];
  textures: THREE.Texture[];
  /** Per-tile materials only. Shared manager materials never enter this list. */
  materials: THREE.Material[];
  lod: number; // current detail bucket (0 = full .. 3 = buildings only)
  treeLod: TreeLod;
  facade: THREE.Mesh | null;
  facadeMeshes: THREE.Mesh[];
  facadeDetailed: boolean;
  targetDetail: TileBuildDetail;
  builtDetail: TileBuildDetail | -1;
  requestId: number;
  workerIndex: number;
}

interface BundleSlice {
  region: string;
  url: string;
  offset: number;
  length: number;
}

export interface TileStats {
  loaded: number;
  pending: number;
  total: number;
}

export class TileManager {
  private scene: THREE.Scene;
  private known = new Set<string>(); // tiles that exist on disk
  private tileExtension: 'json' | 'bin' = 'json';
  private bundleForTile = new Map<string, BundleSlice>();
  private bundleCache = new Map<string, Promise<ArrayBuffer>>();
  private bundleJsonFallback = true;
  private records = new Map<string, TileRecord>();
  private workers: Worker[] = [];
  private inFlight = new Map<string, number>(); // key -> worker idx
  private queue: string[] = [];
  private facadeMat = makeFacadeMaterial();
  private facadeSimpleMat = makeFacadeLodMaterial();
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
  private canopyKit = treeCanopyMaterial();
  private canopyMat = this.canopyKit.mat;
  private trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 2.4, 5);
  private canopyGeos: THREE.BufferGeometry[] = [];
  private midCanopyGeo: THREE.BufferGeometry;
  private farCanopyGeo: THREE.BufferGeometry;
  private pendingAdd: BuildResponse[] = [];
  private prefetched = new Set<string>(); // JSON warmed (or warming) into the HTTP cache
  private prefetchQueue: string[] = [];
  private prefetchInFlight = 0;
  private prefetchPlanX = Number.NaN;
  private prefetchPlanZ = Number.NaN;
  private prefetchPlanRadius = 0;
  private prefetchPlanScale = 1;
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
  private requestSequence = 0;
  private roadRevision = 0;
  private readonly streamTelemetry = new TileStreamingTelemetry();
  private compile: ((g: THREE.Object3D) => Promise<void>) | null;
  loadRadius = 1100;
  unloadRadius = 1400;
  /** Runtime governor multiplier for speculative cache warming only. */
  prefetchScale = 1;
  ready = false;

  constructor(scene: THREE.Scene, workerCount = 2, compile: ((g: THREE.Object3D) => Promise<void>) | null = null) {
    this.scene = scene;
    this.compile = compile;
    // Four genuinely different near silhouettes, all shared across tiles.
    const makeOrganic = (parts: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[], seed: number) => {
      const pieces = parts.map((part) => {
        const geo = new THREE.IcosahedronGeometry(1, 1);
        geo.scale(part.sx, part.sy, part.sz);
        geo.translate(part.x, part.y, part.z);
        return geo;
      });
      const merged = mergeGeometries(pieces, false)!;
      for (const piece of pieces) piece.dispose();
      const pos = merged.getAttribute('position') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const noise = hash01(seed + Math.round(v.x * 37.1) + Math.round(v.y * 17.7) * 131 + Math.round(v.z * 23.3) * 977);
        const scale = 1 + (noise - 0.5) * 0.34;
        pos.setXYZ(i, v.x * scale, v.y * scale, v.z * scale);
      }
      merged.computeVertexNormals();
      merged.translate(0, 3.15, 0);
      return merged;
    };
    this.canopyGeos = [
      makeOrganic([{ x: 0, y: 0, z: 0, sx: 1.5, sy: 1.8, sz: 1.5 }, { x: 0.82, y: -0.42, z: 0.35, sx: 0.9, sy: 0.9, sz: 0.85 }], 11),
      makeOrganic([{ x: 0, y: 0.2, z: 0, sx: 1.0, sy: 2.05, sz: 0.95 }, { x: -0.2, y: -0.9, z: 0.1, sx: 0.72, sy: 1.1, sz: 0.7 }], 29),
      makeOrganic([{ x: 0, y: -0.15, z: 0, sx: 1.75, sy: 1.3, sz: 1.55 }, { x: 1.05, y: -0.42, z: 0.2, sx: 1.05, sy: 0.8, sz: 0.9 }, { x: -0.9, y: -0.35, z: -0.25, sx: 0.95, sy: 0.75, sz: 0.85 }], 47),
      makeOrganic([{ x: 0, y: 0, z: 0, sx: 1.3, sy: 1.85, sz: 1.5 }, { x: 0.35, y: 0.75, z: -0.25, sx: 0.8, sy: 0.95, sz: 0.9 }], 71),
    ];
    this.midCanopyGeo = new THREE.IcosahedronGeometry(1.45, 0);
    this.midCanopyGeo.scale(1, 1.18, 1);
    this.midCanopyGeo.translate(0, 3.15, 0);
    // Solid octahedral impostor equivalent: six triangles, no alpha overdraw.
    this.farCanopyGeo = new THREE.OctahedronGeometry(1.35, 0);
    this.farCanopyGeo.scale(1, 1.35, 1);
    this.farCanopyGeo.translate(0, 3.15, 0);
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
    this.tileExtension = idx.format === 'nct3' ? 'bin' : 'json';
    if (idx.format === 'nct3-regions' && idx.regions && typeof idx.regions === 'object') {
      this.bundleJsonFallback = idx.fallback === 'json';
      for (const [region, raw] of Object.entries(idx.regions as Record<string, unknown>)) {
        const value = raw as { f?: unknown; t?: unknown };
        if (typeof value.f !== 'string' || !value.t || typeof value.t !== 'object') continue;
        const url = dataUrl(`/tiles/${value.f}`);
        for (const [key, span] of Object.entries(value.t as Record<string, unknown>)) {
          if (!Array.isArray(span) || span.length !== 2) continue;
          const offset = Number(span[0]), length = Number(span[1]);
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) continue;
          this.bundleForTile.set(key, { region, url, offset, length });
        }
      }
    }
    for (const k of idx.tiles as string[]) this.known.add(k);
    this.ready = true;
  }

  stats(): TileStats {
    let loaded = 0;
    for (const r of this.records.values()) if (r.group || r.state === 'empty') loaded++;
    // A worker result is not resident until its geometry has been integrated.
    // Include that handoff queue so HUD/benchmark readiness cannot report a
    // false idle window between decode completion and GPU integration.
    return {
      loaded,
      pending: this.queue.length + this.inFlight.size + this.pendingAdd.length,
      total: this.known.size,
    };
  }

  /** Per-frame queue signal without the record traversal used by HUD stats. */
  pendingCount(): number {
    return this.queue.length + this.inFlight.size + this.pendingAdd.length;
  }

  /** Fixed-window worker/decode/integration and queue-pressure diagnostics. */
  streamingReport(): TileStreamingReport {
    const detailCounts: [number, number, number] = [0, 0, 0];
    for (const rec of this.records.values()) {
      if (rec.builtDetail >= 0) detailCounts[rec.builtDetail as TileBuildDetail]++;
    }
    this.streamTelemetry.setDetailCounts(detailCounts);
    this.recordPressure();
    return this.streamTelemetry.report();
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
        if (!r || (!r.group && r.state !== 'ready' && r.state !== 'empty')) return false;
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

  /** Changes only when the resident immutable road topology changes. */
  get roadNetworkRevision(): number {
    return this.roadRevision;
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
          // Includes the widest non-uniform species profile plus a small lean.
          // Trees remain non-colliding; this only keeps teleport cameras out.
          const r = TREE_CANOPY_RADIUS * scale + padding;
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

  /**
   * Stable semantic storefront anchors around a point. Pass a reused `out`
   * array from per-frame consumers to keep this allocation-free. Stride is
   * [worldX, groundY, worldZ, storefrontCategory].
   */
  retailAnchorsNear(x: number, z: number, radius = 320, out: number[] = []): number[] {
    out.length = 0;
    const tx = Math.floor(x / TILE_SIZE), tz = Math.floor(z / TILE_SIZE);
    const tileRadius = Math.ceil(radius / TILE_SIZE);
    const radiusSq = radius * radius;
    for (let dx = -tileRadius; dx <= tileRadius; dx++) {
      for (let dz = -tileRadius; dz <= tileRadius; dz++) {
        const anchors = this.records.get(tileKey(tx + dx, tz + dz))?.retailAnchors;
        if (!anchors) continue;
        if (appendRetailAnchorsWithin(anchors, x, z, radiusSq, out)) return out;
      }
    }
    return out;
  }

  update(camX: number, camZ: number, camY = 0) {
    // Advance the shared water material's animation. update() is called every frame (in
    // every mode), so this keeps tile water rippling in lockstep with the ocean without
    // World having to drive it. Clamp dt so a backgrounded tab / first frame can't jump it.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.lastWaterNow) {
      const materialDt = Math.min(0.1, (now - this.lastWaterNow) / 1000);
      this.waterKit.update(materialDt);
      this.canopyKit.update(materialDt);
    }
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
      const wi = rec.workerIndex >= 0 ? rec.workerIndex : this.pickWorker();
      rec.workerIndex = wi;
      rec.requestId = ++this.requestSequence;
      this.inFlight.set(key, wi);
      this.streamTelemetry.requested(rec.group !== null);
      this.dispatchBuild(rec, wi);
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
        || Math.abs(this.loadRadius - this.prefetchPlanRadius) >= 128
        || Math.abs(this.prefetchScale - this.prefetchPlanScale) >= 0.05;
      if (planStale || (this.prefetchQueue.length === 0 && now >= this.nextPrefetchPlanAt)) {
        this.planPrefetch(camX, camZ);
        this.nextPrefetchPlanAt = now + 1000;
      }
      this.pumpPrefetch();
    }
    this.recordPressure();
  }

  /** Refresh work whose result changes only after meaningful camera movement. */
  private refreshSpatial(camX: number, camY: number, camZ: number) {
    setFacadeDetailFade(this.facadeMat, this.loadRadius);
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
        const targetDetail = this.detailForTile(tx, tz, camX, camZ);
        this.records.set(key, {
          key, tx, tz, state: 'queued', group: null, collision: null, roadPaths: null,
          trees: null, retailAnchors: null, signs: null, geometries: [], textures: [], lod: 0,
          treeLod: treeLodForDistanceSq((cx - camX) ** 2 + (cz - camZ) ** 2), facade: null,
          facadeMeshes: [], layerGroups: [null, null, null],
          materials: [], facadeDetailed: true, targetDetail, builtDetail: -1, requestId: 0, workerIndex: -1,
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
        if (rec.roadPaths) this.roadRevision++;
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
    // The old 420/700/1000m floors were sensible for the 1150m desktop ring,
    // but broke the proportional contract on mobile's 750m ring: tier 3 sat
    // outside the load radius, so mobile never reached buildings-only LOD.
    // These floors preserve a generous ~300m full-detail neighborhood while
    // allowing every device/radius to shed all three tiers before the fog edge.
    const t1 = Math.max(280, this.loadRadius * 0.3);
    const t2 = Math.max(400, this.loadRadius * 0.48);
    const t3 = Math.max(580, this.loadRadius * 0.7);
    const H = 30;
    const grow1 = (t1 + H) ** 2, grow2 = (t2 + H) ** 2, grow3 = (t3 + H) ** 2;
    const shrink1 = (t1 - H) ** 2, shrink2 = (t2 - H) ** 2, shrink3 = (t3 - H) ** 2;
    for (const rec of this.records.values()) {
      this.updateFacadeMaterial(rec, camX, camY, camZ);
      const desiredDetail = this.detailForTile(rec.tx, rec.tz, camX, camZ);
      if (desiredDetail > rec.targetDetail) rec.targetDetail = desiredDetail;
      if (desiredDetail > rec.builtDetail && rec.state === 'ready') {
        rec.state = 'queued';
        this.queue.push(rec.key);
      }
      if (!rec.group) continue;
      const cx = (rec.tx + 0.5) * TILE_SIZE, cz = (rec.tz + 0.5) * TILE_SIZE;
      const dSq = (cx - camX) ** 2 + (cz - camZ) ** 2;
      this.updateShadowPolicy(rec, dSq);
      const grow = dSq > grow3 ? 3 : dSq > grow2 ? 2 : dSq > grow1 ? 1 : 0; // moving away
      const shrink = dSq < shrink1 ? 0 : dSq < shrink2 ? 1 : dSq < shrink3 ? 2 : 3; // approaching
      let lod = rec.lod;
      if (grow > lod) lod = grow;
      else if (shrink < lod) lod = shrink;
      const treeLod = treeLodForDistanceSq(dSq);
      if (lod === rec.lod && treeLod === rec.treeLod) continue;
      rec.lod = lod;
      rec.treeLod = treeLod;
      rec.group.traverse((child) => {
        if (child === rec.group) return;
        const tier = child.userData.lodTier as number | undefined;
        const vegetationLod = child.userData.vegetationLod as TreeLod | undefined;
        child.visible = (!tier || tier > lod) && (vegetationLod === undefined || vegetationLod === treeLod);
      });
    }
  }

  /**
   * The sun map represents the nearby contact layer, not a second rendering
   * of the full resident city. Generic building massing already contains the
   * silhouette of roof/facade deltas, so only its immutable base mesh casts.
   * Tree crowns keep their highest-cost animated shadow only on Ultra; High
   * retains the much cheaper trunk cue. Hero landmarks own one explicit proxy.
   */
  private updateShadowPolicy(rec: TileRecord, tileDistanceSq: number) {
    const q = quality();
    const facadeRadius = q.level === 'ultra' ? 500
      : q.level === 'high' ? 380
        : q.level === 'medium' ? 230
          : 0;
    if (rec.facade) {
      rec.facade.castShadow = q.shadows
        && facadeRadius > 0
        && tileDistanceSq <= facadeRadius * facadeRadius;
    }
    if (!rec.group) return;
    const trunkRadius = q.level === 'ultra' ? 440 : q.level === 'high' ? 340 : 0;
    const canopyRadius = q.level === 'ultra' ? 280 : 0;
    rec.group.traverse((child) => {
      const role = child.userData.tileShadowRole as string | undefined;
      if (role === 'tree-trunk') {
        (child as THREE.Mesh).castShadow = q.shadows
          && trunkRadius > 0
          && tileDistanceSq <= trunkRadius * trunkRadius;
      } else if (role === 'tree-canopy') {
        (child as THREE.Mesh).castShadow = q.shadows
          && canopyRadius > 0
          && tileDistanceSq <= canopyRadius * canopyRadius;
      }
    });
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
    // Scale the premium-facade handoff with the resident ring too. A fixed
    // 900m exit threshold meant a 750m mobile ring kept the expensive window
    // shader on every building tile. Desktop still resolves to its existing
    // ~900/760m pair; mobile uses ~585/445m. The same wide 140m hysteresis
    // prevents material chatter while moving quickly across a boundary.
    const { detailOut, detailIn } = facadeDetailLod(this.loadRadius);
    const threshold = rec.facadeDetailed ? detailOut : detailIn;
    const detailed = dSq < threshold * threshold;
    if (detailed === rec.facadeDetailed) return;
    rec.facadeDetailed = detailed;
    const material = detailed ? this.facadeMat : this.facadeSimpleMat;
    for (const facade of rec.facadeMeshes) facade.material = material;
  }

  /**
   * Requested worker payload tier, measured to the tile AABB rather than its
   * center so the camera's own 256m tile always receives near detail.
   */
  private detailForTile(tx: number, tz: number, camX: number, camZ: number): TileBuildDetail {
    const minX = tx * TILE_SIZE, maxX = minX + TILE_SIZE;
    const minZ = tz * TILE_SIZE, maxZ = minZ + TILE_SIZE;
    const dx = camX < minX ? minX - camX : camX > maxX ? camX - maxX : 0;
    const dz = camZ < minZ ? minZ - camZ : camZ > maxZ ? camZ - maxZ : 0;
    const dSq = dx * dx + dz * dz;
    if (dSq <= 150 * 150) return 2;
    const mid = Math.max(420, this.loadRadius * 0.5);
    if (dSq <= mid * mid) return 1;
    return 0;
  }

  private recordPressure() {
    this.streamTelemetry.pressure(
      this.queue.length,
      this.inFlight.size,
      this.pendingAdd.length,
      this.prefetchQueue.length + this.prefetchInFlight,
    );
  }

  private dispatchBuild(rec: TileRecord, workerIndex: number) {
    const requestId = rec.requestId;
    // Additive contract: even a tile requested at near range is built as
    // base -> mid -> near so every response is one immutable delta.
    const detail = Math.min(rec.targetDetail, rec.builtDetail + 1) as TileBuildDetail;
    const fallback = () => {
      const current = this.records.get(rec.key);
      if (current !== rec || current.requestId !== requestId || this.destroyed) return;
      this.workers[workerIndex].postMessage({
        type: 'build',
        key: rec.key,
        tx: rec.tx,
        tz: rec.tz,
        url: dataUrl(`/tiles/${rec.key}.json`),
        detail,
        requestId,
      });
    };
    const slice = this.bundleForTile.get(rec.key);
    if (!slice) {
      this.workers[workerIndex].postMessage({
        type: 'build',
        key: rec.key,
        tx: rec.tx,
        tz: rec.tz,
        url: this.tileUrl(rec.key),
        detail,
        requestId,
      });
      return;
    }
    const started = performance.now();
    void this.loadBundle(slice)
      .then((bundle) => {
        const current = this.records.get(rec.key);
        if (current !== rec || current.requestId !== requestId || this.destroyed) {
          this.inFlight.delete(rec.key);
          return;
        }
        if (slice.offset + slice.length > bundle.byteLength) throw new Error('invalid tile bundle span');
        const source = bundle.slice(slice.offset, slice.offset + slice.length);
        this.workers[workerIndex].postMessage({
          type: 'build',
          key: rec.key,
          tx: rec.tx,
          tz: rec.tz,
          url: `${slice.url}#${rec.key}`,
          source,
          sourceFetchMs: performance.now() - started,
          detail,
          requestId,
        }, [source]);
      })
      .catch((error) => {
        if (this.bundleJsonFallback) {
          fallback();
          return;
        }
        this.onBuilt({
          type: 'built',
          key: rec.key,
          detail,
          requestId,
          buildings: null,
          roads: null,
          walks: null,
          areas: null,
          water: null,
          markings: null,
          trees: null,
          retailAnchors: null,
          hydrants: null,
          signs: null,
          collision: null,
          roadPaths: null,
          error: String(error),
        }, workerIndex);
      });
  }

  private loadBundle(slice: BundleSlice): Promise<ArrayBuffer> {
    const hit = this.bundleCache.get(slice.region);
    if (hit) {
      this.bundleCache.delete(slice.region);
      this.bundleCache.set(slice.region, hit);
      return hit;
    }
    const pending = fetch(slice.url).then((res) => {
      if (!res.ok) throw new Error(`tile bundle ${res.status}`);
      return res.arrayBuffer();
    });
    this.bundleCache.set(slice.region, pending);
    while (this.bundleCache.size > 8) {
      const oldest = this.bundleCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.bundleCache.delete(oldest);
    }
    void pending.catch(() => {
      if (this.bundleCache.get(slice.region) === pending) this.bundleCache.delete(slice.region);
    });
    return pending;
  }

  /** Build a nearest-first list for the one ring just beyond resident tiles. */
  private planPrefetch(camX: number, camZ: number) {
    const ctx = Math.floor(camX / TILE_SIZE), ctz = Math.floor(camZ / TILE_SIZE);
    const pr = this.loadRadius + 400 * Math.max(0.5, Math.min(1, this.prefetchScale));
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
    this.prefetchPlanScale = this.prefetchScale;
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
      const slice = this.bundleForTile.get(key);
      const pending = slice
        ? this.loadBundle(slice)
        : fetch(this.tileUrl(key)).then(async (r) => {
            if (!r.ok) throw new Error(`prefetch ${r.status}`);
            return r.arrayBuffer(); // consume the body so it is eligible for HTTP caching
          });
      void pending
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

  private tileUrl(key: string): string {
    return dataUrl(`/tiles/${key}.${this.tileExtension}`);
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
    this.streamTelemetry.workerCompleted(res.timing, res.detail);
    const rec = this.records.get(res.key);
    if (!rec || (res.requestId ?? 0) !== rec.requestId) {
      this.streamTelemetry.staleResponses++;
      return; // unloaded/replaced while building
    }
    if (res.error) {
      this.streamTelemetry.errors++;
      rec.state = rec.group ? 'ready' : 'empty';
      return;
    }
    this.pendingAdd.push(res);
    this.recordPressure();
  }

  private integrate(res: BuildResponse) {
    const rec = this.records.get(res.key);
    if (!rec || (res.requestId ?? 0) !== rec.requestId) {
      this.streamTelemetry.staleResponses++;
      return;
    }
    if (res.detail <= rec.builtDetail) {
      rec.state = 'ready';
      return;
    }
    if (res.detail !== rec.builtDetail + 1) {
      // A tier may never leapfrog another tier: doing so would violate both
      // collision readiness and the immutable-layer identity contract.
      this.streamTelemetry.staleResponses++;
      rec.state = 'ready';
      return;
    }
    const integrateStarted = performance.now();
    const integratedBytes = buildResponseByteLength(res);
    const rootGroup = rec.group ?? new THREE.Group();
    const layerGroup = new THREE.Group();
    layerGroup.userData.tileDetail = res.detail;
    installTileDetailLayer(rec.layerGroups, res.detail, layerGroup);
    if (!rec.group) rec.group = rootGroup;

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
      geo.setAttribute('normal', new THREE.BufferAttribute(payload.normal, 3, true));
      geo.setAttribute('color', new THREE.BufferAttribute(payload.color, 3, true));
      if (payload.uv) geo.setAttribute('uv', new THREE.BufferAttribute(payload.uv, 2));
      if (payload.style) geo.setAttribute('aStyle', new THREE.BufferAttribute(payload.style, 1));
      if (payload.semantic) geo.setAttribute('aSemantic', new THREE.BufferAttribute(payload.semantic, 1));
      geo.setIndex(new THREE.BufferAttribute(payload.index, 1));
      geo.computeBoundingSphere();
      if (opts?.bounds) geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = opts?.cast ?? false;
      mesh.receiveShadow = opts?.receive ?? false;
      if (opts?.order !== undefined) mesh.renderOrder = opts.order;
      if (opts?.tier) mesh.userData.lodTier = opts.tier;
      layerGroup.add(mesh);
      rec.geometries.push(geo);
      return mesh;
    };

    const facade = addMesh(
      res.buildings,
      rec.facadeDetailed ? this.facadeMat : this.facadeSimpleMat,
      // Mid roof equipment and near facade relief are additive overlays on the
      // same massing. Casting each layer would submit the city to the shadow
      // pass three times without changing its silhouette.
      {
        cast: false,
        receive: true,
        bounds: true,
        // Near façade relief is sub-pixel outside the full-detail ring; roof
        // equipment survives through the mid ring. Base massing is permanent.
        tier: res.detail === 2 ? 1 : res.detail === 1 ? 2 : undefined,
      },
    );
    if (facade) {
      rec.facadeMeshes.push(facade);
      if (res.detail === 0) rec.facade = facade;
    }
    if (res.detail === 0 && rec.facade) {
      this.updateFacadeMaterial(rec, this.lastSpatialX, this.lastSpatialY, this.lastSpatialZ);
    }
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
      layerGroup.add(mesh);
      rec.geometries.push(mesh.geometry);
      rec.textures.push(texture);
      if (Array.isArray(mesh.material)) rec.materials.push(...mesh.material);
      else rec.materials.push(mesh.material);
    }
    if (res.hydrants && res.hydrants.length >= 4) {
      const hyd = buildHydrants(res.hydrants, this.hydrantMat);
      hyd.userData.lodTier = 1;
      layerGroup.add(hyd);
    }

    if (res.trees && res.trees.length >= 5) {
      const count = res.trees.length / 5;
      const trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, count);
      const speciesCounts = [0, 0, 0, 0];
      const speciesForTree = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const x = res.trees[i * 5], z = res.trees[i * 5 + 2], hue = res.trees[i * 5 + 4];
        const species = Math.min(
          TREE_PROFILES.length - 1,
          Math.floor(hash01(x * 0.137 + z * 0.173 + hue * 997.3) * TREE_PROFILES.length),
        );
        speciesForTree[i] = species;
        speciesCounts[species]++;
      }
      const nearCanopies = speciesCounts.map((speciesCount, species) => speciesCount > 0
        ? new THREE.InstancedMesh(this.canopyGeos[species], this.canopyMat, speciesCount)
        : null);
      const nearWrite = [0, 0, 0, 0];
      const midCanopies = new THREE.InstancedMesh(this.midCanopyGeo, this.canopyMat, count);
      const farCanopies = new THREE.InstancedMesh(this.farCanopyGeo, this.canopyMat, count);
      const trunkMatrix = new THREE.Matrix4();
      const canopyMatrix = new THREE.Matrix4();
      const midMatrix = new THREE.Matrix4();
      const farMatrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const euler = new THREE.Euler(0, 0, 0, 'YXZ');
      const c = new THREE.Color();
      for (let i = 0; i < count; i++) {
        const x = res.trees[i * 5], y = res.trees[i * 5 + 1], z = res.trees[i * 5 + 2];
        const s = res.trees[i * 5 + 3], hue = res.trees[i * 5 + 4];
        // The source's stable position/hue becomes a deterministic species,
        // orientation and lean—no new tile payload and no runtime randomness.
        const seed = x * 0.137 + z * 0.173 + hue * 997.3;
        const species = speciesForTree[i];
        const profile = TREE_PROFILES[species];
        const spread = 0.92 + hash01(seed + 11.7) * 0.16;
        const height = 0.94 + hash01(seed + 23.9) * 0.13;
        const yaw = hash01(seed + 37.1) * Math.PI * 2;
        const leanX = (hash01(seed + 51.3) - 0.5) * 0.07;
        const leanZ = (hash01(seed + 67.9) - 0.5) * 0.07;
        position.set(x, y, z);
        euler.set(leanX, yaw, leanZ);
        rotation.setFromEuler(euler);

        const trunkWidth = 0.76 + profile.x * 0.12 + hash01(seed + 79.1) * 0.16;
        scale.set(s * trunkWidth, s * profile.y * height, s * trunkWidth);
        trunkMatrix.compose(position, rotation, scale);
        trunks.setMatrixAt(i, trunkMatrix);

        scale.set(
          s * profile.x * spread,
          s * profile.y * height,
          s * profile.z * (1.04 - (spread - 0.92) * 0.5),
        );
        canopyMatrix.compose(position, rotation, scale);
        const nearCanopy = nearCanopies[species]!;
        const nearIndex = nearWrite[species]++;
        nearCanopy.setMatrixAt(nearIndex, canopyMatrix);

        // Mid and far tiers preserve each source tree's height/spread and
        // stable orientation, but use 20- and 6-triangle solid crowns. These
        // stay one draw each per tile and avoid billboard alpha overdraw.
        scale.set(
          s * profile.x * spread * 1.08,
          s * profile.y * height,
          s * profile.z,
        );
        midMatrix.compose(position, rotation, scale);
        midCanopies.setMatrixAt(i, midMatrix);
        scale.multiplyScalar(1.07);
        farMatrix.compose(position, rotation, scale);
        farCanopies.setMatrixAt(i, farMatrix);

        c.setHSL(
          profile.hue + (hue - 0.5) * 0.035,
          profile.sat * (0.9 + hash01(seed + 91.7) * 0.2),
          profile.light + (hash01(seed + 103.1) - 0.5) * 0.07,
        );
        nearCanopy.setColorAt(nearIndex, c);
        midCanopies.setColorAt(i, c);
        farCanopies.setColorAt(i, c);
        c.setHSL(
          0.065 + hash01(seed + 113.9) * 0.025,
          0.08 + hash01(seed + 127.3) * 0.08,
          0.78 + hash01(seed + 139.7) * 0.12,
        );
        trunks.setColorAt(i, c);
      }
      trunks.instanceMatrix.needsUpdate = true;
      midCanopies.instanceMatrix.needsUpdate = true;
      farCanopies.instanceMatrix.needsUpdate = true;
      if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
      if (midCanopies.instanceColor) midCanopies.instanceColor.needsUpdate = true;
      if (farCanopies.instanceColor) farCanopies.instanceColor.needsUpdate = true;
      const q = quality();
      trunks.castShadow = false;
      trunks.receiveShadow = q.shadows;
      trunks.userData.tileShadowRole = 'tree-trunk';
      trunks.userData.vegetationLod = 0;
      for (const canopy of nearCanopies) {
        if (!canopy) continue;
        canopy.instanceMatrix.needsUpdate = true;
        if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
        canopy.castShadow = false;
        canopy.receiveShadow = q.shadows;
        canopy.userData.tileShadowRole = 'tree-canopy';
        canopy.userData.vegetationLod = 0;
        layerGroup.add(canopy);
      }
      midCanopies.receiveShadow = q.shadows;
      midCanopies.userData.vegetationLod = 1;
      farCanopies.receiveShadow = q.shadows;
      farCanopies.userData.vegetationLod = 2;
      layerGroup.add(trunks, midCanopies, farCanopies);
    }

    // Base owns immutable collision and road topology. Near owns activity
    // anchors/furniture. Null delta fields never clear an earlier tier.
    const installedRoadTopology = !rec.roadPaths && Boolean(res.roadPaths);
    retainTileResponseState(rec, res);
    if (installedRoadTopology) this.roadRevision++;
    rec.state = 'ready';
    const tileCx = (rec.tx + 0.5) * TILE_SIZE;
    const tileCz = (rec.tz + 0.5) * TILE_SIZE;
    const tileDistanceSq = Number.isFinite(this.lastSpatialX)
      ? (tileCx - this.lastSpatialX) ** 2 + (tileCz - this.lastSpatialZ) ** 2
      : Number.POSITIVE_INFINITY;
    this.updateShadowPolicy(rec, tileDistanceSq);
    for (const child of layerGroup.children) {
      const tier = child.userData.lodTier as number | undefined;
      const vegetationLod = child.userData.vegetationLod as TreeLod | undefined;
      child.visible = (!tier || tier > rec.lod)
        && (vegetationLod === undefined || vegetationLod === rec.treeLod);
    }
    this.streamTelemetry.integrated(
      performance.now() - integrateStarted,
      integratedBytes,
      res.detail,
    );
    // Collision / readiness are set above so gameplay never waits on the GPU;
    // only the VISIBLE add is deferred. The first frame a fresh material combo
    // is drawn otherwise compiles its shader programs synchronously inside
    // renderer.render() (measured ~82ms for the opening tile ring). Pre-warm the
    // programs off the render frame, then reveal. If the tile unloaded while the
    // compile was in flight (the player kept moving), drop it — dispose() has
    // already freed the geometry, so skipping the add leaks nothing.
    const attachLayer = () => {
      if (this.records.get(res.key) !== rec || rec.group !== rootGroup) return;
      attachCompiledTileDetailLayer(
        rec.layerGroups,
        res.detail,
        layerGroup,
        (layer) => {
          if (layer.parent !== rootGroup) rootGroup.add(layer);
        },
        () => {
          if (rootGroup.parent !== this.scene) this.scene.add(rootGroup);
        },
      );
    };
    if (this.compile) {
      const key = res.key;
      void this.compile(layerGroup).then(attachLayer, () => {
        // Compilation failure must not strand a collision-ready tile. The
        // renderer can still compile synchronously on its first visible frame.
        if (this.records.get(key) === rec) attachLayer();
      });
    } else {
      attachLayer();
    }
    if (rec.targetDetail > rec.builtDetail) {
      rec.state = 'queued';
      this.queue.push(rec.key);
    }
    this.recordPressure();
  }

  private dispose(rec: TileRecord) {
    if (rec.group) {
      this.scene.remove(rec.group);
      disposeOwnedResources(rec.geometries, rec.textures, rec.materials);
    }
    // A layer may still be compiling and therefore not attached to the root.
    // The tier registry owns it regardless, so disposal remains complete.
    forEachTileDetailLayer(rec.layerGroups, (layer) => {
      layer.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
    });
  }

  destroy() {
    this.destroyed = true;
    this.queue.length = 0;
    this.prefetchQueue.length = 0;
    this.pendingAdd.length = 0;
    this.bundleCache.clear();
    this.bundleForTile.clear();
    for (const w of this.workers) w.terminate();
    for (const rec of this.records.values()) this.dispose(rec);
    this.records.clear();
    this.trunkGeo.dispose();
    for (const canopyGeo of this.canopyGeos) canopyGeo.dispose();
    this.midCanopyGeo.dispose();
    this.farCanopyGeo.dispose();
    this.facadeMat.dispose();
    this.facadeSimpleMat.dispose();
    this.flatMat.dispose();
    this.roadMat.dispose();
    this.walkMat.dispose();
    this.markingsMat.dispose();
    this.waterKit.mat.dispose();
    this.hydrantMat.dispose();
    this.trunkMat.dispose();
    this.canopyMat.dispose();
  }
}
