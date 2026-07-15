#!/usr/bin/env node
// scripts/fetch-subway.mjs
//
// Builds public/subway/subway.json from:
//   1. The MTA "Subway Stations" CSV (one row per station platform/complex-component)
//   2. OpenStreetMap subway_entrance nodes (via Overpass API)
//
// Usage:
//   node scripts/fetch-subway.mjs            (uses data/cache/ if already populated)
//   node scripts/fetch-subway.mjs --refresh   (bypasses cache, re-downloads everything)
//
// Coordinate system MUST match src/engine/geo.ts exactly:
//   x = (lon - (-73.9855)) * 84327
//   z = -(lat - 40.758) * 111132

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const OUT_DIR = path.join(ROOT, 'public', 'subway');
const OUT_FILE = path.join(OUT_DIR, 'subway.json');

const STATIONS_CACHE = path.join(CACHE_DIR, 'stations.csv');
const ENTRANCES_CACHE = path.join(CACHE_DIR, 'entrances.json');

const REFRESH = process.argv.includes('--refresh');

// ---------------------------------------------------------------------------
// Coordinate system (duplicated from src/engine/geo.ts -- keep in exact sync)
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

// ---------------------------------------------------------------------------
// Generic fetch with retry + exponential backoff
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, opts = {}, attempts = 4) {
  const { timeoutMs = 30000, ...fetchOpts } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < attempts - 1) {
        const backoff = 1000 * 2 ** i;
        console.warn(`  attempt ${i + 1}/${attempts} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------
const STATIONS_PRIMARY = 'https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD';
const STATIONS_FALLBACK = 'http://web.mta.info/developers/data/nyct/subway/Stations.csv';

async function getStationsCSV() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!REFRESH && fs.existsSync(STATIONS_CACHE) && fs.statSync(STATIONS_CACHE).size > 1000) {
    console.log('[stations] using cached CSV (data/cache/stations.csv)');
    return { text: fs.readFileSync(STATIONS_CACHE, 'utf8'), source: 'cache', fallbackUsed: false };
  }
  const headers = { 'User-Agent': 'nycworld-subway-fetch/1.0 (+data pipeline script)' };
  try {
    console.log('[stations] fetching primary: data.ny.gov');
    const text = await fetchWithRetry(STATIONS_PRIMARY, { headers });
    fs.writeFileSync(STATIONS_CACHE, text, 'utf8');
    return { text, source: 'primary (data.ny.gov)', fallbackUsed: false };
  } catch (err) {
    console.warn(`[stations] primary failed (${err.message}); trying fallback: web.mta.info`);
    const text = await fetchWithRetry(STATIONS_FALLBACK, { headers });
    fs.writeFileSync(STATIONS_CACHE, text, 'utf8');
    return { text, source: 'fallback (web.mta.info)', fallbackUsed: true };
  }
}

const OVERPASS_QUERY = `[out:json][timeout:120];
node["railway"="subway_entrance"](40.6980,-74.0260,40.8820,-73.9060);
out qt;`;
const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';

async function getEntrancesJSON() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!REFRESH && fs.existsSync(ENTRANCES_CACHE) && fs.statSync(ENTRANCES_CACHE).size > 100) {
    try {
      const cached = JSON.parse(fs.readFileSync(ENTRANCES_CACHE, 'utf8'));
      if (Array.isArray(cached.elements)) {
        console.log('[entrances] using cached Overpass response (data/cache/entrances.json)');
        return { data: cached, source: 'cache', fallbackUsed: false };
      }
    } catch {
      // fall through to re-fetch
    }
  }
  // Overpass's Apache front-end returns 406 Not Acceptable for requests
  // without a distinguishing User-Agent (Node's fetch default UA gets
  // blocked) -- always identify ourselves.
  const headers = {
    'User-Agent': 'nycworld-subway-fetch/1.0 (+data pipeline script)',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  try {
    console.log('[entrances] querying primary mirror: overpass-api.de');
    const text = await fetchWithRetry(OVERPASS_PRIMARY, {
      method: 'POST',
      headers,
      body: OVERPASS_QUERY,
      timeoutMs: 130000,
    });
    const data = JSON.parse(text);
    fs.writeFileSync(ENTRANCES_CACHE, text, 'utf8');
    return { data, source: 'primary (overpass-api.de)', fallbackUsed: false };
  } catch (err) {
    console.warn(`[entrances] primary mirror failed (${err.message}); trying fallback: overpass.kumi.systems`);
    const text = await fetchWithRetry(OVERPASS_FALLBACK, {
      method: 'POST',
      headers,
      body: OVERPASS_QUERY,
      timeoutMs: 130000,
    });
    const data = JSON.parse(text);
    fs.writeFileSync(ENTRANCES_CACHE, text, 'utf8');
    return { data, source: 'fallback (overpass.kumi.systems)', fallbackUsed: true };
  }
}

// ---------------------------------------------------------------------------
// Small robust CSV parser (RFC4180-ish: quoted fields, embedded commas/quotes)
// ---------------------------------------------------------------------------
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // ignore; \n (handled below) terminates the row
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function normalizeKey(h) {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function csvToRecords(text) {
  const rows = parseCSV(text);
  const header = rows[0].map(normalizeKey);
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function pick(record, candidates) {
  for (const c of candidates) {
    if (record[c] !== undefined && record[c] !== '') return record[c];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Curated layout overrides (name normalized: lowercase, strip non-alphanumeric;
// routes compared as sets, order-independent).
// ---------------------------------------------------------------------------
function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const OVERRIDES = [
  ['Times Sq-42 St', ['1', '2', '3'], 'dual-island', 4, 0],
  ['Times Sq-42 St', ['N', 'Q', 'R', 'W'], 'dual-island', 4, 0],
  ['Times Sq-42 St', ['S'], 'island', 2, 0],
  ['Times Sq-42 St', ['7'], 'island', 2, 0],
  ['Grand Central-42 St', ['4', '5', '6'], 'dual-island', 4, 0],
  ['Grand Central-42 St', ['7'], 'island', 2, 0],
  ['Grand Central-42 St', ['S'], 'island', 2, 0],
  ['34 St-Penn Station', ['1', '2', '3'], 'dual-island', 4, 0],
  ['34 St-Penn Station', ['A', 'C', 'E'], 'dual-island', 4, 0],
  ['34 St-Herald Sq', ['B', 'D', 'F', 'M'], 'dual-island', 4, 0],
  ['34 St-Herald Sq', ['N', 'Q', 'R', 'W'], 'dual-island', 4, 0],
  ['14 St-Union Sq', ['4', '5', '6'], 'dual-island', 4, 0],
  ['14 St-Union Sq', ['N', 'Q', 'R', 'W'], 'dual-island', 4, 0],
  ['14 St-Union Sq', ['L'], 'island', 2, 0],
  ['Fulton St', ['4', '5'], 'island', 2, 0],
  ['Fulton St', ['2', '3'], 'side', 2, 0],
  ['Fulton St', ['A', 'C'], 'island', 2, 0],
  ['Fulton St', ['J', 'Z'], 'island', 2, 0],
  ['Wall St', ['4', '5'], 'island', 2, 0],
  ['Wall St', ['2', '3'], 'side', 2, 0],
  ['Bowling Green', ['4', '5'], 'island', 2, 0],
  ['South Ferry', ['1'], 'island', 2, 0],
  ['Chambers St', ['1', '2', '3'], 'dual-island', 4, 0],
  ['Chambers St', ['J', 'Z'], 'dual-island', 4, 0],
  ['59 St-Columbus Circle', ['A', 'B', 'C', 'D'], 'dual-island', 4, 0],
  ['59 St-Columbus Circle', ['1'], 'island', 2, 0],
  ['96 St', ['1', '2', '3'], 'dual-island', 4, 0],
  ['72 St', ['1', '2', '3'], 'dual-island', 4, 0],
  ['42 St-Port Authority Bus Terminal', ['A', 'C', 'E'], 'dual-island', 4, 0],
  // W 4 St-Wash Sq: the live MTA CSV splits this into two rows by division
  // (IND 8th Ave A/C/E and IND 6th Ave B/D/F/M) rather than one merged row;
  // both the split rows and a hypothetical merged row are covered.
  ['W 4 St-Wash Sq', ['A', 'B', 'C', 'D', 'E', 'F', 'M'], 'dual-island', 4, 0],
  ['W 4 St-Wash Sq', ['A', 'C', 'E'], 'dual-island', 4, 0],
  ['W 4 St-Wash Sq', ['B', 'D', 'F', 'M'], 'dual-island', 4, 0],
  ['125 St', ['4', '5', '6'], 'dual-island', 4, 0],
  ['125 St', ['A', 'B', 'C', 'D'], 'dual-island', 4, 0],
  ['86 St', ['4', '5', '6'], 'dual-island', 4, 0],
  ['96 St', ['Q'], 'island', 2, 0],
  ['86 St', ['Q'], 'island', 2, 0],
  ['72 St', ['Q'], 'island', 2, 0],
  ['34 St-Hudson Yards', ['7'], 'island', 2, 0],
  // 168 St: in the live MTA CSV the IRT (1-train) platform is named
  // "168 St-Washington Hts" while the IND (A/C) platform is named "168 St" --
  // both name spellings are covered here so the override applies regardless
  // of which naming convention a given CSV snapshot uses.
  ['168 St', ['A', 'C', '1'], 'dual-island', 4, 0],
  ['168 St', ['A', 'C'], 'island', 2, 0],
  ['168 St', ['1'], 'island', 2, 0],
  ['168 St-Washington Hts', ['A', 'C', '1'], 'dual-island', 4, 0],
  ['168 St-Washington Hts', ['1'], 'island', 2, 0],
  ['Inwood-207 St', ['A'], 'island', 2, 0],
  ['145 St', ['3'], 'island', 2, 0],
];

function findOverride(name, routes) {
  const n = normName(name);
  const routeSet = new Set(routes);
  for (const [oname, oroutes, type, tracks, passTracks] of OVERRIDES) {
    if (normName(oname) !== n) continue;
    if (oroutes.length !== routeSet.size) continue;
    if (!oroutes.every((r) => routeSet.has(r))) continue;
    return { type, tracks, passTracks };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout heuristics
// ---------------------------------------------------------------------------
function heuristicTypeTracks(routes) {
  let type, tracks, passTracks;
  if (routes.length >= 3) {
    type = 'dual-island';
    tracks = 4;
    passTracks = 0;
  } else if (routes.length === 2) {
    type = 'island';
    tracks = 2;
    passTracks = 0;
  } else {
    type = 'side';
    tracks = 2;
    passTracks = 0;
  }
  if (type === 'side') {
    // routes is a single-element array here. Lines that are themselves only
    // 2 tracks system-wide (L, G, J/Z, 7) keep a plain side platform; every
    // other single-route station sits on a 4-track trunk with express tracks
    // passing through the middle without stopping.
    const soloLineRoutes = new Set(['L', 'G', 'J', 'Z', '7']);
    if (!soloLineRoutes.has(routes[0])) {
      tracks = 4;
      passTracks = 2;
    }
  }
  return { type, tracks, passTracks };
}

function computeDivision(rawDivision, routes) {
  const d = (rawDivision || '').trim();
  if (d.toUpperCase() === 'IRT') return 'IRT';
  const allNumOrS = routes.length > 0 && routes.every((r) => /^\d+$/.test(r) || r === 'S');
  if (allNumOrS) return 'IRT';
  return d;
}

function computeDepth(name, routes) {
  let depth = 14;
  if (routes.includes('7')) depth = 18;
  const isHudsonYards = /hudson\s*yards/i.test(name);
  const isSecondAveQ = routes.includes('Q') && /^(72|86|96)\s*st\b/i.test(name.trim());
  if (isHudsonYards || isSecondAveQ) depth = 24;
  const isDeep191 = /191/.test(name);
  const isDeep168With1 = /168/.test(name) && routes.includes('1');
  const isDeep181 = /181/.test(name);
  if (isDeep191 || isDeep168With1 || isDeep181) depth = 30;
  return depth;
}

const ROUTE_COLORS = {
  1: '#EE352E', 2: '#EE352E', 3: '#EE352E',
  4: '#00933C', 5: '#00933C', 6: '#00933C',
  7: '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  S: '#808183', GS: '#808183', FS: '#808183',
};
function bandColorFor(routes) {
  return ROUTE_COLORS[routes[0]] ?? '#808183';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== fetch-subway: building public/subway/subway.json ===');

  const [stationsSrc, entrancesSrc] = await Promise.all([getStationsCSV(), getEntrancesJSON()]);

  // ---- Stations ----
  const records = csvToRecords(stationsSrc.text);
  const manhattanRecords = records.filter((r) => {
    const borough = (pick(r, ['borough']) || '').toUpperCase();
    const division = (pick(r, ['division']) || '').toUpperCase();
    return borough === 'M' && division !== 'SIR';
  });

  let overridesApplied = 0;
  const stations = manhattanRecords.map((r) => {
    const id = pick(r, ['gtfsstopid', 'gtfsstationid', 'stopid']);
    const complexId = pick(r, ['complexid']);
    const name = pick(r, ['stopname', 'stationname', 'station']) ?? '';
    const structure = pick(r, ['structure']) ?? '';
    const rawDivision = pick(r, ['division']) ?? '';
    const routesRaw = pick(r, ['daytimeroutes', 'routes']) ?? '';
    const routes = routesRaw.trim().split(/\s+/).filter(Boolean);
    const lat = parseFloat(pick(r, ['gtfslatitude', 'latitude', 'lat']));
    const lon = parseFloat(pick(r, ['gtfslongitude', 'longitude', 'lon', 'long']));

    const division = computeDivision(rawDivision, routes);
    const [x, z] = lonLatToXZ(lon, lat);

    const override = findOverride(name, routes);
    if (override) overridesApplied++;
    const tt = override ?? heuristicTypeTracks(routes);

    const layout = {
      type: tt.type,
      tracks: tt.tracks,
      passTracks: tt.passTracks,
      platformLength: division === 'IRT' ? 156 : 183,
      depth: computeDepth(name, routes),
      bandColor: bandColorFor(routes),
    };

    return { id, complexId, name, routes, structure, division, pos: [round1(x), round1(z)], layout };
  });

  // ---- Entrances ----
  const nodes = (entrancesSrc.data.elements || []).filter(
    (e) => e.type === 'node' && typeof e.lat === 'number' && typeof e.lon === 'number'
  );

  let droppedEntrances = 0;
  const entrances = [];
  for (const node of nodes) {
    const [x, z] = lonLatToXZ(node.lon, node.lat);
    const kind = node.tags && node.tags.elevator === 'yes' ? 'elevator' : 'stair';
    let best = null;
    let bestDist = Infinity;
    for (const s of stations) {
      const dx = x - s.pos[0];
      const dz = z - s.pos[1];
      const d = Math.hypot(dx, dz);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    if (best && bestDist <= 250) {
      entrances.push({ pos: [round1(x), round1(z)], stationId: best.id, kind });
    } else {
      droppedEntrances++;
    }
  }

  // ---- Write output ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const output = { stations, entrances };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  // ---------------------------------------------------------------------
  // Validate
  // ---------------------------------------------------------------------
  const warnings = [];
  if (stations.length < 100 || stations.length > 170) {
    warnings.push(`station count ${stations.length} outside expected 100-170`);
  }
  if (entrances.length < 250 || entrances.length > 600) {
    warnings.push(`entrance count ${entrances.length} outside expected 250-600`);
  }
  const timesSq = stations.filter((s) => normName(s.name) === normName('Times Sq-42 St'));
  const timesSqRoutes = new Set(timesSq.flatMap((s) => s.routes));
  if (!(timesSqRoutes.has('N') && timesSqRoutes.has('1'))) {
    warnings.push('Times Sq-42 St is missing N and/or 1 among its rows');
  }
  const grandCentral = stations.filter((s) => normName(s.name) === normName('Grand Central-42 St'));
  if (grandCentral.length === 0) warnings.push('Grand Central-42 St rows not found');

  for (const s of stations) {
    const l = s.layout;
    const ok = l && l.type && l.tracks && l.passTracks !== undefined && l.platformLength && l.depth && l.bandColor;
    if (!ok) warnings.push(`station ${s.id} (${s.name}) has incomplete layout`);
  }
  const stationIds = new Set(stations.map((s) => s.id));
  const badEntranceRefs = entrances.filter((e) => !stationIds.has(e.stationId)).length;
  if (badEntranceRefs > 0) warnings.push(`${badEntranceRefs} entrances reference an unknown stationId`);

  // ---------------------------------------------------------------------
  // Report (<30 lines)
  // ---------------------------------------------------------------------
  const typeDist = { side: 0, island: 0, 'dual-island': 0 };
  for (const s of stations) typeDist[s.layout.type]++;

  console.log('\n--- REPORT ---');
  console.log(
    `stations: ${stations.length} (Manhattan) | entrances linked: ${entrances.length} | dropped: ${droppedEntrances}`
  );
  console.log(
    `sources: stations=${stationsSrc.source}, entrances=${entrancesSrc.source}` +
      (stationsSrc.fallbackUsed || entrancesSrc.fallbackUsed ? ' [fallback used]' : '')
  );
  console.log(
    `overrides applied: ${overridesApplied} | type distribution: side=${typeDist.side}, island=${typeDist.island}, dual-island=${typeDist['dual-island']}`
  );
  const sampleTimesSq123 = timesSq.find((s) => new Set(s.routes).has('1') && s.routes.length === 3);
  console.log('sample Times Sq (1/2/3):', JSON.stringify(sampleTimesSq123));
  console.log('sample entrances (5):', JSON.stringify(entrances.slice(0, 5)));
  if (warnings.length) {
    console.log(`WARNINGS (${warnings.length}):`);
    for (const w of warnings.slice(0, 10)) console.log(' -', w);
  } else {
    console.log('all validations passed.');
  }
  console.log(`wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
