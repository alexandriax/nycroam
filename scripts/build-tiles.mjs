#!/usr/bin/env node
// scripts/build-tiles.mjs
//
// Reads everything in data/cache/ (written by scripts/fetch-osm.mjs), dedupes
// OSM elements, assembles multipolygons, and emits:
//   public/tiles/index.json
//   public/tiles/{tx}_{tz}.json   (one per non-empty 256m tile)
//   public/tiles/skyline.json
//   public/geo/ground.json
//
// Shared constants below MUST match src/engine/geo.ts exactly.
//
// Usage: node scripts/build-tiles.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import earcut from 'earcut';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const TILES_DIR = path.join(ROOT, 'public', 'tiles');
const GEO_DIR = path.join(ROOT, 'public', 'geo');
const TERRAIN_FILE = path.join(GEO_DIR, 'terrain.json');

// ---- shared constants (must match src/engine/geo.ts) --------------------------------
const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
const TILE_SIZE = 256;

function lonLatToXZ(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

const BBOX = { south: 40.698, west: -74.026, north: 40.882, east: -73.906 };
const ROWS = 8;
const COLS = 4;
const LAYERS = ['buildings', 'roads', 'areas', 'trees'];

// ---- tiny geometry / math utilities --------------------------------------------------
function round1(v) {
  return Number(v.toFixed(1));
}

function tileOf(pt) {
  return [Math.floor(pt[0] / TILE_SIZE), Math.floor(pt[1] / TILE_SIZE)];
}
function tileKeyOf(tx, tz) {
  return `${tx}_${tz}`;
}
function toTileLocalDecimeters(points, tx, tz) {
  const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE;
  const flat = new Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    flat[i * 2] = Math.round((points[i][0] - ox) * 10);
    flat[i * 2 + 1] = Math.round((points[i][1] - oz) * 10);
  }
  return flat;
}

function pointsEqual(a, b, eps = 0.01) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}
function ringClosed(ring, eps = 0.01) {
  return ring.length >= 4 && pointsEqual(ring[0], ring[ring.length - 1], eps);
}
function ringArea(ring) {
  // shoelace, signed
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    sum += x0 * z1 - x1 * z0;
  }
  return sum / 2;
}
function centroidOf(ring) {
  let sx = 0, sz = 0;
  for (const [x, z] of ring) { sx += x; sz += z; }
  return [sx / ring.length, sz / ring.length];
}
function pointInPolygon(pt, ring) {
  let inside = false;
  const [x, z] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function isDegenerateRing(ring) {
  return ring.length < 3 || Math.abs(ringArea(ring)) < 4;
}

// CCW winding test/fix exactly per spec: (x1-x0)*(z2-z0)-(x2-x0)*(z1-z0) < 0
function ccwFix(p0, p1, p2) {
  const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  return cross < 0 ? [p0, p1, p2] : [p0, p2, p1];
}

function triangulatePolygon(outer, holes) {
  const vertices = [];
  const holeIndices = [];
  for (const [x, z] of outer) vertices.push(x, z);
  for (const hole of holes) {
    holeIndices.push(vertices.length / 2);
    for (const [x, z] of hole) vertices.push(x, z);
  }
  const idx = earcut(vertices, holeIndices.length ? holeIndices : undefined, 2);
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const p0 = [vertices[a * 2], vertices[a * 2 + 1]];
    const p1 = [vertices[b * 2], vertices[b * 2 + 1]];
    const p2 = [vertices[c * 2], vertices[c * 2 + 1]];
    tris.push(ccwFix(p0, p1, p2));
  }
  return tris;
}

// ---- terrain (public/geo/terrain.json, produced by scripts/fetch-terrain.mjs) --------
function loadTerrain() {
  const json = JSON.parse(fs.readFileSync(TERRAIN_FILE, 'utf8'));
  if (!json || !Array.isArray(json.h) || !json.nx || !json.nz) {
    throw new Error(`invalid ${TERRAIN_FILE} — run scripts/fetch-terrain.mjs first`);
  }
  return json;
}
let TERRAIN = null;
// Bilinear-sample the terrain grid at world (x,z) meters -> elevation meters. Clamps to grid edges.
function terrainAt(x, z) {
  const { originX, originZ, step, nx, nz, h } = TERRAIN;
  const fx = (x - originX) / step;
  const fz = (z - originZ) / step;
  const x0 = Math.max(0, Math.min(nx - 1, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(nz - 1, Math.floor(fz)));
  const x1 = Math.min(nx - 1, x0 + 1);
  const z1 = Math.min(nz - 1, z0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const tz = Math.max(0, Math.min(1, fz - z0));
  const v00 = h[z0 * nx + x0], v10 = h[z0 * nx + x1], v01 = h[z1 * nx + x0], v11 = h[z1 * nx + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return (top + (bot - top) * tz) / 10; // stored as decimeters -> meters
}

// ---- deterministic hash utilities (no Math.random anywhere) --------------------------
// Classic "GLSL-style" deterministic pseudo-random hash from floats. `salt` selects an
// independent hash stream (jitter-x, jitter-z, keep/drop decisions, ...) from the same
// (x,z) seed so different decisions don't correlate.
function hash2(x, z, salt) {
  const s = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7 + 0.1) * 43758.5453123;
  return s - Math.floor(s);
}

function pointInPolygonWithHoles(pt, poly) {
  if (!pointInPolygon(pt, poly.outer)) return false;
  for (const hole of poly.holes) {
    if (pointInPolygon(pt, hole)) return false;
  }
  return true;
}

function pointToSegmentDist(p, a, b) {
  const [x, z] = p, [x1, z1] = a, [x2, z2] = b;
  const dx = x2 - x1, dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-9) return Math.hypot(x - x1, z - z1);
  let t = ((x - x1) * dx + (z - z1) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz));
}
function pointToPolylinesDist(pt, polylines) {
  let min = Infinity;
  for (const pts of polylines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const d = pointToSegmentDist(pt, pts[i], pts[i + 1]);
      if (d < min) min = d;
      if (min < 1e-6) return min;
    }
  }
  return min;
}

function polyBBox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}
// Hex (triangular) lattice, anchored to the global (world) origin so adjoining polygons
// of the same kind tile seamlessly regardless of polygon boundary position.
function hexLatticePoints(bbox, spacing) {
  const rowSpacing = spacing * (Math.sqrt(3) / 2);
  const rowStart = Math.floor(bbox.minZ / rowSpacing) - 1;
  const rowEnd = Math.ceil(bbox.maxZ / rowSpacing) + 1;
  const pts = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    const z = r * rowSpacing;
    const xOff = ((((r % 2) + 2) % 2)) * (spacing / 2);
    const colStart = Math.floor((bbox.minX - xOff) / spacing) - 1;
    const colEnd = Math.ceil((bbox.maxX - xOff) / spacing) + 1;
    for (let c = colStart; c <= colEnd; c++) pts.push([c * spacing + xOff, z]);
  }
  return pts;
}
function gridLatticePoints(bbox, spacing) {
  const rowStart = Math.floor(bbox.minZ / spacing) - 1;
  const rowEnd = Math.ceil(bbox.maxZ / spacing) + 1;
  const colStart = Math.floor(bbox.minX / spacing) - 1;
  const colEnd = Math.ceil(bbox.maxX / spacing) + 1;
  const pts = [];
  for (let r = rowStart; r <= rowEnd; r++) for (let c = colStart; c <= colEnd; c++) pts.push([c * spacing, r * spacing]);
  return pts;
}

function sampleEveryNth(list, max) {
  if (list.length <= max) return list;
  const N = Math.ceil(list.length / max);
  const sampled = [];
  for (let i = 0; i < list.length && sampled.length < max; i += N) sampled.push(list[i]);
  return sampled;
}

// ---- ring/way/relation -> local-meter polygons ---------------------------------------
function wayToRing(el) {
  if (!el.geometry || el.geometry.length < 2) return null;
  let pts = el.geometry.filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').map((p) => lonLatToXZ(p.lon, p.lat));
  if (pts.length < 2) return null;
  if (!ringClosed(pts)) pts = pts.concat([pts[0]]);
  pts = pts.slice(0, -1);
  return pts;
}

function stitchRings(segments) {
  const segs = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const used = new Array(segs.length).fill(false);
  const rings = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = segs[i].slice();
    let progress = true;
    while (progress && !ringClosed(ring)) {
      progress = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const seg = segs[j];
        const rStart = ring[0], rEnd = ring[ring.length - 1];
        const sStart = seg[0], sEnd = seg[seg.length - 1];
        if (pointsEqual(rEnd, sStart)) { ring = ring.concat(seg.slice(1)); used[j] = true; progress = true; break; }
        if (pointsEqual(rEnd, sEnd)) { ring = ring.concat(seg.slice(0, -1).reverse()); used[j] = true; progress = true; break; }
        if (pointsEqual(rStart, sEnd)) { ring = seg.slice(0, -1).concat(ring); used[j] = true; progress = true; break; }
        if (pointsEqual(rStart, sStart)) { ring = seg.slice(1).reverse().concat(ring); used[j] = true; progress = true; break; }
      }
    }
    if (ringClosed(ring)) {
      ring = ring.slice(0, -1);
      if (ring.length >= 3) rings.push(ring);
    } // else: leftover that doesn't close -> discard, per spec
  }
  return rings;
}

function assembleMultipolygons(relationEl) {
  const members = relationEl.members || [];
  const outerSegs = [];
  const innerSegs = [];
  for (const m of members) {
    if (!m.geometry || !Array.isArray(m.geometry) || m.geometry.length < 2) continue;
    const pts = m.geometry
      .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number')
      .map((p) => lonLatToXZ(p.lon, p.lat));
    if (pts.length < 2) continue;
    if ((m.role || '') === 'inner') innerSegs.push(pts);
    else outerSegs.push(pts); // '' or 'outer' or anything unexpected -> outer
  }
  const outerRings = stitchRings(outerSegs).filter((r) => !isDegenerateRing(r));
  const innerRings = stitchRings(innerSegs).filter((r) => r.length >= 3);
  const polygons = outerRings.map((r) => ({ outer: r, holes: [] }));
  for (const hole of innerRings) {
    const testPt = hole[0];
    for (const poly of polygons) {
      if (pointInPolygon(testPt, poly.outer)) { poly.holes.push(hole); break; }
    }
    // if not contained by any outer, drop (shouldn't normally happen)
  }
  return polygons;
}

// ---- length parsing (height/min_height tags) ------------------------------------------
function parseLength(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (s === '') return null;
  s = s.split(';')[0].trim(); // some tags list multiple values; take the first
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meter|meters|metre|metres)?$/i);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*(ft|feet|')$/i);
  if (m) return parseFloat(m[1]) * 0.3048;
  m = s.match(/^(-?\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)?"?$/);
  if (m) {
    const feet = parseFloat(m[1]);
    const inches = m[2] ? parseFloat(m[2]) : 0;
    return (feet * 12 + inches) * 0.0254;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function stableHash8(id) {
  const n = Number(id);
  const h = Math.sin(n * 12.9898) * 43758.5453;
  const frac = h - Math.floor(h);
  return Math.floor(frac * 8);
}
function computeHeight(tags, id) {
  const h = parseLength(tags.height);
  if (h != null && Number.isFinite(h) && h > 0) return h;
  if (tags['building:levels'] != null) {
    const lvl = parseFloat(tags['building:levels']);
    if (Number.isFinite(lvl) && lvl > 0) return lvl * 3.35 + 1.5;
  }
  return 12 + (stableHash8(id) % 8);
}
function computeMinHeight(tags) {
  const m = parseLength(tags.min_height);
  if (m != null && Number.isFinite(m) && m > 0) return m;
  if (tags['building:min_level'] != null) {
    const lvl = parseFloat(tags['building:min_level']);
    if (Number.isFinite(lvl) && lvl > 0) return lvl * 3.35;
  }
  return 0;
}

// ---- cache loading + dedup -------------------------------------------------------------
function loadLayer(layerName) {
  const map = new Map();
  const re = new RegExp(`^${layerName}_(\\d+)_(\\d+)\\.json$`);
  let files = [];
  try {
    files = fs.readdirSync(CACHE_DIR).filter((f) => re.test(f));
  } catch {
    return map;
  }
  let parsedOk = 0;
  for (const f of files) {
    const full = path.join(CACHE_DIR, f);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.warn(`  WARN: failed to parse cache file ${f}: ${e.message}`);
      continue;
    }
    if (!Array.isArray(json.elements)) continue;
    parsedOk++;
    for (const el of json.elements) {
      const key = `${el.type}/${el.id}`;
      if (!map.has(key)) map.set(key, el);
    }
  }
  console.log(`  loaded ${layerName}: ${parsedOk}/${ROWS * COLS} chunk files, ${map.size} unique elements`);
  return map;
}

// ======================================================================================
// MAIN
// ======================================================================================
async function main() {
  fs.mkdirSync(TILES_DIR, { recursive: true });
  fs.mkdirSync(GEO_DIR, { recursive: true });

  console.log('Loading terrain...');
  TERRAIN = loadTerrain();
  console.log(`  terrain grid ${TERRAIN.nx}x${TERRAIN.nz}, step ${TERRAIN.step}m, origin (${TERRAIN.originX},${TERRAIN.originZ})`);

  console.log('Loading cache...');
  const buildingsMap = loadLayer('buildings');
  const roadsMap = loadLayer('roads');
  const areasMap = loadLayer('areas');
  const treesMap = loadLayer('trees');

  const missingChunks = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      for (const layer of LAYERS) {
        const f = path.join(CACHE_DIR, `${layer}_${row}_${col}.json`);
        if (!fs.existsSync(f)) missingChunks.push(`${layer}_${row}_${col}`);
      }
    }
  }
  if (missingChunks.length) {
    console.warn(`WARNING: ${missingChunks.length}/${ROWS * COLS * LAYERS.length} chunk files missing (proceeding with what's available):`);
    console.warn(`  ${missingChunks.slice(0, 20).join(', ')}${missingChunks.length > 20 ? ', ...' : ''}`);
  }

  // ---- BUILDINGS ----------------------------------------------------------------------
  console.log('Processing buildings...');
  const buildingElements = []; // {isPart, outer, holes, height, minHeight, kind, name, area, centroid}
  let wayCount = 0, relCount = 0, skippedDegenerate = 0;
  for (const el of buildingsMap.values()) {
    const tags = el.tags || {};
    const partVal = tags['building:part'];
    const buildingVal = tags['building'];
    const isPart = partVal !== undefined && partVal !== 'no';
    const isBuilding = !isPart && buildingVal !== undefined && buildingVal !== 'no';
    if (!isPart && !isBuilding) continue;

    let polys = [];
    if (el.type === 'way') {
      wayCount++;
      const ring = wayToRing(el);
      if (ring && !isDegenerateRing(ring)) polys = [{ outer: ring, holes: [] }];
      else skippedDegenerate++;
    } else if (el.type === 'relation') {
      relCount++;
      polys = assembleMultipolygons(el).filter((p) => {
        const ok = !isDegenerateRing(p.outer);
        if (!ok) skippedDegenerate++;
        return ok;
      });
    }
    if (polys.length === 0) continue;

    const height = computeHeight(tags, el.id);
    const minHeight = computeMinHeight(tags);
    const kindTag = isPart ? partVal : buildingVal;
    const kind = kindTag && kindTag !== 'yes' ? kindTag : undefined;
    const name = tags.name || undefined;

    for (const poly of polys) {
      const holeArea = poly.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
      const area = Math.abs(ringArea(poly.outer)) - holeArea;
      buildingElements.push({
        isPart, outer: poly.outer, holes: poly.holes, height, minHeight, kind, name,
        area, centroid: centroidOf(poly.outer),
      });
    }
  }

  // building:part suppression (spatially binned by tile, +/- 1 neighbor)
  const partsByTile = new Map();
  for (const b of buildingElements) {
    if (!b.isPart) continue;
    const [tx, tz] = tileOf(b.centroid);
    const key = tileKeyOf(tx, tz);
    if (!partsByTile.has(key)) partsByTile.set(key, []);
    partsByTile.get(key).push(b);
  }
  function neighborKeys(tx, tz) {
    const keys = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) keys.push(tileKeyOf(tx + dx, tz + dz));
    return keys;
  }

  const keptBuildings = [];
  let suppressedCount = 0;
  for (const b of buildingElements) {
    if (b.isPart) { keptBuildings.push(b); continue; }
    const [tx, tz] = tileOf(b.centroid);
    let coveredArea = 0;
    for (const key of neighborKeys(tx, tz)) {
      const candidates = partsByTile.get(key);
      if (!candidates) continue;
      for (const part of candidates) {
        if (pointInPolygon(part.centroid, b.outer)) coveredArea += part.area;
      }
    }
    if (b.area > 0 && coveredArea / b.area > 0.85) { suppressedCount++; continue; }
    keptBuildings.push(b);
  }

  console.log(
    `  buildings: ${wayCount} ways, ${relCount} relations, ${skippedDegenerate} degenerate skipped, ` +
      `${suppressedCount} plain buildings suppressed by parts, ${keptBuildings.length} kept polygons`
  );

  // Building-attached landmarks (crowns, the Hearst diagrid tower...) must sit
  // on the REAL massing, not at a hand-typed coordinate: measure each host
  // building's oriented footprint and heights into public/geo/landmarks-fit.json,
  // which LandmarkManager feeds to the builders. `clearAboveMin` additionally
  // drops the parts our build replaces (e.g. Hearst's tower above its 1928
  // base) while keeping the rest of the building.
  const LANDMARK_FIT = [
    { id: 'hearst-tower', lat: 40.7666, lon: -73.9836, r: 45, clearAboveH: 5 },
    { id: 'chrysler', lat: 40.7516, lon: -73.9755, r: 45, clearAboveMin: 184, clearAboveH: 270 },
    { id: 'empire-state', lat: 40.7484, lon: -73.9857, r: 40, clearAboveMin: 325 },
    { id: 'one-vanderbilt', lat: 40.7529, lon: -73.9787, r: 40 },
    { id: 'woolworth', lat: 40.7124, lon: -74.0083, r: 40 },
    { id: 'top-of-the-rock', lat: 40.7591, lon: -73.9794, r: 40 },
    { id: 'flatiron', lat: 40.7411, lon: -73.9897, r: 40 },
    { id: 'msg', lat: 40.7505, lon: -73.9934, r: 80 },
    { id: 'edge-deck', lat: 40.7539, lon: -74.0006, r: 45 },
  ].map((e) => { const [x, z] = lonLatToXZ(e.lon, e.lat); return { ...e, x, z }; });

  console.log('Measuring landmark host buildings...');
  const fitOut = {};
  const fitCleared = new Set(); // building object refs to drop
  for (const lf of LANDMARK_FIT) {
    const cands = keptBuildings.filter((b) => {
      const dx = b.centroid[0] - lf.x, dz = b.centroid[1] - lf.z;
      return dx * dx + dz * dz < lf.r * lf.r;
    });
    if (!cands.length) { console.warn(`  fit ${lf.id}: NO building found at anchor`); continue; }
    // dominant orientation: longest edge of the largest footprint
    const largest = cands.reduce((a, b) => (b.area > a.area ? b : a));
    let ex = 1, ez = 0, bestLen = 0;
    const ring = largest.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = dx * dx + dz * dz;
      if (len > bestLen) { bestLen = len; const l = Math.sqrt(len); ex = dx / l; ez = dz / l; }
    }
    const rot = Math.atan2(-ez, ex); // rotation.y mapping local +x onto the edge
    const proj = (pt) => {
      const dx = pt[0] - lf.x, dz = pt[1] - lf.z;
      return [dx * ex + dz * ez, -dx * ez + dz * ex]; // [along, perp]
    };
    const measure = (list) => {
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, roof = 0;
      for (const b of list) {
        roof = Math.max(roof, b.height);
        for (const pt of b.outer) {
          const [u, v] = proj(pt);
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
      }
      return { minU, maxU, minV, maxV, roof };
    };
    const all = measure(cands);
    const isTall = (b) => (lf.clearAboveMin !== undefined && (b.minHeight ?? 0) >= lf.clearAboveMin)
      || (lf.clearAboveH !== undefined && b.height >= lf.clearAboveH);
    const cleared = lf.clearAboveMin !== undefined || lf.clearAboveH !== undefined ? cands.filter(isTall) : [];
    for (const b of cleared) fitCleared.add(b);
    const kept = cands.filter((b) => !cleared.includes(b));
    const keptM = kept.length ? measure(kept) : all;
    const top = measure(cands.filter((b) => b.height >= all.roof - 12));
    // center of the full-massing obb, in world coords
    const cu = (all.minU + all.maxU) / 2, cv = (all.minV + all.maxV) / 2;
    fitOut[lf.id] = {
      cx: Math.round((lf.x + ex * cu - ez * cv) * 10) / 10,
      cz: Math.round((lf.z + ez * cu + ex * cv) * 10) / 10,
      rot: Math.round(rot * 1000) / 1000,
      w: Math.round(all.maxU - all.minU),
      d: Math.round(all.maxV - all.minV),
      roofH: Math.round(all.roof),          // tallest massing incl. parts we cleared
      keptH: Math.round(keptM.roof),        // tallest massing left standing
      topW: Math.round(top.maxU - top.minU),
      topD: Math.round(top.maxV - top.minV),
      parts: cands.length,
      clearedParts: cleared.length,
    };
    console.log(`  fit ${lf.id}: ${cands.length} parts, obb ${fitOut[lf.id].w}x${fitOut[lf.id].d}m rot ${fitOut[lf.id].rot}, roof ${fitOut[lf.id].roofH}m, kept ${fitOut[lf.id].keptH}m, cleared ${cleared.length}`);
  }
  fs.writeFileSync(path.join(GEO_DIR, 'landmarks-fit.json'), JSON.stringify({ v: 1, fits: fitOut }));

  // Premium landmark builds (src/engine/landmarks) REPLACE the generic OSM
  // massing at these spots — a bespoke Oculus/Guggenheim/cathedral built at a
  // point that OSM also maps as a building would be swallowed inside it.
  // Buildings whose centroid falls within r of a point are dropped; layered
  // landmarks (crowns, marquees, facades) keep their massing and are NOT here.
  const LANDMARK_CLEAR = [
    ['oculus', 40.7115, -74.0113, 55], ['sept11-museum', 40.7115, -74.0125, 28],
    ['trinity-church', 40.7081, -74.0121, 40], ['federal-hall', 40.7074, -74.0102, 30],
    ['castle-clinton', 40.7033, -74.017, 38], ['fraunces-tavern', 40.7034, -74.0113, 18],
    ['whitehall-terminal', 40.7013, -74.0131, 45], ['city-hall', 40.7128, -74.006, 50],
    ['st-patricks', 40.7586, -73.9758, 62], ['guggenheim', 40.783, -73.959, 40],
    ['un-secretariat', 40.749, -73.9687, 55], ['un-ga', 40.7497, -73.9674, 45],
    ['dakota', 40.7765, -73.9761, 42], ['carnegie-hall', 40.7651, -73.9799, 35],
    ['whitney', 40.7397, -74.0089, 35], ['vessel', 40.7538, -74.0022, 40],
    ['little-island', 40.742, -74.01, 70], ['belvedere', 40.7794, -73.9692, 28],
    ['grants-tomb', 40.8134, -73.963, 32], ['riverside-church', 40.8119, -73.9633, 42],
    ['columbia-low', 40.8081, -73.9619, 42], ['st-john-divine', 40.8038, -73.9619, 55],
    ['cloisters', 40.8649, -73.9317, 55], ['hamilton-grange', 40.8214, -73.9469, 18],
    ['morris-jumel', 40.834, -73.9354, 20], ['dyckman-farmhouse', 40.8672, -73.9339, 18],
  ].map(([id, lat, lon, r]) => { const [x, z] = lonLatToXZ(lon, lat); return { id, x, z, r }; });
  let landmarkCleared = 0;

  // bin into tiles + collect skyline candidates
  const tileBuildings = new Map(); // key -> array of output objs
  const tileBuildingFootprints = new Map(); // key -> array of {outer,holes} world-meter rings (for tree placement filters)
  const skylineCandidates = [];
  for (const b of keptBuildings) {
    let cleared = fitCleared.has(b);
    for (const lc of LANDMARK_CLEAR) {
      if (cleared) break;
      const dx = b.centroid[0] - lc.x, dz = b.centroid[1] - lc.z;
      if (dx * dx + dz * dz < lc.r * lc.r) { cleared = true; break; }
    }
    if (cleared) { landmarkCleared++; continue; }
    const [tx, tz] = tileOf(b.centroid);
    const key = tileKeyOf(tx, tz);
    const p = [toTileLocalDecimeters(b.outer, tx, tz), ...b.holes.map((h) => toTileLocalDecimeters(h, tx, tz))];
    const obj = { p, h: round1(b.height), b: round1(terrainAt(b.centroid[0], b.centroid[1])) };
    if (b.minHeight > 0) obj.m = round1(b.minHeight);
    if (b.name) obj.n = b.name;
    if (b.kind) obj.k = b.kind;
    if (!tileBuildings.has(key)) tileBuildings.set(key, []);
    tileBuildings.get(key).push(obj);
    if (!tileBuildingFootprints.has(key)) tileBuildingFootprints.set(key, []);
    tileBuildingFootprints.get(key).push({ outer: b.outer, holes: b.holes });

    if (b.height >= 70) skylineCandidates.push(b);
  }

  console.log(`  landmark clearing: ${landmarkCleared} buildings dropped at ${LANDMARK_CLEAR.length} premium-landmark sites`);

  // ---- ROADS ----------------------------------------------------------------------------
  console.log('Processing roads...');
  function segmentGridCrossings(p0, p1) {
    const [x0, z0] = p0, [x1, z1] = p1;
    const crossings = [];
    if (x0 !== x1) {
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      const kMin = Math.ceil(lo / TILE_SIZE - 1e-9);
      const kMax = Math.floor(hi / TILE_SIZE + 1e-9);
      for (let k = kMin; k <= kMax; k++) {
        const boundary = k * TILE_SIZE;
        if (boundary <= lo + 1e-9 || boundary >= hi - 1e-9) continue;
        const t = (boundary - x0) / (x1 - x0);
        crossings.push({ t, x: boundary, z: z0 + t * (z1 - z0) });
      }
    }
    if (z0 !== z1) {
      const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
      const kMin = Math.ceil(lo / TILE_SIZE - 1e-9);
      const kMax = Math.floor(hi / TILE_SIZE + 1e-9);
      for (let k = kMin; k <= kMax; k++) {
        const boundary = k * TILE_SIZE;
        if (boundary <= lo + 1e-9 || boundary >= hi - 1e-9) continue;
        const t = (boundary - z0) / (z1 - z0);
        crossings.push({ t, x: x0 + t * (x1 - x0), z: boundary });
      }
    }
    crossings.sort((a, b) => a.t - b.t);
    const deduped = [];
    for (const c of crossings) {
      if (deduped.length && Math.abs(c.t - deduped[deduped.length - 1].t) < 1e-6) continue;
      deduped.push(c);
    }
    return deduped;
  }
  function splitAtGridLines(points) {
    const pieces = [];
    let current = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const crossings = segmentGridCrossings(p0, p1);
      for (const c of crossings) {
        current.push([c.x, c.z]);
        pieces.push(current);
        current = [[c.x, c.z]];
      }
      current.push(p1);
    }
    pieces.push(current);
    return pieces.filter((p) => p.length >= 2);
  }

  // Bridge piece elevation profile: ends sit at terrainAt(end)+0.5, interior points blend
  // smoothly (quadratic bump) up to a peak of max(terrainAt(endA),terrainAt(endB))+6 at the
  // piece midpoint, so the piece reads as a gentle arch rather than a flat deck. Parametrized
  // by POINT INDEX (not arc length): real OSM bridge ways often bunch extra nodes near one
  // end (e.g. a curving ramp), and arc-length parametrization would then place every actual
  // sample point past the curve's true peak, making the discrete e[] values monotonic instead
  // of visibly arched. Index-based t pins the middle node(s) to the peak regardless of spacing.
  function bridgeElevations(piece) {
    const n = piece.length;
    const groundA = terrainAt(piece[0][0], piece[0][1]);
    const groundB = terrainAt(piece[n - 1][0], piece[n - 1][1]);
    const elevA = groundA + 0.5;
    const elevB = groundB + 0.5;
    const peak = Math.max(groundA, groundB) + 6;
    const bump = peak - (elevA + elevB) / 2;
    const e = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const baseline = elevA + (elevB - elevA) * t;
      const shape = 4 * t * (1 - t); // 0 at ends, 1 at midpoint
      e[i] = round1(baseline + bump * shape);
    }
    return e;
  }
  function plainElevations(piece) {
    return piece.map(([x, z]) => round1(terrainAt(x, z)));
  }

  const tileRoads = new Map();
  const tileRoadPiecesWorld = new Map(); // key -> array of {pts (world meters), cls} for tree placement filters
  let roadWayCount = 0, roadPieceCount = 0;
  for (const el of roadsMap.values()) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};
    if (!tags.highway) continue;
    if (tags.area === 'yes') continue;
    if (tags.tunnel === 'yes') continue;
    if (!el.geometry || el.geometry.length < 2) continue;

    let c = tags.highway;
    if (tags.footway === 'crossing' || tags.cycleway === 'crossing') c = 'crossing';
    const bridge = tags.bridge && tags.bridge !== 'no' ? 1 : undefined;

    const pts = el.geometry.filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').map((p) => lonLatToXZ(p.lon, p.lat));
    if (pts.length < 2) continue;
    roadWayCount++;

    const pieces = splitAtGridLines(pts);
    for (const piece of pieces) {
      if (piece.length < 2) continue;
      const mid = [(piece[0][0] + piece[piece.length - 1][0]) / 2, (piece[0][1] + piece[piece.length - 1][1]) / 2];
      const [tx, tz] = tileOf(mid);
      const key = tileKeyOf(tx, tz);
      const flat = toTileLocalDecimeters(piece, tx, tz);
      const obj = { p: flat, c, e: bridge ? bridgeElevations(piece) : plainElevations(piece) };
      if (bridge) obj.b = 1;
      if (!tileRoads.has(key)) tileRoads.set(key, []);
      tileRoads.get(key).push(obj);
      if (!tileRoadPiecesWorld.has(key)) tileRoadPiecesWorld.set(key, []);
      tileRoadPiecesWorld.get(key).push({ pts: piece, cls: c });
      roadPieceCount++;
    }
  }

  // ---- MAJOR STREETS: island-wide skeleton for the minimap's widest zoom -------------------
  // The minimap draws streets from the tile stream, but tiles only load within ~1.1km of the
  // player, so at the widest zoom most of the view has no road data at all. Bake the
  // avenue/highway skeleton once: simplified and major-only, it ships whole for the price of
  // a couple of tiles. Widths match ROAD_STYLE so the minimap can weight these lines with the
  // exact same math it uses for the streamed centerlines.
  console.log('Extracting major streets for the minimap...');
  const MAJOR_W = { motorway: 22, trunk: 20, primary: 17, secondary: 14 };
  const majorWays = [];
  let majorPtsBefore = 0, majorPtsAfter = 0;
  for (const el of roadsMap.values()) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};
    const w = MAJOR_W[tags.highway];
    if (!w) continue;
    if (tags.area === 'yes' || tags.tunnel === 'yes') continue;
    if (!el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map((g) => lonLatToXZ(g.lon, g.lat));
    majorPtsBefore += pts.length;
    // 12m ~= half a pixel at the widest zoom; detail below that is invisible
    const simp = pts.length > 2 ? simplifyRing(pts, 12) : pts;
    if (simp.length < 2) continue;
    majorPtsAfter += simp.length;
    majorWays.push({ w, p: simp.flatMap((pt) => [Math.round(pt[0]), Math.round(pt[1])]) });
  }
  fs.writeFileSync(path.join(GEO_DIR, 'streets.json'), JSON.stringify({ v: 1, ways: majorWays }));
  console.log(
    `  major streets: ${majorWays.length} ways, ${majorPtsBefore} -> ${majorPtsAfter} points ` +
      `(${(fs.statSync(path.join(GEO_DIR, 'streets.json')).size / 1024).toFixed(0)}KB)`
  );

  // ---- STREET SIGNS: real intersections of named streets --------------------
  console.log('Extracting street-sign intersections...');
  const SIGN_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
  const CLASS_W = { motorway: 22, trunk: 20, primary: 17, secondary: 14, tertiary: 12, unclassified: 10, residential: 10 };
  const nodeEntries = new Map(); // node id -> { pt, entries: Map(name -> {dir, cls}) }
  for (const el of roadsMap.values()) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};
    if (!tags.highway || !SIGN_CLASSES.has(tags.highway) || !tags.name) continue;
    if (tags.tunnel === 'yes' || tags.area === 'yes') continue;
    if (!el.nodes || !el.geometry || el.nodes.length !== el.geometry.length) continue;
    const pts = el.geometry.map((g) => lonLatToXZ(g.lon, g.lat));
    for (let i = 0; i < el.nodes.length; i++) {
      const id = el.nodes[i];
      let rec = nodeEntries.get(id);
      if (!rec) { rec = { pt: pts[i], entries: new Map() }; nodeEntries.set(id, rec); }
      let dx = 0, dz = 0;
      if (i > 0) { dx += pts[i][0] - pts[i - 1][0]; dz += pts[i][1] - pts[i - 1][1]; }
      if (i < pts.length - 1) { dx += pts[i + 1][0] - pts[i][0]; dz += pts[i + 1][1] - pts[i][1]; }
      const len = Math.hypot(dx, dz) || 1;
      if (!rec.entries.has(tags.name)) rec.entries.set(tags.name, { dir: [dx / len, dz / len], cls: tags.highway });
    }
  }
  const tileSigns = new Map();
  const signDedupe = new Set();
  let signCount = 0;
  for (const rec of nodeEntries.values()) {
    if (rec.entries.size < 2) continue;
    const names = [...rec.entries.keys()].slice(0, 2);
    const ea = rec.entries.get(names[0]), eb = rec.entries.get(names[1]);
    // dual carriageways / split ways produce clusters of nodes for the same
    // street pair — keep one sign assembly per pair per ~45m cell
    const cell = `${Math.round(rec.pt[0] / 45)}:${Math.round(rec.pt[1] / 45)}`;
    const dkey = names.slice().sort().join('|') + '@' + cell;
    if (signDedupe.has(dkey)) continue;
    signDedupe.add(dkey);
    // push the pole out of the roadway onto a corner (quadrant by hash)
    let cx = ea.dir[0] + eb.dir[0], cz = ea.dir[1] + eb.dir[1];
    let cl = Math.hypot(cx, cz);
    if (cl < 0.3) { cx = -ea.dir[1] + eb.dir[0]; cz = ea.dir[0] + eb.dir[1]; cl = Math.hypot(cx, cz) || 1; }
    const hsh = Math.abs(Math.sin(rec.pt[0] * 12.9898 + rec.pt[1] * 78.233));
    const s1 = hsh < 0.5 ? 1 : -1;
    const dist = ((CLASS_W[ea.cls] || 10) + (CLASS_W[eb.cls] || 10)) / 4 + 2.2;
    const px = rec.pt[0] + (cx / cl) * dist * s1;
    const pz = rec.pt[1] + (cz / cl) * dist * s1;
    const [stx, stz] = tileOf([px, pz]);
    const skey = tileKeyOf(stx, stz);
    if (!tileSigns.has(skey)) tileSigns.set(skey, []);
    const slist = tileSigns.get(skey);
    if (slist.length >= 12) continue;
    slist.push({
      p: [Math.round((px - stx * TILE_SIZE) * 10), Math.round((pz - stz * TILE_SIZE) * 10)],
      e: Math.round(terrainAt(px, pz) * 10),
      n: names,
      a: [
        Math.round((Math.atan2(ea.dir[1], ea.dir[0]) * 180) / Math.PI),
        Math.round((Math.atan2(eb.dir[1], eb.dir[0]) * 180) / Math.PI),
      ],
    });
    signCount++;
  }
  console.log(`  signs: ${signCount} intersection assemblies (${nodeEntries.size} named-road nodes)`);

  // ---- HYDRANTS (OSM emergency=fire_hydrant nodes) ---------------------------
  const hydrantsMap = loadLayer('hydrants');
  const tileHyd = new Map();
  let hydCount = 0;
  for (const el of hydrantsMap.values()) {
    if (el.type !== 'node' || typeof el.lat !== 'number') continue;
    const [hx, hz] = lonLatToXZ(el.lon, el.lat);
    const [htx, htz] = tileOf([hx, hz]);
    const hkey = tileKeyOf(htx, htz);
    if (!tileHyd.has(hkey)) tileHyd.set(hkey, []);
    const harr = tileHyd.get(hkey);
    if (harr.length >= 200 * 3) continue;
    harr.push(Math.round((hx - htx * TILE_SIZE) * 10), Math.round((hz - htz * TILE_SIZE) * 10), Math.round(terrainAt(hx, hz) * 10));
    hydCount++;
  }
  // Augment: OSM only maps ~2.5k of Manhattan's hydrants. Fill gaps along
  // streets at ~80m spacing (NYC standard), deferring to real hydrants within 40m.
  const hydGrid = new Set();
  const gk = (x, z) => `${Math.round(x / 40)}:${Math.round(z / 40)}`;
  for (const arr of tileHyd.values()) {
    for (let i = 0; i < arr.length; i += 3) {
      // reconstruct world pos is tile-local; grid key built during binning below instead
    }
  }
  // rebuild grid from OSM nodes directly
  for (const el of hydrantsMap.values()) {
    if (el.type !== 'node' || typeof el.lat !== 'number') continue;
    const [x, z] = lonLatToXZ(el.lon, el.lat);
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      hydGrid.add(`${Math.round(x / 40) + gx}:${Math.round(z / 40) + gz}`);
    }
  }
  const HYD_CLASSES = new Set(['residential', 'tertiary', 'secondary', 'unclassified']);
  const HYD_W = { secondary: 14, tertiary: 12, unclassified: 10, residential: 10 };
  let hydProc = 0;
  for (const [key, pieces] of tileRoadPiecesWorld) {
    for (const piece of pieces) {
      if (!HYD_CLASSES.has(piece.cls)) continue;
      const pts = piece.pts;
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const seg = Math.hypot(bx - ax, bz - az);
        let d = 80 - acc;
        while (d < seg) {
          const t = d / seg;
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const nx = -(bz - az) / seg, nz = (bx - ax) / seg;
          const side = Math.abs(Math.sin(x * 12.9898 + z * 78.233)) < 0.5 ? 1 : -1;
          const off = (HYD_W[piece.cls] || 10) / 2 + 1.3;
          const hx = x + nx * off * side, hz = z + nz * off * side;
          // reject candidates inside ANY vehicular roadbed (cross streets at corners)
          let inRoad = false;
          for (const other of pieces) {
            if (other === piece) continue;
            const ow = (CLASS_W[other.cls] || (HYD_W[other.cls] ?? 0)) || 0;
            if (!ow) continue;
            const clr = ow / 2 + 0.6;
            const op = other.pts;
            for (let k = 1; k < op.length && !inRoad; k++) {
              const [x1, z1] = op[k - 1], [x2, z2] = op[k];
              const ddx = x2 - x1, ddz = z2 - z1;
              const l2 = ddx * ddx + ddz * ddz;
              let tt = l2 > 0 ? ((hx - x1) * ddx + (hz - z1) * ddz) / l2 : 0;
              tt = Math.max(0, Math.min(1, tt));
              const qx = x1 + tt * ddx, qz = z1 + tt * ddz;
              if ((hx - qx) * (hx - qx) + (hz - qz) * (hz - qz) < clr * clr) inRoad = true;
            }
            if (inRoad) break;
          }
          if (!inRoad && !hydGrid.has(gk(hx, hz))) {
            for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
              hydGrid.add(`${Math.round(hx / 40) + gx}:${Math.round(hz / 40) + gz}`);
            }
            const [htx, htz] = tileOf([hx, hz]);
            const hkey = tileKeyOf(htx, htz);
            if (!tileHyd.has(hkey)) tileHyd.set(hkey, []);
            const harr = tileHyd.get(hkey);
            if (harr.length < 200 * 3) {
              harr.push(Math.round((hx - htx * TILE_SIZE) * 10), Math.round((hz - htz * TILE_SIZE) * 10), Math.round(terrainAt(hx, hz) * 10));
              hydProc++;
            }
          }
          d += 80;
        }
        acc = (acc + seg) % 80;
      }
    }
  }
  console.log(`  hydrants: ${hydCount} OSM + ${hydProc} procedural across ${tileHyd.size} tiles`);
  console.log(`  roads: ${roadWayCount} ways -> ${roadPieceCount} tile pieces`);

  // ---- AREAS ------------------------------------------------------------------------------
  console.log('Processing areas...');
  const LEISURE_PARK = new Set(['park', 'garden', 'common', 'dog_park', 'golf_course']);
  const LANDUSE_GRASS = new Set(['grass', 'meadow', 'village_green', 'flowerbed', 'recreation_ground']);
  function classifyArea(tags) {
    const leisure = tags.leisure, landuse = tags.landuse, natural = tags.natural;
    if (leisure) {
      if (LEISURE_PARK.has(leisure)) return 'park';
      if (leisure === 'playground') return 'playground';
      if (leisure === 'pitch') return 'sports';
    }
    if (landuse) {
      if (LANDUSE_GRASS.has(landuse)) return 'grass';
      if (landuse === 'cemetery') return 'cemetery';
      if (landuse === 'forest') return 'wood';
    }
    if (natural) {
      if (natural === 'wood' || natural === 'scrub') return 'wood';
      if (natural === 'grassland') return 'grass';
      if (natural === 'beach' || natural === 'sand') return 'sand';
      if (natural === 'water') return 'water';
    }
    if (tags.man_made === 'pier') return 'pier';
    if (tags.highway === 'pedestrian' && tags.area === 'yes') return 'plaza';
    return null;
  }
  const WATER_AREA_CAP = 1500000; // m^2 - drop rivers, keep park lakes/reservoir

  const VEGETATION_KINDS = new Set(['wood', 'park', 'grass', 'cemetery']);
  const tileAreas = new Map(); // key -> Map<kind, number[]> (triples x,z,e per vertex; e = absolute decimeters)
  const areaPolysByKind = new Map(); // kind -> array of {outer,holes} world-meter rings (wood/park/grass/cemetery only, for procedural trees)
  for (const k of VEGETATION_KINDS) areaPolysByKind.set(k, []);
  let areaPolyCount = 0, areaTriCount = 0, waterDropped = 0;
  for (const el of areasMap.values()) {
    const tags = el.tags || {};
    const kind = classifyArea(tags);
    if (!kind) continue;

    let polys = [];
    if (el.type === 'way') {
      const ring = wayToRing(el);
      if (ring && !isDegenerateRing(ring)) polys = [{ outer: ring, holes: [] }];
    } else if (el.type === 'relation') {
      polys = assembleMultipolygons(el).filter((p) => !isDegenerateRing(p.outer));
    }

    for (const poly of polys) {
      const holeArea = poly.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
      const netArea = Math.abs(ringArea(poly.outer)) - holeArea;
      if (kind === 'water' && netArea > WATER_AREA_CAP) { waterDropped++; continue; }

      if (VEGETATION_KINDS.has(kind)) areaPolysByKind.get(kind).push(poly);

      // Water: flatten every triangle of this SOURCE polygon to one constant level so
      // ponds/lakes render dead flat instead of following the (noisy, bilinear-sampled) terrain.
      // Level = mean shoreline elevation + 0.3 so it clears DEM noise inside the basin.
      let waterLevelDm = null;
      if (kind === 'water') {
        let sumE = 0;
        for (const v of poly.outer) sumE += terrainAt(v[0], v[1]);
        waterLevelDm = Math.round((sumE / poly.outer.length + 0.3) * 10);
      }

      areaPolyCount++;
      // Subdivide so per-vertex elevations follow the terrain instead of a giant flat
      // triangle slicing through hills (which buried most of Central Park's lawns).
      // subdivideAll is hoisted from the ground-mesh section below. Water stays flat,
      // so skip subdividing it (constant level regardless of vertex count).
      const trisRaw = triangulatePolygon(poly.outer, poly.holes);
      const tris = kind === 'water' ? trisRaw : subdivideAll(trisRaw, 45);
      for (const [p0, p1, p2] of tris) {
        const cx = (p0[0] + p1[0] + p2[0]) / 3;
        const cz = (p0[1] + p1[1] + p2[1]) / 3;
        const [tx, tz] = tileOf([cx, cz]);
        const key = tileKeyOf(tx, tz);
        const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE;
        if (!tileAreas.has(key)) tileAreas.set(key, new Map());
        const kindMap = tileAreas.get(key);
        if (!kindMap.has(kind)) kindMap.set(kind, []);
        const arr = kindMap.get(kind);
        for (const p of [p0, p1, p2]) {
          const eDm = kind === 'water' ? waterLevelDm : Math.round(terrainAt(p[0], p[1]) * 10);
          arr.push(Math.round((p[0] - ox) * 10), Math.round((p[1] - oz) * 10), eDm);
        }
        areaTriCount++;
      }
    }
  }
  console.log(`  areas: ${areaPolyCount} polygons -> ${areaTriCount} triangles (${waterDropped} large water polygons dropped as rivers)`);

  // ---- TREES: real OSM nodes -----------------------------------------------------------
  console.log('Processing trees...');
  const treesByTile = new Map(); // key -> array of [x,z] world meters
  let treeCount = 0;
  for (const el of treesMap.values()) {
    if (el.type !== 'node' || typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
    const pt = lonLatToXZ(el.lon, el.lat);
    const [tx, tz] = tileOf(pt);
    const key = tileKeyOf(tx, tz);
    if (!treesByTile.has(key)) treesByTile.set(key, []);
    treesByTile.get(key).push(pt);
    treeCount++;
  }
  // Subway entrance stair kits are placed at runtime around these points (with
  // a few meters of ejection slack) — keep trees out of them. subway.json is
  // produced by fetch-subway.mjs; when absent (partial pipeline runs) trees
  // simply skip this filter.
  const entrancesByTile = new Map(); // key -> array of [x,z]
  try {
    const subwayPath = path.join(GEO_DIR, '..', 'subway', 'subway.json');
    const subwayData = JSON.parse(fs.readFileSync(subwayPath, 'utf8'));
    for (const en of subwayData.entrances || []) {
      const [tx, tz] = tileOf(en.pos);
      const key = tileKeyOf(tx, tz);
      if (!entrancesByTile.has(key)) entrancesByTile.set(key, []);
      entrancesByTile.get(key).push(en.pos);
    }
    console.log(`  tree clearance: ${(subwayData.entrances || []).length} subway entrances loaded`);
  } catch {
    console.warn('  tree clearance: public/subway/subway.json missing — entrance clearance skipped');
  }
  const ENTRANCE_CLEAR = 7; // covers the kit footprint + runtime ejection slack
  function nearEntrance(x, z) {
    const [tx, tz] = tileOf([x, z]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = entrancesByTile.get(tileKeyOf(tx + dx, tz + dz));
        if (!list) continue;
        for (const [ex, ez] of list) {
          if ((x - ex) * (x - ex) + (z - ez) * (z - ez) < ENTRANCE_CLEAR * ENTRANCE_CLEAR) return true;
        }
      }
    }
    return false;
  }

  const realTreesByTile = new Map(); // key -> array of [x,z] world meters, capped at 800 (unchanged from v1)
  let treeTilesSampled = 0;
  let realCulledAtEntrances = 0;
  for (const [key, rawList] of treesByTile) {
    const list = rawList.filter(([x, z]) => {
      if (nearEntrance(x, z)) { realCulledAtEntrances++; return false; }
      return true;
    });
    const sampled = sampleEveryNth(list, 800);
    if (sampled.length < list.length) treeTilesSampled++;
    realTreesByTile.set(key, sampled);
  }
  console.log(`  real OSM trees: ${treeCount} nodes across ${treesByTile.size} tiles (${treeTilesSampled} tiles capped at 800)`);
  if (realCulledAtEntrances) console.log(`  real OSM trees: ${realCulledAtEntrances} culled at subway entrances`);

  // ---- PROCEDURAL VEGETATION -------------------------------------------------------------
  // Scattered inside wood/park/grass/cemetery polygons (deterministic hex/grid lattice +
  // hash jitter/thinning) plus street trees along residential/tertiary/secondary/unclassified
  // roads. Candidates are generated in world meters, then filtered against that SAME TILE's
  // roads/buildings, then merged with real trees and capped per tile.
  console.log('Generating procedural vegetation...');
  const STREET_CLASSES = new Set(['residential', 'tertiary', 'secondary', 'unclassified']);
  const CLASS_WIDTH = { secondary: 14, tertiary: 12, unclassified: 10, residential: 10 };
  const VEG_SPACING = { wood: 8, park: 15, grass: 20, cemetery: 15 };
  const VEG_JITTER = { wood: 3, park: 5, grass: 6, cemetery: 5 };
  const VEG_KEEP = { wood: 1, park: 0.55, grass: 0.3, cemetery: 0.5 };
  const VEG_HEX = { wood: true, park: false, grass: false, cemetery: false };
  const STREET_TREE_SPACING = 15;

  function generateProceduralCandidates(spacingMul) {
    const candidates = new Map(); // key -> array of [x,z,clearance]
    function addCandidate(x, z, clearance) {
      const [tx, tz] = tileOf([x, z]);
      const key = tileKeyOf(tx, tz);
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push([x, z, clearance]);
    }

    // -- wood/park/grass/cemetery interior scatter --
    for (const kind of VEGETATION_KINDS) {
      const spacing = VEG_SPACING[kind] * spacingMul;
      const jitter = VEG_JITTER[kind];
      const keep = VEG_KEEP[kind];
      const useHex = VEG_HEX[kind];
      for (const poly of areaPolysByKind.get(kind)) {
        const bbox = polyBBox(poly.outer);
        const lattice = useHex ? hexLatticePoints(bbox, spacing) : gridLatticePoints(bbox, spacing);
        for (const [lx, lz] of lattice) {
          const jx = (hash2(lx, lz, 0) * 2 - 1) * jitter;
          const jz = (hash2(lx, lz, 1) * 2 - 1) * jitter;
          const px = lx + jx, pz = lz + jz;
          if (!pointInPolygonWithHoles([px, pz], poly)) continue;
          if (keep < 1 && hash2(lx, lz, 2) >= keep) continue;
          addCandidate(px, pz, 5);
        }
      }
    }

    // -- street trees along qualifying road classes --
    for (const [, pieces] of tileRoadPiecesWorld) {
      for (const piece of pieces) {
        if (!STREET_CLASSES.has(piece.cls)) continue;
        const pts = piece.pts;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const total = cum[pts.length - 1];
        if (total <= 0) continue;
        const offset = CLASS_WIDTH[piece.cls] / 2 + 2.5;
        const spacing = STREET_TREE_SPACING * spacingMul;
        let segIdx = 0;
        for (let s = 0; s <= total; s += spacing) {
          while (segIdx < pts.length - 2 && cum[segIdx + 1] < s) segIdx++;
          const segStart = pts[segIdx], segEnd = pts[segIdx + 1];
          const segLen = cum[segIdx + 1] - cum[segIdx];
          const tt = segLen > 1e-6 ? (s - cum[segIdx]) / segLen : 0;
          const bx = segStart[0] + (segEnd[0] - segStart[0]) * tt;
          const bz = segStart[1] + (segEnd[1] - segStart[1]) * tt;
          let dx = segEnd[0] - segStart[0], dz = segEnd[1] - segStart[1];
          const dlen = Math.hypot(dx, dz) || 1;
          dx /= dlen; dz /= dlen;
          const perpX = -dz, perpZ = dx;
          for (const side of [1, -1]) {
            const sx = bx + perpX * offset * side;
            const sz = bz + perpZ * offset * side;
            const salt = side === 1 ? 10 : 20;
            if (hash2(sx, sz, salt + 2) < 0.35) continue; // drop 35%
            const jx = (hash2(sx, sz, salt) * 2 - 1) * 1.5;
            const jz = (hash2(sx, sz, salt + 1) * 2 - 1) * 1.5;
            addCandidate(sx + jx, sz + jz, 2);
          }
        }
      }
    }
    return candidates;
  }

  function filterCandidates(candidates) {
    const result = new Map(); // key -> array of [x,z]
    let before = 0, after = 0;
    for (const [key, list] of candidates) {
      before += list.length;
      const roadPolylines = (tileRoadPiecesWorld.get(key) || []).map((p) => p.pts);
      const buildings = tileBuildingFootprints.get(key) || [];
      const kept = [];
      for (const [x, z, clearance] of list) {
        if (pointToPolylinesDist([x, z], roadPolylines) < clearance) continue;
        if (nearEntrance(x, z)) continue;
        let insideBuilding = false;
        for (const bpoly of buildings) {
          if (pointInPolygonWithHoles([x, z], bpoly)) { insideBuilding = true; break; }
        }
        if (insideBuilding) continue;
        kept.push([x, z]);
      }
      after += kept.length;
      result.set(key, kept);
    }
    return { byTile: result, before, after };
  }

  function buildFinalTrees(spacingMul) {
    const candidates = generateProceduralCandidates(spacingMul);
    const { byTile: proceduralByTile, before, after } = filterCandidates(candidates);
    const allTreeKeys = new Set([...realTreesByTile.keys(), ...proceduralByTile.keys()]);
    const finalByTile = new Map(); // key -> flat triples [dx,dz,e_dm,...]
    let grandTotal = 0, tilesCappedAt1400 = 0;
    for (const key of allTreeKeys) {
      const [tx, tz] = key.split('_').map(Number);
      const real = realTreesByTile.get(key) || [];
      const proc = proceduralByTile.get(key) || [];
      let combined = real.concat(proc); // real OSM trees first, procedural after (per spec)
      if (combined.length > 1400) { combined = sampleEveryNth(combined, 1400); tilesCappedAt1400++; }
      const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE;
      const flat = new Array(combined.length * 3);
      for (let i = 0; i < combined.length; i++) {
        const [x, z] = combined[i];
        flat[i * 3] = Math.round((x - ox) * 10);
        flat[i * 3 + 1] = Math.round((z - oz) * 10);
        flat[i * 3 + 2] = Math.round(terrainAt(x, z) * 10);
      }
      finalByTile.set(key, flat);
      grandTotal += combined.length;
    }
    return { finalByTile, grandTotal, proceduralRawBefore: before, proceduralRawAfter: after, tilesCappedAt1400 };
  }

  let vegResult = buildFinalTrees(1.0);
  console.log(
    `  procedural candidates: ${vegResult.proceduralRawBefore} generated, ${vegResult.proceduralRawAfter} kept after road/building clearance filters`
  );
  console.log(`  combined total trees (real+procedural): ${vegResult.grandTotal} (${vegResult.tilesCappedAt1400} tiles capped at 1400)`);
  if (vegResult.grandTotal > 900000) {
    console.log('  total exceeds 900k -> raising vegetation spacings 20% and regenerating once...');
    vegResult = buildFinalTrees(1.2);
    console.log(
      `  [retry] procedural candidates: ${vegResult.proceduralRawBefore} generated, ${vegResult.proceduralRawAfter} kept; ` +
        `combined total: ${vegResult.grandTotal} (${vegResult.tilesCappedAt1400} tiles capped at 1400)`
    );
  }
  const tileTrees = vegResult.finalByTile; // key -> flat triples [dx,dz,e_dm,...]

  // ---- WRITE TILE FILES + index.json -------------------------------------------------------
  console.log('Writing tiles...');
  // Clear any stale tile files from a previous (e.g. partial-cache) run so the output
  // directory never mixes tiles from different builds.
  const tileFileRe = /^-?\d+_-?\d+\.json$/;
  for (const f of fs.readdirSync(TILES_DIR)) {
    if (tileFileRe.test(f)) fs.unlinkSync(path.join(TILES_DIR, f));
  }
  const allKeys = new Set([...tileBuildings.keys(), ...tileRoads.keys(), ...tileAreas.keys(), ...tileTrees.keys(), ...tileSigns.keys(), ...tileHyd.keys()]);
  const sortedKeys = [...allKeys].sort((a, b) => {
    const [atx, atz] = a.split('_').map(Number);
    const [btx, btz] = b.split('_').map(Number);
    return atx - btx || atz - btz;
  });

  let totalBuildingsWritten = 0, totalRoadsWritten = 0;
  const writtenTiles = [];
  for (const key of sortedKeys) {
    const [tx, tz] = key.split('_').map(Number);
    const tile = { v: 2, x: tx, z: tz };
    const b = tileBuildings.get(key);
    if (b && b.length) { tile.buildings = b; totalBuildingsWritten += b.length; }
    const r = tileRoads.get(key);
    if (r && r.length) { tile.roads = r; totalRoadsWritten += r.length; }
    const a = tileAreas.get(key);
    if (a && a.size) {
      const areasObj = {};
      for (const [kind, arr] of a) if (arr.length) areasObj[kind] = arr;
      if (Object.keys(areasObj).length) tile.areas = areasObj;
    }
    const t = tileTrees.get(key);
    if (t && t.length) tile.trees = t;
    const sg = tileSigns.get(key);
    if (sg && sg.length) tile.signs = sg;
    const hy = tileHyd.get(key);
    if (hy && hy.length) tile.hyd = hy;

    if (!tile.buildings && !tile.roads && !tile.areas && !tile.trees && !tile.signs && !tile.hyd) continue; // skip empty

    const file = path.join(TILES_DIR, `${key}.json`);
    fs.writeFileSync(file, JSON.stringify(tile));
    writtenTiles.push(key);
  }

  const indexObj = {
    v: 2,
    tileSize: TILE_SIZE,
    tiles: writtenTiles,
    counts: { buildings: totalBuildingsWritten, roads: totalRoadsWritten, tiles: writtenTiles.length },
  };
  fs.writeFileSync(path.join(TILES_DIR, 'index.json'), JSON.stringify(indexObj));
  console.log(`  wrote ${writtenTiles.length} tile files + index.json`);

  // ---- SKYLINE ------------------------------------------------------------------------------
  console.log('Building skyline...');
  function perpendicularDistance(p, a, b) {
    const [x, z] = p, [x1, z1] = a, [x2, z2] = b;
    const dx = x2 - x1, dz = z2 - z1;
    if (dx === 0 && dz === 0) return Math.hypot(x - x1, z - z1);
    const t = ((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz);
    const projX = x1 + t * dx, projZ = z1 + t * dz;
    return Math.hypot(x - projX, z - projZ);
  }
  function douglasPeucker(points, epsilon) {
    if (points.length < 3) return points.slice();
    let maxDist = 0, index = 0;
    const p0 = points[0], pEnd = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = perpendicularDistance(points[i], p0, pEnd);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > epsilon) {
      const left = douglasPeucker(points.slice(0, index + 1), epsilon);
      const right = douglasPeucker(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [p0, pEnd];
  }
  function distSq(a, b) { const dx = a[0] - b[0], dz = a[1] - b[1]; return dx * dx + dz * dz; }
  function simplifyClosedRing(ring, epsilon) {
    const n = ring.length;
    if (n <= 3) return ring.slice();
    let maxD = -1, ia = 0, ib = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = distSq(ring[i], ring[j]);
        if (d > maxD) { maxD = d; ia = i; ib = j; }
      }
    }
    const chain1 = ring.slice(ia, ib + 1);
    const chain2 = ring.slice(ib).concat(ring.slice(0, ia + 1));
    const s1 = douglasPeucker(chain1, epsilon);
    const s2 = douglasPeucker(chain2, epsilon);
    return s1.slice(0, -1).concat(s2.slice(0, -1));
  }
  function convexHull(points) {
    const pts = [...new Map(points.map((p) => [`${p[0]}_${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  const skylineOut = [];
  for (const b of skylineCandidates) {
    let ring = simplifyClosedRing(b.outer, 1.5);
    if (ring.length > 16) ring = convexHull(b.outer);
    const flat = [];
    for (const [x, z] of ring) flat.push(round1(x), round1(z));
    skylineOut.push({ p: flat, h: round1(b.height), m: round1(b.minHeight || 0), g: round1(terrainAt(b.centroid[0], b.centroid[1])) });
  }
  fs.writeFileSync(path.join(TILES_DIR, 'skyline.json'), JSON.stringify({ b: skylineOut }));
  console.log(`  skyline: ${skylineOut.length} buildings/parts >= 70m`);

  // ---- GROUND ------------------------------------------------------------------------------
  console.log('Building ground mesh...');
  function loadBorough() {
    const file = path.join(CACHE_DIR, 'borough.json');
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && json.type === 'FeatureCollection' && Array.isArray(json.features)) return json;
    } catch { /* missing or invalid */ }
    return null;
  }
  function isManhattanFeature(f) {
    const props = f.properties || {};
    for (const key of Object.keys(props)) {
      if (/boro|borough/i.test(key) && String(props[key]).trim().toLowerCase() === 'manhattan') return true;
    }
    return false;
  }
  function geometryToPolygons(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }
  function geoRingToLocal(ring) {
    const pts = ring.map(([lon, lat]) => lonLatToXZ(lon, lat));
    if (pts.length > 1 && pointsEqual(pts[0], pts[pts.length - 1], 1e-6)) pts.pop();
    return pts;
  }

  let groundTrisRaw = []; // array of [p0,p1,p2], each p = [x,z] world meters
  let groundSource = 'borough';
  const borough = loadBorough();
  let manhattanFeatures = [];
  if (borough) manhattanFeatures = borough.features.filter(isManhattanFeature);

  const outlineRings = [];
  if (borough && manhattanFeatures.length) {
    for (const feature of manhattanFeatures) {
      const polygons = geometryToPolygons(feature.geometry);
      for (const polygon of polygons) {
        if (!polygon.length) continue;
        const outer = geoRingToLocal(polygon[0]);
        if (outer.length < 3) continue;
        // simplified silhouette rings for the minimap
        const simp = simplifyRing(outer, 25);
        if (simp.length >= 3) outlineRings.push(simp.flatMap((pt) => [Math.round(pt[0]), Math.round(pt[1])]));
        const holes = polygon.slice(1).map(geoRingToLocal).filter((r) => r.length >= 3);
        const tris = triangulatePolygon(outer, holes);
        groundTrisRaw.push(...tris);
      }
    }
    fs.writeFileSync(path.join(GEO_DIR, 'outline.json'), JSON.stringify({ v: 1, rings: outlineRings }));
    console.log(`  ground: ${manhattanFeatures.length} Manhattan feature(s) from borough.json -> ${groundTrisRaw.length} source triangles; outline rings: ${outlineRings.length}`);
  } else {
    groundSource = 'fallback-rectangle';
    const corners = [
      lonLatToXZ(BBOX.west, BBOX.south),
      lonLatToXZ(BBOX.east, BBOX.south),
      lonLatToXZ(BBOX.east, BBOX.north),
      lonLatToXZ(BBOX.west, BBOX.north),
    ];
    groundTrisRaw.push(ccwFix(corners[0], corners[1], corners[2]), ccwFix(corners[0], corners[2], corners[3]));
    console.warn('  WARNING: borough.json missing/invalid or no Manhattan feature found — using FALLBACK RECTANGLE for ground.json');
  }

  // The borough-polygon earcut triangulation (and especially the fallback rectangle) can
  // produce huge triangles that can't follow hills. Recursively subdivide by longest-edge
  // midpoint bisection (winding-preserving) until every edge is under the threshold, THEN
  // sample terrain per vertex. Cap total triangle count by falling back to a coarser
  // threshold if 70m produces too many.
  function edgeLen(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function simplifyRing(pts, eps) {
    // iterative Douglas-Peucker on an open copy of the ring
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const [ax, az] = pts[i0], [bx, bz] = pts[i1];
      let maxD = -1, maxI = -1;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      for (let i = i0 + 1; i < i1; i++) {
        const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > eps && maxI > 0) {
        keep[maxI] = true;
        stack.push([i0, maxI], [maxI, i1]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function subdivideAll(triangles, maxEdge) {
    const out = [];
    const stack = triangles.slice();
    while (stack.length) {
      const tri = stack.pop();
      const [A, B, C] = tri;
      const dAB = edgeLen(A, B), dBC = edgeLen(B, C), dCA = edgeLen(C, A);
      const m = Math.max(dAB, dBC, dCA);
      if (m < maxEdge) { out.push(tri); continue; }
      const pts = [A, B, C];
      const ei = m === dAB ? 0 : m === dBC ? 1 : 2; // edge (ei, ei+1), opposite vertex ei+2
      const p0 = pts[ei], p1 = pts[(ei + 1) % 3], opp = pts[(ei + 2) % 3];
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      stack.push([p0, mid, opp], [mid, p1, opp]); // preserves winding of the original triangle
    }
    return out;
  }
  const GROUND_TRI_CAP = 400000;
  let groundLeafTris = subdivideAll(groundTrisRaw, 70);
  let groundSubdivThreshold = 70;
  if (groundLeafTris.length > GROUND_TRI_CAP) {
    groundSubdivThreshold = 100;
    groundLeafTris = subdivideAll(groundTrisRaw, 100);
    console.log(`  ground: 70m subdivision exceeded ${GROUND_TRI_CAP} triangles -> retried at 100m -> ${groundLeafTris.length} triangles`);
  }
  console.log(`  ground: subdivided to <${groundSubdivThreshold}m edges -> ${groundLeafTris.length} triangles, sampling elevation per vertex...`);

  const groundTris = new Array(groundLeafTris.length * 9);
  for (let i = 0; i < groundLeafTris.length; i++) {
    const [p0, p1, p2] = groundLeafTris[i];
    let o = i * 9;
    for (const p of [p0, p1, p2]) {
      groundTris[o++] = round1(p[0]);
      groundTris[o++] = round1(p[1]);
      groundTris[o++] = round1(terrainAt(p[0], p[1]));
    }
  }
  // Ground is ~1M vertices. As JSON that is ~19MB and costs a multi-hundred-ms
  // JSON.parse on the main thread before anything can render. Every coordinate
  // is round1'd above, so integer decimeters are EXACTLY lossless. Only ~16% of
  // the vertices are unique, so weld them into an index buffer, delta-code the
  // indices (they climb monotonically through spatially-sorted triangles, so
  // the deltas are tiny and gzip flattens them), and ship binary: ~5.7MB raw,
  // ~1.9MB gzipped, zero parse. The loader re-expands to the identical
  // non-indexed vertex order, so the mesh and its flat shading are unchanged.
  function encodeGroundBin(tris) {
    const n = tris.length / 3; // vertex count
    const map = new Map();
    const vx = [], vz = [], vy = [];
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.round(tris[i * 3] * 10);
      const z = Math.round(tris[i * 3 + 1] * 10);
      const y = Math.round(tris[i * 3 + 2] * 10);
      const key = `${x},${z},${y}`;
      let j = map.get(key);
      if (j === undefined) { j = vx.length; map.set(key, j); vx.push(x); vz.push(z); vy.push(y); }
      idx[i] = j;
    }
    const V = vx.length;
    const HEADER = 16;
    const idxOff = (HEADER + V * 10 + 3) & ~3; // 4-byte align the index stream
    const buf = Buffer.alloc(idxOff + n * 4);
    buf.writeUInt32LE(0x4743594e, 0); // 'NYCG'
    buf.writeUInt32LE(3, 4);          // format version
    buf.writeUInt32LE(V, 8);          // unique vertices
    buf.writeUInt32LE(n, 12);         // emitted vertices (= index count)
    let o = HEADER;
    for (let i = 0; i < V; i++) { buf.writeInt32LE(vx[i], o); o += 4; }
    for (let i = 0; i < V; i++) { buf.writeInt32LE(vz[i], o); o += 4; }
    for (let i = 0; i < V; i++) { buf.writeInt16LE(vy[i], o); o += 2; }
    o = idxOff;
    let prev = 0;
    for (let i = 0; i < n; i++) { buf.writeInt32LE(idx[i] - prev, o); prev = idx[i]; o += 4; }
    return { buf, unique: V, emitted: n };
  }
  const groundBin = encodeGroundBin(groundTris);
  fs.writeFileSync(path.join(GEO_DIR, 'ground.bin'), groundBin.buf);
  // drop the superseded JSON so a stale 19MB copy can't be served
  try { fs.unlinkSync(path.join(GEO_DIR, 'ground.json')); } catch { /* already absent */ }
  console.log(
    `  ground.bin: ${groundBin.emitted.toLocaleString()} verts -> ${groundBin.unique.toLocaleString()} unique ` +
      `(${(groundBin.buf.length / 1e6).toFixed(2)}MB binary)`
  );

  // ---- VALIDATION --------------------------------------------------------------------------
  console.log('\n=== VALIDATION ===');
  const results = [];

  const tileCountOk = writtenTiles.length >= 400 && writtenTiles.length <= 2000;
  results.push(`tiles written: ${writtenTiles.length} (expect 400-2000) -> ${tileCountOk ? 'PASS' : 'FAIL'}`);

  const buildingsOk = totalBuildingsWritten >= 25000 && totalBuildingsWritten <= 90000;
  results.push(`total buildings: ${totalBuildingsWritten} (expect 25000-90000) -> ${buildingsOk ? 'PASS' : 'FAIL'}`);

  const esbXZ = lonLatToXZ(-73.9857, 40.7484);
  const [esbTx, esbTz] = tileOf(esbXZ);
  const esbKey = tileKeyOf(esbTx, esbTz);
  const esbBuildings = tileBuildings.get(esbKey) || [];
  const esbTall = esbBuildings.some((b) => b.h >= 300);
  results.push(`Empire State Building tile (${esbKey}): ${esbBuildings.length} buildings, tallest h=${Math.max(0, ...esbBuildings.map((b) => b.h))} -> ${esbTall ? 'PASS' : 'FAIL'}`);

  const timesSquareRoads = tileRoads.get('0_0') || [];
  const tsOk = timesSquareRoads.length > 0;
  results.push(`Tile 0_0 (Times Square): ${timesSquareRoads.length} road pieces -> ${tsOk ? 'PASS' : 'FAIL'}`);

  const cpXZ = lonLatToXZ(-73.9665, 40.781);
  const [cpTx, cpTz] = tileOf(cpXZ);
  const cpKey = tileKeyOf(cpTx, cpTz);
  const cpAreas = tileAreas.get(cpKey);
  const cpHasParkOrGrass = !!(cpAreas && (cpAreas.get('park')?.length || cpAreas.get('grass')?.length));
  const cpTreeList = tileTrees.get(cpKey) || [];
  const cpTreeCountVal = cpTreeList.length / 3;
  const cpHasTrees = cpTreeCountVal > 200;
  const cpWater = cpAreas && cpAreas.get('water');
  let cpWaterFlat = null;
  if (cpWater && cpWater.length >= 3) {
    const levels = new Set();
    for (let i = 2; i < cpWater.length; i += 3) levels.add(cpWater[i]);
    cpWaterFlat = levels.size === 1;
  }
  results.push(
    `Central Park tile (${cpKey}): park/grass tris=${cpHasParkOrGrass}, water flat=${cpWaterFlat}, trees=${cpTreeCountVal} (expect >200) -> ${
      cpHasParkOrGrass && cpHasTrees ? 'PASS' : 'FAIL'
    }`
  );

  const whXZ = lonLatToXZ(-73.938, 40.852);
  const [whTx, whTz] = tileOf(whXZ);
  const whKey = tileKeyOf(whTx, whTz);
  const whBuildings = tileBuildings.get(whKey) || [];
  const whMaxB = Math.max(0, ...whBuildings.map((b) => b.b));
  results.push(`Washington Heights tile (${whKey}): ${whBuildings.length} buildings, max ground b=${whMaxB} (expect >15) -> ${whMaxB > 15 ? 'PASS' : 'FAIL'}`);

  let bridgeSample = null; // prefer a piece with a visible interior point (arch demo)
  let anyBridge = null;
  for (const [key, list] of tileRoads) {
    for (const r of list) {
      if (r.b !== 1 || !r.e) continue;
      if (!anyBridge) anyBridge = { key, e: r.e };
      if (r.e.length >= 3) { bridgeSample = { key, e: r.e }; break; }
    }
    if (bridgeSample) break;
  }
  const sample = bridgeSample || anyBridge;
  let bridgeArched = false;
  if (bridgeSample) {
    const e = bridgeSample.e;
    const maxMid = Math.max(...e.slice(1, -1));
    bridgeArched = maxMid > e[0] && maxMid > e[e.length - 1];
  }
  results.push(
    `Bridge tile sample: ${sample ? `${sample.key} e=[${sample.e.join(',')}]` : 'none found'} -> ${
      sample ? (bridgeSample ? (bridgeArched ? 'PASS' : 'FAIL') : 'SKIP (only 2-pt bridge pieces found, no interior point to arch)') : 'SKIP (no bridge found)'
    }`
  );

  let groundYMin = Infinity, groundYMax = -Infinity;
  for (let i = 2; i < groundTris.length; i += 3) {
    if (groundTris[i] < groundYMin) groundYMin = groundTris[i];
    if (groundTris[i] > groundYMax) groundYMax = groundTris[i];
  }
  const groundRange = groundYMax - groundYMin;
  results.push(`ground.json y range: ${groundYMin.toFixed(1)}-${groundYMax.toFixed(1)}m (span ${groundRange.toFixed(1)}m, expect >40m) -> ${groundRange > 40 ? 'PASS' : 'FAIL'}`);

  let totalTilesDirBytes = 0;
  for (const f of fs.readdirSync(TILES_DIR)) {
    totalTilesDirBytes += fs.statSync(path.join(TILES_DIR, f)).size;
  }
  const sizeMb = totalTilesDirBytes / (1024 * 1024);
  const sizeOk = sizeMb < 160;
  results.push(`public/tiles total size: ${sizeMb.toFixed(1)}MB (expect <160MB) -> ${sizeOk ? 'PASS' : 'FAIL'}`);

  for (const line of results) console.log(line);

  // 15-line excerpt of a midtown tile (Empire State Building tile)
  console.log(`\n=== EXCERPT: ${esbKey}.json (midtown) ===`);
  const excerptFile = path.join(TILES_DIR, `${esbKey}.json`);
  if (fs.existsSync(excerptFile)) {
    const pretty = JSON.stringify(JSON.parse(fs.readFileSync(excerptFile, 'utf8')), null, 1);
    console.log(pretty.split('\n').slice(0, 15).join('\n'));
  } else {
    console.log('(tile file not found)');
  }

  // ---- FINAL SUMMARY ------------------------------------------------------------------------
  console.log('\n=== SUMMARY ===');
  console.log(`tiles: ${writtenTiles.length}`);
  console.log(`buildings: ${totalBuildingsWritten} (${suppressedCount} suppressed plain buildings)`);
  console.log(`roads: ${roadWayCount} ways -> ${totalRoadsWritten} pieces`);
  console.log(`area polygons: ${areaPolyCount} -> ${areaTriCount} triangles (${waterDropped} large water bodies dropped)`);
  console.log(`trees: ${treeCount} real OSM nodes (${treeTilesSampled} tiles capped at 800) + ${vegResult.proceduralRawAfter} procedural -> ${vegResult.grandTotal} combined (${vegResult.tilesCappedAt1400} tiles capped at 1400)`);
  console.log(`skyline buildings (h>=70m): ${skylineOut.length}`);
  console.log(`ground source: ${groundSource}, ${groundTris.length / 9} triangles (subdivided to <${groundSubdivThreshold}m edges)`);
  console.log(`public/tiles size: ${sizeMb.toFixed(1)}MB`);
  console.log(`missing cache chunk files: ${missingChunks.length}`);
  console.log('DONE');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
