#!/usr/bin/env node
// scripts/build-plaques.mjs
//
// Emits the ADDRESS-PLAQUE data layer consumed at runtime by
// src/engine/PlaqueManager.ts. Reads the same data/cache/ OSM snapshot the tile
// pipeline uses (which already carries addr:* / name / wikidata tags — the tile
// bake just drops them) and, for every street-numbered building, computes a
// plaque anchored on its STREET-FACING wall plus the metadata the info modal
// shows. Also snaps each building to the nearest OldNYC historical-photo marker.
//
// Output: public/geo/plaques/index.json  + public/geo/plaques/{tx}_{tz}.json
//   plaque record: { x, z, e, a, num?, st?, nm?, k?, lv?, wd?, wp?, web?, o?, lm? }
//     x,z  decimetres relative to the tile origin (tile chosen by centroid, as
//          in build-tiles.mjs); e = plaque-centre elevation in decimetres
//     a    outward facing bearing in integer degrees (atan2(nz,nx))
//     num  house number   st street   nm display name   k building kind
//     lv   levels   wd wikidata Q-id   wp wikipedia "lang:Title"   web website
//     o    OldNYC "lat,lon" marker key (exact string; omit if none within range)
//     lm   1 for a curated landmark (info glyph instead of a number)
//
// This is a self-contained data step (no existing tile is rebuilt). The shared
// geometry/road machinery mirrors scripts/build-tiles.mjs — keep the constants,
// VEHICULAR_HALF set, LANDMARK_CLEAR list, and coordinate transforms in sync.
//
// Usage:  node scripts/fetch-oldnyc.mjs   (once, produces the marker index)
//         node scripts/build-plaques.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const GEO_DIR = path.join(ROOT, 'public', 'geo');
const PLAQUE_DIR = path.join(GEO_DIR, 'plaques');
const TERRAIN_FILE = path.join(GEO_DIR, 'terrain.json');
const OLDNYC_FILE = path.join(CACHE_DIR, 'oldnyc-markers.json');

// ---- shared constants (must match src/engine/geo.ts / build-tiles.mjs) ----------------
const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
const TILE_SIZE = 256;
const ROWS = 8, COLS = 4;

function lonLatToXZ(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}
function tileOf(pt) { return [Math.floor(pt[0] / TILE_SIZE), Math.floor(pt[1] / TILE_SIZE)]; }

// ---- tuning -----------------------------------------------------------------
const PLAQUE_Y = 2.3;        // metres above the building base, clamped under short roofs
const PLAQUE_OUT = 0.4;      // metres proud of the wall face (toward the street)
const MIN_AREA = 14;         // m^2: skip slivers
const ROAD_PROBE = 2.5;      // m: push a candidate wall midpoint outward before scoring vs roads
const NO_ROAD_MAX = 95;      // m: if the nearest vehicular road is farther, fall back to longest edge
const OLDNYC_SNAP_M = 120;   // m: max distance to snap a building to an OldNYC marker
const LANDMARK_MATCH_M = 90; // m: max anchor->building distance for a curated landmark plaque (largest wins)

// ---- geometry / math helpers (mirror build-tiles.mjs) -------------------------------
function pointsEqual(a, b, eps = 0.01) { return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps; }
function ringClosed(ring, eps = 0.01) { return ring.length >= 4 && pointsEqual(ring[0], ring[ring.length - 1], eps); }
function ringArea(ring) {
  let sum = 0; const n = ring.length;
  for (let i = 0; i < n; i++) { const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % n]; sum += x0 * z1 - x1 * z0; }
  return sum / 2;
}
function centroidOf(ring) {
  let sx = 0, sz = 0;
  for (const [x, z] of ring) { sx += x; sz += z; }
  return [sx / ring.length, sz / ring.length];
}
function pointInPolygon(pt, ring) {
  let inside = false; const [x, z] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function isDegenerateRing(ring) { return ring.length < 3 || Math.abs(ringArea(ring)) < 4; }

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
    if (ringClosed(ring)) { ring = ring.slice(0, -1); if (ring.length >= 3) rings.push(ring); }
  }
  return rings;
}
function assembleMultipolygons(relationEl) {
  const members = relationEl.members || [];
  const outerSegs = [], innerSegs = [];
  for (const m of members) {
    if (!m.geometry || !Array.isArray(m.geometry) || m.geometry.length < 2) continue;
    const pts = m.geometry.filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').map((p) => lonLatToXZ(p.lon, p.lat));
    if (pts.length < 2) continue;
    if ((m.role || '') === 'inner') innerSegs.push(pts); else outerSegs.push(pts);
  }
  const outerRings = stitchRings(outerSegs).filter((r) => !isDegenerateRing(r));
  return outerRings.map((r) => ({ outer: r }));
}

// ---- terrain ------------------------------------------------------------------------
let TERRAIN = null;
function loadTerrain() {
  const json = JSON.parse(fs.readFileSync(TERRAIN_FILE, 'utf8'));
  if (!json || !Array.isArray(json.h) || !json.nx || !json.nz) throw new Error(`invalid ${TERRAIN_FILE}`);
  return json;
}
function terrainAt(x, z) {
  const { originX, originZ, step, nx, nz, h } = TERRAIN;
  const fx = (x - originX) / step, fz = (z - originZ) / step;
  const x0 = Math.max(0, Math.min(nx - 1, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(nz - 1, Math.floor(fz)));
  const x1 = Math.min(nx - 1, x0 + 1), z1 = Math.min(nz - 1, z0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), tz = Math.max(0, Math.min(1, fz - z0));
  const v00 = h[z0 * nx + x0], v10 = h[z0 * nx + x1], v01 = h[z1 * nx + x0], v11 = h[z1 * nx + x1];
  const top = v00 + (v10 - v00) * tx, bot = v01 + (v11 - v01) * tx;
  return (top + (bot - top) * tz) / 10;
}

// ---- cache loading ------------------------------------------------------------------
function loadLayer(layerName) {
  const map = new Map();
  const re = new RegExp(`^${layerName}_(\\d+)_(\\d+)\\.json$`);
  let files = [];
  try { files = fs.readdirSync(CACHE_DIR).filter((f) => re.test(f)); } catch { return map; }
  for (const f of files) {
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(json.elements)) continue;
    for (const el of json.elements) {
      const key = `${el.type}/${el.id}`;
      if (!map.has(key)) map.set(key, el);
    }
  }
  console.log(`  loaded ${layerName}: ${map.size} unique elements`);
  return map;
}

// ---- vehicular road spatial index (mirrors build-tiles.mjs global road index) --------
const VEHICULAR_HALF = {
  motorway: 11, trunk: 10, primary: 8.5, secondary: 7, tertiary: 6,
  unclassified: 5, residential: 5, living_street: 4, service: 2.75,
  motorway_link: 4.5, trunk_link: 4.5, primary_link: 4.5, secondary_link: 4.5, tertiary_link: 4.5,
};
const ROAD_CELL = 64;
const roadGrid = new Map();
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
// Nearest vehicular centerline distance to (px,pz), scanning the 3x3 cell block.
function nearestVehicularDist(px, pz) {
  const gx = Math.floor(px / ROAD_CELL), gz = Math.floor(pz / ROAD_CELL);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const a = roadGrid.get(roadCellKey(gx + dx, gz + dz));
    if (!a) continue;
    for (const s of a) {
      const vx = s.x2 - s.x1, vz = s.z2 - s.z1, l2 = vx * vx + vz * vz;
      if (l2 < 1e-9) continue;
      let t = ((px - s.x1) * vx + (pz - s.z1) * vz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = px - (s.x1 + t * vx), oz = pz - (s.z1 + t * vz);
      const d2 = ox * ox + oz * oz;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

// ---- OldNYC marker snapping ---------------------------------------------------------
const OLDNYC_CELL = 128;
const oldnycGrid = new Map();
function loadOldNyc() {
  if (!fs.existsSync(OLDNYC_FILE)) {
    console.warn(`  WARN: ${path.relative(ROOT, OLDNYC_FILE)} missing — run scripts/fetch-oldnyc.mjs; OldNYC links disabled`);
    return 0;
  }
  const { markers } = JSON.parse(fs.readFileSync(OLDNYC_FILE, 'utf8'));
  for (const [latStr, lonStr, cnt] of markers) {
    const [x, z] = lonLatToXZ(parseFloat(lonStr), parseFloat(latStr));
    const gx = Math.floor(x / OLDNYC_CELL), gz = Math.floor(z / OLDNYC_CELL);
    const k = `${gx},${gz}`;
    let a = oldnycGrid.get(k);
    if (!a) { a = []; oldnycGrid.set(k, a); }
    a.push({ x, z, key: `${latStr},${lonStr}`, cnt });
  }
  return markers.length;
}
// Nearest marker key within OLDNYC_SNAP_M metres of (px,pz), or null.
function snapOldNyc(px, pz) {
  const gx = Math.floor(px / OLDNYC_CELL), gz = Math.floor(pz / OLDNYC_CELL);
  let best = null, bestD2 = OLDNYC_SNAP_M * OLDNYC_SNAP_M;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const a = oldnycGrid.get(`${gx + dx},${gz + dz}`);
    if (!a) continue;
    for (const m of a) {
      const ex = m.x - px, ez = m.z - pz, d2 = ex * ex + ez * ez;
      if (d2 < bestD2) { bestD2 = d2; best = m.key; }
    }
  }
  return best;
}

// ---- curated landmark plaques -------------------------------------------------------
// Building/monument landmarks that deserve a wall plaque even where the tile
// pipeline replaces or clears their OSM massing. Names mirror
// src/engine/landmarks/registry.ts; `wiki` overrides the Wikipedia title only
// where it differs from the display name (runtime falls back to the name, and to
// the matched building's own wikidata/wikipedia tag when present).
const LANDMARK_INFO = [
  { id: 'one-wtc', name: 'One World Trade Center', lat: 40.712507, lon: -74.013462 },
  { id: 'oculus', name: 'Oculus', lat: 40.7115, lon: -74.0113, wiki: 'World Trade Center station (PATH)' },
  { id: 'sept11-museum', name: 'National September 11 Memorial & Museum', lat: 40.7115, lon: -74.0125, wiki: 'National September 11 Memorial & Museum' },
  { id: 'nyse', name: 'New York Stock Exchange', lat: 40.7069, lon: -74.0113, wiki: 'New York Stock Exchange Building' },
  { id: 'federal-hall', name: 'Federal Hall', lat: 40.7074, lon: -74.0102 },
  { id: 'trinity-church', name: 'Trinity Church', lat: 40.7081, lon: -74.0121, wiki: 'Trinity Church (Manhattan)' },
  { id: 'castle-clinton', name: 'Castle Clinton', lat: 40.7033, lon: -74.017 },
  { id: 'whitehall-terminal', name: 'Staten Island Ferry Whitehall Terminal', lat: 40.7013, lon: -74.0131, wiki: 'Whitehall Terminal' },
  { id: 'fraunces-tavern', name: 'Fraunces Tavern', lat: 40.7034, lon: -74.0113 },
  { id: 'city-hall', name: 'New York City Hall', lat: 40.7128, lon: -74.006 },
  { id: 'woolworth', name: 'Woolworth Building', lat: 40.7124, lon: -74.0083 },
  { id: 'municipal-building', name: 'Manhattan Municipal Building', lat: 40.7127, lon: -74.0041 },
  { id: 'stonewall', name: 'Stonewall Inn', lat: 40.7338, lon: -74.0021, wiki: 'Stonewall Inn' },
  { id: 'flatiron', name: 'Flatiron Building', lat: 40.74107, lon: -73.98964 },
  { id: 'whitney', name: 'Whitney Museum of American Art', lat: 40.7397, lon: -74.0089 },
  { id: 'chelsea-market', name: 'Chelsea Market', lat: 40.7425, lon: -74.0053 },
  { id: 'edge-deck', name: 'Edge (30 Hudson Yards)', lat: 40.7539, lon: -74.0006, wiki: '30 Hudson Yards' },
  { id: 'empire-state', name: 'Empire State Building', lat: 40.7484, lon: -73.9857 },
  { id: 'nypl', name: 'New York Public Library Main Branch', lat: 40.75290, lon: -73.98165, wiki: 'New York Public Library Main Branch' },
  { id: 'msg', name: 'Madison Square Garden', lat: 40.7505, lon: -73.9934 },
  { id: 'grand-central', name: 'Grand Central Terminal', lat: 40.7519, lon: -73.9772 },
  { id: 'chrysler', name: 'Chrysler Building', lat: 40.7516, lon: -73.9755 },
  { id: 'one-vanderbilt', name: 'One Vanderbilt', lat: 40.7529, lon: -73.9787 },
  { id: 'united-nations', name: 'United Nations Headquarters', lat: 40.7489, lon: -73.9681, wiki: 'Headquarters of the United Nations' },
  { id: 'chase-hq', name: '270 Park Avenue (JPMorganChase HQ)', lat: 40.755819, lon: -73.975652, wiki: '270 Park Avenue' },
  { id: 'top-of-the-rock', name: '30 Rockefeller Plaza', lat: 40.7591, lon: -73.9794, wiki: '30 Rockefeller Plaza' },
  { id: 'st-patricks', name: "St. Patrick's Cathedral", lat: 40.7585, lon: -73.976, wiki: "St. Patrick's Cathedral (Manhattan)" },
  { id: 'radio-city', name: 'Radio City Music Hall', lat: 40.7599, lon: -73.9801 },
  { id: 'moma', name: 'Museum of Modern Art', lat: 40.7616, lon: -73.9774 },
  { id: 'carnegie-hall', name: 'Carnegie Hall', lat: 40.7651, lon: -73.9799 },
  { id: 'hearst-tower', name: 'Hearst Tower', lat: 40.7666, lon: -73.9836, wiki: 'Hearst Tower (New York City)' },
  { id: 'plaza-hotel', name: 'The Plaza Hotel', lat: 40.7644, lon: -73.9745, wiki: 'Plaza Hotel' },
  { id: 'dakota', name: 'The Dakota', lat: 40.776614, lon: -73.976125, wiki: 'The Dakota' },
  { id: 'amnh', name: 'American Museum of Natural History', lat: 40.7808, lon: -73.973 },
  { id: 'met-museum', name: 'Metropolitan Museum of Art', lat: 40.779391, lon: -73.962542 },
  { id: 'guggenheim', name: 'Solomon R. Guggenheim Museum', lat: 40.783, lon: -73.959, wiki: 'Solomon R. Guggenheim Museum' },
  { id: 'apollo', name: 'Apollo Theater', lat: 40.8101, lon: -73.9499 },
  { id: 'st-john-divine', name: 'Cathedral of St. John the Divine', lat: 40.8038, lon: -73.9619 },
  { id: 'columbia', name: 'Low Memorial Library', lat: 40.8081, lon: -73.9619, wiki: 'Low Memorial Library' },
  { id: 'riverside-church', name: 'Riverside Church', lat: 40.8119, lon: -73.9633 },
  { id: 'grants-tomb', name: "Grant's Tomb", lat: 40.8134, lon: -73.963, wiki: "Grant's Tomb" },
  { id: 'hamilton-grange', name: 'Hamilton Grange National Memorial', lat: 40.8214, lon: -73.9469 },
  { id: 'morris-jumel', name: 'Morris-Jumel Mansion', lat: 40.8345, lon: -73.9386 },
  { id: 'dyckman-farmhouse', name: 'Dyckman Farmhouse', lat: 40.866852, lon: -73.922818 },
  { id: 'cloisters', name: 'The Cloisters', lat: 40.8649, lon: -73.9317, wiki: 'The Cloisters' },
  { id: 'belvedere', name: 'Belvedere Castle', lat: 40.7794, lon: -73.9692 },
].map((e) => { const [x, z] = lonLatToXZ(e.lon, e.lat); return { ...e, x, z }; });

// Premium-landmark clear radii (mirror scripts/build-tiles.mjs LANDMARK_CLEAR):
// ordinary numbered buildings inside these are NOT plaqued (their OSM massing is
// dropped for a bespoke build). Curated landmark plaques above are exempt — they
// intentionally mount on the replaced footprint.
const LANDMARK_CLEAR = [
  ['oculus', 40.7115, -74.0113, 55], ['sept11-museum', 40.7115, -74.0125, 28],
  ['trinity-church', 40.7081, -74.0121, 40], ['federal-hall', 40.7074, -74.0102, 30],
  ['castle-clinton', 40.7033, -74.017, 38], ['fraunces-tavern', 40.7034, -74.0113, 18],
  ['whitehall-terminal', 40.7013, -74.0131, 45], ['city-hall', 40.7128, -74.006, 50],
  ['st-patricks', 40.7586, -73.9758, 62], ['guggenheim', 40.783, -73.959, 40],
  ['times-square', 40.758, -73.9855, 55],
  ['un-secretariat', 40.7489, -73.9681, 60], ['un-ga', 40.7501, -73.9677, 50],
  ['chase-hq', 40.7558, -73.9755, 50],
  ['dakota', 40.7765, -73.9761, 50], ['carnegie-hall', 40.7651, -73.9799, 35],
  ['whitney', 40.7397, -74.0089, 35], ['vessel', 40.7538, -74.0022, 40],
  ['little-island', 40.742, -74.01, 70], ['belvedere', 40.7794, -73.9692, 28],
  ['grants-tomb', 40.8134, -73.963, 32], ['riverside-church', 40.8119, -73.9633, 42],
  ['columbia-low', 40.8081, -73.9619, 42], ['st-john-divine', 40.8038, -73.9619, 55],
  ['cloisters', 40.8649, -73.9317, 55], ['hamilton-grange', 40.8214, -73.9469, 18],
  ['morris-jumel', 40.8345, -73.9386, 20], ['dyckman-farmhouse', 40.8668, -73.9229, 18],
].map(([id, lat, lon, r]) => { const [x, z] = lonLatToXZ(lon, lat); return { id, x, z, r2: r * r }; });
function inLandmarkClear(cx, cz) {
  for (const lc of LANDMARK_CLEAR) {
    const dx = cx - lc.x, dz = cz - lc.z;
    if (dx * dx + dz * dz < lc.r2) return true;
  }
  return false;
}

// ---- street-facing wall solve -------------------------------------------------------
// Choose the outer-ring edge that best faces a vehicular street; return the plaque
// anchor (just proud of that wall) + outward bearing. Falls back to the longest
// edge when no road is near.
function solveWall(outer, centroid) {
  const n = outer.length;
  let best = null, bestScore = Infinity, longest = null, longestLen = -1;
  for (let i = 0; i < n; i++) {
    const a = outer[i], b = outer[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1.5) continue;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    // outward normal (away from centroid)
    let nx = ez / len, nz = -ex / len;
    if ((mx - centroid[0]) * nx + (mz - centroid[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const d = nearestVehicularDist(mx + nx * ROAD_PROBE, mz + nz * ROAD_PROBE);
    // score: nearest road distance, lightly rewarding longer frontages
    const score = d - Math.min(len, 40) * 0.15;
    if (score < bestScore) { bestScore = score; best = { mx, mz, nx, nz, roadDist: d }; }
    if (len > longestLen) {
      longestLen = len;
      let lnx = ez / len, lnz = -ex / len;
      if ((mx - centroid[0]) * lnx + (mz - centroid[1]) * lnz < 0) { lnx = -lnx; lnz = -lnz; }
      longest = { mx, mz, nx: lnx, nz: lnz, roadDist: Infinity };
    }
  }
  const chosen = best && best.roadDist <= NO_ROAD_MAX ? best : (best || longest);
  if (!chosen) return null;
  return {
    x: chosen.mx + chosen.nx * PLAQUE_OUT,
    z: chosen.mz + chosen.nz * PLAQUE_OUT,
    nx: chosen.nx,
    nz: chosen.nz,
  };
}

// ======================================================================================
async function main() {
  fs.mkdirSync(PLAQUE_DIR, { recursive: true });
  console.log('Loading terrain...');
  TERRAIN = loadTerrain();
  console.log('Loading OldNYC markers...');
  const oldnycCount = loadOldNyc();
  console.log(`  ${oldnycCount} markers indexed`);
  console.log('Loading cache...');
  const buildingsMap = loadLayer('buildings');
  const roadsMap = loadLayer('roads');

  // ---- build vehicular road index ----
  for (const el of roadsMap.values()) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};
    if (!tags.highway || tags.area === 'yes' || tags.tunnel === 'yes') continue;
    const half = VEHICULAR_HALF[tags.highway];
    if (half === undefined) continue;
    if (!el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number').map((p) => lonLatToXZ(p.lon, p.lat));
    for (let i = 0; i < pts.length - 1; i++) addRoadSeg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], half);
  }
  console.log(`  vehicular road index: ${roadGrid.size} cells`);

  // ---- extract building footprints + tags ----
  console.log('Extracting buildings...');
  const bldgs = []; // { outer, centroid, area, tags }
  for (const el of buildingsMap.values()) {
    const tags = el.tags || {};
    const buildingVal = tags['building'];
    const isPart = tags['building:part'] !== undefined && tags['building:part'] !== 'no';
    const isBuilding = !isPart && buildingVal !== undefined && buildingVal !== 'no';
    if (!isBuilding) continue; // plaque real buildings, not parts
    const layerNum = parseFloat(tags.layer);
    if (tags.location === 'underground' || (buildingVal === 'train_station' && layerNum < 0)) continue;

    let polys = [];
    if (el.type === 'way') {
      const ring = wayToRing(el);
      if (ring && !isDegenerateRing(ring)) polys = [{ outer: ring }];
    } else if (el.type === 'relation') {
      polys = assembleMultipolygons(el).filter((p) => !isDegenerateRing(p.outer));
    }
    for (const poly of polys) {
      const area = Math.abs(ringArea(poly.outer));
      if (area < MIN_AREA) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of poly.outer) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      bldgs.push({ outer: poly.outer, centroid: centroidOf(poly.outer), area, tags, bbox: { minX, maxX, minZ, maxZ } });
    }
  }
  console.log(`  ${bldgs.length} building polygons`);

  // ---- spatial index of buildings by centroid (for landmark matching) ----
  const BCELL = 64;
  const bGrid = new Map();
  for (const b of bldgs) {
    const gx = Math.floor(b.centroid[0] / BCELL), gz = Math.floor(b.centroid[1] / BCELL);
    const k = `${gx},${gz}`;
    let a = bGrid.get(k);
    if (!a) { a = []; bGrid.set(k, a); }
    a.push(b);
  }
  // Building whose footprint CONTAINS (px,pz) — robust for big landmark massings
  // (One WTC, the Met, AMNH) whose centroid sits far from any point anchor.
  // Linear scan (bbox-pruned) is fine for the ~45 landmark queries.
  function buildingContaining(px, pz) {
    let best = null, bestArea = Infinity;
    for (const b of bldgs) {
      const bb = b.bbox;
      if (px < bb.minX || px > bb.maxX || pz < bb.minZ || pz > bb.maxZ) continue;
      if (!pointInPolygon([px, pz], b.outer)) continue;
      if (b.area < bestArea) { bestArea = b.area; best = b; } // tightest containing footprint
    }
    return best;
  }
  // LARGEST building whose centroid is within maxM — landmarks are the dominant
  // massing at their anchor, so this beats nearest-centroid (which can snap to a
  // tiny plaza kiosk sitting closer than the tower itself, e.g. One WTC).
  function largestBuildingNear(px, pz, maxM) {
    const gx = Math.floor(px / BCELL), gz = Math.floor(pz / BCELL);
    const rc = Math.ceil(maxM / BCELL), max2 = maxM * maxM;
    let best = null, bestArea = -1;
    for (let dx = -rc; dx <= rc; dx++) for (let dz = -rc; dz <= rc; dz++) {
      const a = bGrid.get(`${gx + dx},${gz + dz}`);
      if (!a) continue;
      for (const b of a) {
        const ex = b.centroid[0] - px, ez = b.centroid[1] - pz;
        if (ex * ex + ez * ez > max2) continue;
        if (b.area > bestArea) { bestArea = b.area; best = b; }
      }
    }
    return best;
  }
  const matchLandmark = (px, pz) => buildingContaining(px, pz) || largestBuildingNear(px, pz, LANDMARK_MATCH_M);

  // ---- emit records, binned by tile ----
  const tilePlaques = new Map();
  const used = new Set(); // building refs already emitted as landmarks
  let landmarkCount = 0, ordinaryCount = 0, oldnycLinks = 0;

  function emit(b, opts) {
    const wall = solveWall(b.outer, b.centroid);
    if (!wall) return false;
    const base = terrainAt(b.centroid[0], b.centroid[1]);
    const [tx, tz] = tileOf(b.centroid);
    const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE;
    const rec = {
      x: Math.round((wall.x - ox) * 10),
      z: Math.round((wall.z - oz) * 10),
      e: Math.round((base + PLAQUE_Y) * 10),
      a: Math.round((Math.atan2(wall.nz, wall.nx) * 180) / Math.PI),
    };
    if (opts.num) rec.num = opts.num;
    if (opts.st) rec.st = opts.st;
    if (opts.nm) rec.nm = opts.nm;
    if (opts.k) rec.k = opts.k;
    if (opts.lv) rec.lv = opts.lv;
    if (opts.wd) rec.wd = opts.wd;
    if (opts.wp) rec.wp = opts.wp;
    if (opts.web) rec.web = opts.web;
    if (opts.lm) rec.lm = 1;
    const o = snapOldNyc(b.centroid[0], b.centroid[1]);
    if (o) { rec.o = o; oldnycLinks++; }
    const key = `${tx}_${tz}`;
    if (!tilePlaques.has(key)) tilePlaques.set(key, []);
    tilePlaques.get(key).push(rec);
    return true;
  }

  // curated landmark plaques first (exempt from LANDMARK_CLEAR)
  for (const lm of LANDMARK_INFO) {
    const b = matchLandmark(lm.x, lm.z);
    if (!b) { console.warn(`  landmark ${lm.id}: no building within ${LANDMARK_MATCH_M}m`); continue; }
    if (used.has(b)) continue;
    used.add(b);
    const t = b.tags;
    const lv = t['building:levels'] ? parseInt(t['building:levels'], 10) : undefined;
    if (emit(b, {
      num: t['addr:housenumber'], st: t['addr:street'], nm: lm.name,
      k: t.building && t.building !== 'yes' ? t.building : undefined,
      lv: Number.isFinite(lv) ? lv : undefined,
      wd: t.wikidata, wp: t.wikipedia || (lm.wiki ? `en:${lm.wiki}` : undefined),
      web: t.website, lm: true,
    })) landmarkCount++;
  }

  // ordinary numbered buildings
  for (const b of bldgs) {
    if (used.has(b)) continue;
    const t = b.tags;
    const num = t['addr:housenumber'];
    if (!num) continue;
    if (inLandmarkClear(b.centroid[0], b.centroid[1])) continue;
    const lv = t['building:levels'] ? parseInt(t['building:levels'], 10) : undefined;
    if (emit(b, {
      num, st: t['addr:street'], nm: t.name,
      k: t.building && t.building !== 'yes' ? t.building : undefined,
      lv: Number.isFinite(lv) ? lv : undefined,
      wd: t.wikidata, wp: t.wikipedia, web: t.website,
    })) ordinaryCount++;
  }

  // ---- write ----
  const index = [];
  let totalBytes = 0, recCount = 0;
  for (const [key, recs] of tilePlaques) {
    const [tx, tz] = key.split('_').map(Number);
    const out = JSON.stringify({ v: 1, x: tx, z: tz, plaques: recs });
    fs.writeFileSync(path.join(PLAQUE_DIR, `${key}.json`), out);
    index.push(key);
    totalBytes += out.length;
    recCount += recs.length;
  }
  index.sort();
  fs.writeFileSync(path.join(PLAQUE_DIR, 'index.json'), JSON.stringify({ v: 1, tiles: index }));

  fs.writeFileSync(path.join(GEO_DIR, 'OLDNYC_NOTICE.txt'),
    'Historical-photo deep links point to OldNYC (https://www.oldnyc.org/).\n' +
    'OldNYC is by Dan Vanderkam (github.com/danvk/oldnyc, github.com/oldnyc/oldnyc.github.io),\n' +
    'Apache-2.0. Photos are from the NYPL Milstein Collection and remain NYPL\'s; this app\n' +
    'redistributes no images and only links out. Marker coordinates (facts) are used under\n' +
    'Apache-2.0 to construct #g:lat,lon deep links.\n');

  console.log(
    `\nWrote ${index.length} plaque tiles, ${recCount} plaques ` +
      `(${landmarkCount} landmarks + ${ordinaryCount} numbered), ${oldnycLinks} OldNYC links ` +
      `(${(totalBytes / 1024 / 1024).toFixed(1)}MB total)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
