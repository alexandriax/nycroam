// Web worker: fetch tile JSON -> build merged geometry buffers (transferable).
import earcut from 'earcut';
import type {
  BuildRequest, BuildResponse, MeshPayload, TileJson, CollisionData, BuildingArchetype, TileBuildDetail,
} from './tileTypes';
import {
  ROAD_STYLE, AREA_STYLE, CONCRETE_CLASSES, PATH_KIND_ROAD, PATH_KIND_BIKE, PATH_KIND_SERVICE,
  ROAD_FLAG_SIDEWALK_LEFT, ROAD_FLAG_SIDEWALK_RIGHT, ROAD_FLAG_DRIVEWAY, ROAD_FLAG_MEDIAN,
  ROAD_FLAG_ISLAND, ROAD_FLAG_INTERSECTION_START, ROAD_FLAG_INTERSECTION_END,
  ROAD_FLAG_CROSSING, buildResponseByteLength, tileDetailIncludesBaseSurfaces,
  tileRoadSurfaceDetail,
} from './tileTypes';
import { buildingColor, hash01, legacyBuildingArchetype, roofColor } from './palette';
import { packBuildingSemantics, semanticsForBuilding } from './tileSemantics';
import { decodeTileBinary, isTileBinary } from './tileBinary';
import { TILE_SIZE } from './geo';
import { LANDMARKS_PLACED } from './landmarks/registry';
import {
  buildSidewalkTopology,
  sidewalkSpansForRoad,
  type SidewalkTopologyRoad,
} from './sidewalkTopology';

// Monument sites where OSM maps the monument itself as building rings that the
// tile pipeline shipped as generic massing — suppressed here so the bespoke
// landmark build doesn't stand beside a windowed duplicate of itself.
const CLEAR_ZONES = LANDMARKS_PLACED
  .filter((l) => l.clear || l.clearName)
  .map((l) => ({
    x: l.x, z: l.z,
    r2: (l.clear ?? 0) * (l.clear ?? 0),
    name: l.clearName,
  }));

// NYC DOT bike-lane green (thermoplastic paint) + white edge stripes. Keep the
// blue channel at/below red so it renders a warm leaf-green, never a cool teal
// that reads as water; deeper + more saturated than the old wash.
const BIKE_GREEN: [number, number, number] = [0.05, 0.34, 0.06];

/**
 * Manhattan's signature protected on-street bike lanes. The OSM snapshot maps
 * greenways/bridge paths as separate `cycleway` ways (rendered directly), but
 * the avenue lanes live as `cycleway:*` tags on the avenue way itself — tags
 * the tile pipeline never kept. This curated set paints them back: matched by
 * street NAME at build time (via the tile's corner-sign data), on the real
 * curb side (NYC DOT places them on the LEFT of one-way avenues), bounded to
 * their real extents. side: world side of the centerline (w/e/n/s).
 */
const CURATED_LANES: Record<string, { side: 'w' | 'e' | 'n' | 's'; zMin: number; zMax: number }> = {
  // Extent along the avenue as world z (+z south, origin Times Sq). The grid's
  // 29° tilt sweeps an avenue across kilometers of x, so x never constrains —
  // the sign-name match already pins WHICH street this is.
  '1st Avenue': { side: 'w', zMin: -5600, zMax: 3700 }, // 125th → Houston
  '2nd Avenue': { side: 'e', zMin: -5600, zMax: 3700 }, // 125th → Houston
  '3rd Avenue': { side: 'w', zMin: -3150, zMax: -450 }, // 96th → 59th
  '6th Avenue': { side: 'w', zMin: -500, zMax: 4050 }, // 57th → Lispenard
  '8th Avenue': { side: 'w', zMin: -650, zMax: 2350 }, // Columbus Circle → Abingdon Sq
  '9th Avenue': { side: 'e', zMin: -650, zMax: 2500 }, // 59th → Gansevoort
  '10th Avenue': { side: 'w', zMin: -850, zMax: 2550 }, // 52nd → 14th
  'Amsterdam Avenue': { side: 'w', zMin: -4600, zMax: -1400 }, // 110th → 72nd
  'Columbus Avenue': { side: 'e', zMin: -4600, zMax: -500 }, // 110th → 59th
  'Lafayette Street': { side: 'w', zMin: 2950, zMax: 4050 }, // Astor Pl → Spring
  'Hudson Street': { side: 'w', zMin: 2400, zMax: 4800 }, // 14th → Chambers
  'Chrystie Street': { side: 'e', zMin: 3650, zMax: 4800 }, // Houston → Canal
};

// road classes that can carry a curated painted lane
const LANE_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
const SURFACE_STREETS = new Set([
  'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
]);

// Vehicular road classes (a sign inside one of these ribbons is standing in the
// street). Footways/paths/crossings are excluded — signs belong on sidewalks.
const VEHICULAR_ROADS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

/**
 * Push a baked sign position out of any vehicular road ribbon onto the nearest
 * sidewalk. Baked corner offsets under-cleared wide avenues, leaving some signs
 * mid-roadway; this walks the sign out of the deepest-penetrating ribbon a few
 * times, which converges to the corner at a 2-street intersection. Total travel
 * is capped so a data glitch can't fling a sign across the block.
 */
function nudgeSignOutOfRoads(
  sx: number, sz: number, vroads: { pts: number[]; half: number }[],
): [number, number] {
  const SIDEWALK = 1.9; // clearance past the curb
  const MAX_TRAVEL = 16;
  let x = sx, z = sz;
  for (let iter = 0; iter < 5; iter++) {
    let worst = 0, wx = 0, wz = 0;
    for (const vr of vroads) {
      const target = vr.half + SIDEWALK;
      const p = vr.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const x1 = p[i], z1 = p[i + 1], x2 = p[i + 2], z2 = p[i + 3];
        const dx = x2 - x1, dz = z2 - z1;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        let t = ((x - x1) * dx + (z - z1) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x1 + t * dx, qz = z1 + t * dz;
        const ox = x - qx, oz = z - qz;
        const pen = target - Math.hypot(ox, oz);
        if (pen > worst) { worst = pen; wx = ox; wz = oz; }
      }
    }
    if (worst <= 0.01) break;
    const d = Math.hypot(wx, wz);
    if (d > 1e-3) { x += (wx / d) * worst; z += (wz / d) * worst; }
    else { x += worst; } // exactly on a centerline: nudge along +x
  }
  // clamp total displacement (keeps a glitchy push near the original corner)
  const tdx = x - sx, tdz = z - sz, td = Math.hypot(tdx, tdz);
  if (td > MAX_TRAVEL) { x = sx + (tdx / td) * MAX_TRAVEL; z = sz + (tdz / td) * MAX_TRAVEL; }
  return [x, z];
}

/**
 * Which curated lane (if any) runs down this road way: a corner-sign blade
 * whose name is curated, whose bearing runs parallel to the way, and whose
 * pole sits beside it (perpendicular distance within the roadbed + sidewalk)
 * names the street. Signs live on every named intersection, so any avenue
 * stretch long enough to paint has one nearby.
 */
function matchCuratedLane(
  pts: number[],
  blades: { x: number; z: number; ang: number; name: string }[],
  halfW: number,
): string | null {
  let best = 18; // meters: max perpendicular distance sign→way
  let name: string | null = null;
  for (const bl of blades) {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x1 = pts[i], z1 = pts[i + 1], x2 = pts[i + 2], z2 = pts[i + 3];
      const dx = x2 - x1, dz = z2 - z1;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      let dAng = Math.abs(Math.atan2(dz, dx) - bl.ang) % Math.PI;
      if (dAng > Math.PI / 2) dAng = Math.PI - dAng;
      if (dAng > 0.26) continue; // ~15°: blade not parallel to this way
      let t = ((bl.x - x1) * dx + (bl.z - z1) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(bl.x - (x1 + t * dx), bl.z - (z1 + t * dz));
      const lim = Math.min(best, halfW + 9);
      if (d < lim) { best = d; name = bl.name; }
    }
  }
  return name;
}

/**
 * Push polyline points out of ground-level building rings (plus `clearance`).
 * Elevated parts (base well above the local surface) are skipped — a lane may
 * legitimately run under an arcade or skybridge. Movement is capped so a data
 * glitch can't drag a lane across the block.
 */
function nudgePolylineOutOfBuildings(
  pts: number[], ys: number[],
  rings: number[][], aabb: number[], bases: number[],
  clearance: number,
) {
  const MAX_TRAVEL = 7;
  for (let pi = 0; pi < pts.length / 2; pi++) {
    const sx = pts[pi * 2], sz = pts[pi * 2 + 1];
    let x = sx, z = sz;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let ri = 0; ri < rings.length; ri++) {
        if (bases[ri] > ys[pi] + 2) continue; // overhead part — lane passes under
        if (x < aabb[ri * 4] - clearance || z < aabb[ri * 4 + 1] - clearance
          || x > aabb[ri * 4 + 2] + clearance || z > aabb[ri * 4 + 3] + clearance) continue;
        const ring = rings[ri];
        const rn = ring.length / 2;
        let inside = false;
        for (let i = 0, j = rn - 1; i < rn; j = i++) {
          const xi = ring[i * 2], zi = ring[i * 2 + 1];
          const xj = ring[j * 2], zj = ring[j * 2 + 1];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
        // nearest boundary point
        let bestD2 = Infinity, bx = 0, bz = 0;
        for (let i = 0, j = rn - 1; i < rn; j = i++) {
          const x1 = ring[j * 2], z1 = ring[j * 2 + 1];
          const x2 = ring[i * 2], z2 = ring[i * 2 + 1];
          const dx = x2 - x1, dz = z2 - z1;
          const l2 = dx * dx + dz * dz;
          if (l2 < 1e-9) continue;
          let t = ((x - x1) * dx + (z - z1) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x1 + t * dx, qz = z1 + t * dz;
          const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
          if (d2 < bestD2) { bestD2 = d2; bx = qx; bz = qz; }
        }
        const d = Math.sqrt(bestD2);
        if (inside) {
          const nx = d > 1e-6 ? (bx - x) / d : 1, nz = d > 1e-6 ? (bz - z) / d : 0;
          x = bx + nx * clearance; z = bz + nz * clearance;
          moved = true;
        } else if (d < clearance && d > 1e-6) {
          const nx = (x - bx) / d, nz = (z - bz) / d;
          x = bx + nx * clearance; z = bz + nz * clearance;
          moved = true;
        }
      }
      if (!moved) break;
    }
    const td = Math.hypot(x - sx, z - sz);
    if (td > MAX_TRAVEL) { x = sx + ((x - sx) / td) * MAX_TRAVEL; z = sz + ((z - sz) / td) * MAX_TRAVEL; }
    pts[pi * 2] = x; pts[pi * 2 + 1] = z;
  }
}

class MeshAcc {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  uvs: number[] | null = null;
  styles: number[] | null = null;
  semantics: number[] | null = null;
  facades: number[] | null = null;
  facadeBase = 0;
  facadeSeed = 0;
  facadeOrigin = 0;
  facadeWidth = 1;

  constructor(withUv = false, withStyle = false, withSemantic = false) {
    if (withUv) this.uvs = [];
    if (withStyle) this.styles = [];
    if (withSemantic) { this.semantics = []; this.facades = []; }
  }

  get vcount() { return this.pos.length / 3; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, u = 0, v = 0) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b);
    if (this.uvs) this.uvs.push(u, v);
    if (this.styles) this.styles.push(this.styleCursor);
    if (this.semantics) this.semantics.push(this.semanticCursor);
    if (this.facades) this.facades.push(x * nz - z * nx - this.facadeOrigin, y - this.facadeBase, this.facadeWidth, this.facadeSeed);
  }

  styleCursor = 0;
  semanticCursor = 0;

  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }

  payload(): MeshPayload | null {
    if (this.idx.length === 0) return null;
    const normal = new Int8Array(this.nrm.length);
    const color = new Uint8Array(this.col.length);
    for (let i = 0; i < this.nrm.length; i++) normal[i] = Math.round(Math.max(-1, Math.min(1, this.nrm[i])) * 127);
    for (let i = 0; i < this.col.length; i++) color[i] = Math.round(Math.max(0, Math.min(1, this.col[i])) * 255);
    return {
      position: new Float32Array(this.pos),
      normal,
      color,
      index: this.vcount <= 65535 ? new Uint16Array(this.idx) : new Uint32Array(this.idx),
      ...(this.uvs ? { uv: new Float32Array(this.uvs) } : {}),
      ...(this.styles ? { style: new Uint8Array(this.styles) } : {}),
      ...(this.facades ? { facade: new Float32Array(this.facades) } : {}),
      ...(this.semantics ? { semantic: new Float32Array(this.semantics) } : {}),
    };
  }
}

function ringArea(pts: number[]): number {
  // shoelace on flat [x,z,...]
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return a / 2;
}

function reverseRing(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

function isConvexRing(pts: number[]): boolean {
  const count = pts.length / 2;
  let sign = 0;
  for (let i = 0; i < count; i++) {
    const a = i * 2, b = ((i + 1) % count) * 2, c = ((i + 2) % count) * 2;
    const cross = (pts[b] - pts[a]) * (pts[c + 1] - pts[b + 1])
      - (pts[b + 1] - pts[a + 1]) * (pts[c] - pts[b]);
    if (Math.abs(cross) < 1e-5) continue;
    const next = cross > 0 ? 1 : -1;
    if (sign && next !== sign) return false;
    sign = next;
  }
  return sign !== 0;
}

/** Extrude a polygon (rings in world meters, flat [x,z]) from y0 to y1 into acc. */
function extrude(
  acc: MeshAcc,
  rings: number[][],
  y0: number,
  y1: number,
  color: [number, number, number],
  bottomCap = false,
  roofColor: [number, number, number] = color,
) {
  // orient: outer ring negative shoelace (see design note), holes positive -> normal (-dz,0,dx) faces outward
  const oriented = rings.map((r, i) => {
    const a = ringArea(r);
    if (i === 0 ? a > 0 : a < 0) return reverseRing(r);
    return r;
  });

  const [cr, cg, cb] = color;
  const wallShade = 1.0; // shading handled by lights/shader

  // walls
  for (const ring of oriented) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = ring[i * 2], z1 = ring[i * 2 + 1];
      const x2 = ring[j * 2], z2 = ring[j * 2 + 1];
      const dx = x2 - x1, dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = -dz / len, nz = dx / len;
      acc.facadeOrigin = x1 * nz - z1 * nx;
      acc.facadeWidth = len;
      const base = acc.vcount;
      acc.vertex(x1, y0, z1, nx, 0, nz, cr * wallShade, cg * wallShade, cb * wallShade);
      acc.vertex(x2, y0, z2, nx, 0, nz, cr * wallShade, cg * wallShade, cb * wallShade);
      acc.vertex(x2, y1, z2, nx, 0, nz, cr * wallShade, cg * wallShade, cb * wallShade);
      acc.vertex(x1, y1, z1, nx, 0, nz, cr * wallShade, cg * wallShade, cb * wallShade);
      acc.tri(base, base + 2, base + 1);
      acc.tri(base, base + 3, base + 2);
    }
  }

  // roof cap at y1
  const flat: number[] = [];
  const holeIdx: number[] = [];
  for (let i = 0; i < oriented.length; i++) {
    if (i > 0) holeIdx.push(flat.length / 2);
    for (let k = 0; k < oriented[i].length; k++) flat.push(oriented[i][k]);
  }
  let tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
  // messy footprints (self-intersections, touching holes) can make earcut give
  // up -> roofless open shells. Retry without holes, then fall back to a fan.
  if (tris.length === 0 && oriented[0].length >= 6) {
    const outerOnly = oriented[0];
    flat.length = 0;
    for (let k = 0; k < outerOnly.length; k++) flat.push(outerOnly[k]);
    holeIdx.length = 0;
    tris = earcut(flat, undefined, 2);
    if (tris.length === 0) {
      tris = [];
      for (let i = 1; i < flat.length / 2 - 1; i++) tris.push(0, i, i + 1);
    }
  }
  const base = acc.vcount;
  const roofShade = 0.92;
  const [rr, rg, rb] = roofColor;
  for (let i = 0; i < flat.length; i += 2) {
    acc.vertex(flat[i], y1, flat[i + 1], 0, 1, 0, rr * roofShade, rg * roofShade, rb * roofShade);
  }
  const fixedTris: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    let a = tris[t], b = tris[t + 1], c = tris[t + 2];
    // ensure upward-facing winding: for y-up viewing, cross must give +y
    const ax = flat[a * 2], az = flat[a * 2 + 1];
    const bx = flat[b * 2], bz = flat[b * 2 + 1];
    const cx = flat[c * 2], cz = flat[c * 2 + 1];
    const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (crossY < 0) { const tmp = b; b = c; c = tmp; }
    acc.tri(base + a, base + b, base + c);
    fixedTris.push(a, b, c);
  }

  // underside cap: floating parts (min_height) would otherwise read as hollow
  // shells when seen from below (their far walls are backface-culled)
  if (bottomCap) {
    const base2 = acc.vcount;
    for (let i = 0; i < flat.length; i += 2) {
      acc.vertex(flat[i], y0, flat[i + 1], 0, -1, 0, cr * 0.42, cg * 0.42, cb * 0.42);
    }
    for (let t = 0; t < fixedTris.length; t += 3) {
      acc.tri(base2 + fixedTris[t], base2 + fixedTris[t + 2], base2 + fixedTris[t + 1]);
    }
  }
}

/**
 * Low-cost authored silhouette for source-tagged pyramidal/hipped/domed roofs.
 * Faces are appended to the same merged building mesh and therefore add no
 * material or draw calls. Eligibility is deliberately narrow to avoid invalid
 * fans on complex/holed footprints.
 */
function addApexRoof(
  acc: MeshAcc,
  ring: number[],
  eaveY: number,
  apexY: number,
  color: [number, number, number],
) {
  const count = ring.length / 2;
  if (count < 3 || count > 12) return;
  let cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cz += ring[i + 1]; }
  cx /= count;
  cz /= count;

  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    let ax = ring[i * 2], az = ring[i * 2 + 1];
    let bx = ring[j * 2], bz = ring[j * 2 + 1];
    const ux = bx - ax, uy = 0, uz = bz - az;
    const vx = cx - ax, vy = apexY - eaveY, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (ny < 0) {
      [ax, bx] = [bx, ax];
      [az, bz] = [bz, az];
      nx = -nx; ny = -ny; nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = acc.vcount;
    acc.vertex(ax, eaveY, az, nx, ny, nz, color[0], color[1], color[2]);
    acc.vertex(bx, eaveY, bz, nx, ny, nz, color[0], color[1], color[2]);
    acc.vertex(cx, apexY, cz, nx, ny, nz, color[0], color[1], color[2]);
    acc.tri(base, base + 1, base + 2);
  }
}

function addRoofFace(
  acc: MeshAcc,
  points: [number, number, number][],
  color: [number, number, number],
) {
  if (points.length < 3) return;
  const [a, b, c] = points;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; points.reverse(); }
  const len = Math.hypot(nx, ny, nz) || 1;
  const base = acc.vcount;
  for (const p of points) acc.vertex(p[0], p[1], p[2], nx / len, ny / len, nz / len, ...color);
  for (let i = 1; i < points.length - 1; i++) acc.tri(base, base + i, base + i + 1);
}

/** Exact four-sided gable with a ridge spanning the two short-edge midpoints. */
function addGabledRoof(
  acc: MeshAcc,
  ring: number[],
  eaveY: number,
  ridgeY: number,
  color: [number, number, number],
) {
  if (ring.length !== 8) return;
  const p: [number, number][] = [];
  for (let i = 0; i < 8; i += 2) p.push([ring[i], ring[i + 1]]);
  const edgeLength = (i: number) => Math.hypot(p[(i + 1) % 4][0] - p[i][0], p[(i + 1) % 4][1] - p[i][1]);
  const e0 = edgeLength(0) + edgeLength(2) >= edgeLength(1) + edgeLength(3) ? 0 : 1;
  const v0 = p[e0], v1 = p[(e0 + 1) % 4], v2 = p[(e0 + 2) % 4], v3 = p[(e0 + 3) % 4];
  const r1: [number, number, number] = [(v1[0] + v2[0]) / 2, ridgeY, (v1[1] + v2[1]) / 2];
  const r0: [number, number, number] = [(v3[0] + v0[0]) / 2, ridgeY, (v3[1] + v0[1]) / 2];
  const q = (v: [number, number]): [number, number, number] => [v[0], eaveY, v[1]];
  addRoofFace(acc, [q(v0), q(v1), r1, r0], color);
  addRoofFace(acc, [q(v2), q(v3), r0, r1], color);
  addRoofFace(acc, [q(v1), q(v2), r1], color);
  addRoofFace(acc, [q(v3), q(v0), r0], color);
}

/** Convex shed/skillion plane; height varies across the footprint's narrow axis. */
function addSkillionRoof(
  acc: MeshAcc,
  ring: number[],
  eaveY: number,
  highY: number,
  color: [number, number, number],
) {
  const bounds = ringCentroidAndBounds(ring);
  const alongX = bounds.maxX - bounds.minX <= bounds.maxZ - bounds.minZ;
  const lo = alongX ? bounds.minX : bounds.minZ;
  const span = Math.max(0.01, (alongX ? bounds.maxX : bounds.maxZ) - lo);
  const base = acc.vcount;
  for (let i = 0; i < ring.length; i += 2) {
    const t = ((alongX ? ring[i] : ring[i + 1]) - lo) / span;
    const rise = (highY - eaveY) * t;
    const slope = (highY - eaveY) / span;
    const nx = alongX ? -slope : 0;
    const nz = alongX ? 0 : -slope;
    const nl = Math.hypot(nx, 1, nz);
    acc.vertex(ring[i], eaveY + rise, ring[i + 1], nx / nl, 1 / nl, nz / nl, ...color);
  }
  const tris = earcut(ring, undefined, 2);
  for (let i = 0; i < tris.length; i += 3) pushUpTri(acc, base + tris[i], base + tris[i + 1], base + tris[i + 2]);
}

/** Cylinder+cone (water tower) into acc. */
function waterTower(acc: MeshAcc, cx: number, cz: number, yBase: number, seed: number) {
  const r = 1.7 + hash01(seed) * 0.5;
  const hCyl = 3.0 + hash01(seed + 1) * 1.2;
  const hCone = 1.6;
  const seg = 9;
  const wood: [number, number, number] = [0.32, 0.24, 0.18];
  const roof: [number, number, number] = [0.22, 0.17, 0.13];
  const yLeg = yBase + 1.1; // legs implied by shadow gap; start tank above roof
  // cylinder sides
  const base = acc.vcount;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const nx = Math.cos(a), nz = Math.sin(a);
    acc.vertex(cx + nx * r, yLeg, cz + nz * r, nx, 0, nz, wood[0], wood[1], wood[2]);
    acc.vertex(cx + nx * r, yLeg + hCyl, cz + nz * r, nx, 0, nz, wood[0], wood[1], wood[2]);
  }
  for (let i = 0; i < seg; i++) {
    const a = base + i * 2;
    acc.tri(a, a + 2, a + 1);
    acc.tri(a + 1, a + 2, a + 3);
  }
  // cone
  const apexIdx = acc.vcount;
  acc.vertex(cx, yLeg + hCyl + hCone, cz, 0, 1, 0, roof[0], roof[1], roof[2]);
  const rim = acc.vcount;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const nx = Math.cos(a), nz = Math.sin(a);
    acc.vertex(cx + nx * (r + 0.15), yLeg + hCyl, cz + nz * (r + 0.15), nx * 0.6, 0.8, nz * 0.6, roof[0], roof[1], roof[2]);
  }
  for (let i = 0; i < seg; i++) acc.tri(apexIdx, rim + i, rim + i + 1);
  // simple pedestal box
  const pr = r * 0.55;
  extrude(acc, [[cx - pr, cz - pr, cx + pr, cz - pr, cx + pr, cz + pr, cx - pr, cz + pr]], yBase, yLeg + 0.05, [0.25, 0.22, 0.2]);
}

function ringCentroidAndBounds(ring: number[]) {
  let cx = 0, cz = 0, minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const count = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], z = ring[i + 1];
    cx += x; cz += z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { cx: cx / count, cz: cz / count, minX, minZ, maxX, maxZ };
}

/** Append a box aligned to one façade edge; still part of the one tile mesh. */
function facadeBox(
  acc: MeshAcc,
  ring: number[],
  edge: number,
  along: number,
  depth: number,
  y0: number,
  y1: number,
  color: [number, number, number],
) {
  const count = ring.length / 2;
  const j = (edge + 1) % count;
  const x0 = ring[edge * 2], z0 = ring[edge * 2 + 1];
  const x1 = ring[j * 2], z1 = ring[j * 2 + 1];
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < along + 0.2) return;
  const tx = dx / len, tz = dz / len;
  const orientation = ringArea(ring) <= 0 ? 1 : -1;
  const nx = (-dz / len) * orientation, nz = (dx / len) * orientation;
  const cx = (x0 + x1) * 0.5 + nx * depth * 0.45;
  const cz = (z0 + z1) * 0.5 + nz * depth * 0.45;
  const ha = along * 0.5, hd = depth * 0.5;
  extrude(acc, [[
    cx - tx * ha - nx * hd, cz - tz * ha - nz * hd,
    cx + tx * ha - nx * hd, cz + tz * ha - nz * hd,
    cx + tx * ha + nx * hd, cz + tz * ha + nz * hd,
    cx - tx * ha + nx * hd, cz - tz * ha + nz * hd,
  ]], y0, y1, color);
}

/**
 * Bounded roof kit: edge parapets plus a few deterministic plant/skylight/
 * terrace elements. Everything lands in the merged façade payload.
 */
function addRoofDetails(
  acc: MeshAcc,
  ring: number[],
  roofY: number,
  seed: number,
  roofFamily: number,
  detail: TileBuildDetail,
) {
  if (detail < 1 || ring.length < 8) return;
  const area = Math.abs(ringArea(ring));
  if (area < 90) return;
  const bounds = ringCentroidAndBounds(ring);
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  if (width < 4 || depth < 4) return;
  if (detail === 1) {
    const parapet = roofFamily === 0 || roofFamily === 6 || roofFamily === 7;
    if (parapet && ring.length <= 28 && hash01(seed + 201) < 0.78) {
      const count = ring.length / 2;
      const stone: [number, number, number] = [0.43, 0.43, 0.4];
      for (let edge = 0; edge < count; edge++) {
        const j = (edge + 1) % count;
        const len = Math.hypot(ring[j * 2] - ring[edge * 2], ring[j * 2 + 1] - ring[edge * 2 + 1]);
        if (len >= 2.2) facadeBox(acc, ring, edge, Math.max(1.5, len - 0.18), 0.24, roofY, roofY + 0.62, stone);
      }
    }

    // Source-tagged terrace/green roof: one inset planted slab, no new material.
    if (roofFamily === 6 && width > 8 && depth > 8) {
      const gx = Math.min(width * 0.58, width - 3);
      const gz = Math.min(depth * 0.58, depth - 3);
      extrude(acc, [[
        bounds.cx - gx / 2, bounds.cz - gz / 2, bounds.cx + gx / 2, bounds.cz - gz / 2,
        bounds.cx + gx / 2, bounds.cz + gz / 2, bounds.cx - gx / 2, bounds.cz + gz / 2,
      ]], roofY + 0.05, roofY + 0.2, [0.25, 0.39, 0.23]);
    }

    if (roofFamily === 7 || (area > 500 && hash01(seed + 207) < 0.18)) {
      // Industrial skylight monitor: a compact raised strip reads clearly from
      // above without attempting expensive sawtooth tessellation.
      const sw = Math.max(2.2, Math.min(width, depth) * 0.18);
      const sl = Math.max(4, Math.max(width, depth) * 0.48);
      const alongX = width >= depth;
      const hw = alongX ? sl / 2 : sw / 2;
      const hz = alongX ? sw / 2 : sl / 2;
      extrude(acc, [[
        bounds.cx - hw, bounds.cz - hz, bounds.cx + hw, bounds.cz - hz,
        bounds.cx + hw, bounds.cz + hz, bounds.cx - hw, bounds.cz + hz,
      ]], roofY + 0.08, roofY + 0.72, [0.42, 0.48, 0.5]);
    }
    return;
  }

  if (detail !== 2 || (roofFamily !== 0 && roofFamily !== 6 && roofFamily !== 7)) return;
  const units = Math.min(3, Math.max(1, Math.floor(area / 900)));
  for (let i = 0; i < units; i++) {
    if (hash01(seed + 219 + i * 13) > 0.7) continue;
    const ux = bounds.cx + (hash01(seed + 223 + i * 17) - 0.5) * Math.max(0, width - 5) * 0.52;
    const uz = bounds.cz + (hash01(seed + 229 + i * 19) - 0.5) * Math.max(0, depth - 5) * 0.52;
    const uw = 1.5 + hash01(seed + 233 + i) * 1.8;
    const ud = 1.3 + hash01(seed + 239 + i) * 1.7;
    const uh = 0.8 + hash01(seed + 241 + i) * 1.1;
    extrude(acc, [[ux - uw / 2, uz - ud / 2, ux + uw / 2, uz - ud / 2, ux + uw / 2, uz + ud / 2, ux - uw / 2, uz + ud / 2]],
      roofY + 0.06, roofY + uh, [0.37, 0.39, 0.39]);
  }
}

/** A sparse near-only façade kit: awnings, AC sleeves, or balcony slabs. */
function addNearFacadeDetails(
  acc: MeshAcc,
  ring: number[],
  baseY: number,
  topY: number,
  seed: number,
  archetype: BuildingArchetype,
  storefront: number,
  era: number,
) {
  if (ring.length < 8 || ring.length > 28 || topY - baseY < 6) return;
  const count = ring.length / 2;
  let edge = 0, longest = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const len = Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
    if (len > longest) { longest = len; edge = i; }
  }
  // Near-only prewar silhouette kit. At most four platforms per building;
  // all beams merge into the existing detail delta, never per-prop draws.
  const prewar = era <= 3 && [0, 4, 5, 7, 8, 10].includes(archetype);
  if (prewar && longest > 4) {
    const trim: [number, number, number] = archetype === 5 ? [0.32, 0.25, 0.21] : [0.53, 0.49, 0.41];
    facadeBox(acc, ring, edge, longest - 0.3, 0.48, topY - 0.44, topY - 0.18, trim);
    facadeBox(acc, ring, edge, longest - 0.2, 0.66, topY - 0.18, topY + 0.04, trim);
    if (topY - baseY > 12) facadeBox(acc, ring, edge, longest - 0.3, 0.26, baseY + 4.2, baseY + 4.4, trim);
  }
  const next = (edge + 1) % count;
  const ax = ring[edge * 2], az = ring[edge * 2 + 1];
  const tx = (ring[next * 2] - ax) / longest, tz = (ring[next * 2 + 1] - az) / longest;
  const orientation = ringArea(ring) <= 0 ? 1 : -1;
  const nx = -tz * orientation, nz = tx * orientation;
  const cx = ax + tx * longest * .5, cz = az + tz * longest * .5;
  const beam = (along: number, out: number, w: number, d: number, y: number, h: number, color: [number, number, number]) => {
    const x = cx + tx * along + nx * out, z = cz + tz * along + nz * out;
    extrude(acc, [[x - tx*w/2 - nx*d/2, z - tz*w/2 - nz*d/2,
      x + tx*w/2 - nx*d/2, z + tz*w/2 - nz*d/2,
      x + tx*w/2 + nx*d/2, z + tz*w/2 + nz*d/2,
      x - tx*w/2 + nx*d/2, z - tz*w/2 + nz*d/2]], y, y+h, color);
  };
  if (archetype === 5 && longest < 19) {
    const stone: [number, number, number] = [.32, .24, .19];
    for (let step = 0; step < 5; step++) beam(longest * .23, 1.9 - step*.28, 1.55, .34, baseY, .19*(step+1), stone);
  }
  if (prewar && [0, 4, 7].includes(archetype) && longest > 7 && topY-baseY < 42 && hash01(seed + 331) < .44) {
    const iron: [number, number, number] = [.10, .105, .10];
    const pitch = 3.1 * (0.94 + .14 * hash01(seed + 113));
    const floors = Math.min(4, Math.floor((topY-baseY-4.5)/pitch));
    for (let f = 0; f < floors; f++) {
      const y = baseY + 3.65 + .85 * hash01(seed + 113) + .8 + f*pitch;
      beam(0, .73, 2.65, 1.28, y, .09, iron);
      beam(0, 1.34, 2.65, .045, y+.95, .055, iron);
      for (const along of [-1.28, -.65, 0, .65, 1.28]) beam(along, 1.34, .035, .035, y+.09, .9, iron);
      // Open treads connect successive platforms without opaque stair blocks.
      if (f > 0) for (let step = 0; step < 9; step++) beam(-1.05+step*.25, .8, .29, .57, y-pitch+step*pitch/9, .045, iron);
    }
  }
  if (storefront > 0 && longest > 6 && hash01(seed + 301) < 0.62) {
    facadeBox(acc, ring, edge, Math.min(longest * 0.62, 9), 1.15, baseY + 3.05, baseY + 3.22,
      storefront === 2 ? [0.42, 0.16, 0.11] : [0.17, 0.25, 0.31]);
  }
  if (archetype === 9 && longest > 7) {
    const floors = Math.min(4, Math.floor((topY - baseY - 5) / 6));
    for (let i = 0; i < floors; i++) {
      facadeBox(acc, ring, edge, Math.min(longest * 0.44, 7), 1.0, baseY + 5.5 + i * 6, baseY + 5.68 + i * 6,
        [0.5, 0.5, 0.48]);
    }
  } else if ((archetype === 0 || archetype === 4 || archetype === 13) && longest > 5 && hash01(seed + 307) < 0.28) {
    const y = Math.min(topY - 1.2, baseY + 6 + hash01(seed + 311) * Math.max(1, topY - baseY - 8));
    facadeBox(acc, ring, edge, 0.85, 0.48, y, y + 0.62, [0.49, 0.5, 0.48]);
  }
}

/**
 * Ribbon along a polyline. `lateralOffset` shifts the whole ribbon sideways
 * (lane lines); `uvScale` maps meters to texture repeats (0 = no UVs written).
 * `dashes` = [on, off] meters emits interrupted segments (dashed lines).
 */
function buildRibbon(
  acc: MeshAcc,
  pts: number[],
  width: number,
  ys: number[],
  col: [number, number, number],
  lateralOffset = 0,
  uvScale = 0,
  dashes: [number, number] | null = null,
  edgeShade = 1,
) {
  const n = pts.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  const laterals: number[] = new Array(n * 2);
  const dists: number[] = new Array(n);
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    if (i > 0) dist += Math.hypot(x - pts[(i - 1) * 2], z - pts[(i - 1) * 2 + 1]);
    dists[i] = dist;
    let dx = 0, dz = 0;
    if (i > 0) { dx += x - pts[(i - 1) * 2]; dz += z - pts[(i - 1) * 2 + 1]; }
    if (i < n - 1) { dx += pts[(i + 1) * 2] - x; dz += pts[(i + 1) * 2 + 1] - z; }
    const len = Math.hypot(dx, dz) || 1;
    let lx = -dz / len, lz = dx / len;
    if (i > 0 && i < n - 1) {
      const ax = x - pts[(i - 1) * 2], az = z - pts[(i - 1) * 2 + 1];
      const alen = Math.hypot(ax, az) || 1;
      const cosHalf = (ax / alen) * (dx / len) + (az / alen) * (dz / len);
      const scale = Math.min(2, 1 / Math.max(0.5, Math.abs(cosHalf)));
      lx *= scale; lz *= scale;
    }
    laterals[i * 2] = lx;
    laterals[i * 2 + 1] = lz;
  }

  const emit = (i0: number, i1: number) => {
    const base = acc.vcount;
    const shadedEdges = edgeShade < 0.999;
    const rowVerts = shadedEdges ? 3 : 2;
    for (let i = i0; i <= i1; i++) {
      const x = pts[i * 2] + laterals[i * 2] * lateralOffset;
      const z = pts[i * 2 + 1] + laterals[i * 2 + 1] * lateralOffset;
      const lx = laterals[i * 2], lz = laterals[i * 2 + 1];
      const y = ys[i];
      const u = uvScale ? dists[i] * uvScale : 0;
      if (shadedEdges) {
        acc.vertex(x + lx * hw, y, z + lz * hw, 0, 1, 0, col[0] * edgeShade, col[1] * edgeShade, col[2] * edgeShade, u, (hw * uvScale));
        acc.vertex(x, y, z, 0, 1, 0, col[0], col[1], col[2], u, 0);
        acc.vertex(x - lx * hw, y, z - lz * hw, 0, 1, 0, col[0] * edgeShade, col[1] * edgeShade, col[2] * edgeShade, u, -(hw * uvScale));
      } else {
        acc.vertex(x + lx * hw, y, z + lz * hw, 0, 1, 0, col[0], col[1], col[2], u, (hw * uvScale));
        acc.vertex(x - lx * hw, y, z - lz * hw, 0, 1, 0, col[0], col[1], col[2], u, -(hw * uvScale));
      }
    }
    for (let i = 0; i < i1 - i0; i++) {
      const a = base + i * rowVerts;
      const b = a + rowVerts;
      if (shadedEdges) {
        pushUpTri(acc, a, b, a + 1);
        pushUpTri(acc, a + 1, b, b + 1);
        pushUpTri(acc, a + 1, b + 1, a + 2);
        pushUpTri(acc, a + 2, b + 1, b + 2);
      } else {
        pushUpTri(acc, a, b, a + 1);
        pushUpTri(acc, a + 1, b, b + 1);
      }
    }
  };

  if (!dashes) {
    emit(0, n - 1);
    return;
  }

  // dashed: walk the polyline, emitting sub-ribbons during the "on" phase
  const [on, off] = dashes;
  const period = on + off;
  let segStartIdx: number | null = null;
  const cut: number[] = [];
  const cutYs: number[] = [];
  const emitCut = () => {
    if (cut.length >= 4) {
      const saved = acc.uvs; // dashes carry no meaningful uv; keep zeros
      buildRibbon(acc, cut, width, cutYs, col, 0, 0, null);
      void saved;
    }
    cut.length = 0;
    cutYs.length = 0;
  };
  const step = 0.4;
  for (let d = 0; d < dists[n - 1]; d += step) {
    const phase = d % period;
    const onPhase = phase < on;
    // interpolate point at distance d (+ lateral offset)
    let i = 0;
    while (i < n - 2 && dists[i + 1] < d) i++;
    const segLen = dists[i + 1] - dists[i] || 1;
    const t = (d - dists[i]) / segLen;
    const x = pts[i * 2] + (pts[(i + 1) * 2] - pts[i * 2]) * t + (laterals[i * 2]) * lateralOffset;
    const z = pts[i * 2 + 1] + (pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]) * t + (laterals[i * 2 + 1]) * lateralOffset;
    const y = ys[i] + (ys[i + 1] - ys[i]) * t;
    if (onPhase) {
      cut.push(x, z);
      cutYs.push(y);
      segStartIdx = segStartIdx ?? i;
    } else if (cut.length) {
      emitCut();
      segStartIdx = null;
    }
  }
  emitCut();
}

function buildRaisedCurb(
  acc: MeshAcc,
  pts: number[],
  ys: number[],
  lateralOffset: number,
  height = 0.14,
  drivewayCuts: readonly [number, number][] = [],
) {
  if (drivewayCuts.length) {
    // Subdivide only curb runs that may contain a source-tagged driveway.
    // Omit a 3.6m opening around the driveway center, producing an actual
    // geometry break instead of a shader flag.
    for (let i = 1; i < pts.length / 2; i++) {
      const x0 = pts[(i - 1) * 2], z0 = pts[(i - 1) * 2 + 1];
      const x1 = pts[i * 2], z1 = pts[i * 2 + 1];
      const length = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(1, Math.ceil(length / 1.6));
      for (let step = 0; step < steps; step++) {
        const t0 = step / steps, t1 = (step + 1) / steps, tm = (t0 + t1) * 0.5;
        const dx = x1 - x0, dz = z1 - z0;
        const segLength = Math.hypot(dx, dz) || 1;
        const nx = -dz / segLength, nz = dx / segLength;
        const mx = x0 + dx * tm + nx * lateralOffset;
        const mz = z0 + dz * tm + nz * lateralOffset;
        let cut = false;
        for (const point of drivewayCuts) {
          if ((point[0] - mx) ** 2 + (point[1] - mz) ** 2 < 1.8 ** 2) { cut = true; break; }
        }
        if (cut) continue;
        buildRaisedCurb(
          acc,
          [x0 + dx * t0, z0 + dz * t0, x0 + dx * t1, z0 + dz * t1],
          [ys[i - 1] + (ys[i] - ys[i - 1]) * t0, ys[i - 1] + (ys[i] - ys[i - 1]) * t1],
          lateralOffset,
          height,
        );
      }
    }
    return;
  }
  const top = ys.map((y) => y + height);
  const color: [number, number, number] = [0.73, 0.74, 0.72];
  buildRibbon(acc, pts, 0.32, top, color, lateralOffset, 0.25);
  const sideColor: [number, number, number] = [0.54, 0.55, 0.53];
  for (let i = 1; i < pts.length / 2; i++) {
    const x0 = pts[(i - 1) * 2], z0 = pts[(i - 1) * 2 + 1];
    const x1 = pts[i * 2], z1 = pts[i * 2 + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = -dz / len, nz = dx / len;
    for (const edge of [-0.16, 0.16]) {
      const off = lateralOffset + edge;
      const ax = x0 + nx * off, az = z0 + nz * off;
      const bx = x1 + nx * off, bz = z1 + nz * off;
      const normalSign = edge > 0 ? 1 : -1;
      const base = acc.vcount;
      acc.vertex(ax, ys[i - 1], az, nx * normalSign, 0, nz * normalSign, sideColor[0], sideColor[1], sideColor[2]);
      acc.vertex(bx, ys[i], bz, nx * normalSign, 0, nz * normalSign, sideColor[0], sideColor[1], sideColor[2]);
      acc.vertex(bx, top[i], bz, nx * normalSign, 0, nz * normalSign, sideColor[0], sideColor[1], sideColor[2]);
      acc.vertex(ax, top[i - 1], az, nx * normalSign, 0, nz * normalSign, sideColor[0], sideColor[1], sideColor[2]);
      acc.tri(base, base + 1, base + 2);
      acc.tri(base, base + 2, base + 3);
    }
  }
}

function addIntersectionFan(
  acc: MeshAcc,
  x: number,
  z: number,
  y: number,
  radius: number,
  color: [number, number, number],
) {
  const segments = 12;
  const base = acc.vcount;
  acc.vertex(x, y, z, 0, 1, 0, ...color);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    acc.vertex(x + Math.cos(a) * radius, y, z + Math.sin(a) * radius, 0, 1, 0, ...color);
  }
  for (let i = 0; i < segments; i++) pushUpTri(acc, base, base + i + 1, base + i + 2);
}

function addSidewalkCorner(
  acc: MeshAcc,
  points: number[],
  y: number,
) {
  const ring: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i], z = points[i + 1];
    const previous = ring.length >= 2
      ? Math.hypot(x - ring[ring.length - 2], z - ring[ring.length - 1])
      : Infinity;
    if (previous > 0.025) ring.push(x, z);
  }
  if (ring.length >= 6
    && Math.hypot(ring[0] - ring[ring.length - 2], ring[1] - ring[ring.length - 1]) < 0.025) {
    ring.length -= 2;
  }
  if (ring.length < 6) return;
  const triangles = earcut(ring, undefined, 2);
  if (triangles.length < 3) return;
  const base = acc.vcount;
  const color: [number, number, number] = [0.82, 0.82, 0.79];
  for (let i = 0; i < ring.length; i += 2) {
    acc.vertex(ring[i], y + 0.14, ring[i + 1], 0, 1, 0, ...color, ring[i] * 0.25, ring[i + 1] * 0.25);
  }
  for (let i = 0; i < triangles.length; i += 3) {
    pushUpTri(acc, base + triangles[i], base + triangles[i + 1], base + triangles[i + 2]);
  }
}

function addRoadRect(
  acc: MeshAcc,
  cx: number,
  cz: number,
  tx: number,
  tz: number,
  along: number,
  across: number,
  y: number,
  color: [number, number, number],
) {
  const bx = -tz, bz = tx;
  const ha = along * 0.5, hb = across * 0.5;
  const base = acc.vcount;
  acc.vertex(cx - tx * ha - bx * hb, y, cz - tz * ha - bz * hb, 0, 1, 0, ...color);
  acc.vertex(cx + tx * ha - bx * hb, y, cz + tz * ha - bz * hb, 0, 1, 0, ...color);
  acc.vertex(cx + tx * ha + bx * hb, y, cz + tz * ha + bz * hb, 0, 1, 0, ...color);
  acc.vertex(cx - tx * ha + bx * hb, y, cz - tz * ha + bz * hb, 0, 1, 0, ...color);
  pushUpTri(acc, base, base + 1, base + 2);
  pushUpTri(acc, base, base + 2, base + 3);
}

function addManhole(acc: MeshAcc, cx: number, cz: number, y: number, seed: number) {
  const seg = 10;
  const radius = 0.42 + hash01(seed) * 0.1;
  const color: [number, number, number] = [0.19, 0.2, 0.2];
  const center = acc.vcount;
  acc.vertex(cx, y, cz, 0, 1, 0, ...color);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const tooth = i % 2 ? 0.98 : 1.02;
    acc.vertex(cx + Math.cos(a) * radius * tooth, y, cz + Math.sin(a) * radius * tooth, 0, 1, 0, ...color);
  }
  for (let i = 0; i < seg; i++) pushUpTri(acc, center, center + i + 1, center + i + 2);
}

function addTopologyCrosswalk(
  acc: MeshAcc,
  pts: number[],
  ys: number[],
  roadWidth: number,
  atStart: boolean,
) {
  const total = polyLength(pts);
  if (total < 8) return;
  const inset = Math.min(5.5, total * 0.24);
  const centerDistance = atStart ? inset : total - inset;
  for (let bar = -2; bar <= 2; bar++) {
    const [cx, cz, tx, tz, y] = pointAt(pts, ys, centerDistance + bar * 0.78);
    addRoadRect(acc, cx, cz, tx, tz, 0.42, Math.max(3.2, roadWidth - 0.9), y + 0.024,
      [0.76, 0.77, 0.76]);
  }
}

function polyLength(pts: number[]): number {
  let d = 0;
  for (let i = 1; i < pts.length / 2; i++) {
    d += Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
  }
  return d;
}

function pointPolylineDistance(x: number, z: number, pts: number[]): number {
  let best = Infinity;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], z0 = pts[i - 1], x1 = pts[i], z1 = pts[i + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
  }
  return best;
}

/** Point + unit tangent + interpolated y at arc distance d along a polyline. */
function pointAt(pts: number[], ys: number[], d: number): [number, number, number, number, number] {
  let acc = 0;
  for (let i = 1; i < pts.length / 2; i++) {
    const sx = pts[(i - 1) * 2], sz = pts[(i - 1) * 2 + 1];
    const ex = pts[i * 2], ez = pts[i * 2 + 1];
    const seg = Math.hypot(ex - sx, ez - sz);
    if (acc + seg >= d || i === pts.length / 2 - 1) {
      const t = seg > 0 ? Math.min(1, (d - acc) / seg) : 0;
      const tx = seg > 0 ? (ex - sx) / seg : 1;
      const tz = seg > 0 ? (ez - sz) / seg : 0;
      return [sx + (ex - sx) * t, sz + (ez - sz) * t, tx, tz, ys[i - 1] + (ys[i] - ys[i - 1]) * t];
    }
    acc += seg;
  }
  return [pts[0], pts[1], 1, 0, ys[0]];
}

/**
 * Remove an arc-length interval from each end of a polyline while preserving
 * every interior bend. Attached sidewalks use this at real junctions so their
 * offset ribbons stop at the curb return instead of continuing across the
 * intersecting carriageway.
 */
function trimPolyline(
  pts: number[],
  ys: number[],
  trimStart: number,
  trimEnd: number,
): { pts: number[]; ys: number[] } | null {
  const total = polyLength(pts);
  const start = Math.max(0, trimStart);
  const end = Math.min(total, total - Math.max(0, trimEnd));
  if (end - start < 1.25) return null;

  const startPoint = pointAt(pts, ys, start);
  const endPoint = pointAt(pts, ys, end);
  const outPts = [startPoint[0], startPoint[1]];
  const outYs = [startPoint[4]];
  let distance = 0;
  for (let i = 1; i < pts.length / 2; i++) {
    distance += Math.hypot(
      pts[i * 2] - pts[(i - 1) * 2],
      pts[i * 2 + 1] - pts[(i - 1) * 2 + 1],
    );
    if (distance > start + 1e-4 && distance < end - 1e-4) {
      outPts.push(pts[i * 2], pts[i * 2 + 1]);
      outYs.push(ys[i]);
    }
  }
  outPts.push(endPoint[0], endPoint[1]);
  outYs.push(endPoint[4]);
  return { pts: outPts, ys: outYs };
}

function pushUpTri(acc: MeshAcc, a: number, b: number, c: number) {
  const p = acc.pos;
  const ax = p[a * 3], az = p[a * 3 + 2];
  const bx = p[b * 3], bz = p[b * 3 + 2];
  const cx = p[c * 3], cz = p[c * 3 + 2];
  const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  if (crossY < 0) acc.tri(a, c, b); else acc.tri(a, b, c);
}

function buildTile(tile: TileJson, detail: TileBuildDetail, requestId: number): BuildResponse {
  const ox = tile.x * TILE_SIZE;
  const oz = tile.z * TILE_SIZE;
  const toWorld = (d: number, origin: number) => origin + d / 10;
  const v2 = (tile.v ?? 1) >= 2; // elevations baked; areas/trees are [x,z,e] triples

  // ---- buildings ----
  const bAcc = new MeshAcc(false, true, true);
  const colRings: number[][] = [];
  const colAabb: number[] = [];
  const colTop: number[] = [];
  const colBase: number[] = [];
  const retailAnchorValues: number[] = [];
  let seedBase = (tile.x * 73856093) ^ (tile.z * 19349663);

  if (tile.buildings) {
    for (let bi = 0; bi < tile.buildings.length; bi++) {
      const b = tile.buildings[bi];
      const seed = b.v ?? (seedBase + bi * 17);
      const rings = b.p.map((ring) => {
        const out: number[] = new Array(ring.length);
        for (let i = 0; i < ring.length; i += 2) {
          out[i] = toWorld(ring[i], ox);
          out[i + 1] = toWorld(ring[i + 1], oz);
        }
        return out;
      });
      // baked OSM massing of a monument the landmark system rebuilds? skip it
      // (height guard: never suppress a real tower that merely stands close)
      if (CLEAR_ZONES.length && b.h < 80) {
        const r0 = rings[0];
        let cx = 0, cz = 0;
        const rn = r0.length / 2;
        for (let i = 0; i < r0.length; i += 2) { cx += r0[i]; cz += r0[i + 1]; }
        cx /= rn; cz /= rn;
        let cleared = false;
        for (const zn of CLEAR_ZONES) {
          if (zn.name && b.n === zn.name) { cleared = true; break; }
          if (!zn.r2) continue;
          const dx = cx - zn.x, dz = cz - zn.z;
          if (dx * dx + dz * dz < zn.r2) { cleared = true; break; }
        }
        if (cleared) continue;
      }
      const h = Math.max(3, b.h);
      const minH = b.m ?? 0;
      const base = b.b ?? 0;
      const archetype = (
        Number.isInteger(b.a) && (b.a as number) >= 0 && (b.a as number) <= 15
          ? b.a
          : legacyBuildingArchetype(seed, h, b.k)
      ) as BuildingArchetype;
      const semantics = semanticsForBuilding(b, archetype);
      const bc = buildingColor(seed, h, semantics.archetype, b.c);
      const rc = roofColor(seed, b.q, b.o, bc.col);
      bAcc.facadeBase = base;
      bAcc.facadeSeed = hash01(seed + 113);
      bAcc.styleCursor = bc.archetype;
      bAcc.semanticCursor = b.s ?? packBuildingSemantics(semantics);
      const solidHeight = h - minH;
      const apexRoof = rings.length === 1
        && (semantics.roof === 1 || semantics.roof === 4 || semantics.roof === 5)
        && rings[0].length >= 6
        && rings[0].length <= 24
        && isConvexRing(rings[0])
        && solidHeight >= 5;
      const gabledRoof = rings.length === 1 && semantics.roof === 2 && rings[0].length === 8 && solidHeight >= 5;
      const skillionRoof = rings.length === 1 && semantics.roof === 3
        && rings[0].length >= 6 && rings[0].length <= 24 && isConvexRing(rings[0]) && solidHeight >= 4;
      const shapedRoof = apexRoof || gabledRoof || skillionRoof;
      const roofRise = shapedRoof
        ? Math.min(7, solidHeight * 0.35, Math.max(1.2, h * (semantics.roof === 4 ? 0.18 : 0.12)))
        : 0;
      const wallTop = base + h - roofRise;
      if (detail === 2 && semantics.storefront > 0 && minH === 0) {
        const footprint = ringCentroidAndBounds(rings[0]);
        retailAnchorValues.push(footprint.cx, base, footprint.cz, semantics.storefront);
      }
      if (tileDetailIncludesBaseSurfaces(detail)) {
        // Stable base massing is uploaded once. Sink foundations 2.5m so
        // sloped ground never shows a gap; elevated parts get a sealed bottom.
        extrude(
          bAcc,
          rings,
          base + minH - (minH > 0 ? 0 : 2.5),
          wallTop,
          bc.col,
          minH > 0,
          rc,
        );
        if (apexRoof) addApexRoof(bAcc, rings[0], wallTop, base + h, rc);
        else if (gabledRoof) addGabledRoof(bAcc, rings[0], wallTop, base + h, rc);
        else if (skillionRoof) addSkillionRoof(bAcc, rings[0], wallTop, base + h, rc);
      } else {
        // Roof furniture and near façade kits are separate immutable deltas;
        // neither path repeats the base extrusion or the other detail tier.
        bAcc.facadeSeed = -1;
        addRoofDetails(bAcc, rings[0], base + h, seed, semantics.roof, detail);
      }
      if (detail === 2 && minH === 0 && hash01(seed + 297) < 0.42) {
        bAcc.facadeSeed = -1;
        addNearFacadeDetails(bAcc, rings[0], base, wallTop, seed, semantics.archetype, semantics.storefront, semantics.era);
      }

      // collision for every solid part: ground-level buildings push the player
      // out; elevated parts (setback towers, skybridges) carry base+top so the
      // player can land on / collide with them only at their own altitude
      if (rings[0].length >= 6) {
        colRings.push(rings[0]);
        let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
        for (let i = 0; i < rings[0].length; i += 2) {
          minX = Math.min(minX, rings[0][i]); maxX = Math.max(maxX, rings[0][i]);
          minZ = Math.min(minZ, rings[0][i + 1]); maxZ = Math.max(maxZ, rings[0][i + 1]);
        }
        colAabb.push(minX, minZ, maxX, maxZ);
        colTop.push(base + h);
        colBase.push(base + minH);
      }

      // water towers on mid-rise flat roofs
      if (detail === 1 && minH === 0 && h > 22 && h < 95 && hash01(seed + 3) < 0.22) {
        const ring = rings[0];
        // centroid
        let cx = 0, cz = 0; const n = ring.length / 2;
        for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cz += ring[i + 1]; }
        cx /= n; cz /= n;
        // rough area check
        const area = Math.abs(ringArea(ring));
        if (area > 220) { bAcc.styleCursor = 4; waterTower(bAcc, cx, cz, base + h, seed + 5); }
      }
    }
  }

  // ---- flat layers: areas, asphalt roads (uv'd), concrete walks (uv'd), markings ----
  const aAcc = new MeshAcc();
  const wtrAcc = new MeshAcc(); // water only — rendered with the animated water material
  const rAcc = new MeshAcc(true);
  const wAcc = new MeshAcc(true);
  const mAcc = new MeshAcc();
  const WHITE: [number, number, number] = [0.8, 0.81, 0.82];
  const YELLOW: [number, number, number] = [0.82, 0.65, 0.1];

  if (tileDetailIncludesBaseSurfaces(detail) && tile.areas) {
    const stride = v2 ? 3 : 2;
    for (const kind of Object.keys(tile.areas)) {
      const style = AREA_STYLE[kind] ?? AREA_STYLE.grass;
      const tris = tile.areas[kind];
      // Water goes to its own mesh so it can carry the animated water material (waves,
      // fresnel-to-sky, sun glint) — the same look as the ocean plane — instead of the flat
      // teal vertex color that read as painted parkland. Everything else merges into aAcc.
      // The style color is still written per vertex as a harmless fallback tint.
      const acc = kind === 'water' ? wtrAcc : aAcc;
      const base = acc.vcount;
      for (let i = 0; i < tris.length; i += stride) {
        const ey = v2 ? tris[i + 2] / 10 : 0;
        acc.vertex(toWorld(tris[i], ox), ey + style.y, toWorld(tris[i + 1], oz), 0, 1, 0, style.col[0], style.col[1], style.col[2]);
      }
      for (let v = 0; v < tris.length / stride; v += 3) {
        pushUpTri(acc, base + v, base + v + 1, base + v + 2);
      }
    }
  }

  // Eject centerlines: real streets + bike lanes + service lanes. Footways,
  // steps and crossings stay out — they are places props are SUPPOSED to stand,
  // and at the closest minimap zoom they turn the grid into hairball noise.
  //
  // Service lanes used to be skipped here too, which silently made the runtime
  // placement solver blind to them: World.ejectFromRoads only sees what lands in
  // RoadPaths, so every bus stop / bike dock / entrance kit that ended up in a
  // driveway or parking aisle stayed there. They ride along tagged
  // PATH_KIND_SERVICE so the solver sees them while the minimap and the
  // street-name / curb-tangent lookups still ignore them.
  const MINIMAP_SKIP = new Set(['footway', 'path', 'steps', 'crossing']);
  const mmStart: number[] = [0];
  const mmPts: number[] = [];
  const mmWidth: number[] = [];
  const mmKind: number[] = [];
  const mmFlags: number[] = [];
  // vehicular centerlines (world coords) for pushing signs off the roadbed;
  // bike lanes count too — a street sign planted mid-lane is an obstruction
  const vroads: { pts: number[]; half: number }[] = [];
  // bike-lane ribbons (world coords) so trees/hydrants stay out of them
  const bikePaths: { pts: number[]; half: number }[] = [];

  // corner-sign blades naming curated protected-lane streets, in world coords
  const signBlades: { x: number; z: number; ang: number; name: string }[] = [];
  for (const s of tile.signs ?? []) {
    for (let b = 0; b < s.n.length; b++) {
      if (!CURATED_LANES[s.n[b]]) continue;
      signBlades.push({
        x: toWorld(s.p[0], ox), z: toWorld(s.p[1], oz),
        ang: ((s.a[b] ?? 0) * Math.PI) / 180, name: s.n[b],
      });
    }
  }
  // Explicit OSM crossing ways suppress topology inference nearby. Without
  // this guard a complex node (especially Columbus Circle) received the real
  // crossing plus a second five-bar crossing for every connected road piece.
  const explicitCrossingPoints: Array<readonly [number, number]> = [];
  for (const road of tile.roads ?? []) {
    if (road.c !== 'crossing') continue;
    for (let i = 0; i < road.p.length; i += 2) {
      explicitCrossingPoints.push([
        toWorld(road.p[i], ox),
        toWorld(road.p[i + 1], oz),
      ]);
    }
  }
  const hasExplicitCrossingNear = (x: number, z: number): boolean =>
    explicitCrossingPoints.some(([cx, cz]) => (cx - x) ** 2 + (cz - z) ** 2 <= 13 ** 2);
  const inferredCrosswalkKeys = new Set<string>();
  const crosswalkRoads: { pts: number[]; half: number }[] = [];
  for (const road of tile.roads ?? []) {
    if (road.b || !VEHICULAR_ROADS.has(road.c)) continue;
    const style = ROAD_STYLE[road.c] ?? ROAD_STYLE.residential;
    const width = Math.max(1.2, Math.min(45, road.w !== undefined ? road.w / 10 : style.w));
    crosswalkRoads.push({
      pts: road.p.map((value, index) => toWorld(value, index % 2 === 0 ? ox : oz)),
      half: width * 0.5,
    });
  }
  const crosswalkRoadHalfWidth = (
    x: number,
    z: number,
    crossingDx: number,
    crossingDz: number,
  ): number => {
    let bestHalfWidth = 0;
    for (const road of crosswalkRoads) {
      for (let i = 2; i < road.pts.length; i += 2) {
        const ax = road.pts[i - 2], az = road.pts[i - 1];
        const bx = road.pts[i], bz = road.pts[i + 1];
        const dx = bx - ax, dz = bz - az;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq));
        const qx = ax + dx * t, qz = az + dz * t;
        if ((x - qx) ** 2 + (z - qz) ** 2 > (road.half + 0.3) ** 2) continue;
        const inverseLength = 1 / Math.sqrt(lengthSq);
        const parallel = Math.abs(
          crossingDx * dx * inverseLength + crossingDz * dz * inverseLength,
        );
        // A crosswalk traverses a carriageway. Reject OSM pedestrian-network
        // fragments that run along a lane or diagonally through a junction.
        if (parallel <= 0.58) bestHalfWidth = Math.max(bestHalfWidth, road.half);
      }
    }
    return bestHalfWidth;
  };
  const explicitCrosswalkPaintKeys = new Set<string>();
  const drivewayCuts: [number, number][] = [];
  for (const road of tile.roads ?? []) {
    if (!(road.f && (road.f & ROAD_FLAG_DRIVEWAY)) || road.p.length < 4) continue;
    drivewayCuts.push(
      [toWorld(road.p[0], ox), toWorld(road.p[1], oz)],
      [toWorld(road.p[road.p.length - 2], ox), toWorld(road.p[road.p.length - 1], oz)],
    );
  }
  // Street-section geometry belongs exclusively to detail 1. Avoid rebuilding
  // its topology graph for base and near delta requests that cannot consume it.
  const sidewalkRoads: SidewalkTopologyRoad[] = detail === 1 ? (tile.roads ?? []).map((road) => {
    const style = ROAD_STYLE[road.c] ?? ROAD_STYLE.residential;
    const width = Math.max(1.2, Math.min(45, road.w !== undefined ? road.w / 10 : style.w));
    const legacyFlags = !road.b && SURFACE_STREETS.has(road.c)
      ? ROAD_FLAG_SIDEWALK_LEFT | ROAD_FLAG_SIDEWALK_RIGHT
      : 0;
    const flags = road.f ?? legacyFlags;
    const count = road.p.length / 2;
    const pts = road.p.map((value, index) =>
      toWorld(value, index % 2 === 0 ? ox : oz));
    const ys = new Array<number>(count);
    for (let i = 0; i < count; i++) ys[i] = (road.e ? road.e[i] : road.b ? 7 : 0) + style.y;
    return {
      pts,
      ys,
      halfWidth: width * 0.5,
      // Attached sidewalks form corners only with other ground-level surface
      // streets. Service driveways already receive explicit curb cuts and must
      // not split a main sidewalk into two unowned terminal gaps.
      participates: !road.b
        && SURFACE_STREETS.has(road.c)
        && !(flags & ROAD_FLAG_DRIVEWAY),
      sidewalkLeft: SURFACE_STREETS.has(road.c) && Boolean(flags & ROAD_FLAG_SIDEWALK_LEFT),
      sidewalkRight: SURFACE_STREETS.has(road.c) && Boolean(flags & ROAD_FLAG_SIDEWALK_RIGHT),
      junctionStart: Boolean(flags & ROAD_FLAG_INTERSECTION_START),
      junctionEnd: Boolean(flags & ROAD_FLAG_INTERSECTION_END),
      expectedDegreeStart: road.i?.[0] ?? 0,
      expectedDegreeEnd: road.i?.[1] ?? 0,
    };
  }) : [];
  const sidewalkTopology = detail === 1 ? buildSidewalkTopology(sidewalkRoads, {
    minX: ox,
    minZ: oz,
    maxX: ox + TILE_SIZE,
    maxZ: oz + TILE_SIZE,
  }) : null;

  let roadIndex = 0;
  const intersectionFans = new Map<string, {
    x: number; z: number; y: number; radius: number; color: [number, number, number];
  }>();
  if (tile.roads) {
    for (const r of tile.roads) {
      const currentRoadIndex = roadIndex++;
      const roadSeed = seedBase + currentRoadIndex * 53;
      const style = ROAD_STYLE[r.c] ?? ROAD_STYLE.residential;
      const bike = r.c === 'cycleway';
      const roadWidth = Math.max(1.2, Math.min(45, r.w !== undefined ? r.w / 10 : style.w));
      const legacySidewalks = !r.b && SURFACE_STREETS.has(r.c)
        ? ROAD_FLAG_SIDEWALK_LEFT | ROAD_FLAG_SIDEWALK_RIGHT
        : 0;
      const roadFlags = r.f ?? legacySidewalks;
      const n = r.p.length / 2;
      const pts: number[] = new Array(r.p.length);
      const ys: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        pts[i * 2] = toWorld(r.p[i * 2], ox);
        pts[i * 2 + 1] = toWorld(r.p[i * 2 + 1], oz);
        ys[i] = (r.e ? r.e[i] : r.b ? 7 : 0) + style.y;
      }
      // OSM lane alignments occasionally graze a building footprint — walk
      // those points back out so the painted lane never runs through a wall
      if (bike) nudgePolylineOutOfBuildings(pts, ys, colRings, colAabb, colBase, roadWidth / 2 + 0.3);
      if (n >= 2 && (VEHICULAR_ROADS.has(r.c) || bike)) vroads.push({ pts, half: roadWidth / 2 });
      if (bike && n >= 2) bikePaths.push({ pts, half: roadWidth / 2 });
      if (tileDetailIncludesBaseSurfaces(detail) && !MINIMAP_SKIP.has(r.c) && n >= 2) {
        for (const v of pts) mmPts.push(v);
        mmStart.push(mmPts.length / 2);
        mmWidth.push(roadWidth);
        mmKind.push(bike ? PATH_KIND_BIKE : r.c === 'service' ? PATH_KIND_SERVICE : PATH_KIND_ROAD);
        mmFlags.push(roadFlags);
      }
      const concrete = CONCRETE_CLASSES.has(r.c);
      const acc = concrete ? wAcc : rAcc;
      const surfaceVariation = 0.94 + hash01(roadSeed + 31) * 0.1;
      // near-white base tint so the texture map carries the color
      const tint: [number, number, number] = r.b
        ? [0.95, 0.97, 1.02]
        : concrete
          ? [style.col[0] * 1.55, style.col[1] * 1.55, style.col[2] * 1.55]
          : [style.col[0] * 4.2, style.col[1] * 4.2, style.col[2] * 4.2];
      const roadColor: [number, number, number] = [
        Math.min(1.15, tint[0] * surfaceVariation),
        Math.min(1.15, tint[1] * surfaceVariation),
        Math.min(1.15, tint[2] * surfaceVariation),
      ];
      // Base carries only the broad road skeleton. Mid adds the missing local
      // streets/paths plus street-section geometry without repeating any base
      // road ribbon.
      // A crossing way is a routing centerline between two kerbs, not another
      // slab of pavement. Its former concrete ribbon was the pale "sidewalk in
      // the street" visible at every Manhattan crosswalk; near detail owns only
      // the road marking below.
      const emitSurface = r.c !== 'crossing' && detail === tileRoadSurfaceDetail(r.c);
      if (emitSurface) buildRibbon(acc, pts, roadWidth, ys, roadColor, 0, 0.25, null, concrete ? 1 : 0.73);
      if (detail === 1 && !r.b && !concrete && SURFACE_STREETS.has(r.c)) {
        const rememberFan = (pointIndex: number) => {
          const x = pts[pointIndex * 2], z = pts[pointIndex * 2 + 1], y = ys[pointIndex] + 0.002;
          const key = `${Math.round(x * 5)},${Math.round(z * 5)}`;
          const radius = Math.min(9, Math.max(3.2, roadWidth * 0.58));
          const previous = intersectionFans.get(key);
          if (!previous || radius > previous.radius) intersectionFans.set(key, { x, z, y, radius, color: roadColor });
        };
        if (roadFlags & ROAD_FLAG_INTERSECTION_START) rememberFan(0);
        if (roadFlags & ROAD_FLAG_INTERSECTION_END) rememberFan(n - 1);
      }

      // v3 street section: dark gutter, real 14cm curb reveal, and a merged
      // sidewalk strip where source/inference says the sidewalk is attached.
      // Legacy public tiles retain conservative two-sided sidewalks.
      if (detail === 1 && !r.b && SURFACE_STREETS.has(r.c) && !(roadFlags & ROAD_FLAG_DRIVEWAY)) {
        const gutterY = ys.map((y) => y + 0.006);
        const gutterCol: [number, number, number] = [0.36, 0.37, 0.38];
        buildRibbon(rAcc, pts, 0.42, gutterY, gutterCol, roadWidth / 2 - 0.24, 0.25);
        buildRibbon(rAcc, pts, 0.42, gutterY, gutterCol, -(roadWidth / 2 - 0.24), 0.25);
        for (const span of sidewalkSpansForRoad(sidewalkTopology!, currentRoadIndex)) {
          if (span.renderLeft && (roadFlags & ROAD_FLAG_SIDEWALK_LEFT)) {
            const sidewalkLine = trimPolyline(
              span.pts,
              span.ys,
              span.trimStartLeft,
              span.trimEndLeft,
            );
            if (sidewalkLine) {
              const sidewalkY = sidewalkLine.ys.map((y) => y + 0.14);
              const sidewalkCuts = drivewayCuts.filter(
                ([x, z]) =>
                  pointPolylineDistance(x, z, sidewalkLine.pts) <= roadWidth / 2 + 4.5,
              );
              buildRaisedCurb(
                wAcc, sidewalkLine.pts, sidewalkLine.ys,
                roadWidth / 2 + 0.16, 0.14, sidewalkCuts,
              );
              buildRibbon(
                wAcc, sidewalkLine.pts, 2.0, sidewalkY,
                [0.82, 0.82, 0.79], roadWidth / 2 + 1.33, 0.25,
              );
            }
          }
          if (span.renderRight && (roadFlags & ROAD_FLAG_SIDEWALK_RIGHT)) {
            const sidewalkLine = trimPolyline(
              span.pts,
              span.ys,
              span.trimStartRight,
              span.trimEndRight,
            );
            if (sidewalkLine) {
              const sidewalkY = sidewalkLine.ys.map((y) => y + 0.14);
              const sidewalkCuts = drivewayCuts.filter(
                ([x, z]) =>
                  pointPolylineDistance(x, z, sidewalkLine.pts) <= roadWidth / 2 + 4.5,
              );
              buildRaisedCurb(
                wAcc, sidewalkLine.pts, sidewalkLine.ys,
                -(roadWidth / 2 + 0.16), 0.14, sidewalkCuts,
              );
              buildRibbon(
                wAcc, sidewalkLine.pts, 2.0, sidewalkY,
                [0.82, 0.82, 0.79], -(roadWidth / 2 + 1.33), 0.25,
              );
            }
          }
        }
        if (roadFlags & (ROAD_FLAG_MEDIAN | ROAD_FLAG_ISLAND)) {
          const sidewalkY = ys.map((y) => y + 0.14);
          buildRaisedCurb(wAcc, pts, ys, 0, roadFlags & ROAD_FLAG_ISLAND ? 0.18 : 0.12);
          buildRibbon(wAcc, pts, roadFlags & ROAD_FLAG_ISLAND ? 1.8 : 1.1,
            sidewalkY, [0.56, 0.58, 0.53], 0, 0.25);
        }
      }

      // ---- markings ----
      const mys = ys.map((y) => y + 0.02);
      if (detail === 2 && bike) {
        // NYC-style painted lane: solid green fill with white edge stripes,
        // kept just below crosswalk bars so crossings still paint over the lane
        const bys = ys.map((y) => y + 0.016);
        buildRibbon(mAcc, pts, roadWidth - 0.55, bys, BIKE_GREEN, 0, 0);
        buildRibbon(mAcc, pts, 0.1, bys, WHITE, roadWidth / 2 - 0.14);
        buildRibbon(mAcc, pts, 0.1, bys, WHITE, -(roadWidth / 2 - 0.14));
      } else if (detail === 2 && (r.c === 'crossing' || (roadFlags & ROAD_FLAG_CROSSING))) {
        // An OSM crossing way is the pedestrian travel line, often spanning
        // sidewalk, median, and several carriageways. Painting bars at every
        // point along it creates a huge ladder/starburst at complex junctions.
        // Instead, identify each contiguous carriageway encounter and place one
        // compact continental cluster there. Bars run with pedestrian travel
        // and are spaced along the road direction.
        const total = polyLength(pts);
        const paintInset = Math.min(1.15, total * 0.18);
        const clusters: Array<{ start: number; end: number; halfWidth: number }> = [];
        let active: { start: number; end: number; halfWidth: number } | null = null;
        const sampleStep = 0.55;
        for (let d = paintInset; d <= total - paintInset + 0.001; d += sampleStep) {
          const [cx, cz, tx, tz, cy] = pointAt(pts, mys, d);
          void cy;
          const halfWidth = crosswalkRoadHalfWidth(cx, cz, tx, tz);
          if (halfWidth > 0) {
            if (!active) active = { start: d, end: d, halfWidth };
            else {
              active.end = d;
              active.halfWidth = Math.max(active.halfWidth, halfWidth);
            }
          } else if (active) {
            clusters.push(active);
            active = null;
          }
        }
        if (active) clusters.push(active);

        for (const cluster of clusters) {
          if (cluster.end - cluster.start < 1.35) continue;
          const centerDistance = (cluster.start + cluster.end) * 0.5;
          const [cx, cz, tx, tz, cy] = pointAt(pts, mys, centerDistance);
          const bearing = (Math.atan2(tz, tx) + Math.PI) % Math.PI;
          const key = `${Math.round(cx / 3)}:${Math.round(cz / 3)}:${Math.round(bearing / (Math.PI / 12))}`;
          if (explicitCrosswalkPaintKeys.has(key)) continue;
          explicitCrosswalkPaintKeys.add(key);
          const crossingLength = Math.min(
            14,
            Math.max(3.2, cluster.end - cluster.start + sampleStep),
          );
          const roadTx = -tz, roadTz = tx;
          for (let bar = -2; bar <= 2; bar++) {
            const offset = bar * 0.86;
            addRoadRect(
              mAcc,
              cx + roadTx * offset,
              cz + roadTz * offset,
              tx,
              tz,
              crossingLength,
              0.46,
              cy + 0.004,
              WHITE,
            );
          }
        }
      } else if (detail === 2 && ['motorway', 'trunk', 'primary', 'secondary'].includes(r.c)) {
        buildRibbon(mAcc, pts, 0.12, mys, YELLOW, 0.17);
        buildRibbon(mAcc, pts, 0.12, mys, YELLOW, -0.17);
        buildRibbon(mAcc, pts, 0.12, mys, WHITE, roadWidth / 2 - 0.45);
        buildRibbon(mAcc, pts, 0.12, mys, WHITE, -(roadWidth / 2 - 0.45));
      } else if (detail === 2 && ['tertiary', 'unclassified'].includes(r.c)) {
        buildRibbon(mAcc, pts, 0.12, mys, WHITE, 0, 0, [2.6, 4.2]);
      }

      // curated protected lane riding this street? paint it curbside
      if (detail === 2 && !r.b && signBlades.length && LANE_CLASSES.has(r.c) && polyLength(pts) > 25) {
        const laneName = matchCuratedLane(pts, signBlades, roadWidth / 2);
        const lane = laneName ? CURATED_LANES[laneName] : null;
        if (lane) {
          // way must actually be inside this lane's real extent
          const mz = pts[Math.floor(n / 2) * 2 + 1];
          if (mz >= lane.zMin && mz <= lane.zMax) {
            // overall way bearing decides which lateral sign is the wanted
            // world side (ways are digitized in arbitrary directions)
            let sdx = 0, sdz = 0;
            for (let i = 2; i < pts.length; i += 2) { sdx += pts[i] - pts[i - 2]; sdz += pts[i + 1] - pts[i - 1]; }
            const latX = -sdz, latZ = sdx; // right-of-way lateral, world frame
            const sign = lane.side === 'w' ? (latX < 0 ? 1 : -1)
              : lane.side === 'e' ? (latX > 0 ? 1 : -1)
              : lane.side === 'n' ? (latZ < 0 ? 1 : -1)
              : (latZ > 0 ? 1 : -1);
            const off = sign * (roadWidth / 2 - 1.45);
            const lys = ys.map((y) => y + 0.016);
            buildRibbon(mAcc, pts, 1.8, lys, BIKE_GREEN, off);
            buildRibbon(mAcc, pts, 0.1, lys, WHITE, off + 1.0);
            buildRibbon(mAcc, pts, 0.1, lys, WHITE, off - 1.0);
          }
        }
      }

      // Crosswalks are inferred only at real shared OSM endpoints, never at
      // arbitrary tile clips. Explicit crossing ways above take priority and a
      // quantized direction key prevents multiple OSM road pieces at the same
      // junction from painting the same inferred crossing repeatedly.
      if (detail === 2 && !r.b && SURFACE_STREETS.has(r.c) && r.c !== 'living_street') {
        const maybeAddTopologyCrosswalk = (atStart: boolean) => {
          const pointIndex = atStart ? 0 : n - 1;
          const x = pts[pointIndex * 2], z = pts[pointIndex * 2 + 1];
          if (hasExplicitCrossingNear(x, z)) return;
          const neighbor = atStart ? 1 : n - 2;
          let dx = pts[neighbor * 2] - x;
          let dz = pts[neighbor * 2 + 1] - z;
          const length = Math.hypot(dx, dz) || 1;
          dx /= length;
          dz /= length;
          // Undirected 15-degree bearing bucket: opposite-digitized pieces are
          // the same crossing, perpendicular approaches remain independent.
          const bearing = (Math.atan2(dz, dx) + Math.PI) % Math.PI;
          const directionBucket = Math.round(bearing / (Math.PI / 12));
          const key = `${Math.round(x / 4)}:${Math.round(z / 4)}:${directionBucket}`;
          if (inferredCrosswalkKeys.has(key)) return;
          inferredCrosswalkKeys.add(key);
          addTopologyCrosswalk(mAcc, pts, mys, roadWidth, atStart);
        };
        if (roadFlags & ROAD_FLAG_INTERSECTION_START) maybeAddTopologyCrosswalk(true);
        if (roadFlags & ROAD_FLAG_INTERSECTION_END) maybeAddTopologyCrosswalk(false);
      }

      // Bounded merged road furniture/decal layer: deterministic manholes,
      // curb drains, utility cuts, and patch plates. No per-object meshes.
      if (detail === 2 && !r.b && SURFACE_STREETS.has(r.c)) {
        const length = polyLength(pts);
        if (length > 18 && hash01(roadSeed + 401) < 0.62) {
          const d = Math.min(length - 4, 7 + hash01(roadSeed + 409) * Math.max(1, length - 14));
          const [cx, cz, tx, tz, y] = pointAt(pts, mys, d);
          addManhole(mAcc, cx - tz * roadWidth * 0.12, cz + tx * roadWidth * 0.12, y + 0.008, roadSeed + 419);
        }
        if (length > 24 && hash01(roadSeed + 421) < 0.48) {
          const d = Math.min(length - 4, 9 + hash01(roadSeed + 431) * Math.max(1, length - 18));
          const [cx, cz, tx, tz, y] = pointAt(pts, mys, d);
          const side = hash01(roadSeed + 433) < 0.5 ? -1 : 1;
          addRoadRect(mAcc, cx - tz * side * (roadWidth / 2 - 0.35), cz + tx * side * (roadWidth / 2 - 0.35),
            tx, tz, 0.7, 0.22, y + 0.009, [0.16, 0.17, 0.17]);
        }
        if (length > 30 && hash01(roadSeed + 439) < 0.34) {
          const d = Math.min(length - 5, 10 + hash01(roadSeed + 443) * Math.max(1, length - 20));
          const [cx, cz, tx, tz, y] = pointAt(pts, mys, d);
          addRoadRect(mAcc, cx, cz, tx, tz, 2.2 + hash01(roadSeed + 449) * 2.8,
            Math.min(roadWidth * 0.42, 3.8), y + 0.006, [0.31, 0.32, 0.33]);
        }
      }
    }
  }
  for (const fan of intersectionFans.values()) {
    addIntersectionFan(rAcc, fan.x, fan.z, fan.y, fan.radius, fan.color);
  }
  if (detail === 1) {
    // Corner paving and curb returns are junction-owned: each wedge is emitted
    // once into the already-merged walks payload, never once per road approach.
    for (const junction of sidewalkTopology!.junctions.values()) {
      for (const corner of junction.corners) {
        addSidewalkCorner(wAcc, corner.paving, corner.y);
        buildRaisedCurb(wAcc, corner.curb, [corner.y, corner.y], 0, 0.14);
      }
    }
  }

  // deepest bike-lane penetration at (x,z): [penetration, awayX, awayZ]
  const bikePen = (x: number, z: number, extra: number): [number, number, number] => {
    let worst = 0, wx = 0, wz = 1;
    for (const bp of bikePaths) {
      const target = bp.half + extra;
      const p = bp.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const x1 = p[i], z1 = p[i + 1], x2 = p[i + 2], z2 = p[i + 3];
        const dx = x2 - x1, dz = z2 - z1;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        let t = ((x - x1) * dx + (z - z1) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ox2 = x - (x1 + t * dx), oz2 = z - (z1 + t * dz);
        const d = Math.hypot(ox2, oz2);
        const pen = target - d;
        if (pen > worst) { worst = pen; if (d > 1e-3) { wx = ox2 / d; wz = oz2 / d; } }
      }
    }
    return [worst, wx, wz];
  };

  // ---- trees ----
  // water triangles (world) + bbox, so a trunk never sprouts inside a fountain
  // or pond — the pipeline culls trees from roads/buildings but not water.
  const waterTris: number[] = [];
  let wMinX = Infinity, wMinZ = Infinity, wMaxX = -Infinity, wMaxZ = -Infinity;
  if (tile.areas?.water) {
    const st = v2 ? 3 : 2;
    const wv = tile.areas.water;
    for (let i = 0; i + 3 * st <= wv.length; i += 3 * st) {
      const ax = toWorld(wv[i], ox), az = toWorld(wv[i + 1], oz);
      const bx = toWorld(wv[i + st], ox), bz = toWorld(wv[i + st + 1], oz);
      const cx = toWorld(wv[i + 2 * st], ox), cz = toWorld(wv[i + 2 * st + 1], oz);
      waterTris.push(ax, az, bx, bz, cx, cz);
      wMinX = Math.min(wMinX, ax, bx, cx); wMaxX = Math.max(wMaxX, ax, bx, cx);
      wMinZ = Math.min(wMinZ, az, bz, cz); wMaxZ = Math.max(wMaxZ, az, bz, cz);
    }
  }
  const inWater = (x: number, z: number): boolean => {
    if (!waterTris.length || x < wMinX || x > wMaxX || z < wMinZ || z > wMaxZ) return false;
    for (let t = 0; t < waterTris.length; t += 6) {
      const ax = waterTris[t], az = waterTris[t + 1], bx = waterTris[t + 2];
      const bz = waterTris[t + 3], cx = waterTris[t + 4], cz = waterTris[t + 5];
      const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
      const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
      const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
    }
    return false;
  };
  let trees: Float32Array | null = null;
  if (detail === 2 && tile.trees && tile.trees.length >= 2) {
    const stride = v2 ? 3 : 2;
    const total = Math.floor(tile.trees.length / stride);
    const count = Math.min(1400, total);
    const step = total / count;
    const kept: number[] = [];
    for (let i = 0; i < count; i++) {
      const si = Math.floor(i * step) * stride;
      const x = toWorld(tile.trees[si], ox);
      const z = toWorld(tile.trees[si + 1], oz);
      // a trunk in the middle of a painted lane is an obstruction — skip it
      if (bikePaths.length && bikePen(x, z, 0.45)[0] > 0) continue;
      if (inWater(x, z)) continue; // no trunks in fountains / ponds
      const ey = v2 ? tile.trees[si + 2] / 10 : 0;
      const s = 0.75 + hash01(seedBase + i) * 0.7;
      kept.push(x, ey, z, s, hash01(seedBase + i + 99));
    }
    trees = kept.length ? new Float32Array(kept) : null;
  }

  // ---- collision pack ----
  let collision: CollisionData | null = null;
  if (tileDetailIncludesBaseSurfaces(detail) && colRings.length) {
    const starts = new Uint32Array(colRings.length + 1);
    let total = 0;
    for (let i = 0; i < colRings.length; i++) { starts[i] = total; total += colRings[i].length / 2; }
    starts[colRings.length] = total;
    const pts = new Float32Array(total * 2);
    let o = 0;
    for (const ring of colRings) { pts.set(ring, o); o += ring.length; }
    collision = {
      ringStart: starts, points: pts, aabb: new Float32Array(colAabb),
      top: new Float32Array(colTop), base: new Float32Array(colBase),
    };
  }

  // ---- hydrants: world transforms for instancing ----
  let hydrants: Float32Array | null = null;
  if (detail === 2 && tile.hyd && tile.hyd.length >= 3) {
    const n = Math.floor(tile.hyd.length / 3);
    hydrants = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      let hx = toWorld(tile.hyd[i * 3], ox);
      let hz = toWorld(tile.hyd[i * 3 + 1], oz);
      // curbside hydrants that baked into a painted lane slide to its edge
      if (bikePaths.length) {
        const [pen, awayX, awayZ] = bikePen(hx, hz, 0.35);
        if (pen > 0 && pen < 4) { hx += awayX * pen; hz += awayZ * pen; }
      }
      hydrants[i * 4] = hx;
      hydrants[i * 4 + 1] = tile.hyd[i * 3 + 2] / 10;
      hydrants[i * 4 + 2] = hz;
      hydrants[i * 4 + 3] = hash01(seedBase + i * 61) * Math.PI * 2;
    }
  }

  // ---- signs: to world coords (geometry built on the main thread, atlas needs DOM) ----
  // then nudge any that baked into a roadbed out onto the sidewalk.
  const signs = (detail === 2 ? tile.signs ?? [] : []).map((s) => {
    const [sx, sz] = nudgeSignOutOfRoads(toWorld(s.p[0], ox), toWorld(s.p[1], oz), vroads);
    return { x: sx, y: s.e / 10, z: sz, names: s.n, angles: s.a };
  });

  return {
    type: 'built',
    key: `${tile.x}_${tile.z}`,
    detail,
    requestId,
    buildings: bAcc.payload(),
    roads: rAcc.payload(),
    walks: wAcc.payload(),
    areas: aAcc.payload(),
    water: wtrAcc.payload(),
    markings: mAcc.payload(),
    trees,
    retailAnchors: retailAnchorValues.length ? new Float32Array(retailAnchorValues) : null,
    hydrants,
    signs: signs.length ? signs : null,
    collision,
    roadPaths: tileDetailIncludesBaseSurfaces(detail) && mmWidth.length
      ? {
          start: new Uint32Array(mmStart),
          pts: new Float32Array(mmPts),
          width: new Float32Array(mmWidth),
          kind: new Uint8Array(mmKind),
          flags: new Uint16Array(mmFlags),
        }
      : null,
  };
}

const decodedTileCache = new Map<string, { tile: TileJson; bytes: number }>();
let decodedTileCacheBytes = 0;
const MAX_DECODED_TILES = 24;
const MAX_DECODED_BYTES = 8 * 1024 * 1024;

function cacheDecodedTile(url: string, tile: TileJson, bytes: number) {
  const previous = decodedTileCache.get(url);
  if (previous) decodedTileCacheBytes -= previous.bytes;
  decodedTileCache.delete(url);
  decodedTileCache.set(url, { tile, bytes });
  decodedTileCacheBytes += bytes;
  while (decodedTileCache.size > MAX_DECODED_TILES || decodedTileCacheBytes > MAX_DECODED_BYTES) {
    const oldest = decodedTileCache.entries().next().value as [string, { tile: TileJson; bytes: number }] | undefined;
    if (!oldest) break;
    decodedTileCache.delete(oldest[0]);
    decodedTileCacheBytes -= oldest[1].bytes;
  }
}

self.onmessage = async (ev: MessageEvent<BuildRequest>) => {
  const req = ev.data;
  if (req.type !== 'build') return;
  const totalStarted = performance.now();
  try {
    let fetchMs = 0;
    let decodeMs = 0;
    let sourceBytes = 0;
    let tile: TileJson;
    const cached = decodedTileCache.get(req.url);
    if (cached) {
      // Refresh insertion order: approach upgrades normally hit the same
      // affinity worker and avoid a second request + parse.
      decodedTileCache.delete(req.url);
      decodedTileCache.set(req.url, cached);
      tile = cached.tile;
    } else {
      let source: ArrayBuffer;
      if (req.source) {
        source = req.source;
        fetchMs = req.sourceFetchMs ?? 0;
      } else {
        const fetchStarted = performance.now();
        const res = await fetch(req.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        source = await res.arrayBuffer();
        fetchMs = performance.now() - fetchStarted;
      }
      const decodeStarted = performance.now();
      tile = isTileBinary(source)
        ? decodeTileBinary(source)
        : JSON.parse(new TextDecoder().decode(source)) as TileJson;
      decodeMs = performance.now() - decodeStarted;
      sourceBytes = source.byteLength;
      cacheDecodedTile(req.url, tile, sourceBytes);
    }
    const decodeEnded = performance.now();
    const out = buildTile(tile, req.detail ?? 2, req.requestId ?? 0);
    const buildEnded = performance.now();
    const transfer: Transferable[] = [];
    for (const m of [out.buildings, out.roads, out.walks, out.areas, out.water, out.markings]) {
      if (m) {
        transfer.push(m.position.buffer, m.normal.buffer, m.color.buffer, m.index.buffer);
        if (m.uv) transfer.push(m.uv.buffer);
        if (m.style) transfer.push(m.style.buffer);
        if (m.semantic) transfer.push(m.semantic.buffer);
        if (m.facade) transfer.push(m.facade.buffer);
      }
    }
    if (out.trees) transfer.push(out.trees.buffer);
    if (out.retailAnchors) transfer.push(out.retailAnchors.buffer);
    if (out.hydrants) transfer.push(out.hydrants.buffer);
    if (out.collision) {
      transfer.push(
        out.collision.ringStart.buffer, out.collision.points.buffer, out.collision.aabb.buffer,
        out.collision.top.buffer, out.collision.base.buffer,
      );
    }
    if (out.roadPaths) {
      transfer.push(
        out.roadPaths.start.buffer, out.roadPaths.pts.buffer,
        out.roadPaths.width.buffer, out.roadPaths.kind.buffer,
      );
      if (out.roadPaths.flags) transfer.push(out.roadPaths.flags.buffer);
    }
    const transferBytes = buildResponseByteLength(out);
    out.timing = {
      fetchMs,
      decodeMs,
      buildMs: buildEnded - decodeEnded,
      totalMs: buildEnded - totalStarted,
      sourceBytes,
      transferBytes,
    };
    (self as unknown as Worker).postMessage(out, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      type: 'built', key: req.key, detail: req.detail ?? 2, requestId: req.requestId ?? 0,
      buildings: null, roads: null, walks: null,
      areas: null, water: null, markings: null, trees: null, retailAnchors: null,
      hydrants: null, signs: null, collision: null,
      roadPaths: null,
      error: String(e),
    } satisfies BuildResponse);
  }
};

export {};
