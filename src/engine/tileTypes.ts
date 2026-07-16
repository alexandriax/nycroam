// Tile JSON schema (produced by scripts/build-tiles.mjs) and worker message protocol.

export interface TileBuilding {
  p: number[][]; // rings: [outer, hole, hole...] flat [dx0,dz0,...] integer decimeters rel. to tile origin
  h: number; // height m
  m?: number; // min height m
  n?: string; // name
  k?: string; // building kind
  b?: number; // v2: ground elevation m
}

export interface TileRoad {
  p: number[]; // flat decimeters
  c: string; // highway class
  b?: number; // bridge
  e?: number[]; // v2: per-point elevation m
}

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
}

export interface MeshPayload {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
  uv?: Float32Array;
  style?: Float32Array; // buildings: 0 = masonry, 1 = glass (per vertex)
}

export interface BuildResponse {
  type: 'built';
  key: string;
  buildings: MeshPayload | null;
  roads: MeshPayload | null; // asphalt family, uv'd for texturing
  walks: MeshPayload | null; // concrete family (sidewalks/paths), uv'd
  areas: MeshPayload | null; // parks/water/plazas
  markings: MeshPayload | null; // lane lines + crosswalk bars
  trees: Float32Array | null; // [x,y,z, scale, hueJitter] * n  (world coords)
  hydrants: Float32Array | null; // [x,y,z,rotY] * n (world coords)
  signs: { x: number; y: number; z: number; names: string[]; angles: number[] }[] | null;
  collision: CollisionData | null;
  roadPaths: RoadPaths | null; // minimap street lines
  error?: string;
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
}

export interface CollisionData {
  // Building outer rings for player push-out. World-space meters.
  ringStart: Uint32Array; // index into points (per ring), length = ringCount+1
  points: Float32Array; // [x0,z0,x1,z1,...]
  aabb: Float32Array; // [minX,minZ,maxX,maxZ] per ring
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
  cycleway: { w: 2.4, col: [0.2, 0.3, 0.26], y: 0.09 },
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
