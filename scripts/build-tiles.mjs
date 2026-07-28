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

    // Drop below-grade footprints. OSM maps big subway-station complexes as
    // `building=train_station` polygons that trace the mezzanine UNDER the
    // streets (59th St–Columbus Circle, Penn Station, Herald Sq, Fulton St…).
    // Rendered as above-ground massing they become flat slabs bleeding across
    // whole avenues (the "shops bleeding into 8th Ave" at Columbus Circle). The
    // app already builds all 153 stations procedurally, so anything underground
    // is dropped here; real station terminals that sit above grade (Grand
    // Central h=45.8, the Oculus h=47, Fulton Center) carry no location=under-
    // ground / negative layer and are kept.
    const layerNum = parseFloat(tags.layer);
    if (tags.location === 'underground' || (buildingVal === 'train_station' && layerNum < 0)) continue;

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

  // ---- coincident-wall cleanup (z-fighting) --------------------------------
  // OSM maps a stepped tower or a podium-plus-towers complex as a pile of
  // building:part shells, and almost never tags min_height on them. Every part
  // therefore extrudes from y=0 through all the others, and wherever two of
  // them trace the SAME street frontage (they share OSM nodes) their walls are
  // exactly coplanar, so the depth buffer cannot order them: the facade
  // flickers and shows patches of the neighbouring part's palette colour.
  //
  // Two passes fix it by removing only geometry that is buried anyway:
  //   (1) give each untagged nested tier a real base, so a stepped tower
  //       renders as true stacked segments instead of nested full-height boxes;
  //   (2) drop a building whose own volume is already filled by TALLER
  //       neighbours overlapping its height band (a low podium tiled by the
  //       towers rising through it).
  // Silhouettes are unchanged; only invisible, fighting geometry goes away.
  //
  // NOT attempted here: two partially-overlapping outlines that each stick out
  // of the other. Nudging one inward was tried and reverted -- in a cluster
  // every member has a taller neighbour, so they all shift together and the
  // shared wall stays coincident, and it moved 542 real footprints for no
  // measurable gain. Note that abutting party walls (endemic in Manhattan row
  // blocks) are NOT a problem: their faces have opposite normals, so backface
  // culling always hides one.

  // (1) setback tiers: base = height of the tallest SHORTER part containing it
  let basedParts = 0;
  for (const p of buildingElements) {
    if (!p.isPart || p.minHeight > 0) continue; // never clobber an authored min_height
    const [tx, tz] = tileOf(p.centroid);
    let base = 0;
    for (const key of neighborKeys(tx, tz)) {
      const candidates = partsByTile.get(key);
      if (!candidates) continue;
      for (const q of candidates) {
        if (q === p || q.height >= p.height) continue; // only strictly shorter tiers
        if (q.height <= base || q.area < p.area) continue; // a container is at least as big
        if (!pointInPolygon(p.centroid, q.outer)) continue;
        base = q.height;
      }
    }
    if (base > 0) { p.minHeight = base; basedParts++; }
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

  // (2) buildings fully buried inside taller overlapping neighbours.
  // Runs LAST, over the survivors only. Order matters: a stepped tower often
  // has BOTH a full-height plain outline and its setback parts, and the plain
  // outline covers every tier. Run before the plain-vs-parts suppression below
  // and the outline eats all the setbacks, flattening the tower into a box
  // (measured: 834 buildings lost off the skyline). The suppression drops the
  // outline first; burial then only removes what is genuinely enclosed.
  // This runs over EVERY building, not just building:part. The Rockefeller
  // podium case ("One Rockefeller Plaza", 18m, brick) is a plain `building`
  // way tiled by three plain 138-149m glass towers that also rise from y=0,
  // so neither the part rule above nor the plain-vs-parts suppression below
  // sees it — yet its street wall is coplanar with theirs and fights.
  //
  // Coverage is grid-sampled rather than summed from candidate areas: summing
  // double-counts where candidates overlap each other, which would delete a
  // stepped tower's own ground-level base (its eight tiers each cover most of
  // it). Sampling measures the true union and cannot over-count.
  const bboxOf = (ring) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    return [x0, z0, x1, z1];
  };
  // precompute bbox + tile bin once; the bbox reject below is what keeps this
  // affordable, since almost every building has no overlapping taller neighbour
  const bbAll = new Array(keptBuildings.length);
  const allByTile = new Map();
  keptBuildings.forEach((b, i) => {
    b._idx = i;
    bbAll[i] = bboxOf(b.outer);
    const [tx, tz] = tileOf(b.centroid);
    const key = tileKeyOf(tx, tz);
    if (!allByTile.has(key)) allByTile.set(key, []);
    allByTile.get(key).push(b);
  });
  const buried = new Set();
  let droppedParts = 0;
  for (const p of keptBuildings) {
    const pb = bbAll[p._idx];
    const [tx, tz] = tileOf(p.centroid);
    const cands = [];
    for (const key of neighborKeys(tx, tz)) {
      const list = allByTile.get(key);
      if (!list) continue;
      for (const q of list) {
        if (q === p || buried.has(q)) continue;
        // strictly taller, or an exact-height twin resolved by index so a
        // duplicated footprint drops one copy instead of fighting forever
        if (q.height < p.height) continue;
        if (q.height === p.height && q._idx > p._idx) continue;
        if (q.minHeight >= p.height || q.height <= p.minHeight) continue; // bands must overlap
        const qb = bbAll[q._idx];
        if (qb[2] < pb[0] || qb[0] > pb[2] || qb[3] < pb[1] || qb[1] > pb[3]) continue; // bbox reject
        cands.push({ q, bb: qb });
      }
    }
    if (!cands.length) continue;
    const N = 10;
    let inside = 0, covered = 0;
    for (let i = 0; i < N; i++) {
      const x = pb[0] + ((i + 0.5) / N) * (pb[2] - pb[0]);
      for (let j = 0; j < N; j++) {
        const z = pb[1] + ((j + 0.5) / N) * (pb[3] - pb[1]);
        if (!pointInPolygon([x, z], p.outer)) continue;
        inside++;
        for (const { q, bb } of cands) {
          if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
          if (pointInPolygon([x, z], q.outer)) { covered++; break; }
        }
      }
    }
    if (inside >= 12 && covered / inside > 0.9) { buried.add(p); droppedParts++; }
  }

  for (let i = keptBuildings.length - 1; i >= 0; i--) {
    if (buried.has(keptBuildings[i])) keptBuildings.splice(i, 1);
  }

  console.log(
    `  buildings: ${wayCount} ways, ${relCount} relations, ${skippedDegenerate} degenerate skipped, ` +
      `${suppressedCount} plain buildings suppressed by parts, ${keptBuildings.length} kept polygons`
  );
  console.log(`  z-fight cleanup: ${basedParts} setback tiers based, ${droppedParts} buried buildings dropped`);


  // Building-attached landmarks (crowns, the Hearst diagrid tower...) must sit
  // on the REAL massing, not at a hand-typed coordinate: measure each host
  // building's oriented footprint and heights into public/geo/landmarks-fit.json,
  // which LandmarkManager feeds to the builders. `clearAboveMin` additionally
  // drops the parts our build replaces (e.g. Hearst's tower above its 1928
  // base) while keeping the rest of the building.
  const LANDMARK_FIT = [
    // Replace One WTC as one coherent premium landmark. OSM maps the faceted
    // body as five overlapping 417m prisms plus a separate 541m antenna, while
    // the old hand anchor sat ~59m southwest and added a second floating mast.
    // Measure only this >400m site cluster, then clear all of it after the fit;
    // the always-on landmark build supplies both the near tower and skyline.
    { id: 'one-wtc', lat: 40.7130, lon: -74.01319, r: 70, minH: 400, clearAboveH: 400 },
    // r 55 (was 45): NOTE the "~150m parts at 45.2m" that motivated the bump
    // were actually The Sheffield 57's towers next door — site grouping now
    // excludes them from the measure AND from the clear (the r only bounds the
    // candidate search; ownership decides what belongs to Hearst).
    { id: 'hearst-tower', lat: 40.7666, lon: -73.9836, r: 55, clearAboveH: 5 },
    { id: 'chrysler', lat: 40.7516, lon: -73.9755, r: 45, clearAboveMin: 184, clearAboveH: 270 },
    { id: 'empire-state', lat: 40.7484, lon: -73.9857, r: 40, clearAboveMin: 325 },
    // One Bryant Park is mapped as one 366m containing outline plus numerous
    // ground-up/pyramidal parts between 12m and 366m. The architectural roof is
    // actually 288m and the remaining height is a ~78m spire, so every opaque
    // source part must go. Ownership grouping isolates the complete two-acre
    // site without touching adjacent 4 Times Square.
    {
      id: 'one-bryant', lat: 40.7555573, lon: -73.9847166, r: 85,
      clearAll: true,
    },
    // Full coherent replacement for Foster + Partners' completed tower. The
    // source maps one full-block outline plus nine contiguous stepped bands;
    // their 130/250/330/382/423m tops accurately describe the fan silhouette,
    // but emitting every part from ground produces an opaque bronze truss
    // stack. Measure the ownership group, then let the premium builder recreate
    // the lifted base, glass envelope and correctly limited east/west bracing.
    { id: 'chase-hq', lat: 40.755980, lon: -73.975987, r: 60, clearAll: true },
    // Central Park Tower is currently ten overlapping generic prisms,
    // including its 8.5m eastern cantilever and 472m architectural cap. Measure
    // the complete 217 W 57th ownership group and replace it coherently so the
    // Nordstrom podium, slender shaft and stainless pinstripe skin read as one
    // landmark instead of stacked anonymous boxes.
    {
      id: 'central-park-tower', lat: 40.766410, lon: -73.980772, r: 62,
      clearAll: true, clearAdjacentAboveH: 200, clearAdjacentWithin: 30,
    },
    // 111 West 57th's current source is thirteen ground-up rectangles stacked
    // at every feathered setback, plus its containing development outline and
    // south lobby volume. Measure and clear that exact ownership group so the
    // premium tower can express one coherent terracotta profile without
    // hidden full-height slabs multiplying its silhouette and collision.
    {
      id: 'steinway-tower', lat: 40.764998, lon: -73.977437, r: 40,
      clearAll: true,
    },
    // Viñoly's 432 Park Avenue tower is one unusually clean 425.5m source
    // part: measure only that square shaft so the adjacent low retail/office
    // volumes retain their real footprints. The premium build replaces the
    // shaft while exposing its five double-height windbreak floors instead of
    // leaving the source's solid generic extrusion behind it.
    {
      id: '432-park', lat: 40.7615943, lon: -73.9718353, r: 22,
      minH: 400, clearAboveH: 400,
    },
    // Full coherent replacement. The source maps the KPF tower as more than 20
    // overlapping full-height prisms: accurate in aggregate, but flat generic
    // boxes in the renderer, plus a 77m solid pyramid where the staggered glass
    // crown and slender spire should be. Site grouping safely isolates every
    // part owned by the named One Vanderbilt outline from Grand Central and
    // neighbouring towers, then clearAll removes only that ownership group.
    { id: 'one-vanderbilt', lat: 40.7529, lon: -73.9787, r: 58, clearAll: true },
    // Measure only the accurately centered 120m-above tower stack, then clear
    // its eleven overlapping 170–238m generic parts. The mapped 30-storey/120m
    // base stays; one coherent premium build now supplies the progressively
    // smaller Gothic tower, copper crown and 241m spire above that shoulder.
    { id: 'woolworth', lat: 40.7124, lon: -74.0083, r: 40, minH: 150, clearAboveH: 170 },
    // The registry point historically marked the Chambers Street triumphal
    // arch, about 50m southwest of the actual central tower. Measure the tower
    // at its own source-part center and clear only its 123–183m wedding-cake
    // stack; the accurate 107m C-plan block and 113m wing pavilions remain.
    {
      id: 'municipal-building', lat: 40.712960, lon: -74.003620, r: 55,
      minH: 123, clearAboveH: 123,
    },
    // Rebuild the New York Life Building's upper tower from the 115m setback.
    // OSM's 148m shaft, four corner turrets and 187.5m pyramidal roof are
    // otherwise emitted as flat generic prisms, including a solid gold block
    // where the landmark's signature six-story gilded crown should be.
    { id: 'new-york-life', lat: 40.742735, lon: -73.985608, r: 48, minH: 100, clearAboveH: 148 },
    // OSM's named outer Met Life tower is a 150m flat-roofed prism, while its
    // nested parts reach the documented height but remain generic extrusions.
    // Replace only those tower parts; the historic home-office complex stays.
    { id: 'met-life-tower', lat: 40.741239, lon: -73.987305, r: 24, minH: 145, clearAboveH: 145 },
    // minH: obb only over the tall slab — low wings shifted the center 34m off
    // the shaft and the summit crown hung off the roof edge
    { id: 'top-of-the-rock', lat: 40.7591, lon: -73.9794, r: 40, minH: 120 },
    // (flatiron was dropped from the fit list: a triangle's longest-edge obb
    // rotated and offset the cornice trim — it uses a measured registry rot now)
    { id: 'msg', lat: 40.7505, lon: -73.9934, r: 80 },
    // 30 Hudson Yards is now mapped as eight overlapping 130–395m ground-up
    // prisms, including three coincident 395m crown pieces and a separate Edge
    // slab. Their aggregate OBB is accurate, but generic extrusion makes KPF's
    // crystalline taper into an opaque stack. Replace the complete ownership
    // group while preserving adjacent 50 Hudson Yards.
    {
      id: 'edge-deck', lat: 40.753949, lon: -74.000555, r: 60,
      clearAll: true, fitRot: 2.638,
    },
  ].map((e) => { const [x, z] = lonLatToXZ(e.lon, e.lat); return { ...e, x, z }; });

  console.log('Measuring landmark host buildings...');
  const fitOut = {};
  const fitCleared = new Set(); // building object refs to drop
  for (const lf of LANDMARK_FIT) {
    const rawCands = keptBuildings.filter((b) => {
      if (lf.minH !== undefined && b.height < lf.minH) return false; // obb of the tall shaft only
      const dx = b.centroid[0] - lf.x, dz = b.centroid[1] - lf.z;
      return dx * dx + dz * dz < lf.r * lf.r;
    });
    if (!rawCands.length) { console.warn(`  fit ${lf.id}: NO building found at anchor`); continue; }

    // ---- SITE GROUPING: measure only the HOST building's massing -------------
    // A radius alone can't separate abutting Manhattan lots: Hearst's r=55
    // circle also caught The Sheffield 57 next door (incl. its 146m/154m tower
    // parts), inflating the obb from the true ~60x49m site to 103x67 — the
    // bespoke base built from those numbers paved over the sidewalk, and the
    // clear erased the Sheffield itself. Ownership fixes this: a building:part
    // belongs to the plain-building OUTLINE that contains its centroid (using
    // pre-suppression outlines, since part-covered outlines are dropped from
    // keptBuildings), and the site is the ownership group at the anchor point.
    // Parts with no containing outline are orphans (Hearst is mapped as parts
    // only) and group together. Falls back to the un-grouped candidate set if
    // grouping ever leaves the site empty.
    const outlineR2 = (lf.r + 80) * (lf.r + 80);
    const outlines = buildingElements.filter((b) => {
      if (b.isPart) return false;
      const dx = b.centroid[0] - lf.x, dz = b.centroid[1] - lf.z;
      return dx * dx + dz * dz < outlineR2;
    });
    const ownerOf = (b) => {
      if (!b.isPart) return b; // a plain building owns itself
      for (const o of outlines) if (pointInPolygon(b.centroid, o.outer)) return o;
      return null; // orphan part (no containing outline)
    };
    let seedOwner;
    let seeded = false;
    for (const o of outlines) {
      if (pointInPolygon([lf.x, lf.z], o.outer)) { seedOwner = o; seeded = true; break; }
    }
    if (!seeded) {
      for (const b of rawCands) {
        if (b.isPart && pointInPolygon([lf.x, lf.z], b.outer)) { seedOwner = ownerOf(b); seeded = true; break; }
      }
    }
    if (!seeded) {
      let best = null, bestD = Infinity;
      for (const b of rawCands) {
        const dx = b.centroid[0] - lf.x, dz = b.centroid[1] - lf.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; best = b; }
      }
      seedOwner = best ? ownerOf(best) : undefined;
    }
    const siteCands = rawCands.filter((b) => ownerOf(b) === seedOwner);
    const cands = siteCands.length ? siteCands : rawCands;
    if (cands.length !== rawCands.length) {
      console.log(`  fit ${lf.id}: site grouping excluded ${rawCands.length - cands.length}/${rawCands.length} foreign parts`);
    }
    // Central Park Tower's east shaft/cantilever pieces are mapped as separate
    // building:parts whose centroids fall outside the containing podium outline,
    // so strict ownership (correctly) classifies four of them as adjacent.
    // Require BOTH a landmark-specific height and a tight centroid radius:
    // this claims those 237–433m pieces without deleting the 259–290m parts of
    // 220 Central Park South whose centroids also fall inside the broad fit
    // radius.
    const adjacentRadius = lf.clearAdjacentWithin ?? Infinity;
    const adjacentCleared = lf.clearAdjacentAboveH === undefined
      ? []
      : rawCands.filter((b) =>
        !cands.includes(b)
        && b.height >= lf.clearAdjacentAboveH
        && Math.hypot(b.centroid[0] - lf.x, b.centroid[1] - lf.z) <= adjacentRadius
      );
    // dominant orientation: longest edge of the largest footprint
    // A broad low podium can have a different longest edge from its tower. A
    // landmark may nominate either the tall shaft as the orientation authority
    // or a surveyed rotation while still measuring/clearing the complete
    // ownership group (30 Hudson Yards' rail-platform base is the motivating
    // case: its tall source parts are nearly square and numerically unstable).
    const orientCands = lf.orientAboveH === undefined
      ? cands
      : cands.filter((b) => b.height >= lf.orientAboveH);
    const largest = (orientCands.length ? orientCands : cands)
      .reduce((a, b) => (b.area > a.area ? b : a));
    let ex = lf.fitRot === undefined ? 1 : Math.cos(lf.fitRot);
    let ez = lf.fitRot === undefined ? 0 : -Math.sin(lf.fitRot);
    if (lf.fitRot === undefined) {
      let bestLen = 0;
      const ring = largest.outer;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = dx * dx + dz * dz;
        if (len > bestLen) { bestLen = len; const l = Math.sqrt(len); ex = dx / l; ez = dz / l; }
      }
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
    const isTall = (b) => lf.clearAll
      || (lf.clearAboveMin !== undefined && (b.minHeight ?? 0) >= lf.clearAboveMin)
      || (lf.clearAboveH !== undefined && b.height >= lf.clearAboveH);
    const clearedOnSite = lf.clearAll || lf.clearAboveMin !== undefined || lf.clearAboveH !== undefined
      ? cands.filter(isTall)
      : [];
    const cleared = clearedOnSite.concat(adjacentCleared);
    for (const b of cleared) fitCleared.add(b);
    const kept = cands.filter((b) => !clearedOnSite.includes(b));
    // A full replacement intentionally leaves no host massing. Report keptH=0
    // so builders and validation cannot mistake the measured source roof for a
    // surviving slab.
    const keptM = kept.length ? measure(kept) : { ...all, roof: 0 };
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
      parts: cands.length + adjacentCleared.length,
      clearedParts: cleared.length,
    };
    console.log(`  fit ${lf.id}: ${fitOut[lf.id].parts} parts, obb ${fitOut[lf.id].w}x${fitOut[lf.id].d}m rot ${fitOut[lf.id].rot}, roof ${fitOut[lf.id].roofH}m, kept ${fitOut[lf.id].keptH}m, cleared ${cleared.length}`);
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
    // st-patricks was ONE r=62 circle anchored near the Madison end — it erased
    // seven neighbours ACROSS Madison Av + E 51st (460/488 Madison incl. the
    // Look Building, 5/7/11 E 51st) that the bespoke cathedral never replaces.
    // Two block-shaped circles cover exactly the cathedral's own block: the
    // nave + Lady-chapel end, and the small Madison/50th rectory corner.
    ['st-patricks', 40.758495, -73.976191, 42], ['st-patricks-rectory', 40.758063, -73.975696, 14],
    // OSM also maps the twin 100.5m front spires as their own parts at the 5th
    // Av corners — outside both circles above, they survived as free-standing
    // slivers DUPLICATING the replica's spires
    ['st-patricks-spires', 40.758720, -73.976689, 16],
    ['guggenheim', 40.783, -73.959, 40],
    // AMNH is one huge flat 46m OSM slab (267x237m) — clearing its centroid drops
    // the whole single building so the bespoke Roosevelt-Memorial/Rose-Center
    // build stands alone. r=30 catches only that centroid; Hayden House (190m NE)
    // and everything across CPW/Columbus survive.
    ['amnh', 40.780962, -73.974258, 30],
    // The mapped 30m 432 Park podium wraps around the square tower and would
    // otherwise swallow the premium lobby/plaza. Its centroid is 29m from the
    // tall shaft; a 7m clear is surgical, while the development's separate
    // 20.5m and 28.3m East 57th Street retail/office volumes remain intact.
    ['432-park-podium', 40.7617805, -73.9719587, 7],
    // The modern 111 W 57th source group and the landmarked 1925 Steinway Hall
    // are separate OSM ownership outlines but physically form one development.
    // A tight centroid clear removes only the 67m hall that the premium builder
    // recreates; Windsor Park and every neighboring 57th/58th Street building
    // are more than 25m from this centroid.
    ['steinway-hall', 40.7649461, -73.9775890, 8],
    // Times Square's bowtie is our billboard-stack canyon; drop the generic
    // brick OSM massing in the core so the spectaculars stand free instead of
    // spearing through buildings (the district's real towers beyond r remain).
    ['times-square', 40.758, -73.9855, 55],
    // recentered on the measured OSM centroids: the old circles sat 50-90m off
    // and left the real 156m Secretariat slab + GA hall standing through the build
    ['un-secretariat', 40.7489, -73.9681, 60], ['un-ga', 40.7501, -73.9677, 50],
    // The Flatiron is duplicated in OSM as an 86m detailed outline plus an
    // overlapping 88m part. A tight 14m centroid circle removes only those two
    // volumes (the nearest unrelated building centroid is more than 27m away).
    ['flatiron', 40.74107, -73.98964, 14],
    ['dakota', 40.7765, -73.9761, 50], ['carnegie-hall', 40.7651, -73.9799, 35],
    ['whitney', 40.7397, -74.0089, 35], ['vessel', 40.7538, -74.0022, 40],
    ['little-island', 40.742, -74.01, 70], ['belvedere', 40.7794, -73.9692, 28],
    ['grants-tomb', 40.8134, -73.963, 32], ['riverside-church', 40.8119, -73.9633, 42],
    ['columbia-low', 40.8081, -73.9619, 42], ['st-john-divine', 40.8038, -73.9619, 55],
    ['cloisters', 40.8649, -73.9317, 55], ['hamilton-grange', 40.8214, -73.9469, 18],
    // both aligned to the registry anchors — the old points were 276m / 929m off,
    // clearing innocent blocks while the real sites kept their OSM massing
    ['morris-jumel', 40.8345, -73.9386, 20], ['dyckman-farmhouse', 40.8668, -73.9229, 18],
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

  // ---- GLOBAL VEHICULAR ROAD INDEX ----------------------------------------------------------
  // Street props (signs, hydrants, trees) were placed with only their OWN tile's road
  // pieces in view, so a wide avenue whose centerline sits in a NEIGHBOURING tile went
  // unseen and props baked into its roadbed (70% of signs, 7% of hydrants, 6% of trees).
  // Flatten every vehicular road piece — already in world metres in tileRoadPiecesWorld —
  // into one coarse spatial grid (64m cells) so any prop can query the nearest ribbon
  // island-wide. Half-widths are ROAD_STYLE.w/2 (tileTypes.ts); the class set and 64m cell
  // size match src/engine/World.ejectFromRoads and the road-intrusion audit exactly.
  const VEHICULAR_HALF = {
    motorway: 11, trunk: 10, primary: 8.5, secondary: 7, tertiary: 6,
    unclassified: 5, residential: 5, living_street: 4, service: 2.75,
    motorway_link: 4.5, trunk_link: 4.5, primary_link: 4.5, secondary_link: 4.5, tertiary_link: 4.5,
  };
  const ROAD_CELL = 64;
  const roadGrid = new Map(); // "gx,gz" -> [{ x1, z1, x2, z2, half }]
  const roadCellKey = (gx, gz) => `${gx},${gz}`;
  function addRoadSeg(x1, z1, x2, z2, half) {
    const s = { x1, z1, x2, z2, half };
    const gx0 = Math.floor(Math.min(x1, x2) / ROAD_CELL), gx1 = Math.floor(Math.max(x1, x2) / ROAD_CELL);
    const gz0 = Math.floor(Math.min(z1, z2) / ROAD_CELL), gz1 = Math.floor(Math.max(z1, z2) / ROAD_CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const k = roadCellKey(gx, gz);
      let a = roadGrid.get(k);
      if (!a) { a = []; roadGrid.set(k, a); }
      a.push(s);
    }
  }
  let roadSegCount = 0;
  for (const pieces of tileRoadPiecesWorld.values()) {
    for (const piece of pieces) {
      const half = VEHICULAR_HALF[piece.cls];
      if (half === undefined) continue; // footway/path/crossing/cycleway: not a vehicular roadbed
      const p = piece.pts;
      for (let i = 0; i < p.length - 1; i++) { addRoadSeg(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], half); roadSegCount++; }
    }
  }
  console.log(`  global road index: ${roadSegCount} vehicular segments in ${roadGrid.size} cells`);

  // Deepest vehicular penetration at (px,pz): scans the 3x3 grid neighbourhood and returns
  // the worst (target - dist) over every nearby ribbon plus its outward normal, where
  // target = half + clearance. A positive `worst` means the point sits inside that ribbon
  // (or within `clearance` of its curb) and must move out along (wx,wz).
  function worstRoadPenetration(px, pz, clearance) {
    const gx = Math.floor(px / ROAD_CELL), gz = Math.floor(pz / ROAD_CELL);
    let worst = 0, wx = 0, wz = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const a = roadGrid.get(roadCellKey(gx + dx, gz + dz));
      if (!a) continue;
      for (const s of a) {
        const vx = s.x2 - s.x1, vz = s.z2 - s.z1, l2 = vx * vx + vz * vz;
        if (l2 < 1e-9) continue;
        let t = ((px - s.x1) * vx + (pz - s.z1) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ox = px - (s.x1 + t * vx), oz = pz - (s.z1 + t * vz);
        const pen = (s.half + clearance) - Math.hypot(ox, oz);
        if (pen > worst) { worst = pen; wx = ox; wz = oz; }
      }
    }
    return { worst, wx, wz };
  }
  // Push (x,z) out of every vehicular ribbon onto the sidewalk, `clearance` metres past the
  // curb, by iterating on the deepest-penetrating ribbon (converges to the corner at a
  // two-street intersection). Models src/engine/World.ejectFromRoads but over the GLOBAL
  // index rather than the runtime's per-tile road paths. `maxTravel` caps total displacement
  // (measured from `capOrigin` if given, else the start) so a data glitch can't fling the
  // prop off its corner (Infinity = no cap). 10 iterations converge the zig-zag at a wide
  // two-avenue intersection; a residual penetration means no sidewalk is reachable (a
  // highway interchange) and the caller drops the prop.
  function ejectFromRoads(x, z, clearance, maxTravel = Infinity, capOrigin = null) {
    let px = x, pz = z;
    for (let iter = 0; iter < 10; iter++) {
      const { worst, wx, wz } = worstRoadPenetration(px, pz, clearance);
      if (worst <= 0.02) break;
      const d = Math.hypot(wx, wz);
      if (d > 1e-3) { px += (wx / d) * worst; pz += (wz / d) * worst; }
      else px += worst; // exactly on a centerline: nudge along +x
    }
    if (Number.isFinite(maxTravel)) {
      const cx = capOrigin ? capOrigin[0] : x, cz = capOrigin ? capOrigin[1] : z;
      const tdx = px - cx, tdz = pz - cz, td = Math.hypot(tdx, tdz);
      if (td > maxTravel) { px = cx + (tdx / td) * maxTravel; pz = cz + (tdz / td) * maxTravel; }
    }
    return [px, pz];
  }
  // True when (x,z) sits within (road half-width + margin) of any vehicular centerline — i.e.
  // standing in (or margin-close to) a roadbed. Used to CULL trees rather than move them.
  function inVehicularRoad(x, z, margin) {
    const gx = Math.floor(x / ROAD_CELL), gz = Math.floor(z / ROAD_CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const a = roadGrid.get(roadCellKey(gx + dx, gz + dz));
      if (!a) continue;
      for (const s of a) {
        const vx = s.x2 - s.x1, vz = s.z2 - s.z1, l2 = vx * vx + vz * vz;
        if (l2 < 1e-9) continue;
        let t = ((x - s.x1) * vx + (z - s.z1) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s.x1 + t * vx, qz = s.z1 + t * vz;
        const lim = s.half + margin;
        if ((x - qx) * (x - qx) + (z - qz) * (z - qz) < lim * lim) return true;
      }
    }
    return false;
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
    const px0 = rec.pt[0] + (cx / cl) * dist * s1;
    const pz0 = rec.pt[1] + (cz / cl) * dist * s1;
    // The diagonal bisector offset above under-clears wide avenues (a corner push doesn't
    // leave a roadbed squarely), so ~70% of sign assemblies baked into the street. Eject
    // out of the deepest-penetrating vehicular ribbon using the GLOBAL road index (incl.
    // avenues whose centerline sits in a neighbouring tile) to 1.9m past the curb = the
    // sidewalk; cap total travel to 16m of the intersection node so it stays on its corner.
    const [px, pz] = ejectFromRoads(px0, pz0, 1.9, 16, rec.pt);
    // Still in pavement after ejecting? The node is a highway interchange (stacked parallel
    // motorway/trunk ribbons) with no sidewalk within 16m — a street-name sign there can't
    // reach a corner, so drop it rather than bake it into the roadbed.
    if (inVehicularRoad(px, pz, 0.1)) continue;
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
    let [hx, hz] = lonLatToXZ(el.lon, el.lat);
    // ~7% of OSM hydrant nodes fall in a roadbed. Eject 0.4m past the curb (hydrants sit
    // right at the curb line) via the global road index; already-clear hydrants don't move.
    // Cap travel at 12m; if still in pavement (a highway median with no curb) drop it.
    [hx, hz] = ejectFromRoads(hx, hz, 0.4, 12);
    if (inVehicularRoad(hx, hz, 0.1)) continue;
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
          let hx = x + nx * off * side, hz = z + nz * off * side;
          // Eject out of ANY vehicular roadbed — cross streets at corners, plus avenues
          // whose centerline sits in a neighbouring tile the old per-tile scan missed —
          // to 0.4m past the curb (cap travel 12m). Place it at the curb; if it can't clear
          // the pavement (a highway median) skip it, as the old per-tile reject did.
          [hx, hz] = ejectFromRoads(hx, hz, 0.4, 12);
          if (!inVehicularRoad(hx, hz, 0.1) && !hydGrid.has(gk(hx, hz))) {
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
  const LAKE_AREA = 20000; // m^2 - at/above this a water body is "lake-scale": gets the
  // interior-clearing water level (below) and culls the trees baked inside it. Below it,
  // ponds/fountains keep the plain grade-level rule so they stay flush with the ground.

  const VEGETATION_KINDS = new Set(['wood', 'park', 'grass', 'cemetery']);
  const tileAreas = new Map(); // key -> Map<kind, number[]> (triples x,z,e per vertex; e = absolute decimeters)
  const areaPolysByKind = new Map(); // kind -> array of {outer,holes} world-meter rings (wood/park/grass/cemetery only, for procedural trees)
  for (const k of VEGETATION_KINDS) areaPolysByKind.set(k, []);
  const lakeWaterPolys = []; // { poly:{outer,holes}, bbox } for lake-scale water — trees inside are culled below
  let areaPolyCount = 0, areaTriCount = 0, waterDropped = 0;

  // Highest terrain elevation (m) inside a lake polygon. Samples the subdivided triangle
  // vertices (all interior to the ring+holes) plus a coarse ~12m grid over the bbox
  // (point-in-polygon filtered) so a berm crest falling between subdivided vertices still
  // registers. The reservoir's DEM tops its shoreline mean inside the retaining berm, so
  // this is what the water surface must clear. Lake-scale water only (few polygons, cheap).
  function lakeInteriorMax(poly, tris) {
    let maxE = -Infinity;
    for (const t of tris) for (const p of t) { const e = terrainAt(p[0], p[1]); if (e > maxE) maxE = e; }
    const bbox = polyBBox(poly.outer);
    for (let x = bbox.minX; x <= bbox.maxX; x += 12) {
      for (let z = bbox.minZ; z <= bbox.maxZ; z += 12) {
        if (!pointInPolygonWithHoles([x, z], poly)) continue;
        const e = terrainAt(x, z);
        if (e > maxE) maxE = e;
      }
    }
    return maxE;
  }
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

      areaPolyCount++;
      // Subdivide EVERY area kind (incl. water) so per-vertex elevations follow the terrain
      // instead of a giant flat triangle slicing through hills (which buried most of Central
      // Park's lawns). subdivideAll is hoisted from the ground-mesh section below. Water keeps
      // ONE constant level across all its (now many) vertices so it stays dead flat — and
      // subdividing it is exactly what lets centroid-binning spread a big body across every
      // tile it covers. The reservoir was ~153 giant slivers binned into a handful of tiles,
      // so most covered tiles streamed in with no water triangles (holes) and the runtime
      // per-tile tree cull saw no water to cull against.
      const trisRaw = triangulatePolygon(poly.outer, poly.holes);
      const tris = subdivideAll(trisRaw, 45);

      // Water: flatten every triangle of this polygon to one constant level so ponds/lakes
      // render dead flat instead of following the (noisy, bilinear-sampled) terrain.
      let waterLevelDm = null;
      if (kind === 'water') {
        let sumE = 0;
        for (const v of poly.outer) sumE += terrainAt(v[0], v[1]);
        const shorelineLevel = sumE / poly.outer.length + 0.3; // +0.3 clears DEM noise in the basin
        let level = shorelineLevel;
        if (netArea >= LAKE_AREA) {
          // Lake-scale bodies (reservoir, Central Park lakes): the DEM inside the berm TOPS
          // the shoreline mean — the reservoir samples up to ~1m ABOVE mean-shoreline+0.3, so
          // the old rule left terrain (and the park polygon that covers the reservoir with no
          // hole) poking ABOVE the water plane, showing green through/above the water. Lift the
          // surface to clear the highest interior DEM sample. Small ponds keep the grade rule.
          const interiorMax = lakeInteriorMax(poly, tris);
          level = Math.max(shorelineLevel, interiorMax + 0.25);
          lakeWaterPolys.push({ poly, bbox: polyBBox(poly.outer) });
        }
        waterLevelDm = Math.round(level * 10);
      }

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
  console.log(`  lake-scale water bodies (>= ${LAKE_AREA} m^2): ${lakeWaterPolys.length} (trees inside are culled below)`);

  // True when (x,z) falls inside any lake-scale water body. Mirrors the global road-index
  // cull: bbox prefilter, then point-in-polygon-with-holes (an island in a lake keeps its
  // trees). Trees inside a reservoir/lake would stand in the water — the roads/buildings
  // culls never covered water. The runtime per-tile cull in tileWorker stays as belt-and-
  // braces for small ponds, which aren't collected here.
  function inLakeWater(x, z) {
    for (const { poly, bbox } of lakeWaterPolys) {
      if (x < bbox.minX || x > bbox.maxX || z < bbox.minZ || z > bbox.maxZ) continue;
      if (pointInPolygonWithHoles([x, z], poly)) return true;
    }
    return false;
  }

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

  // A real OSM tree whose node falls inside (or within TREE_ROAD_MARGIN of) a vehicular
  // ribbon is standing in the street (Times Sq medians, plaza edges the road ribbon
  // overruns) and is CULLED, not moved — trees are plentiful. The old cull saw only the
  // tree's OWN tile's road pieces and under-culled by ~6.7k; inVehicularRoad uses the
  // GLOBAL road index (full half-width + margin) so neighbouring-tile avenues count too.
  // Footways/paths/crossings are absent from the index, so trees keep their sidewalks/plazas.
  const TREE_ROAD_MARGIN = 1.2;

  // Bespoke-landmark tree keep-outs. OSM plots street trees straight down
  // Rockefeller's Lower Plaza and Channel Gardens, where they spear the
  // Prometheus fountain and bury the pools — the real plaza has clipped beds,
  // not London planes. Applied to real AND procedural trees at the merge below.
  const TREE_KEEPOUT = [
    ['rockefeller-lower-plaza', 40.758743, -73.978668, 26],
    ['rockefeller-channel-gardens-w', 40.758517, -73.978129, 16],
    ['rockefeller-channel-gardens-e', 40.758418, -73.977800, 20],
  ].map((e) => { const [x, z] = lonLatToXZ(e[2], e[1]); return { id: e[0], x, z, r2: e[3] * e[3] }; });
  const inTreeKeepout = (x, z) => TREE_KEEPOUT.some((k) => {
    const dx = x - k.x, dz = z - k.z;
    return dx * dx + dz * dz < k.r2;
  });

  const realTreesByTile = new Map(); // key -> array of [x,z] world meters, capped at 800 (unchanged from v1)
  let treeTilesSampled = 0;
  let realCulledAtEntrances = 0, realCulledInRoad = 0, realCulledInBuilding = 0, realCulledInWater = 0;
  for (const [key, rawList] of treesByTile) {
    const buildings = tileBuildingFootprints.get(key) || [];
    const list = rawList.filter(([x, z]) => {
      if (nearEntrance(x, z)) { realCulledAtEntrances++; return false; }
      if (inLakeWater(x, z)) { realCulledInWater++; return false; } // no tree standing in a reservoir/lake
      if (inVehicularRoad(x, z, TREE_ROAD_MARGIN)) { realCulledInRoad++; return false; }
      // a tree node inside a building footprint would spear the building
      for (const bpoly of buildings) {
        if (pointInPolygonWithHoles([x, z], bpoly)) { realCulledInBuilding++; return false; }
      }
      return true;
    });
    const sampled = sampleEveryNth(list, 800);
    if (sampled.length < list.length) treeTilesSampled++;
    realTreesByTile.set(key, sampled);
  }
  console.log(`  real OSM trees: ${treeCount} nodes across ${treesByTile.size} tiles (${treeTilesSampled} tiles capped at 800)`);
  if (realCulledAtEntrances) console.log(`  real OSM trees: ${realCulledAtEntrances} culled at subway entrances`);
  if (realCulledInRoad || realCulledInBuilding) console.log(`  real OSM trees: ${realCulledInRoad} culled in roadway, ${realCulledInBuilding} culled inside buildings`);
  if (realCulledInWater) console.log(`  real OSM trees: ${realCulledInWater} culled inside lake-scale water`);

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
        if (inLakeWater(x, z)) continue; // global: no procedural tree standing in a reservoir/lake
        if (pointToPolylinesDist([x, z], roadPolylines) < clearance) continue; // per-tile: keep off footpaths too
        if (inVehicularRoad(x, z, TREE_ROAD_MARGIN)) continue; // global: no procedural tree in a vehicular roadbed
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
      combined = combined.filter(([x, z]) => !inTreeKeepout(x, z));
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

  // Full 8x4 OSM cache coverage now reaches the whole Manhattan bbox and its
  // harbor/bridge fringe. The old 400-2000 / 25k-90k ranges described the
  // earlier partial-cache build and have falsely failed every complete bake.
  const tileCountOk = writtenTiles.length >= 2500 && writtenTiles.length <= 4000;
  results.push(`tiles written: ${writtenTiles.length} (expect 2500-4000 full-cache) -> ${tileCountOk ? 'PASS' : 'FAIL'}`);

  const buildingsOk = totalBuildingsWritten >= 120000 && totalBuildingsWritten <= 200000;
  results.push(`total buildings: ${totalBuildingsWritten} (expect 120000-200000 full-cache) -> ${buildingsOk ? 'PASS' : 'FAIL'}`);

  const esbXZ = lonLatToXZ(-73.9857, 40.7484);
  const [esbTx, esbTz] = tileOf(esbXZ);
  const esbKey = tileKeyOf(esbTx, esbTz);
  const esbBuildings = tileBuildings.get(esbKey) || [];
  const esbTall = esbBuildings.some((b) => b.h >= 300);
  results.push(`Empire State Building tile (${esbKey}): ${esbBuildings.length} buildings, tallest h=${Math.max(0, ...esbBuildings.map((b) => b.h))} -> ${esbTall ? 'PASS' : 'FAIL'}`);

  // One WTC is a complete premium replacement: its six overlapping OSM
  // prisms/antenna must be measured into the fit and absent from both the near
  // tile and skyline, or the old duplicate-mast bug returns.
  const wtcXZ = lonLatToXZ(-74.01319, 40.7130);
  const [wtcTx, wtcTz] = tileOf(wtcXZ);
  const wtcKey = tileKeyOf(wtcTx, wtcTz);
  const wtcBuildings = tileBuildings.get(wtcKey) || [];
  const wtcBakedTall = wtcBuildings.filter((b) => b.h >= 400).length;
  const wtcFit = fitOut['one-wtc'];
  const wtcOk = !!wtcFit
    && Math.hypot(wtcFit.cx - wtcXZ[0], wtcFit.cz - wtcXZ[1]) < 5
    && wtcFit.roofH >= 540
    && wtcFit.clearedParts === 6
    && wtcBakedTall === 0;
  results.push(
    `One WTC replacement (${wtcKey}): fit roof=${wtcFit?.roofH ?? 0}m, cleared=${wtcFit?.clearedParts ?? 0}, ` +
      `baked >=400m parts=${wtcBakedTall} -> ${wtcOk ? 'PASS' : 'FAIL'}`,
  );

  // The Chrysler crown is procedural from the retained 199m shaft shoulder:
  // the raw source's overlapping round-roof prisms must stay cleared, while
  // their measured 282m crown cap remains available to seat the 318.9m build.
  const chryslerXZ = lonLatToXZ(-73.9755, 40.7516);
  const [chryslerTx, chryslerTz] = tileOf(chryslerXZ);
  const chryslerKey = tileKeyOf(chryslerTx, chryslerTz);
  const chryslerBuildings = tileBuildings.get(chryslerKey) || [];
  const chryslerBakedCrown = chryslerBuildings.filter((b) => b.h >= 200).length;
  const chryslerFit = fitOut.chrysler;
  const chryslerOk = !!chryslerFit
    && Math.abs(chryslerFit.roofH - 282) < 1
    && Math.abs(chryslerFit.keptH - 199) < 1
    && chryslerFit.clearedParts === 11
    && chryslerBakedCrown === 0;
  results.push(
    `Chrysler replacement (${chryslerKey}): fit=${chryslerFit?.keptH ?? 0}-${chryslerFit?.roofH ?? 0}m, ` +
      `cleared=${chryslerFit?.clearedParts ?? 0}, baked >=200m parts=${chryslerBakedCrown} -> ${chryslerOk ? 'PASS' : 'FAIL'}`,
  );

  // One Vanderbilt is also a complete procedural replacement. Its source
  // ownership group contains one block outline plus 23 mutually overlapping
  // parts; none may remain in the near tile or skyline behind the premium
  // four-volume build.
  const oneVXZ = lonLatToXZ(-73.9787, 40.7529);
  const [oneVTx, oneVTz] = tileOf(oneVXZ);
  const oneVKey = tileKeyOf(oneVTx, oneVTz);
  const oneVBuildings = tileBuildings.get(oneVKey) || [];
  const oneVBakedTall = oneVBuildings.filter((b) => b.h >= 300).length;
  const oneVFit = fitOut['one-vanderbilt'];
  const oneVOk = !!oneVFit
    && Math.abs(oneVFit.w - 65) < 1
    && Math.abs(oneVFit.d - 61) < 1
    && Math.abs(oneVFit.roofH - 427) < 1
    && oneVFit.keptH === 0
    && oneVFit.clearedParts === 24
    && oneVBakedTall === 0;
  results.push(
    `One Vanderbilt replacement (${oneVKey}): fit=${oneVFit?.w ?? 0}x${oneVFit?.d ?? 0}m, ` +
      `roof=${oneVFit?.roofH ?? 0}m, cleared=${oneVFit?.clearedParts ?? 0}, ` +
      `baked >=300m parts=${oneVBakedTall} -> ${oneVOk ? 'PASS' : 'FAIL'}`,
  );

  // 270 Park is measured from nine mapped stepped bands (the containing
  // full-block outline is correctly suppressed by those building parts), then
  // supplied entirely by the always-on premium build. The near tile and
  // skyline must not retain any of the old full-height bronze prisms.
  const chaseXZ = lonLatToXZ(-73.975987, 40.755980);
  const [chaseTx, chaseTz] = tileOf(chaseXZ);
  const chaseKey = tileKeyOf(chaseTx, chaseTz);
  const chaseBuildings = tileBuildings.get(chaseKey) || [];
  const chaseBakedTall = chaseBuildings.filter((b) => b.h >= 300).length;
  const chaseFit = fitOut['chase-hq'];
  const chaseOk = !!chaseFit
    && Math.abs(chaseFit.w - 57) < 1
    && Math.abs(chaseFit.d - 109) < 1
    && Math.abs(chaseFit.roofH - 423) < 1
    && chaseFit.keptH === 0
    && chaseFit.clearedParts === 9
    && chaseBakedTall === 0;
  results.push(
    `270 Park replacement (${chaseKey}): fit=${chaseFit?.w ?? 0}x${chaseFit?.d ?? 0}m, ` +
      `roof=${chaseFit?.roofH ?? 0}m, cleared=${chaseFit?.clearedParts ?? 0}, ` +
      `baked >=300m parts=${chaseBakedTall} -> ${chaseOk ? 'PASS' : 'FAIL'}`,
  );

  const outputBuildingCentroid = (b, tx, tz) => {
    const outer = b.p?.[0];
    if (!outer?.length) return null;
    let sx = 0, sz = 0;
    for (let i = 0; i < outer.length; i += 2) {
      sx += tx * TILE_SIZE + outer[i] / 10;
      sz += tz * TILE_SIZE + outer[i + 1] / 10;
    }
    const n = outer.length / 2;
    return [sx / n, sz / n];
  };

  // Woolworth's eleven upper source parts used to enclose the custom crown in a
  // 238m generic prism. They must all be measured but absent within the tight
  // tower radius, leaving the exact 120m mapped base for the procedural build.
  const woolXZ = lonLatToXZ(-74.0083, 40.7124);
  const [woolTx, woolTz] = tileOf(woolXZ);
  const woolKey = tileKeyOf(woolTx, woolTz);
  const woolBuildings = tileBuildings.get(woolKey) || [];
  const woolFit = fitOut.woolworth;
  const woolBakedUpper = woolBuildings.filter((b) => {
    if (b.h < 170) return false;
    const center = outputBuildingCentroid(b, woolTx, woolTz);
    return !!center && !!woolFit
      && Math.hypot(center[0] - woolFit.cx, center[1] - woolFit.cz) <= 22;
  }).length;
  const woolOk = !!woolFit
    && Math.abs(woolFit.w - 30) < 1
    && Math.abs(woolFit.d - 30) < 1
    && Math.abs(woolFit.roofH - 238) < 1
    && woolFit.keptH === 0
    && woolFit.clearedParts === 11
    && woolBakedUpper === 0;
  results.push(
    `Woolworth upper replacement (${woolKey}): fit=${woolFit?.w ?? 0}x${woolFit?.d ?? 0}m, ` +
      `roof=${woolFit?.roofH ?? 0}m, cleared=${woolFit?.clearedParts ?? 0}, ` +
      `baked >=170m within 22m=${woolBakedUpper} -> ${woolOk ? 'PASS' : 'FAIL'}`,
  );

  // The Municipal Building's arch and cupola have different centers. The fit
  // must clear only the twelve central 123–177m parts across the adjacent tile
  // boundary while retaining the 107m C-plan block and both 113m pavilions.
  const muniXZ = lonLatToXZ(-74.003620, 40.712960);
  const [muniTx, muniTz] = tileOf(muniXZ);
  const muniFit = fitOut['municipal-building'];
  let muniBakedUpper = 0, muniWingPavilions = 0, muniBaseKept = false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const tx = muniTx + dx, tz = muniTz + dz;
    for (const b of tileBuildings.get(tileKeyOf(tx, tz)) || []) {
      const center = outputBuildingCentroid(b, tx, tz);
      if (!center || !muniFit) continue;
      const d = Math.hypot(center[0] - muniFit.cx, center[1] - muniFit.cz);
      if (b.h >= 123 && d <= 25) muniBakedUpper++;
      if (Math.abs(b.h - 113) < 0.2 && Math.abs((b.m ?? 0) - 107) < 0.2 && d <= 60) {
        muniWingPavilions++;
      }
      if (Math.abs(b.h - 107) < 0.2 && d <= 10) muniBaseKept = true;
    }
  }
  const muniOk = !!muniFit
    && Math.abs(muniFit.w - 29) < 1
    && Math.abs(muniFit.d - 26) < 1
    && Math.abs(muniFit.roofH - 177) < 1
    && muniFit.keptH === 0
    && muniFit.clearedParts === 12
    && muniBakedUpper === 0
    && muniWingPavilions === 2
    && muniBaseKept;
  results.push(
    `Municipal crown replacement (${tileKeyOf(muniTx, muniTz)}): ` +
      `fit=${muniFit?.w ?? 0}x${muniFit?.d ?? 0}m @ ${muniFit?.roofH ?? 0}m, ` +
      `cleared=${muniFit?.clearedParts ?? 0}, upper residuals=${muniBakedUpper}, ` +
      `base=${muniBaseKept}, wing pavilions=${muniWingPavilions} -> ${muniOk ? 'PASS' : 'FAIL'}`,
  );

  // Central Park Tower owns one broad retail podium plus a dense set of
  // overlapping shaft, shoulder, cantilever and cap pieces. The premium
  // always-on build must be the only >=200m object within the tower's tight
  // 30m site radius. 220 Central Park South begins farther north and must stay.
  const cptXZ = lonLatToXZ(-73.980772, 40.766410);
  const [cptTx, cptTz] = tileOf(cptXZ);
  const cptKey = tileKeyOf(cptTx, cptTz);
  const cptBuildings = tileBuildings.get(cptKey) || [];
  const cptBakedTall = cptBuildings.filter((b) => {
    if (b.h < 200) return false;
    const center = outputBuildingCentroid(b, cptTx, cptTz);
    return !!center && Math.hypot(center[0] - cptXZ[0], center[1] - cptXZ[1]) <= 30;
  }).length;
  const cptFit = fitOut['central-park-tower'];
  const cptOk = !!cptFit
    && Math.abs(cptFit.w - 60) < 1
    && Math.abs(cptFit.d - 61) < 1
    && Math.abs(cptFit.roofH - 472) < 1
    && cptFit.keptH === 0
    && cptFit.parts === 13
    && cptFit.clearedParts === 13
    && cptBakedTall === 0;
  results.push(
    `Central Park Tower replacement (${cptKey}): fit=${cptFit?.w ?? 0}x${cptFit?.d ?? 0}m, ` +
      `roof=${cptFit?.roofH ?? 0}m, cleared=${cptFit?.clearedParts ?? 0}, ` +
      `baked >=200m parts within 30m=${cptBakedTall} -> ${cptOk ? 'PASS' : 'FAIL'}`,
  );

  // 111 West 57th is a complete replacement of fourteen contiguous source
  // bands plus the separately mapped Steinway Hall. A tight spatial test
  // proves no tall strip remains behind the feathered build, while the named
  // Windsor Park neighbor proves that ownership clearing stayed surgical.
  const stwXZ = lonLatToXZ(-73.977437, 40.764998);
  const [stwTx, stwTz] = tileOf(stwXZ);
  const stwKey = tileKeyOf(stwTx, stwTz);
  const stwBuildings = tileBuildings.get(stwKey) || [];
  const stwBakedTall = stwBuildings.filter((b) => {
    if (b.h < 150) return false;
    const center = outputBuildingCentroid(b, stwTx, stwTz);
    return !!center && Math.hypot(center[0] - stwXZ[0], center[1] - stwXZ[1]) <= 30;
  }).length;
  const stwHallBaked = stwBuildings.some((b) => b.n === 'Steinway Hall');
  const stwNeighborKept = stwBuildings.some((b) => b.n === 'Windsor Park');
  const stwFit = fitOut['steinway-tower'];
  const stwOk = !!stwFit
    && Math.abs(stwFit.w - 43) < 1
    && Math.abs(stwFit.d - 18) < 1
    && Math.abs(stwFit.roofH - 435) < 1
    && Math.abs(stwFit.topW - 4) < 1
    && Math.abs(stwFit.topD - 18) < 1
    && stwFit.keptH === 0
    && stwFit.parts === 14
    && stwFit.clearedParts === 14
    && stwBakedTall === 0
    && !stwHallBaked
    && stwNeighborKept;
  results.push(
    `111 West 57th replacement (${stwKey}): fit=${stwFit?.w ?? 0}x${stwFit?.d ?? 0}m, ` +
      `tip=${stwFit?.topW ?? 0}x${stwFit?.topD ?? 0}m @ ${stwFit?.roofH ?? 0}m, ` +
      `cleared=${stwFit?.clearedParts ?? 0}+hall, baked >=150m within 30m=${stwBakedTall}, ` +
      `Windsor Park kept=${stwNeighborKept} -> ${stwOk ? 'PASS' : 'FAIL'}`,
  );

  // 432 Park keeps the source's two detached East 57th Street volumes while
  // replacing the square supertall shaft and its overlapping 30m podium. This
  // guards both sides of the surgical clear: no solid 425m duplicate and no
  // accidental erasure of the real four-/seven-storey development frontage.
  const park432XZ = lonLatToXZ(-73.9718353, 40.7615943);
  const [park432Tx, park432Tz] = tileOf(park432XZ);
  const park432Key = tileKeyOf(park432Tx, park432Tz);
  const park432Buildings = tileBuildings.get(park432Key) || [];
  const park432Near = (lat, lon, radius, height) => {
    const target = lonLatToXZ(lon, lat);
    return park432Buildings.some((b) => {
      if (height !== undefined && Math.abs(b.h - height) > 0.2) return false;
      const center = outputBuildingCentroid(b, park432Tx, park432Tz);
      return !!center && Math.hypot(center[0] - target[0], center[1] - target[1]) <= radius;
    });
  };
  const park432BakedTall = park432Buildings.filter((b) => {
    if (b.h < 400) return false;
    const center = outputBuildingCentroid(b, park432Tx, park432Tz);
    return !!center && Math.hypot(center[0] - park432XZ[0], center[1] - park432XZ[1]) <= 30;
  }).length;
  const park432PodiumKept = park432Near(40.7617805, -73.9719587, 7, 30);
  const park432Retail20Kept = park432Near(40.7616284, -73.9715897, 8, 20.5);
  const park432Retail28Kept = park432Near(40.7615889, -73.9715233, 8, 28.3);
  const park432Fit = fitOut['432-park'];
  const park432Ok = !!park432Fit
    && Math.abs(park432Fit.w - 28) < 2
    && Math.abs(park432Fit.d - 28) < 2
    && Math.abs(park432Fit.roofH - 426) < 1
    && park432Fit.keptH === 0
    && park432Fit.parts === 1
    && park432Fit.clearedParts === 1
    && park432BakedTall === 0
    && !park432PodiumKept
    && park432Retail20Kept
    && park432Retail28Kept;
  results.push(
    `432 Park Avenue replacement (${park432Key}): fit=${park432Fit?.w ?? 0}x${park432Fit?.d ?? 0}m, ` +
      `roof=${park432Fit?.roofH ?? 0}m, cleared=${park432Fit?.clearedParts ?? 0}+podium, ` +
      `baked >=400m within 30m=${park432BakedTall}, retail kept=${park432Retail20Kept && park432Retail28Kept} ` +
      `-> ${park432Ok ? 'PASS' : 'FAIL'}`,
  );

  // One Bryant Park's source contains an especially misleading cluster: a
  // solid 366m pyramidal "roof" plus overlapping 240–279m prisms. Verify the
  // complete host OBB is empty after replacement while the 341m broadcast
  // crown of adjacent 4 Times Square remains at its measured location.
  const bryantFit = fitOut['one-bryant'];
  let bryantResiduals = 0;
  if (bryantFit) {
    const cos = Math.cos(bryantFit.rot), sin = Math.sin(bryantFit.rot);
    for (const [key, buildings] of tileBuildings) {
      const [tx, tz] = key.split('_').map(Number);
      for (const b of buildings) {
        const center = outputBuildingCentroid(b, tx, tz);
        if (!center) continue;
        const dx = center[0] - bryantFit.cx, dz = center[1] - bryantFit.cz;
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        if (Math.abs(lx) < bryantFit.w / 2 - 1 && Math.abs(lz) < bryantFit.d / 2 - 1) {
          bryantResiduals++;
        }
      }
    }
  }
  const fourTimesXZ = lonLatToXZ(-73.9857361, 40.7559605);
  let fourTimesKept = false;
  for (const [key, buildings] of tileBuildings) {
    const [tx, tz] = key.split('_').map(Number);
    for (const b of buildings) {
      if (Math.abs(b.h - 341) > 0.2) continue;
      const center = outputBuildingCentroid(b, tx, tz);
      if (center && Math.hypot(center[0] - fourTimesXZ[0], center[1] - fourTimesXZ[1]) < 12) {
        fourTimesKept = true;
      }
    }
  }
  const bryantOk = !!bryantFit
    && Math.abs(bryantFit.w - 131) < 3
    && Math.abs(bryantFit.d - 62) < 3
    && Math.abs(bryantFit.roofH - 366) < 1
    && bryantFit.keptH === 0
    && bryantFit.clearedParts >= 12
    && bryantResiduals === 0
    && fourTimesKept;
  results.push(
    `One Bryant Park replacement: fit=${bryantFit?.w ?? 0}x${bryantFit?.d ?? 0}m, ` +
      `source roof=${bryantFit?.roofH ?? 0}m, cleared=${bryantFit?.clearedParts ?? 0}, ` +
      `site residuals=${bryantResiduals}, 4 Times Square kept=${fourTimesKept} ` +
      `-> ${bryantOk ? 'PASS' : 'FAIL'}`,
  );

  // 30 Hudson Yards' full replacement must remove every tall source slab while
  // retaining 50 Hudson Yards immediately northeast. A broad radius clear
  // would silently punch a second 308m hole in the development, so validate
  // both sides of the ownership boundary.
  const edgeFit = fitOut['edge-deck'];
  const edgeAnchorXZ = lonLatToXZ(-74.000555, 40.753949);
  let edgeTallResiduals = 0;
  for (const [key, buildings] of tileBuildings) {
    const [tx, tz] = key.split('_').map(Number);
    for (const b of buildings) {
      if (b.h < 120) continue;
      const center = outputBuildingCentroid(b, tx, tz);
      if (center && Math.hypot(center[0] - edgeAnchorXZ[0], center[1] - edgeAnchorXZ[1]) < 52) {
        edgeTallResiduals++;
      }
    }
  }
  const fiftyHudsonXZ = lonLatToXZ(-74.000119, 40.754519);
  let fiftyHudsonKept = false;
  for (const [key, buildings] of tileBuildings) {
    const [tx, tz] = key.split('_').map(Number);
    for (const b of buildings) {
      if (Math.abs(b.h - 308.2) > 0.3) continue;
      const center = outputBuildingCentroid(b, tx, tz);
      if (center && Math.hypot(center[0] - fiftyHudsonXZ[0], center[1] - fiftyHudsonXZ[1]) < 18) {
        fiftyHudsonKept = true;
      }
    }
  }
  const edgeOk = !!edgeFit
    && Math.abs(edgeFit.w - 117) < 3
    && Math.abs(edgeFit.d - 58) < 3
    && Math.abs(edgeFit.roofH - 395) < 1
    && edgeFit.keptH === 0
    && edgeFit.clearedParts >= 7
    && edgeTallResiduals === 0
    && fiftyHudsonKept;
  results.push(
    `30 Hudson Yards replacement: fit=${edgeFit?.w ?? 0}x${edgeFit?.d ?? 0}m, ` +
      `source roof=${edgeFit?.roofH ?? 0}m, cleared=${edgeFit?.clearedParts ?? 0}, ` +
      `tall residuals=${edgeTallResiduals}, 50 Hudson Yards kept=${fiftyHudsonKept} ` +
      `-> ${edgeOk ? 'PASS' : 'FAIL'}`,
  );

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
