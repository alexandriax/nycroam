#!/usr/bin/env node
// scripts/fetch-network.mjs
//
// Builds public/subway/network.json: for every subway route serving
// Manhattan, the ordered south->north sequence of Manhattan stations it
// stops at, plus clamped inter-station travel times -- so the app can
// simulate rideable trains.
//
// Source: MTA NYCT Subway GTFS static (routes.txt, trips.txt, stop_times.txt).
// stop_times.txt is streamed line-by-line (never loaded whole).
//
// Usage:
//   node scripts/fetch-network.mjs            (uses data/cache/ if already populated)
//   node scripts/fetch-network.mjs --refresh   (bypasses cache, re-downloads/re-extracts)
//
// Coordinate system (only needed for the OSM fallback path) MUST match
// src/engine/geo.ts exactly:
//   x = (lon - (-73.9855)) * 84327
//   z = -(lat - 40.758) * 111132

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const GTFS_DIR = path.join(CACHE_DIR, 'gtfs');
const ZIP_PATH = path.join(CACHE_DIR, 'gtfs_subway.zip');
const SUBWAY_JSON = path.join(ROOT, 'public', 'subway', 'subway.json');
const OUT_FILE = path.join(ROOT, 'public', 'subway', 'network.json');

const REFRESH = process.argv.includes('--refresh');
const UA = 'nycroam-network-fetch/1.0 (+data pipeline script)';

// ---------------------------------------------------------------------------
// Coordinate system (duplicated from src/engine/geo.ts -- keep in exact sync)
// Only used by the OSM Overpass fallback path.
// ---------------------------------------------------------------------------
const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
function lonLatToXZ(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

// ---------------------------------------------------------------------------
// Route colors
// ---------------------------------------------------------------------------
const ROUTE_COLORS = {
  1: '#EE352E', 2: '#EE352E', 3: '#EE352E',
  4: '#00933C', 5: '#00933C', 6: '#00933C',
  7: '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  S: '#808183',
};
function colorFor(routeId) {
  return ROUTE_COLORS[routeId] ?? '#808183';
}

function routeSortKey(id) {
  return /^\d+$/.test(id) ? [0, Number(id)] : [1, id];
}
function compareRoutes(a, b) {
  const ka = routeSortKey(a);
  const kb = routeSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[0] === 0) return ka[1] - kb[1];
  return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Generic fetch with retry + exponential backoff (binary-safe)
// ---------------------------------------------------------------------------
async function fetchBufferWithRetry(url, { attempts = 3, timeoutMs = 240000 } = {}) {
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
        const backoff = 2000 * (i + 1);
        console.warn(`  attempt ${i + 1}/${attempts} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function fetchTextWithRetry(url, opts = {}, attempts = 2, timeoutMs = 190000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < attempts - 1) {
        const backoff = 2000 * (i + 1);
        console.warn(`  attempt ${i + 1}/${attempts} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// GTFS download + extraction
// ---------------------------------------------------------------------------
const GTFS_SOURCES = [
  'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
  'http://web.mta.info/developers/data/nyct/subway/google_transit.zip',
];

async function downloadGtfsZip() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!REFRESH && fs.existsSync(ZIP_PATH) && fs.statSync(ZIP_PATH).size > 1_000_000) {
    console.log('[gtfs] using cached zip (data/cache/gtfs_subway.zip)');
    return { source: 'cache' };
  }
  let lastErr;
  for (const url of GTFS_SOURCES) {
    try {
      console.log(`[gtfs] downloading ${url}`);
      const buf = await fetchBufferWithRetry(url);
      if (buf.length < 1_000_000 || buf.slice(0, 2).toString('latin1') !== 'PK') {
        throw new Error(`downloaded file looks invalid (size=${buf.length})`);
      }
      fs.writeFileSync(ZIP_PATH, buf);
      console.log(`[gtfs] downloaded ${buf.length} bytes from ${url}`);
      return { source: url };
    } catch (err) {
      console.warn(`[gtfs] source failed (${url}): ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('all GTFS sources failed');
}

function unzipGtfs() {
  const needed = ['routes.txt', 'trips.txt', 'stop_times.txt'].map((f) => path.join(GTFS_DIR, f));
  if (!REFRESH && needed.every((f) => fs.existsSync(f) && fs.statSync(f).size > 0)) {
    console.log('[gtfs] using previously extracted files (data/cache/gtfs/)');
    return;
  }
  fs.mkdirSync(GTFS_DIR, { recursive: true });
  console.log('[gtfs] unzipping data/cache/gtfs_subway.zip -> data/cache/gtfs/');
  execFileSync('unzip', ['-o', ZIP_PATH, '-d', GTFS_DIR], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const f of needed) {
    if (!fs.existsSync(f)) throw new Error(`expected file missing after unzip: ${f}`);
  }
}

async function ensureGtfsReady() {
  await downloadGtfsZip();
  unzipGtfs();
}

// ---------------------------------------------------------------------------
// CSV helpers (fast path for unquoted lines; full parse only if a quote is present)
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
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
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

function parseGtfsTimeToSeconds(s) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parentStopId(stopId) {
  if (/[NS]$/.test(stopId)) return stopId.slice(0, -1);
  return stopId;
}

// ---------------------------------------------------------------------------
// routes.txt -> route ids (skip SIR, skip express variants that duplicate a
// base route_id, e.g. "6X"/"7X"/"FX" when "6"/"7"/"F" already exist)
// ---------------------------------------------------------------------------
function readRouteIds() {
  const text = fs.readFileSync(path.join(GTFS_DIR, 'routes.txt'), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const idx = headerIndex(lines[0]);
  const raw = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const routeId = (f[idx.route_id] ?? '').trim();
    if (routeId) raw.push(routeId);
  }
  const rawSet = new Set(raw);
  const filtered = raw.filter((id) => {
    if (id === 'SI') return false; // Staten Island Railway
    if (id.length > 1 && id.endsWith('X') && rawSet.has(id.slice(0, -1))) return false; // express dup
    return true;
  });
  return { all: raw, filtered };
}

// ---------------------------------------------------------------------------
// trips.txt -> trip_id -> {route_id, direction_id} (only for routes we keep)
// ---------------------------------------------------------------------------
function readTripMap(routeIdSet) {
  const text = fs.readFileSync(path.join(GTFS_DIR, 'trips.txt'), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const idx = headerIndex(lines[0]);
  const tripMap = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const routeId = f[idx.route_id];
    if (!routeIdSet.has(routeId)) continue;
    const tripId = f[idx.trip_id];
    const directionId = f[idx.direction_id];
    tripMap.set(tripId, { route_id: routeId, direction_id: directionId });
  }
  return tripMap;
}

// ---------------------------------------------------------------------------
// Pass 1: stream stop_times.txt, count stops per relevant trip_id
// ---------------------------------------------------------------------------
async function countStopsPerTrip(tripMap) {
  const filePath = path.join(GTFS_DIR, 'stop_times.txt');
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let idx = null;
  const counts = new Map(); // trip_id -> count, insertion order = first-seen order in file
  for await (const line of rl) {
    if (idx === null) {
      idx = headerIndex(line);
      continue;
    }
    if (!line) continue;
    // trip_id column position varies by feed; use header index generically.
    const f = splitCsvLine(line);
    const tid = f[idx.trip_id];
    if (!tripMap.has(tid)) continue;
    counts.set(tid, (counts.get(tid) || 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Choose canonical trip per route: prefer direction_id=0 max stop count;
// fall back to direction_id=1 only if a route has no direction-0 trips at all.
// ---------------------------------------------------------------------------
function chooseCanonicalTrips(counts, tripMap, routeIds) {
  const bestByRouteDir = new Map(); // "route|dir" -> {tripId, count}
  for (const [tripId, count] of counts) {
    const info = tripMap.get(tripId);
    const key = `${info.route_id}|${info.direction_id}`;
    const cur = bestByRouteDir.get(key);
    if (!cur || count > cur.count) bestByRouteDir.set(key, { tripId, count });
  }
  const chosen = new Map(); // route_id -> {tripId, count, direction}
  const fallbackDirectionRoutes = [];
  const missingRoutes = [];
  for (const route of routeIds) {
    const d0 = bestByRouteDir.get(`${route}|0`);
    const d1 = bestByRouteDir.get(`${route}|1`);
    if (d0) {
      chosen.set(route, { ...d0, direction: '0' });
    } else if (d1) {
      chosen.set(route, { ...d1, direction: '1' });
      fallbackDirectionRoutes.push(route);
    } else {
      missingRoutes.push(route);
    }
  }
  return { chosen, fallbackDirectionRoutes, missingRoutes };
}

// ---------------------------------------------------------------------------
// Pass 2: stream stop_times.txt again, collect ordered stop sequences for the
// chosen canonical trip ids only.
// ---------------------------------------------------------------------------
async function collectSequences(chosenTripIds) {
  const filePath = path.join(GTFS_DIR, 'stop_times.txt');
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let idx = null;
  const seqByTrip = new Map();
  for await (const line of rl) {
    if (idx === null) {
      idx = headerIndex(line);
      continue;
    }
    if (!line) continue;
    const f = splitCsvLine(line);
    const tid = f[idx.trip_id];
    if (!chosenTripIds.has(tid)) continue;
    const stopId = f[idx.stop_id];
    const seq = Number(f[idx.stop_sequence]);
    const arrivalRaw = f[idx.arrival_time] || f[idx.departure_time];
    const arrival = parseGtfsTimeToSeconds(arrivalRaw);
    if (!seqByTrip.has(tid)) seqByTrip.set(tid, []);
    seqByTrip.get(tid).push({ stopId, seq, arrival });
  }
  for (const arr of seqByTrip.values()) arr.sort((a, b) => a.seq - b.seq);
  return seqByTrip;
}

// ---------------------------------------------------------------------------
// Find the longest contiguous run of Manhattan stops within an ordered
// sequence; return { run, gapDetected, runCount }.
// ---------------------------------------------------------------------------
function longestManhattanRun(rows, stationById) {
  const isMh = rows.map((r) => stationById.has(r.parentId));
  const runs = [];
  let start = null;
  for (let i = 0; i < isMh.length; i++) {
    if (isMh[i]) {
      if (start === null) start = i;
    } else if (start !== null) {
      runs.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, isMh.length - 1]);
  if (runs.length === 0) return { run: null, gapDetected: false, runCount: 0 };
  runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  return { run: runs[0], gapDetected: runs.length > 1, runCount: runs.length };
}

// ---------------------------------------------------------------------------
// Main GTFS pipeline
// ---------------------------------------------------------------------------
async function buildFromGtfs(stationById) {
  const { all: allRouteIds, filtered: routeIds } = readRouteIds();
  const expressSkipped = allRouteIds.filter((id) => !routeIds.includes(id) && id !== 'SI');
  console.log(`[routes] ${allRouteIds.length} raw route ids; kept ${routeIds.length} (skipped SI, express dups: ${expressSkipped.join(',') || 'none'})`);

  const routeIdSet = new Set(routeIds);
  const tripMap = readTripMap(routeIdSet);
  console.log(`[trips] loaded ${tripMap.size} trips for kept routes`);

  console.log('[stop_times] pass 1/2: counting stops per trip (streaming)...');
  const counts = await countStopsPerTrip(tripMap);
  console.log(`[stop_times] pass 1 done: ${counts.size} distinct trips observed`);

  const { chosen, fallbackDirectionRoutes, missingRoutes } = chooseCanonicalTrips(counts, tripMap, routeIds);
  const chosenTripIds = new Set([...chosen.values()].map((v) => v.tripId));

  console.log('[stop_times] pass 2/2: collecting ordered stop sequences for canonical trips...');
  const seqByTrip = await collectSequences(chosenTripIds);

  const results = {};
  const gapWarnings = [];
  const droppedRoutes = [];
  const perRouteStopCounts = [];

  for (const route of routeIds) {
    const sel = chosen.get(route);
    const outId = route === 'GS' ? 'S' : route;
    if (!sel) {
      droppedRoutes.push(`${outId} (no trips found at all)`);
      continue;
    }
    const rows = (seqByTrip.get(sel.tripId) || []).map((r) => ({ ...r, parentId: parentStopId(r.stopId) }));
    if (rows.length === 0) {
      droppedRoutes.push(`${outId} (canonical trip had 0 stop_times rows)`);
      continue;
    }
    const { run, gapDetected, runCount } = longestManhattanRun(rows, stationById);
    if (!run) {
      droppedRoutes.push(`${outId} (0 Manhattan stops)`);
      continue;
    }
    if (gapDetected) {
      gapWarnings.push(`${outId}: route left Manhattan and returned (${runCount} runs found) -- kept longest run`);
    }
    const [start, end] = run;
    const kept = rows.slice(start, end + 1);
    if (kept.length < 2) {
      droppedRoutes.push(`${outId} (<2 Manhattan stops: ${kept.length})`);
      continue;
    }
    let stops = kept.map((r) => r.parentId);
    let times = [];
    for (let i = 0; i < kept.length - 1; i++) {
      const raw = kept[i + 1].arrival - kept[i].arrival;
      times.push(Math.max(45, Math.min(360, raw)));
    }
    // Orient south -> north: +z = south, so the south end has the larger z.
    const zFirst = stationById.get(stops[0]).pos[1];
    const zLast = stationById.get(stops[stops.length - 1]).pos[1];
    if (zFirst < zLast) {
      stops = stops.reverse();
      times = times.reverse();
    }
    results[outId] = { stops, t: times, color: colorFor(outId) };
    perRouteStopCounts.push(`${outId}: ${stops.length} stops` + (sel.direction === '1' ? ' [dir1 fallback]' : ''));
  }

  return {
    results,
    diagnostics: {
      allRouteIds,
      routeIds,
      expressSkipped,
      fallbackDirectionRoutes,
      missingRoutes,
      gapWarnings,
      droppedRoutes,
      perRouteStopCounts,
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback: OSM Overpass route relations (only used if both GTFS sources fail)
// ---------------------------------------------------------------------------
const NYC_BBOX = '40.4957,-74.2557,40.9176,-73.7002';
const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function buildFromOsm(stations) {
  const query = `[out:json][timeout:180];\n(\n  relation["type"="route"]["route"="subway"](${NYC_BBOX});\n);\nout body;\n>;\nout skel qt;`;
  let data;
  let lastErr;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      console.log(`[osm-fallback] querying ${mirror}`);
      const text = await fetchTextWithRetry(
        mirror,
        { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: query },
        2,
        190000
      );
      data = JSON.parse(text);
      break;
    } catch (err) {
      console.warn(`[osm-fallback] mirror failed (${mirror}): ${err.message}`);
      lastErr = err;
    }
  }
  if (!data) throw new Error(`OSM fallback also failed: ${lastErr?.message}`);

  const nodesById = new Map();
  for (const el of data.elements) if (el.type === 'node') nodesById.set(el.id, el);
  const relations = data.elements.filter((el) => el.type === 'relation');

  const results = {};
  for (const rel of relations) {
    const tags = rel.tags || {};
    let label = (tags.ref || tags.name || '').trim();
    if (!label) continue;
    label = label.split(/[\s,/]/)[0].toUpperCase();
    if (label === 'SIR' || label === 'SI') continue;
    if (label === 'GS') label = 'S';

    const stopMembers = (rel.members || []).filter((m) => m.type === 'node' && (m.role === 'stop' || m.role === 'platform' || m.role === ''));
    const seq = [];
    for (const m of stopMembers) {
      const node = nodesById.get(m.ref);
      if (!node || typeof node.lat !== 'number') continue;
      const [x, z] = lonLatToXZ(node.lon, node.lat);
      let best = null;
      let bestDist = Infinity;
      for (const s of stations) {
        const d = Math.hypot(x - s.pos[0], z - s.pos[1]);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      if (best && bestDist <= 150 && (seq.length === 0 || seq[seq.length - 1].id !== best.id)) {
        seq.push({ id: best.id, pos: best.pos });
      }
    }
    if (seq.length < 2) continue;
    let ids = seq.map((s) => s.id);
    if (seq[0].pos[1] < seq[seq.length - 1].pos[1]) ids = ids.reverse();
    const times = new Array(ids.length - 1).fill(90);
    if (!results[label] || results[label].stops.length < ids.length) {
      results[label] = { stops: ids, t: times, color: colorFor(label) };
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== fetch-network: building public/subway/network.json ===');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const subway = JSON.parse(fs.readFileSync(SUBWAY_JSON, 'utf8'));
  const stations = subway.stations;
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const stationRouteUnion = new Set();
  for (const s of stations) for (const r of s.routes) stationRouteUnion.add(r);

  let results;
  let diagnostics = null;
  let usedFallback = false;
  let fallbackReason = null;

  try {
    await ensureGtfsReady();
    const out = await buildFromGtfs(stationById);
    results = out.results;
    diagnostics = out.diagnostics;
    if (Object.keys(results).length === 0) throw new Error('GTFS pipeline produced zero routes');
  } catch (err) {
    fallbackReason = err.message;
    console.warn(`[gtfs] pipeline failed: ${err.message}`);
    console.warn('[fallback] both GTFS downloads/processing failed -- falling back to OSM Overpass route relations');
    usedFallback = true;
    results = await buildFromOsm(stations);
  }

  // Sort route keys for a tidy, deterministic file.
  const ordered = {};
  for (const key of Object.keys(results).sort(compareRoutes)) ordered[key] = results[key];

  const output = { v: 1, routes: ordered };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const json = JSON.stringify(output);
  fs.writeFileSync(OUT_FILE, json);
  const bytes = Buffer.byteLength(json, 'utf8');

  // -------------------------------------------------------------------
  // Validate
  // -------------------------------------------------------------------
  const warnings = [];
  if (usedFallback) warnings.push(`FALLBACK USED: GTFS unavailable (${fallbackReason}); network.json derived from OSM with uniform 90s segments`);

  const routeKeys = Object.keys(ordered);
  if (routeKeys.length < 20 || routeKeys.length > 23) {
    warnings.push(`route count ${routeKeys.length} outside expected 20-23`);
  }

  let badStopRefs = 0;
  for (const [rid, r] of Object.entries(ordered)) {
    for (const sid of r.stops) if (!stationById.has(sid)) badStopRefs++;
    if (r.t.length !== r.stops.length - 1) warnings.push(`${rid}: t.length ${r.t.length} != stops.length-1 ${r.stops.length - 1}`);
  }
  if (badStopRefs > 0) warnings.push(`${badStopRefs} stop ids in network.json do not resolve in subway.json`);

  const missingFromOutput = [...stationRouteUnion].filter((r) => !ordered[r]);
  if (missingFromOutput.length) warnings.push(`routes present in subway.json stations but missing from network.json: ${missingFromOutput.join(',')}`);

  if (diagnostics) {
    for (const w of diagnostics.gapWarnings) warnings.push(w);
    if (diagnostics.fallbackDirectionRoutes.length) warnings.push(`routes using direction_id=1 fallback (no dir-0 trips): ${diagnostics.fallbackDirectionRoutes.join(',')}`);
    if (diagnostics.missingRoutes.length) warnings.push(`routes with zero trips found: ${diagnostics.missingRoutes.join(',')}`);
    for (const d of diagnostics.droppedRoutes) warnings.push(`dropped: ${d}`);
  }

  // Spot checks
  const r1 = ordered['1'];
  if (r1) {
    const has127 = r1.stops.includes('127');
    const has142 = r1.stops.includes('142');
    if (!(r1.stops.length >= 30 && r1.stops.length <= 38)) warnings.push(`route 1 stop count ${r1.stops.length} outside expected 30-38`);
    if (!has127 || !has142) warnings.push(`route 1 missing expected landmark stop(s): 127=${has127} 142=${has142}`);
  } else warnings.push('route 1 missing entirely');

  const rS = ordered['S'];
  if (rS) {
    if (rS.stops.length !== 2) warnings.push(`route S stop count ${rS.stops.length} != 2`);
    if (!(rS.stops.includes('902') && rS.stops.includes('901'))) warnings.push(`route S stops unexpected: ${JSON.stringify(rS.stops)}`);
  } else warnings.push('route S missing entirely');

  const r7 = ordered['7'];
  if (r7) {
    if (!(r7.stops.includes('726') && r7.stops.includes('723'))) warnings.push(`route 7 missing expected landmark stop(s): 726/723`);
  } else warnings.push('route 7 missing entirely');

  if (!ordered['L']) warnings.push('route L missing entirely');

  // -------------------------------------------------------------------
  // Report (<30 lines)
  // -------------------------------------------------------------------
  console.log('\n--- REPORT ---');
  console.log(`source: ${usedFallback ? 'OSM Overpass fallback' : 'MTA GTFS static'} | routes: ${routeKeys.length} | bytes: ${bytes}`);
  for (const rid of routeKeys) {
    const r = ordered[rid];
    console.log(`  ${rid}: ${r.stops.length} stops [${r.stops[0]} .. ${r.stops[r.stops.length - 1]}]`);
  }
  if (ordered['L']) console.log(`L stops detail: ${JSON.stringify(ordered['L'].stops)}`);
  if (warnings.length) {
    console.log(`WARNINGS/DEVIATIONS (${warnings.length}):`);
    for (const w of warnings.slice(0, 25)) console.log(' -', w);
  } else {
    console.log('all validations passed.');
  }
  console.log(`wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
