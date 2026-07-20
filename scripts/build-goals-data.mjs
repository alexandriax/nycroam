// Goals / achievements spatial data: Manhattan residential neighborhoods and
// parks, as world-meter polygon rings the runtime GoalTracker tests the player
// against.
//
//   node scripts/build-goals-data.mjs
//
// Sources (all local / NYC Open Data, same as the rest of the pipeline):
//   - Neighborhoods: NYC 2020 Neighborhood Tabulation Areas, dataset 9nt8-h7nd
//     (cached at data/cache/hoods-nta2020.geojson by fetch-hoods.mjs; re-fetched
//     from the resource endpoint if the cache is missing). Manhattan, RESIDENTIAL
//     only — ntatype 0; the park/cemetery/island (9) and other-nonresidential (6)
//     NTAs are dropped. Roosevelt Island rides along inside a type-0 compound.
//   - Parks: leisure=park ways/relations WITH a name, from the local OSM areas
//     cache (data/cache/areas_*.json). Merged by name, area-filtered, then clipped
//     to Manhattan by the outline in public/geo/outline.json.
//
// Output: public/geo/goalsdata.json
//   { v:1, neighborhoods:[{id,name,rings:[[[x,z],...],...]}], parks:[same] }
// Coords are world meters rounded to 0.1m; rings are Douglas-Peucker simplified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const NTA_CACHE = path.join(CACHE_DIR, 'hoods-nta2020.geojson');
const OUTLINE_FILE = path.join(ROOT, 'public', 'geo', 'outline.json');
const OUT = path.join(ROOT, 'public', 'geo', 'goalsdata.json');
const NTA_FEED = 'https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?boroname=Manhattan&$limit=200';

// Geo constants — duplicated EXACTLY from src/engine/geo.ts (keep in sync).
const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
const lonLatToXZ = (lon, lat) => [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];

// Parks below this many square meters are dropped (small playgrounds, medians).
// 12000 keeps the marquee greens through the mid-size neighborhood parks and
// lands the Manhattan count in the intended ~40-90 band. Tunable 8k-20k.
const PARK_AREA_MIN = 12000;
const NTA_RDP = 8; // neighborhood ring simplification tolerance, meters
const PARK_RDP = 6; // park ring simplification tolerance, meters

// ---- geometry helpers ------------------------------------------------------

// Douglas-Peucker on an OPEN polyline of [x,z] points.
function dp(pts, eps) {
  if (pts.length <= 2) return pts;
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
    if (maxD > eps && maxI > 0) { keep[maxI] = true; stack.push([i0, maxI], [maxI, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Simplify a CLOSED ring: open it, split at the farthest point so both halves
// have real chords (a closed ring's start==end chord is degenerate for DP).
function simplify(pts, eps) {
  const closed = pts.length > 1
    && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const open = closed ? pts.slice(0, -1) : pts.slice();
  if (open.length <= 4) return open;
  let far = 1, best = -1;
  for (let i = 1; i < open.length; i++) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = dp(open.slice(0, far + 1), eps);
  const b = dp(open.slice(far), eps);
  return [...a.slice(0, -1), ...b];
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

function ringCentroid(r) {
  let x = 0, z = 0, a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; x += (r[j][0] + r[i][0]) * f; z += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) { // degenerate: fall back to vertex mean
    let sx = 0, sz = 0; for (const p of r) { sx += p[0]; sz += p[1]; }
    return [sx / r.length, sz / r.length];
  }
  a *= 0.5;
  return [x / (6 * a), z / (6 * a)];
}

// Even-odd point-in-polygon across FLAT [x,z,x,z,...] rings (outline.json shape).
function pointInFlatRings(x, z, rings) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], zi = ring[i * 2 + 1];
      const xj = ring[j * 2], zj = ring[j * 2 + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

function slug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const round1 = (v) => Math.round(v * 10) / 10;
// A simplified ring as output rings: [[x,z],...] rounded to 0.1m.
const emitRing = (pts) => pts.map((p) => [round1(p[0]), round1(p[1])]);

// ---- neighborhoods ---------------------------------------------------------

async function loadNTA() {
  if (fs.existsSync(NTA_CACHE)) {
    console.log('neighborhoods: using cached NTA geojson');
    return JSON.parse(fs.readFileSync(NTA_CACHE, 'utf8'));
  }
  console.log('neighborhoods: fetching 2020 NTAs (Manhattan)...');
  const res = await fetch(NTA_FEED, { headers: { 'User-Agent': 'nycroam-goals-build/1.0 (+data pipeline script)' } });
  if (!res.ok) throw new Error(`NTA HTTP ${res.status}`);
  const gj = await res.json();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(NTA_CACHE, JSON.stringify(gj));
  return gj;
}

async function buildNeighborhoods() {
  const gj = await loadNTA();
  const out = [];
  const usedIds = new Set();
  for (const f of gj.features ?? []) {
    const p = f.properties ?? {};
    const name = p.ntaname;
    const geom = f.geometry;
    // residential NTAs only: ntatype 0. Type 9 (park/cemetery/island) and 6
    // (other non-residential, e.g. the UN) are dropped — those aren't places
    // you "live in", and the parks come from the OSM set instead.
    if (!name || !geom || String(p.ntatype) !== '0') continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
      : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    const rings = [];
    for (const poly of polys) {
      // ring 0 of each polygon component is its OUTER boundary; holes are skipped
      // (visits use inside-any-ring, so a hole ring would wrongly read as inside).
      const outer = poly[0];
      if (!outer) continue;
      const pts = outer.map(([lon, lat]) => lonLatToXZ(lon, lat));
      const simp = simplify(pts, NTA_RDP);
      if (simp.length < 4) continue;
      rings.push(emitRing(simp));
    }
    if (!rings.length) continue;
    let id = 'mn-' + slug(name), n = 2;
    while (usedIds.has(id)) id = `mn-${slug(name)}-${n++}`;
    usedIds.add(id);
    out.push({ id, name, rings });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- parks -----------------------------------------------------------------

function buildParks(outlineRings) {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => /^areas_\d+_\d+\.json$/.test(f));
  const seen = new Set(); // dedup the SAME osm element appearing in multiple grid files
  const byName = new Map(); // name -> [ring([x,z]...), ...]
  for (const fn of files) {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, fn), 'utf8'));
    for (const e of j.elements ?? []) {
      if (!e.tags || e.tags.leisure !== 'park' || !e.tags.name) continue;
      const key = `${e.type}/${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rings = [];
      if (e.type === 'way' && Array.isArray(e.geometry)) {
        rings.push(e.geometry.map((pt) => lonLatToXZ(pt.lon, pt.lat)));
      } else if (e.type === 'relation' && Array.isArray(e.members)) {
        for (const m of e.members) {
          if (m.role === 'inner') continue; // holes: skip (inside-any-ring semantics)
          if (Array.isArray(m.geometry) && m.geometry.length > 2) {
            rings.push(m.geometry.map((pt) => lonLatToXZ(pt.lon, pt.lat)));
          }
        }
      }
      if (!rings.length) continue;
      if (!byName.has(e.tags.name)) byName.set(e.tags.name, []);
      byName.get(e.tags.name).push(...rings);
    }
  }

  const out = [];
  const usedIds = new Set();
  for (const [name, allRings] of byName) {
    // drop near-duplicate rings (same geometry pulled from adjacent grid files)
    // by a coarse signature so the union isn't double-weighted for area/bytes
    const uniq = [];
    const sigs = new Set();
    for (const r of allRings) {
      const c = ringCentroid(r);
      const sig = `${Math.round(c[0] / 5)},${Math.round(c[1] / 5)},${Math.round(ringArea(r) / 200)}`;
      if (sigs.has(sig)) continue;
      sigs.add(sig);
      uniq.push(r);
    }
    let total = 0, maxA = 0, maxRing = null;
    for (const r of uniq) {
      const a = ringArea(r);
      total += a;
      if (a > maxA) { maxA = a; maxRing = r; }
    }
    if (total < PARK_AREA_MIN || !maxRing) continue;
    // Manhattan clip: the biggest ring's centroid must sit on the island
    const c = ringCentroid(maxRing);
    if (!pointInFlatRings(c[0], c[1], outlineRings)) continue;
    const rings = [];
    for (const r of uniq) {
      if (ringArea(r) < 400) continue; // drop slivers within a multi-ring park
      const simp = simplify(r, PARK_RDP);
      if (simp.length < 4) continue;
      rings.push(emitRing(simp));
    }
    if (!rings.length) continue;
    let id = 'pk-' + slug(name), n = 2;
    while (usedIds.has(id)) id = `pk-${slug(name)}-${n++}`;
    usedIds.add(id);
    out.push({ id, name, rings });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- main ------------------------------------------------------------------

async function main() {
  const outline = JSON.parse(fs.readFileSync(OUTLINE_FILE, 'utf8'));
  const outlineRings = outline.rings;

  const neighborhoods = await buildNeighborhoods();
  const parks = buildParks(outlineRings);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ v: 1, neighborhoods, parks }));
  const kb = fs.statSync(OUT).size / 1024;

  console.log(`\nneighborhoods: ${neighborhoods.length}`);
  console.log('  ' + neighborhoods.map((n) => n.name).join('\n  '));
  console.log(`\nparks: ${parks.length} (area >= ${PARK_AREA_MIN} m^2, Manhattan-clipped)`);
  console.log('  ' + parks.map((p) => p.name).join('\n  '));
  console.log(`\ngoalsdata.json: ${neighborhoods.length} neighborhoods + ${parks.length} parks, ${kb.toFixed(0)}KB`);
  if (kb > 400) console.warn(`WARNING: ${kb.toFixed(0)}KB exceeds the ~400KB budget — tighten RDP.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
