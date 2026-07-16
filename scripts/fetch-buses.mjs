#!/usr/bin/env node
// Local/Limited/SBS MTA bus routes serving Manhattan streets: real route
// shapes, real curbside stop locations, clipped to the Manhattan silhouette.
// Pulled from four MTA GTFS static feeds (Manhattan, Bronx, Queens, MTA Bus
// Company) since some Bx/Q/BusCo-operated routes cross into Manhattan.
//
//   node scripts/fetch-buses.mjs
//
// Raw feeds are cached in data/cache/gtfs-bus/<feed>.zip + <feed>/ (delete to
// re-fetch/re-extract). Output:
//   public/geo/buses.json  -- conforms to BusData, see src/engine/bus/types.ts
// with all positions in world meters (same local tangent projection as every
// other layer).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache', 'gtfs-bus');
const OUT_DIR = path.join(ROOT, 'public', 'geo');
const OUT = path.join(OUT_DIR, 'buses.json');
const OUTLINE_FILE = path.join(ROOT, 'public', 'geo', 'outline.json');

const UA = 'nycroam-buses-fetch/1.0 (+data pipeline script)';

// ---------------------------------------------------------------------------
// Coordinate system (duplicated from src/engine/geo.ts -- keep in exact sync)
// World frame: +x = east, +z = south (note the negated lat term).
// ---------------------------------------------------------------------------
const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
function lonLatToXZ(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}
function round1(v) {
  return Math.round(v * 10) / 10;
}

// Duplicated from src/engine/bus/types.ts (BUS_DEFAULT_COLOR).
const BUS_DEFAULT_COLOR = '#1d59b3';

const FEEDS = [
  { name: 'gtfs_m', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_m.zip' },
  { name: 'gtfs_bx', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip' },
  { name: 'gtfs_q', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_q.zip' },
  { name: 'gtfs_busco', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_busco.zip' },
];

// Express + shuttle bus exclusions (route_id OR route_short_name).
const EXPRESS_RE = /^(X\d|SIM|BxM|BM\d|QM\d?)/i;

// ---------------------------------------------------------------------------
// fetch with retry + exponential backoff (binary-safe)
// ---------------------------------------------------------------------------
async function fetchBufferWithRetry(url, { attempts = 4, timeoutMs = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < attempts - 1) {
        const backoff = 1500 * (i + 1);
        console.warn(`  attempt ${i + 1}/${attempts} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// GTFS zip download + extraction (resumable: skip whatever is already present)
// ---------------------------------------------------------------------------
const NEEDED_FILES = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt'];

async function ensureFeedReady(feed) {
  const zipPath = path.join(CACHE_DIR, `${feed.name}.zip`);
  const extractDir = path.join(CACHE_DIR, feed.name);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const alreadyExtracted = NEEDED_FILES.every((f) => {
    const p = path.join(extractDir, f);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  });
  if (alreadyExtracted) {
    console.log(`[${feed.name}] using previously extracted files (data/cache/gtfs-bus/${feed.name}/)`);
    return extractDir;
  }

  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 200_000) {
    console.log(`[${feed.name}] using cached zip (data/cache/gtfs-bus/${feed.name}.zip)`);
  } else {
    console.log(`[${feed.name}] downloading ${feed.url}`);
    const buf = await fetchBufferWithRetry(feed.url);
    if (buf.length < 200_000 || buf.slice(0, 2).toString('latin1') !== 'PK') {
      throw new Error(`${feed.name}: downloaded file looks invalid (size=${buf.length})`);
    }
    fs.writeFileSync(zipPath, buf);
    console.log(`[${feed.name}] downloaded ${buf.length} bytes`);
  }

  fs.mkdirSync(extractDir, { recursive: true });
  console.log(`[${feed.name}] unzipping -> data/cache/gtfs-bus/${feed.name}/`);
  execFileSync('unzip', ['-o', zipPath, '-d', extractDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const f of NEEDED_FILES) {
    if (!fs.existsSync(path.join(extractDir, f))) throw new Error(`${feed.name}: expected file missing after unzip: ${f}`);
  }
  return extractDir;
}

// ---------------------------------------------------------------------------
// CSV helpers (fast path for unquoted lines; full quote-aware parse otherwise)
// ---------------------------------------------------------------------------
function splitCsvLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}
function headerIndex(headerLine) {
  const cols = splitCsvLine(headerLine).map((s) => s.trim());
  const idx = {};
  cols.forEach((c, i) => (idx[c] = i));
  return idx;
}
// Small in-memory tables (routes/trips/stops/shapes -- never stop_times, which
// is streamed below). Handles column order via the header row.
function readRows(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { idx: {}, rows: [] };
  const idx = headerIndex(lines[0]);
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) rows[i - 1] = splitCsvLine(lines[i]);
  return { idx, rows };
}

// ---------------------------------------------------------------------------
// stop_times.txt: streamed line-by-line, never fs.readFileSync (100MB+ files).
// Two passes: (1) count stops per candidate trip; (2) collect ordered stop_id
// sequences for only the chosen (fullest) trip per route+direction.
// ---------------------------------------------------------------------------
async function countStopsPerTrip(filePath, tripMap) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let idx = null;
  const counts = new Map();
  for await (const line of rl) {
    if (idx === null) { idx = headerIndex(line); continue; }
    if (!line) continue;
    const f = splitCsvLine(line);
    const tid = f[idx.trip_id];
    if (!tripMap.has(tid)) continue;
    counts.set(tid, (counts.get(tid) || 0) + 1);
  }
  return counts;
}
async function collectSequences(filePath, chosenTripIds) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let idx = null;
  const seqByTrip = new Map();
  for await (const line of rl) {
    if (idx === null) { idx = headerIndex(line); continue; }
    if (!line) continue;
    const f = splitCsvLine(line);
    const tid = f[idx.trip_id];
    if (!chosenTripIds.has(tid)) continue;
    const stopId = f[idx.stop_id];
    const seq = Number(f[idx.stop_sequence]);
    if (!seqByTrip.has(tid)) seqByTrip.set(tid, []);
    seqByTrip.get(tid).push({ stopId, seq });
  }
  for (const arr of seqByTrip.values()) arr.sort((a, b) => a.seq - b.seq);
  return seqByTrip;
}

// ---------------------------------------------------------------------------
// Douglas-Peucker polyline simplification (open polyline; same pattern as
// scripts/build-tiles.mjs's skyline simplifier).
// ---------------------------------------------------------------------------
function perpendicularDistance(p, a, b) {
  const [x, z] = p, [x1, z1] = a, [x2, z2] = b;
  const dx = x2 - x1, dz = z2 - z1;
  if (dx === 0 && dz === 0) return Math.hypot(x - x1, z - z1);
  const t = ((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz);
  return Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz));
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

// ---------------------------------------------------------------------------
// Point in polygon: even-odd across ALL rings (mirrors hoodAt in World.ts).
// ---------------------------------------------------------------------------
function pointInRings(x, z, rings) {
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

// ---------------------------------------------------------------------------
// Shape geometry helpers: arc-length table, monotonic nearest-point
// projection, and interpolated cut points for truncation.
// ---------------------------------------------------------------------------
function cumulativeLengths(polyline) {
  const cum = new Array(polyline.length);
  cum[0] = 0;
  for (let i = 1; i < polyline.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1]);
  }
  return cum;
}
// Nearest point on the polyline at-or-after sFloor (routes double back, so a
// plain global nearest-point match can jump backward). Returns {dist, s}.
function projectMonotonic(polyline, cum, point, sFloor) {
  let best = null;
  for (let i = 0; i < polyline.length - 1; i++) {
    const segStartS = cum[i], segEndS = cum[i + 1];
    if (segEndS < sFloor) continue;
    const p0 = polyline[i], p1 = polyline[i + 1];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const segLen = segEndS - segStartS;
    let tMin = 0;
    if (segStartS < sFloor && segLen > 1e-9) tMin = Math.min(1, Math.max(0, (sFloor - segStartS) / segLen));
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 1e-12 ? ((point[0] - p0[0]) * dx + (point[1] - p0[1]) * dz) / lenSq : 0;
    t = Math.max(tMin, Math.min(1, t));
    const px = p0[0] + t * dx, pz = p0[1] + t * dz;
    const dist = Math.hypot(point[0] - px, point[1] - pz);
    const s = segStartS + t * segLen;
    if (!best || dist < best.dist) best = { dist, s };
  }
  return best;
}
function pointAtS(polyline, cum, s) {
  const last = cum.length - 1;
  if (s <= cum[0]) return polyline[0];
  if (s >= cum[last]) return polyline[polyline.length - 1];
  let i = 0;
  while (i < last - 1 && cum[i + 1] < s) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 1e-9 ? (s - cum[i]) / segLen : 0;
  return [polyline[i][0] + t * (polyline[i + 1][0] - polyline[i][0]), polyline[i][1] + t * (polyline[i + 1][1] - polyline[i][1])];
}
function sliceShapeAtS(polyline, cum, sStart, sEnd) {
  const startPt = pointAtS(polyline, cum, sStart);
  const endPt = pointAtS(polyline, cum, sEnd);
  const mid = [];
  for (let i = 0; i < polyline.length; i++) {
    if (cum[i] > sStart && cum[i] < sEnd) mid.push(polyline[i]);
  }
  const out = [startPt, ...mid, endPt];
  const dedup = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.hypot(out[i][0] - prev[0], out[i][1] - prev[1]) > 1e-6) dedup.push(out[i]);
  }
  return dedup;
}
function longestRun(flags) {
  const runs = [];
  let start = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) { if (start === null) start = i; }
    else if (start !== null) { runs.push([start, i - 1]); start = null; }
  }
  if (start !== null) runs.push([start, flags.length - 1]);
  if (runs.length === 0) return null;
  runs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  return runs[0];
}
function flatShapeLengthMeters(flat) {
  let len = 0;
  for (let i = 2; i < flat.length; i += 2) len += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]);
  return len;
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------
function routeSortKey(id) {
  const m = /^([A-Za-z]+)(\d+)?(.*)$/.exec(id);
  if (!m) return [id, -1, ''];
  return [m[1], m[2] ? Number(m[2]) : -1, m[3] ?? ''];
}
function compareRouteIds(a, b) {
  const ka = routeSortKey(a), kb = routeSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}
function compareStopIds(a, b) {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Per-feed processing: routes.txt -> trips.txt -> shapes.txt -> stops.txt ->
// stop_times.txt (streamed, 2 passes) -> per (route,direction) candidate.
// ---------------------------------------------------------------------------
async function processFeed(feed, outlineRings) {
  const dir = await ensureFeedReady(feed);

  // ---- routes.txt: candidate route metadata (express/shuttle excluded) ----
  const { idx: rIdx, rows: rRows } = readRows(path.join(dir, 'routes.txt'));
  const routeMeta = new Map(); // route_id -> {shortName, longName, color}
  let excludedExpress = 0;
  for (const f of rRows) {
    const routeId = (f[rIdx.route_id] ?? '').trim();
    if (!routeId) continue;
    let shortName = (f[rIdx.route_short_name] ?? '').trim();
    const longName = (f[rIdx.route_long_name] ?? '').trim();
    const colorRaw = (f[rIdx.route_color] ?? '').trim().replace(/^#/, '');
    if (!shortName) shortName = routeId;
    if (EXPRESS_RE.test(routeId) || EXPRESS_RE.test(shortName)) { excludedExpress++; continue; }
    routeMeta.set(routeId, { shortName, longName, color: colorRaw ? `#${colorRaw.toLowerCase()}` : BUS_DEFAULT_COLOR });
  }

  // ---- trips.txt: only trips of candidate routes ----
  const { idx: tIdx, rows: tRows } = readRows(path.join(dir, 'trips.txt'));
  const tripMap = new Map(); // trip_id -> {route_id, direction_id, headsign, shape_id}
  const referencedShapeIds = new Set();
  for (const f of tRows) {
    const routeId = f[tIdx.route_id];
    if (!routeMeta.has(routeId)) continue;
    const dirId = (f[tIdx.direction_id] ?? '').trim();
    if (dirId !== '0' && dirId !== '1') continue;
    const tripId = f[tIdx.trip_id];
    const headsign = (f[tIdx.trip_headsign] ?? '').trim();
    const shapeId = (f[tIdx.shape_id] ?? '').trim();
    tripMap.set(tripId, { route_id: routeId, direction_id: dirId, headsign, shape_id: shapeId });
    if (shapeId) referencedShapeIds.add(shapeId);
  }

  // ---- shapes.txt: only shapes referenced by a candidate trip ----
  const shapePoints = new Map(); // shape_id -> [{seq, lon, lat}] sorted
  const shapesPath = path.join(dir, 'shapes.txt');
  if (fs.existsSync(shapesPath)) {
    const { idx: sIdx, rows: sRows } = readRows(shapesPath);
    for (const f of sRows) {
      const shapeId = f[sIdx.shape_id];
      if (!referencedShapeIds.has(shapeId)) continue;
      const lat = parseFloat(f[sIdx.shape_pt_lat]);
      const lon = parseFloat(f[sIdx.shape_pt_lon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const seq = Number(f[sIdx.shape_pt_sequence]);
      if (!shapePoints.has(shapeId)) shapePoints.set(shapeId, []);
      shapePoints.get(shapeId).push({ seq, lon, lat });
    }
    for (const arr of shapePoints.values()) arr.sort((a, b) => a.seq - b.seq);
  }

  // ---- stops.txt ----
  const { idx: stIdx, rows: stRows } = readRows(path.join(dir, 'stops.txt'));
  const stopsById = new Map(); // stop_id -> {name, lon, lat}
  for (const f of stRows) {
    const stopId = f[stIdx.stop_id];
    if (!stopId) continue;
    const lat = parseFloat(f[stIdx.stop_lat]);
    const lon = parseFloat(f[stIdx.stop_lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stopsById.set(stopId, { name: (f[stIdx.stop_name] ?? '').trim(), lon, lat });
  }

  // ---- stop_times.txt pass 1/2: count stops per candidate trip (streamed) ----
  const counts = await countStopsPerTrip(path.join(dir, 'stop_times.txt'), tripMap);

  // ---- choose the fullest trip per route+direction, preferring a shape ----
  const bestByRouteDir = new Map(); // "route|dir" -> {tripId, count, hasShape}
  for (const [tripId, count] of counts) {
    const info = tripMap.get(tripId);
    const hasShape = !!(info.shape_id && shapePoints.has(info.shape_id));
    const key = `${info.route_id}|${info.direction_id}`;
    const cur = bestByRouteDir.get(key);
    if (!cur || count > cur.count || (count === cur.count && hasShape && !cur.hasShape)) {
      bestByRouteDir.set(key, { tripId, count, hasShape });
    }
  }
  const chosenTripIds = new Set([...bestByRouteDir.values()].map((v) => v.tripId));

  // ---- stop_times.txt pass 2/2: ordered stop sequences for chosen trips ----
  const seqByTrip = await collectSequences(path.join(dir, 'stop_times.txt'), chosenTripIds);

  // ---- build per (route,direction) candidate: shape, monotonic stop
  //      projection, Manhattan clip + truncate, rebase, dest ----
  const candidates = new Map(); // shortName -> {meta, dirs:[{dirId,dest,shape,stops}]}
  for (const [key, sel] of bestByRouteDir) {
    const [routeId, dirId] = key.split('|');
    const meta = routeMeta.get(routeId);
    const tripInfo = tripMap.get(sel.tripId);
    const rows = (seqByTrip.get(sel.tripId) || []).slice().sort((a, b) => a.seq - b.seq);
    if (rows.length === 0) continue;

    const stopRows = [];
    for (const r of rows) {
      const s = stopsById.get(r.stopId);
      if (!s) continue;
      const [x, z] = lonLatToXZ(s.lon, s.lat);
      stopRows.push({ stopId: r.stopId, name: s.name, x, z });
    }
    if (stopRows.length === 0) continue;

    let shapePoly;
    if (tripInfo.shape_id && shapePoints.has(tripInfo.shape_id)) {
      shapePoly = shapePoints.get(tripInfo.shape_id).map((p) => lonLatToXZ(p.lon, p.lat));
    } else {
      shapePoly = stopRows.map((r) => [r.x, r.z]); // fallback: polyline through stops
    }
    shapePoly = shapePoly.filter((p, i) => i === 0 || Math.hypot(p[0] - shapePoly[i - 1][0], p[1] - shapePoly[i - 1][1]) > 1e-6);
    if (shapePoly.length < 2) continue;
    const cum = cumulativeLengths(shapePoly);

    // Monotonic projection: search only at-or-after the previous KEPT stop's s.
    const projected = [];
    let sFloor = -Infinity;
    for (const r of stopRows) {
      const best = projectMonotonic(shapePoly, cum, [r.x, r.z], sFloor);
      if (!best || best.dist > 60) continue; // data glitch: drop this stop
      projected.push({ stopId: r.stopId, name: r.name, x: r.x, z: r.z, s: best.s });
      sFloor = best.s;
    }
    if (projected.length < 2) continue;

    // Manhattan clip: longest contiguous in-polygon run of stops.
    const flags = projected.map((p) => pointInRings(p.x, p.z, outlineRings));
    const run = longestRun(flags);
    if (!run) continue;
    const kept = projected.slice(run[0], run[1] + 1);
    if (kept.length < 2) continue;

    const sStart = Math.max(0, kept[0].s - 40);
    const sEnd = Math.min(cum[cum.length - 1], kept[kept.length - 1].s + 40);
    const truncated = sliceShapeAtS(shapePoly, cum, sStart, sEnd);
    const rebased = kept.map((p) => ({ ...p, s: p.s - sStart }));
    for (let i = 1; i < rebased.length; i++) {
      if (rebased[i].s <= rebased[i - 1].s) rebased[i].s = rebased[i - 1].s + 0.1; // rounding/glitch safety net
    }

    let dest = (tripInfo.headsign || '').toUpperCase().trim();
    if (!dest) dest = rebased[rebased.length - 1].name.toUpperCase().trim();
    if (dest.length > 30) dest = dest.slice(0, 30).trim();

    if (!candidates.has(meta.shortName)) candidates.set(meta.shortName, { meta, dirs: [] });
    candidates.get(meta.shortName).dirs.push({ dirId, dest, shape: truncated, stops: rebased });
  }

  // Normalize: dedupe directions by dirId (keep the longer one), cap at 2.
  for (const rec of candidates.values()) {
    const byDir = new Map();
    for (const d of rec.dirs) {
      const cur = byDir.get(d.dirId);
      if (!cur || d.stops.length > cur.stops.length) byDir.set(d.dirId, d);
    }
    rec.dirs = [...byDir.values()].sort((a, b) => a.dirId.localeCompare(b.dirId)).slice(0, 2);
  }

  return { candidates, excludedExpress, totalRoutesSeen: routeMeta.size };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== fetch-buses: building public/geo/buses.json ===');

  const outline = JSON.parse(fs.readFileSync(OUTLINE_FILE, 'utf8'));
  const outlineRings = outline.rings;
  let bbMinX = Infinity, bbMinZ = Infinity, bbMaxX = -Infinity, bbMaxZ = -Infinity;
  for (const ring of outlineRings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i], z = ring[i + 1];
      if (x < bbMinX) bbMinX = x;
      if (x > bbMaxX) bbMaxX = x;
      if (z < bbMinZ) bbMinZ = z;
      if (z > bbMaxZ) bbMaxZ = z;
    }
  }

  const perFeed = [];
  for (const feed of FEEDS) {
    console.log(`\n--- feed: ${feed.name} ---`);
    const result = await processFeed(feed, outlineRings);
    console.log(`[${feed.name}] ${result.totalRoutesSeen} candidate routes after express/shuttle exclusion (${result.excludedExpress} excluded), ${result.candidates.size} produced >=1 kept direction`);
    perFeed.push({ feedName: feed.name, ...result });
  }

  // ---- qualify (>=4 kept stops in some direction) + dedupe across feeds ----
  const winners = new Map(); // shortName -> {dirs, meta, totalKept, feedName}
  const droppedForThreshold = [];
  const supersededByFeed = [];
  for (const { feedName, candidates } of perFeed) {
    for (const [shortName, rec] of candidates) {
      const maxDir = rec.dirs.length ? Math.max(...rec.dirs.map((d) => d.stops.length)) : 0;
      const totalKept = rec.dirs.reduce((a, d) => a + d.stops.length, 0);
      if (maxDir < 4) {
        droppedForThreshold.push(`${shortName} [${feedName}] (best direction only ${maxDir} Manhattan stop(s))`);
        continue;
      }
      const cur = winners.get(shortName);
      if (!cur) {
        winners.set(shortName, { dirs: rec.dirs, meta: rec.meta, totalKept, feedName });
      } else if (totalKept > cur.totalKept) {
        supersededByFeed.push(`${shortName}: ${feedName} (${totalKept} stops) replaced ${cur.feedName} (${cur.totalKept} stops)`);
        winners.set(shortName, { dirs: rec.dirs, meta: rec.meta, totalKept, feedName });
      } else {
        supersededByFeed.push(`${shortName}: kept ${cur.feedName} (${cur.totalKept} stops) over ${feedName} (${totalKept} stops)`);
      }
    }
  }

  // ---- assemble output (adaptive Douglas-Peucker tolerance for size budget) ----
  function buildOutput(tolerance) {
    const stopsById = new Map(); // stopId -> {n, p}
    const stopRoutes = new Map(); // stopId -> Set(shortName)
    const routesArr = [];
    for (const [shortName, w] of winners) {
      const dirsOut = w.dirs.map((d) => {
        const simp = d.shape.length > 2 ? douglasPeucker(d.shape, tolerance) : d.shape.slice();
        const flatShape = simp.flatMap((p) => [round1(p[0]), round1(p[1])]);
        // Douglas-Peucker only guarantees simplified length <= original length;
        // an out-and-back "spike" in the source shape data (e.g. a terminal
        // loop) can collapse by much more than the tolerance would suggest
        // (seen on M101: 164m). s was computed against the ORIGINAL polyline,
        // so clamp it to the simplified shape's actual length, then re-enforce
        // strict monotonicity backward from the clamp.
        const totalLen = flatShapeLengthMeters(flatShape);
        const sVals = d.stops.map((s) => s.s);
        if (sVals.length && sVals[sVals.length - 1] > totalLen) sVals[sVals.length - 1] = totalLen;
        for (let i = sVals.length - 2; i >= 0; i--) {
          if (sVals[i] >= sVals[i + 1]) sVals[i] = sVals[i + 1] - 0.1;
        }
        const stopsOut = d.stops.map((s, i) => {
          if (!stopsById.has(s.stopId)) stopsById.set(s.stopId, { n: s.name, p: [round1(s.x), round1(s.z)] });
          if (!stopRoutes.has(s.stopId)) stopRoutes.set(s.stopId, new Set());
          stopRoutes.get(s.stopId).add(shortName);
          return { id: s.stopId, s: round1(sVals[i]) };
        });
        return { dest: d.dest, shape: flatShape, stops: stopsOut };
      });
      const sbs = /sbs/i.test(shortName) || shortName.includes('+');
      routesArr.push({ id: shortName, name: w.meta.longName, color: w.meta.color, sbs, dirs: dirsOut });
    }
    routesArr.sort((a, b) => compareRouteIds(a.id, b.id));

    const stopsOutObj = {};
    for (const id of [...stopsById.keys()].sort(compareStopIds)) {
      stopsOutObj[id] = { n: stopsById.get(id).n, p: stopsById.get(id).p, r: [...stopRoutes.get(id)].sort(compareRouteIds) };
    }
    const data = { v: 1, routes: routesArr, stops: stopsOutObj };
    const json = JSON.stringify(data);
    return { data, json };
  }

  let tolerance = 1.25;
  let { data, json } = buildOutput(tolerance);
  let bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > 2_500_000) {
    console.log(`\n[size] ${(bytes / 1024 / 1024).toFixed(2)}MB with tolerance=1.25m exceeds the 2.5MB budget; retrying with tolerance=2m`);
    tolerance = 2.0;
    ({ data, json } = buildOutput(tolerance));
    bytes = Buffer.byteLength(json, 'utf8');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, json);

  // -------------------------------------------------------------------
  // Verify (re-read from disk, exactly as a consumer would)
  // -------------------------------------------------------------------
  const warnings = [];
  const reread = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (reread.v !== 1 || !Array.isArray(reread.routes) || typeof reread.stops !== 'object') {
    warnings.push('top-level shape does not conform to BusData {v:1, routes:[], stops:{}}');
  }
  const sampleRoute = reread.routes[0];
  if (sampleRoute) {
    for (const k of ['id', 'name', 'color', 'sbs', 'dirs']) {
      if (!(k in sampleRoute)) warnings.push(`sample route missing field '${k}'`);
    }
    const sampleDir = sampleRoute.dirs[0];
    if (sampleDir) {
      for (const k of ['dest', 'shape', 'stops']) if (!(k in sampleDir)) warnings.push(`sample dir missing field '${k}'`);
    }
  } else warnings.push('routes array is empty');
  const sampleStopId = Object.keys(reread.stops)[0];
  if (sampleStopId) {
    const s = reread.stops[sampleStopId];
    if (!('n' in s) || !('p' in s) || !('r' in s) || !Array.isArray(s.p) || s.p.length !== 2) {
      warnings.push('sample stop entry does not conform to BusStopInfo {n,p:[x,z],r:[]}');
    }
  } else warnings.push('stops dict is empty');

  const routeCount = reread.routes.length;
  if (routeCount < 40 || routeCount > 60) warnings.push(`route count ${routeCount} outside expected 40-60`);
  const stopCount = Object.keys(reread.stops).length;
  if (stopCount < 1500 || stopCount > 3000) warnings.push(`unique stop count ${stopCount} outside expected 1500-3000`);
  if (bytes > 2_500_000) warnings.push(`file size ${(bytes / 1024 / 1024).toFixed(2)}MB exceeds the 2.5MB target even at tolerance=2m`);

  const routesById = new Map(reread.routes.map((r) => [r.id, r]));
  const boroughCounts = {};
  for (const r of reread.routes) {
    const prefix = (/^([A-Za-z]+)/.exec(r.id) || [, r.id])[1];
    boroughCounts[prefix] = (boroughCounts[prefix] || 0) + 1;
  }

  const allStopIds = new Set(Object.keys(reread.stops));
  const referencedStopIds = new Set();
  let badRefs = 0;
  for (const r of reread.routes) {
    for (const d of r.dirs) {
      if (!d.dest) warnings.push(`${r.id}: empty dest`);
      if (d.stops.length < 2) warnings.push(`${r.id}: dir has <2 stops (${d.stops.length})`);
      const totalLen = flatShapeLengthMeters(d.shape);
      for (let i = 0; i < d.stops.length; i++) {
        const st = d.stops[i];
        referencedStopIds.add(st.id);
        if (!allStopIds.has(st.id)) badRefs++;
        if (i > 0 && st.s <= d.stops[i - 1].s) warnings.push(`${r.id}: s not strictly increasing at index ${i}`);
      }
      if (d.stops[0] && d.stops[0].s < -0.1) warnings.push(`${r.id}: first s ${d.stops[0].s} < -0.1`);
      const lastS = d.stops[d.stops.length - 1]?.s ?? 0;
      if (lastS > totalLen + 1) warnings.push(`${r.id}: last s ${lastS} > shape length ${totalLen.toFixed(1)} + 1`);
      for (let i = 0; i < d.shape.length; i += 2) {
        const x = d.shape[i], z = d.shape[i + 1];
        if (x < bbMinX - 300 || x > bbMaxX + 300 || z < bbMinZ - 300 || z > bbMaxZ + 300) {
          warnings.push(`${r.id}: shape point (${x},${z}) outside outline bbox+300m`);
          break;
        }
      }
    }
  }
  if (badRefs > 0) warnings.push(`${badRefs} dir-stop references do not resolve in the stops dict`);
  const unreferencedStops = [...allStopIds].filter((id) => !referencedStopIds.has(id));
  if (unreferencedStops.length > 0) warnings.push(`${unreferencedStops.length} stops-dict entries are not referenced by any dir`);

  // Watchlist: named routes the spec expects to see present.
  const WATCHLIST = [
    { label: 'M15', ids: ['M15', 'M15-SBS'], need2Dirs: true },
    { label: 'M4', ids: ['M4'] },
    { label: 'M14D', ids: ['M14D-SBS', 'M14D'] },
    { label: 'M42', ids: ['M42'] },
    { label: 'M60', ids: ['M60-SBS', 'M60'] },
    { label: 'M116', ids: ['M116'] },
    { label: 'Bx7', ids: ['Bx7'] },
  ];
  const watchlistReport = [];
  for (const w of WATCHLIST) {
    const foundId = w.ids.find((id) => routesById.has(id));
    if (!foundId) {
      watchlistReport.push(`${w.label}: MISSING (checked ${w.ids.join('/')})`);
      warnings.push(`watchlist route missing: ${w.label}`);
      continue;
    }
    const r = routesById.get(foundId);
    const dirDesc = r.dirs.map((d) => `${d.stops.length} stops/${(flatShapeLengthMeters(d.shape) / 1000).toFixed(1)}km`).join(', ');
    watchlistReport.push(`${foundId}: ${r.dirs.length} dir(s) [${dirDesc}]`);
    if (w.need2Dirs && r.dirs.length !== 2) warnings.push(`${foundId}: expected 2 dirs, found ${r.dirs.length}`);
  }
  for (const id of ['M1', 'M2', 'M3', 'M4']) {
    const r = routesById.get(id);
    if (!r) continue;
    const maxKm = Math.max(...r.dirs.map((d) => flatShapeLengthMeters(d.shape) / 1000));
    if (maxKm < 7.5) warnings.push(`${id}: longest dir shape ${maxKm.toFixed(1)}km, expected roughly >=8km`);
  }

  // -------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------
  console.log('\n--- REPORT ---');
  console.log(`routes: ${routeCount} | unique stops: ${stopCount} | file size: ${(bytes / 1024).toFixed(0)}KB | RDP tolerance: ${tolerance}m`);
  console.log(`by prefix: ${Object.entries(boroughCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log('watchlist:');
  for (const line of watchlistReport) console.log(`  ${line}`);
  if (droppedForThreshold.length) {
    console.log(`dropped for <4-stop threshold (${droppedForThreshold.length}):`);
    for (const d of droppedForThreshold.slice(0, 20)) console.log(`  - ${d}`);
    if (droppedForThreshold.length > 20) console.log(`  ... and ${droppedForThreshold.length - 20} more`);
  }
  if (supersededByFeed.length) {
    console.log(`cross-feed dedupe decisions (${supersededByFeed.length}):`);
    for (const d of supersededByFeed.slice(0, 20)) console.log(`  - ${d}`);
  }
  if (warnings.length) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    for (const w of warnings.slice(0, 40)) console.log(' -', w);
  } else {
    console.log('\nall validations passed.');
  }
  console.log(`\nwrote ${OUT}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
