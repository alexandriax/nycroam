// Web worker: fetch tile JSON -> build merged geometry buffers (transferable).
import earcut from 'earcut';
import type { BuildRequest, BuildResponse, MeshPayload, TileJson, CollisionData } from './tileTypes';
import { ROAD_STYLE, AREA_STYLE, CONCRETE_CLASSES } from './tileTypes';
import { buildingColor, hash01 } from './palette';
import { TILE_SIZE } from './geo';

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

class MeshAcc {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  uvs: number[] | null = null;
  styles: number[] | null = null;

  constructor(withUv = false, withStyle = false) {
    if (withUv) this.uvs = [];
    if (withStyle) this.styles = [];
  }

  get vcount() { return this.pos.length / 3; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, u = 0, v = 0) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b);
    if (this.uvs) this.uvs.push(u, v);
    if (this.styles) this.styles.push(this.styleCursor);
  }

  styleCursor = 0;

  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }

  payload(): MeshPayload | null {
    if (this.idx.length === 0) return null;
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      color: new Float32Array(this.col),
      index: new Uint32Array(this.idx),
      ...(this.uvs ? { uv: new Float32Array(this.uvs) } : {}),
      ...(this.styles ? { style: new Float32Array(this.styles) } : {}),
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

/** Extrude a polygon (rings in world meters, flat [x,z]) from y0 to y1 into acc. */
function extrude(acc: MeshAcc, rings: number[][], y0: number, y1: number, color: [number, number, number], bottomCap = false) {
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
  for (let i = 0; i < flat.length; i += 2) {
    acc.vertex(flat[i], y1, flat[i + 1], 0, 1, 0, cr * roofShade, cg * roofShade, cb * roofShade);
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
    for (let i = i0; i <= i1; i++) {
      const x = pts[i * 2] + laterals[i * 2] * lateralOffset;
      const z = pts[i * 2 + 1] + laterals[i * 2 + 1] * lateralOffset;
      const lx = laterals[i * 2], lz = laterals[i * 2 + 1];
      const y = ys[i];
      const u = uvScale ? dists[i] * uvScale : 0;
      acc.vertex(x + lx * hw, y, z + lz * hw, 0, 1, 0, col[0], col[1], col[2], u, (hw * uvScale));
      acc.vertex(x - lx * hw, y, z - lz * hw, 0, 1, 0, col[0], col[1], col[2], u, -(hw * uvScale));
    }
    for (let i = 0; i < i1 - i0; i++) {
      const a = base + i * 2;
      pushUpTri(acc, a, a + 2, a + 1);
      pushUpTri(acc, a + 1, a + 2, a + 3);
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

function polyLength(pts: number[]): number {
  let d = 0;
  for (let i = 1; i < pts.length / 2; i++) {
    d += Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
  }
  return d;
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

function pushUpTri(acc: MeshAcc, a: number, b: number, c: number) {
  const p = acc.pos;
  const ax = p[a * 3], az = p[a * 3 + 2];
  const bx = p[b * 3], bz = p[b * 3 + 2];
  const cx = p[c * 3], cz = p[c * 3 + 2];
  const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  if (crossY < 0) acc.tri(a, c, b); else acc.tri(a, b, c);
}

function buildTile(tile: TileJson): BuildResponse {
  const ox = tile.x * TILE_SIZE;
  const oz = tile.z * TILE_SIZE;
  const toWorld = (d: number, origin: number) => origin + d / 10;
  const v2 = (tile.v ?? 1) >= 2; // elevations baked; areas/trees are [x,z,e] triples

  // ---- buildings ----
  const bAcc = new MeshAcc(false, true);
  const colRings: number[][] = [];
  const colAabb: number[] = [];
  let seedBase = (tile.x * 73856093) ^ (tile.z * 19349663);

  if (tile.buildings) {
    for (let bi = 0; bi < tile.buildings.length; bi++) {
      const b = tile.buildings[bi];
      const seed = seedBase + bi * 17;
      const rings = b.p.map((ring) => {
        const out: number[] = new Array(ring.length);
        for (let i = 0; i < ring.length; i += 2) {
          out[i] = toWorld(ring[i], ox);
          out[i + 1] = toWorld(ring[i + 1], oz);
        }
        return out;
      });
      const h = Math.max(3, b.h);
      const minH = b.m ?? 0;
      const base = b.b ?? 0;
      const bc = buildingColor(seed, h);
      bAcc.styleCursor = bc.glass ? 1 : 0;
      // sink foundations 2.5m so sloped ground never shows a gap under walls;
      // elevated parts get a sealed underside
      extrude(bAcc, rings, base + minH - (minH > 0 ? 0 : 2.5), base + h, bc.col, minH > 0);

      // collision only for ground-level buildings
      if (minH < 1 && rings[0].length >= 6) {
        colRings.push(rings[0]);
        let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
        for (let i = 0; i < rings[0].length; i += 2) {
          minX = Math.min(minX, rings[0][i]); maxX = Math.max(maxX, rings[0][i]);
          minZ = Math.min(minZ, rings[0][i + 1]); maxZ = Math.max(maxZ, rings[0][i + 1]);
        }
        colAabb.push(minX, minZ, maxX, maxZ);
      }

      // water towers on mid-rise flat roofs
      if (minH === 0 && h > 22 && h < 95 && hash01(seed + 3) < 0.22) {
        const ring = rings[0];
        // centroid
        let cx = 0, cz = 0; const n = ring.length / 2;
        for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cz += ring[i + 1]; }
        cx /= n; cz /= n;
        // rough area check
        const area = Math.abs(ringArea(ring));
        if (area > 220) { bAcc.styleCursor = 0; waterTower(bAcc, cx, cz, base + h, seed + 5); }
      }
    }
  }

  // ---- flat layers: areas, asphalt roads (uv'd), concrete walks (uv'd), markings ----
  const aAcc = new MeshAcc();
  const rAcc = new MeshAcc(true);
  const wAcc = new MeshAcc(true);
  const mAcc = new MeshAcc();
  const WHITE: [number, number, number] = [0.8, 0.81, 0.82];
  const YELLOW: [number, number, number] = [0.82, 0.65, 0.1];

  if (tile.areas) {
    const stride = v2 ? 3 : 2;
    for (const kind of Object.keys(tile.areas)) {
      const style = AREA_STYLE[kind] ?? AREA_STYLE.grass;
      const tris = tile.areas[kind];
      const base = aAcc.vcount;
      for (let i = 0; i < tris.length; i += stride) {
        const ey = v2 ? tris[i + 2] / 10 : 0;
        aAcc.vertex(toWorld(tris[i], ox), ey + style.y, toWorld(tris[i + 1], oz), 0, 1, 0, style.col[0], style.col[1], style.col[2]);
      }
      for (let v = 0; v < tris.length / stride; v += 3) {
        pushUpTri(aAcc, base + v, base + v + 1, base + v + 2);
      }
    }
  }

  // minimap centerlines: real streets only — footways/steps/crossings would
  // turn the closest zoom into hairball noise
  const MINIMAP_SKIP = new Set(['footway', 'path', 'steps', 'crossing', 'cycleway', 'service']);
  const mmStart: number[] = [0];
  const mmPts: number[] = [];
  const mmWidth: number[] = [];
  // vehicular centerlines (world coords) for pushing signs off the roadbed
  const vroads: { pts: number[]; half: number }[] = [];

  if (tile.roads) {
    for (const r of tile.roads) {
      const style = ROAD_STYLE[r.c] ?? ROAD_STYLE.residential;
      const n = r.p.length / 2;
      const pts: number[] = new Array(r.p.length);
      const ys: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        pts[i * 2] = toWorld(r.p[i * 2], ox);
        pts[i * 2 + 1] = toWorld(r.p[i * 2 + 1], oz);
        ys[i] = (r.e ? r.e[i] : r.b ? 7 : 0) + style.y;
      }
      if (n >= 2 && VEHICULAR_ROADS.has(r.c)) vroads.push({ pts, half: style.w / 2 });
      if (!MINIMAP_SKIP.has(r.c) && n >= 2) {
        for (const v of pts) mmPts.push(v);
        mmStart.push(mmPts.length / 2);
        mmWidth.push(style.w);
      }
      const concrete = CONCRETE_CLASSES.has(r.c);
      const acc = concrete ? wAcc : rAcc;
      // near-white base tint so the texture map carries the color
      const tint: [number, number, number] = r.b
        ? [0.95, 0.97, 1.02]
        : concrete
          ? [style.col[0] * 1.55, style.col[1] * 1.55, style.col[2] * 1.55]
          : [style.col[0] * 4.2, style.col[1] * 4.2, style.col[2] * 4.2];
      buildRibbon(acc, pts, style.w, ys, [
        Math.min(1.15, tint[0]), Math.min(1.15, tint[1]), Math.min(1.15, tint[2]),
      ], 0, 0.25);

      // ---- markings ----
      const mys = ys.map((y) => y + 0.02);
      if (r.c === 'crossing') {
        // continental crosswalk: thick bars perpendicular to the walking line
        const total = polyLength(pts);
        for (let d = 0.5; d < total - 0.3; d += 0.95) {
          const [cx, cz, tx, tz, cy] = pointAt(pts, mys, d);
          const bx = -tz, bz = tx; // bar axis = perpendicular to crossing line
          const bw = style.w * 0.42; // bar length across the crossing ribbon
          const hw = 0.24; // half of bar thickness along the walk
          const base = mAcc.vcount;
          mAcc.vertex(cx - tx * hw + bx * bw, cy, cz - tz * hw + bz * bw, 0, 1, 0, WHITE[0], WHITE[1], WHITE[2]);
          mAcc.vertex(cx + tx * hw + bx * bw, cy, cz + tz * hw + bz * bw, 0, 1, 0, WHITE[0], WHITE[1], WHITE[2]);
          mAcc.vertex(cx + tx * hw - bx * bw, cy, cz + tz * hw - bz * bw, 0, 1, 0, WHITE[0], WHITE[1], WHITE[2]);
          mAcc.vertex(cx - tx * hw - bx * bw, cy, cz - tz * hw - bz * bw, 0, 1, 0, WHITE[0], WHITE[1], WHITE[2]);
          pushUpTri(mAcc, base, base + 1, base + 2);
          pushUpTri(mAcc, base, base + 2, base + 3);
        }
      } else if (['motorway', 'trunk', 'primary', 'secondary'].includes(r.c)) {
        buildRibbon(mAcc, pts, 0.12, mys, YELLOW, 0.17);
        buildRibbon(mAcc, pts, 0.12, mys, YELLOW, -0.17);
        buildRibbon(mAcc, pts, 0.12, mys, WHITE, style.w / 2 - 0.45);
        buildRibbon(mAcc, pts, 0.12, mys, WHITE, -(style.w / 2 - 0.45));
      } else if (['tertiary', 'unclassified'].includes(r.c)) {
        buildRibbon(mAcc, pts, 0.12, mys, WHITE, 0, 0, [2.6, 4.2]);
      }
    }
  }

  // ---- trees ----
  let trees: Float32Array | null = null;
  if (tile.trees && tile.trees.length >= 2) {
    const stride = v2 ? 3 : 2;
    const total = Math.floor(tile.trees.length / stride);
    const count = Math.min(1400, total);
    const step = total / count;
    trees = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
      const si = Math.floor(i * step) * stride;
      const x = toWorld(tile.trees[si], ox);
      const z = toWorld(tile.trees[si + 1], oz);
      const ey = v2 ? tile.trees[si + 2] / 10 : 0;
      const s = 0.75 + hash01(seedBase + i) * 0.7;
      trees[i * 5] = x; trees[i * 5 + 1] = ey; trees[i * 5 + 2] = z;
      trees[i * 5 + 3] = s;
      trees[i * 5 + 4] = hash01(seedBase + i + 99);
    }
  }

  // ---- collision pack ----
  let collision: CollisionData | null = null;
  if (colRings.length) {
    const starts = new Uint32Array(colRings.length + 1);
    let total = 0;
    for (let i = 0; i < colRings.length; i++) { starts[i] = total; total += colRings[i].length / 2; }
    starts[colRings.length] = total;
    const pts = new Float32Array(total * 2);
    let o = 0;
    for (const ring of colRings) { pts.set(ring, o); o += ring.length; }
    collision = { ringStart: starts, points: pts, aabb: new Float32Array(colAabb) };
  }

  // ---- hydrants: world transforms for instancing ----
  let hydrants: Float32Array | null = null;
  if (tile.hyd && tile.hyd.length >= 3) {
    const n = Math.floor(tile.hyd.length / 3);
    hydrants = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      hydrants[i * 4] = toWorld(tile.hyd[i * 3], ox);
      hydrants[i * 4 + 1] = tile.hyd[i * 3 + 2] / 10;
      hydrants[i * 4 + 2] = toWorld(tile.hyd[i * 3 + 1], oz);
      hydrants[i * 4 + 3] = hash01(seedBase + i * 61) * Math.PI * 2;
    }
  }

  // ---- signs: to world coords (geometry built on the main thread, atlas needs DOM) ----
  // then nudge any that baked into a roadbed out onto the sidewalk.
  const signs = (tile.signs ?? []).map((s) => {
    const [sx, sz] = nudgeSignOutOfRoads(toWorld(s.p[0], ox), toWorld(s.p[1], oz), vroads);
    return { x: sx, y: s.e / 10, z: sz, names: s.n, angles: s.a };
  });

  return {
    type: 'built',
    key: `${tile.x}_${tile.z}`,
    buildings: bAcc.payload(),
    roads: rAcc.payload(),
    walks: wAcc.payload(),
    areas: aAcc.payload(),
    markings: mAcc.payload(),
    trees,
    hydrants,
    signs: signs.length ? signs : null,
    collision,
    roadPaths: mmWidth.length
      ? {
          start: new Uint32Array(mmStart),
          pts: new Float32Array(mmPts),
          width: new Float32Array(mmWidth),
        }
      : null,
  };
}

self.onmessage = async (ev: MessageEvent<BuildRequest>) => {
  const req = ev.data;
  if (req.type !== 'build') return;
  try {
    const res = await fetch(req.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tile = (await res.json()) as TileJson;
    const out = buildTile(tile);
    const transfer: Transferable[] = [];
    for (const m of [out.buildings, out.roads, out.walks, out.areas, out.markings]) {
      if (m) {
        transfer.push(m.position.buffer, m.normal.buffer, m.color.buffer, m.index.buffer);
        if (m.uv) transfer.push(m.uv.buffer);
        if (m.style) transfer.push(m.style.buffer);
      }
    }
    if (out.trees) transfer.push(out.trees.buffer);
    if (out.hydrants) transfer.push(out.hydrants.buffer);
    if (out.collision) transfer.push(out.collision.ringStart.buffer, out.collision.points.buffer, out.collision.aabb.buffer);
    if (out.roadPaths) transfer.push(out.roadPaths.start.buffer, out.roadPaths.pts.buffer, out.roadPaths.width.buffer);
    (self as unknown as Worker).postMessage(out, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      type: 'built', key: req.key, buildings: null, roads: null, walks: null,
      areas: null, markings: null, trees: null, hydrants: null, signs: null, collision: null,
      roadPaths: null,
      error: String(e),
    } satisfies BuildResponse);
  }
};

export {};
