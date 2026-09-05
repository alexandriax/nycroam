// Tile JSON schema (produced by scripts/build-tiles.mjs) and worker message protocol.

/**
 * Stable façade archetype contract shared by the tile builder, worker, and
 * façade shader. Values are serialized rather than shader-specific flags so
 * future render tiers can interpret the same compact tile data differently.
 */
export type BuildingArchetype =
  | 0 // brick / prewar
  | 1 // glass curtain wall
  | 2 // limestone / stone
  | 3 // concrete / postwar
  | 4 // industrial / loft
  | 5 // brownstone / rowhouse
  | 6 // metal / commercial
  | 7 // mixed-use / storefront
  | 8 // cast-iron loft
  | 9 // residential tower / balconies
  | 10 // Art Deco / setback
  | 11 // modern masonry
  | 12 // institutional
  | 13 // warehouse / utilitarian concrete
  | 14 // small wood / vernacular
  | 15; // hotel / mid-century commercial

export interface TileBuilding {
  p: number[][]; // rings: [outer, hole, hole...] flat [dx0,dz0,...] integer decimeters rel. to tile origin
  h: number; // height m
  m?: number; // min height m
  n?: string; // name
  k?: string; // building kind
  b?: number; // v2: ground elevation m
  a?: BuildingArchetype; // legacy semantic façade archetype; absent in early v1/v2 tiles
  /**
   * v3 packed building semantics (exact in a JS number / float32):
   * archetype 4b, window family 3b, window ratio 4b, storefront 3b,
   * construction era 3b, roof family 3b, contextual-confidence 2b.
   */
  s?: number;
  v?: number; // stable 16-bit variation seed derived from source identity
  // Sparse source semantics. One-character keys keep JSON overhead low; raw
  // OSM strings are retained so improved inference can be shipped without
  // rebuilding the source cache. New clients may ignore any/all of these.
  f?: string; // building:material
  c?: string; // building:colour (or legacy building:color)
  r?: string; // roof:shape
  q?: string; // roof:material
  o?: string; // roof:colour (or legacy roof:color)
  l?: number | string; // building:levels; number when losslessly numeric
  d?: string; // start_date
}

export interface TileRoad {
  p: number[]; // flat decimeters
  c: string; // highway class
  b?: number; // bridge
  e?: number[]; // v2: per-point elevation m
  w?: number; // v3: source/inferred carriageway width, decimeters
  /**
   * v3 topology/semantics bitset. See ROAD_FLAG_* below. Missing means a
   * legacy tile and is interpreted conservatively by the worker.
   */
  f?: number;
  i?: [number, number]; // endpoint junction degrees, capped to uint8
}

export const ROAD_FLAG_SIDEWALK_LEFT = 1 << 0;
export const ROAD_FLAG_SIDEWALK_RIGHT = 1 << 1;
export const ROAD_FLAG_DRIVEWAY = 1 << 2;
export const ROAD_FLAG_MEDIAN = 1 << 3;
export const ROAD_FLAG_ISLAND = 1 << 4;
export const ROAD_FLAG_INTERSECTION_START = 1 << 5;
export const ROAD_FLAG_INTERSECTION_END = 1 << 6;
export const ROAD_FLAG_CROSSING = 1 << 7;
export const ROAD_FLAG_ONEWAY = 1 << 8;
export const ROAD_FLAG_PARKING_LEFT = 1 << 9;
export const ROAD_FLAG_PARKING_RIGHT = 1 << 10;

export interface TileSign {
  p: [number, number]; // decimeters rel. tile origin (already corner-offset)
  e: number; // ground elevation, decimeters
  n: string[]; // full street names (client abbreviates)
  a: number[]; // blade bearings, degrees
}

export interface TileJson {
  v: number; // 1 = flat; 2 = elevations baked (area/tree entries become [x,z,e_dm] triples)
  x: number;
  z: number;
  buildings?: TileBuilding[];
  roads?: TileRoad[];
  areas?: Record<string, number[]>; // kind -> triangle verts, stride 2 (v1) or 3 (v2)
  trees?: number[]; // stride 2 (v1) or 3 (v2)
  signs?: TileSign[];
  hyd?: number[]; // [dx,dz,e_dm] triples
}

// ---- Worker protocol ----

export interface BuildRequest {
  type: 'build';
  key: string;
  tx: number;
  tz: number;
  url: string;
  /** Optional NCT3 slice supplied from a main-thread regional bundle cache. */
  source?: ArrayBuffer;
  sourceFetchMs?: number;
  detail: TileBuildDetail;
  requestId: number;
}

/**
 * 0 = base massing, 1 = mid street/roof delta, 2 = near-field delta.
 *
 * Worker responses are deliberately non-cumulative: a response contains only
 * the layer identified by `detail`. TileManager requests 0 -> 1 -> 2 in order
 * and retains every previously integrated layer.
 */
export type TileBuildDetail = 0 | 1 | 2;

export interface MeshPayload {
  position: Float32Array;
  /** Signed normalized byte normals: 4x smaller than the former float32 path. */
  normal: Int8Array;
  /** Unsigned normalized byte vertex colors: 4x smaller than float32. */
  color: Uint8Array;
  index: Uint16Array | Uint32Array;
  uv?: Float32Array;
  style?: Uint8Array; // buildings: BuildingArchetype 0..15 (per vertex)
  semantic?: Float32Array; // buildings: packed exact semantic word (per vertex)
}

export interface TileWorkerTiming {
  fetchMs: number;
  decodeMs: number;
  buildMs: number;
  totalMs: number;
  sourceBytes: number;
  transferBytes: number;
}

export interface BuildResponse {
  type: 'built';
  key: string;
  detail: TileBuildDetail;
  requestId: number;
  buildings: MeshPayload | null;
  roads: MeshPayload | null; // asphalt family, uv'd for texturing
  walks: MeshPayload | null; // concrete family (sidewalks/paths), uv'd
  areas: MeshPayload | null; // parks/plazas (flat vertex-colored ground)
  water: MeshPayload | null; // water bodies — own mesh, animated water material
  markings: MeshPayload | null; // lane lines + crosswalk bars
  trees: Float32Array | null; // [x,y,z, scale, hueJitter] * n  (world coords)
  retailAnchors: Float32Array | null; // [x,y,z,storefrontCategory] * n
  hydrants: Float32Array | null; // [x,y,z,rotY] * n (world coords)
  signs: { x: number; y: number; z: number; names: string[]; angles: number[] }[] | null;
  collision: CollisionData | null;
  roadPaths: RoadPaths | null; // minimap street lines
  timing?: TileWorkerTiming;
  error?: string;
}

/** Exact transferable typed-array bytes carried by one worker mesh. */
export function meshPayloadByteLength(payload: MeshPayload | null): number {
  if (!payload) return 0;
  return payload.position.byteLength
    + payload.normal.byteLength
    + payload.color.byteLength
    + payload.index.byteLength
    + (payload.uv?.byteLength ?? 0)
    + (payload.style?.byteLength ?? 0)
    + (payload.semantic?.byteLength ?? 0);
}

/**
 * Exact typed-array bytes transferred and integrated for a tier response.
 * String-only sign metadata is structured-cloned and intentionally excluded.
 */
export function buildResponseByteLength(response: BuildResponse): number {
  let bytes = 0;
  for (const mesh of [
    response.buildings,
    response.roads,
    response.walks,
    response.areas,
    response.water,
    response.markings,
  ]) bytes += meshPayloadByteLength(mesh);
  bytes += response.trees?.byteLength ?? 0;
  bytes += response.retailAnchors?.byteLength ?? 0;
  bytes += response.hydrants?.byteLength ?? 0;
  if (response.collision) {
    bytes += response.collision.ringStart.byteLength
      + response.collision.points.byteLength
      + response.collision.aabb.byteLength
      + response.collision.top.byteLength
      + response.collision.base.byteLength;
  }
  if (response.roadPaths) {
    bytes += response.roadPaths.start.byteLength
      + response.roadPaths.pts.byteLength
      + response.roadPaths.width.byteLength
      + response.roadPaths.kind.byteLength
      + (response.roadPaths.flags?.byteLength ?? 0);
  }
  return bytes;
}

/**
 * Install one immutable tier layer. Earlier object identities are retained,
 * and duplicate/out-of-order replacement is rejected instead of silently
 * disposing geometry that another subsystem may still reference.
 */
export function installTileDetailLayer<T>(
  layers: [T | null, T | null, T | null],
  detail: TileBuildDetail,
  layer: T,
): void {
  if (layers[detail] !== null) throw new Error(`tile detail layer ${detail} already installed`);
  if (detail > 0 && layers[detail - 1] === null) {
    throw new Error(`tile detail layer ${detail} installed before ${detail - 1}`);
  }
  layers[detail] = layer;
}

/** Base-only payloads: massing, land/water, collision, and road topology. */
export function tileDetailIncludesBaseSurfaces(detail: TileBuildDetail): boolean {
  return detail === 0;
}

const BASE_ROAD_SURFACE_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link',
]);

/** The one and only tier that owns a road's full-width surface ribbon. */
export function tileRoadSurfaceDetail(roadClass: string): TileBuildDetail {
  return BASE_ROAD_SURFACE_CLASSES.has(roadClass) ? 0 : 1;
}

/**
 * Attach a compiled layer only if it is still the registered identity. Detail
 * callbacks may complete in any order; the root becomes visible only when its
 * base layer completes.
 */
export function attachCompiledTileDetailLayer<T>(
  layers: [T | null, T | null, T | null],
  detail: TileBuildDetail,
  layer: T,
  attachLayer: (layer: T) => void,
  attachRoot: () => void,
): boolean {
  if (layers[detail] !== layer) return false;
  attachLayer(layer);
  if (detail === 0) attachRoot();
  return true;
}

/** Visit attached and still-compiling layers exactly once during final unload. */
export function forEachTileDetailLayer<T>(
  layers: readonly (T | null)[],
  visit: (layer: T) => void,
): void {
  for (const layer of layers) if (layer !== null) visit(layer);
}

export interface RetainedTileResponseState {
  collision: CollisionData | null;
  roadPaths: RoadPaths | null;
  trees: Float32Array | null;
  retailAnchors: Float32Array | null;
  signs: BuildResponse['signs'];
  builtDetail: TileBuildDetail | -1;
}

/** Null delta fields cannot erase base collision/topology or prior near data. */
export function retainTileResponseState(
  state: RetainedTileResponseState,
  response: BuildResponse,
): void {
  if (response.collision) state.collision = response.collision;
  if (response.roadPaths) state.roadPaths = response.roadPaths;
  if (response.trees) state.trees = response.trees;
  if (response.retailAnchors) state.retailAnchors = response.retailAnchors;
  if (response.signs) state.signs = response.signs;
  state.builtDetail = response.detail;
}

/** Road classes rendered as poured concrete rather than asphalt. */
export const CONCRETE_CLASSES = new Set(['pedestrian', 'footway', 'path', 'steps']);

/**
 * Road centerlines for the minimap, in the same flat/offset shape as
 * CollisionData so it costs 3 transferables per tile instead of one per road.
 */
export interface RoadPaths {
  start: Uint32Array; // index into pts (per path), length = pathCount+1
  pts: Float32Array; // [x0,z0,x1,z1,...] world meters
  width: Float32Array; // per path, meters (drives minimap line weight)
  kind: Uint8Array; // per path: 0 = vehicular road, 1 = bike lane, 2 = service lane
  flags?: Uint16Array; // optional v3 ROAD_FLAG_* semantics per path
}

export const PATH_KIND_ROAD = 0;
export const PATH_KIND_BIKE = 1;
/**
 * Alleys, driveways and parking aisles. Carried here ONLY so the runtime
 * placement solver can push kits out of them -- they are drawn as 5.5 m of
 * asphalt like any other lane, and a bus stop standing in one is standing in
 * the road. Everything that treats a path as a *street* (minimap, street names,
 * curb tangents, Street View snapping) filters this kind out.
 */
export const PATH_KIND_SERVICE = 2;

export interface CollisionData {
  // Building rings (incl. elevated parts) for player push-out and roof landing.
  // World-space meters.
  ringStart: Uint32Array; // index into points (per ring), length = ringCount+1
  points: Float32Array; // [x0,z0,x1,z1,...]
  aabb: Float32Array; // [minX,minZ,maxX,maxZ] per ring
  top: Float32Array; // per ring: roof y (ground elevation + part height)
  base: Float32Array; // per ring: underside y of the solid volume (elevated parts float)
}

export const ROAD_STYLE: Record<string, { w: number; col: [number, number, number]; y: number }> = {
  motorway: { w: 22, col: [0.12, 0.125, 0.14], y: 0.08 },
  trunk: { w: 20, col: [0.12, 0.125, 0.14], y: 0.08 },
  primary: { w: 17, col: [0.135, 0.14, 0.155], y: 0.08 },
  secondary: { w: 14, col: [0.135, 0.14, 0.155], y: 0.08 },
  tertiary: { w: 12, col: [0.145, 0.15, 0.165], y: 0.08 },
  unclassified: { w: 10, col: [0.15, 0.155, 0.17], y: 0.07 },
  residential: { w: 10, col: [0.15, 0.155, 0.17], y: 0.07 },
  living_street: { w: 8, col: [0.17, 0.175, 0.19], y: 0.07 },
  service: { w: 5.5, col: [0.17, 0.175, 0.185], y: 0.06 },
  pedestrian: { w: 8, col: [0.52, 0.53, 0.54], y: 0.06 },
  footway: { w: 2.6, col: [0.58, 0.59, 0.6], y: 0.1 },
  crossing: { w: 3, col: [0.4, 0.42, 0.44], y: 0.09 },
  cycleway: { w: 2.4, col: [0.14, 0.145, 0.16], y: 0.09 },
  path: { w: 2, col: [0.5, 0.47, 0.4], y: 0.09 },
  steps: { w: 2.6, col: [0.44, 0.44, 0.46], y: 0.1 },
  motorway_link: { w: 9, col: [0.12, 0.125, 0.14], y: 0.07 },
  trunk_link: { w: 9, col: [0.12, 0.125, 0.14], y: 0.07 },
  primary_link: { w: 9, col: [0.135, 0.14, 0.155], y: 0.07 },
  secondary_link: { w: 9, col: [0.135, 0.14, 0.155], y: 0.07 },
  tertiary_link: { w: 9, col: [0.145, 0.15, 0.165], y: 0.07 },
};

export const AREA_STYLE: Record<string, { col: [number, number, number]; y: number }> = {
  park: { col: [0.32, 0.48, 0.3], y: 0.03 },
  grass: { col: [0.4, 0.55, 0.34], y: 0.03 },
  wood: { col: [0.24, 0.4, 0.26], y: 0.035 },
  water: { col: [0.22, 0.4, 0.48], y: 0.045 },
  sand: { col: [0.78, 0.72, 0.55], y: 0.03 },
  pier: { col: [0.56, 0.57, 0.59], y: 0.05 },
  plaza: { col: [0.63, 0.64, 0.66], y: 0.04 },
  playground: { col: [0.62, 0.55, 0.46], y: 0.035 },
  sports: { col: [0.3, 0.5, 0.52], y: 0.035 },
  cemetery: { col: [0.35, 0.5, 0.36], y: 0.03 },
};
