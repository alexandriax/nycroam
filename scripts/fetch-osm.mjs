#!/usr/bin/env node
// scripts/fetch-osm.mjs
//
// Downloads raw OSM data (via Overpass) for the Manhattan bbox into data/cache/,
// split into a 4 (lon) x 8 (lat) grid of 32 chunks x 4 layers = 128 files, plus a
// single non-chunked NYC borough-boundary GeoJSON file. Fully resumable: rerun
// as many times as needed, it skips whatever is already cached and picks up
// where it left off. Prints `ALL LAYERS CACHED` as its last line once every
// chunk-layer file exists.
//
// Usage: node scripts/fetch-osm.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');

// ---- Manhattan bbox + chunk grid --------------------------------------------------
const BBOX = { south: 40.698, west: -74.026, north: 40.882, east: -73.906 };
const ROWS = 8; // lat divisions
const COLS = 4; // lon divisions
const LAYERS = ['buildings', 'roads', 'areas', 'trees', 'hydrants'];
const TOTAL_TASKS = ROWS * COLS * LAYERS.length; // 128

const latStep = (BBOX.north - BBOX.south) / ROWS;
const lonStep = (BBOX.east - BBOX.west) / COLS;

function chunkBBox(row, col) {
  const south = BBOX.south + row * latStep;
  const north = BBOX.south + (row + 1) * latStep;
  const west = BBOX.west + col * lonStep;
  const east = BBOX.west + (col + 1) * lonStep;
  return { south, west, north, east };
}

// ---- Overpass endpoints + query templates -----------------------------------------
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MAX_INFLIGHT = 2;
const STAGGER_MS = 700;
const RETRY_DELAYS_MS = [2000, 6000, 15000, 30000]; // between attempts 1->2, 2->3, 3->4, 4->5 (5 attempts total)
const REQUEST_TIMEOUT_MS = 60000; // client-side abort; empirically the working mirror(s) respond
// within single-digit-to-tens of seconds for these chunk sizes, while the dead mirror(s) just
// hang forever with zero bytes — 60s bounds the cost of rotating through a hung endpoint without
// starving a merely-busy one. (Overpass's own [timeout:180] is a server-side execution budget,
// not a promise our TCP connection stays open that long.)
const ABORT_MIN_ATTEMPTED = 8; // don't trigger the 30% abort guard on a tiny sample
const ABORT_FAIL_RATIO = 0.3;

// NOTE ON "out tags geom qt" vs "out geom qt": the task spec's query text uses
// `out tags geom qt;`. Empirically (verified live against overpass-api.de), Overpass's
// `tags` verbosity level REPLACES the default `body` level rather than adding to it —
// and for RELATIONS, the members[] list (refs+roles, which `geom` then attaches
// coordinates to) is only emitted at `body` verbosity or above. Under `tags` verbosity,
// every relation comes back with zero members, silently. For WAYS this is harmless
// (`geom` attaches the coordinate array regardless of verbosity, and `body` already
// includes tags, so nothing is lost by using the default). Since `body` is a strict
// superset of `tags` for our purposes, we drop the redundant `tags` keyword so
// multipolygon relations (parks, water bodies, complex building footprints — exactly
// what the "Multipolygon assembly" step in build-tiles.mjs needs) actually come through
// with usable `members[].geometry`/`members[].role`. Confirmed live on a known
// multipolygon (Castle Clinton, relation 3695755): `out tags geom qt` -> 0 members;
// `out geom qt` -> 2 members, each with role + full geometry, tags still present.
function queryFor(layer, bbox) {
  const { south: S, west: W, north: N, east: E } = bbox;
  switch (layer) {
    case 'buildings':
      return `[out:json][timeout:180];
(
  way["building"](${S},${W},${N},${E});
  way["building:part"](${S},${W},${N},${E});
  relation["building"](${S},${W},${N},${E});
  relation["building:part"](${S},${W},${N},${E});
);
out geom qt;`;
    case 'roads':
      return `[out:json][timeout:180];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|cycleway|path|steps|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${S},${W},${N},${E});
out geom qt;`;
    case 'areas':
      return `[out:json][timeout:180];
(
  way["leisure"~"^(park|garden|playground|pitch|common|dog_park|golf_course)$"](${S},${W},${N},${E});
  relation["leisure"~"^(park|garden|playground|pitch|common|dog_park|golf_course)$"](${S},${W},${N},${E});
  way["landuse"~"^(grass|recreation_ground|cemetery|meadow|forest|village_green|flowerbed)$"](${S},${W},${N},${E});
  relation["landuse"~"^(grass|recreation_ground|cemetery|meadow|forest|village_green|flowerbed)$"](${S},${W},${N},${E});
  way["natural"~"^(wood|scrub|grassland|beach|sand|water)$"](${S},${W},${N},${E});
  relation["natural"="water"](${S},${W},${N},${E});
  way["man_made"="pier"](${S},${W},${N},${E});
  way["highway"="pedestrian"]["area"="yes"](${S},${W},${N},${E});
);
out geom qt;`;
    case 'trees':
      return `[out:json][timeout:180];
node["natural"="tree"](${S},${W},${N},${E});
out qt;`;
    case 'hydrants':
      return `[out:json][timeout:180];
node["emergency"="fire_hydrant"](${S},${W},${N},${E});
out qt;`;
    default:
      throw new Error(`unknown layer ${layer}`);
  }
}

// Borough boundaries (water-clipped, i.e. land only, follows the shoreline).
// The dataset id given in the spec (tqmj-j8zm) 404s — NYC Open Data has since
// retired/renamed it. We try it first (in case it's transient), then fall back
// to the verified-working current dataset "Borough Boundaries" (gthc-hcne),
// which is the water-clipped one (as opposed to wh2p-dxnf, "water areas included").
const BOROUGH_URLS = [
  'https://data.cityofnewyork.us/api/geospatial/tqmj-j8zm?method=export&format=GeoJSON',
  'https://data.cityofnewyork.us/api/geospatial/gthc-hcne?method=export&format=GeoJSON',
];

// ---- helpers -----------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function isValidElementsCache(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(txt);
    return Array.isArray(json.elements);
  } catch {
    return false;
  }
}

function isValidGeoJSON(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(txt);
    return json && json.type === 'FeatureCollection' && Array.isArray(json.features);
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, { method = 'GET', body, headers } = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, body, headers, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function fmtSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---- failures.json (persisted, merged across runs) ---------------------------------
const FAILURES_FILE = path.join(CACHE_DIR, 'failures.json');
let failures = new Map(); // key -> record
function loadFailures() {
  try {
    const txt = fs.readFileSync(FAILURES_FILE, 'utf8');
    const json = JSON.parse(txt);
    if (Array.isArray(json.failed)) {
      for (const f of json.failed) failures.set(`${f.layer}_${f.row}_${f.col}`, f);
    }
  } catch {
    /* no prior failures file, fine */
  }
}
function writeFailures() {
  const failed = [...failures.values()].sort((a, b) => (a.layer + a.row + a.col > b.layer + b.row + b.col ? 1 : -1));
  writeAtomic(
    FAILURES_FILE,
    JSON.stringify({ generatedAt: new Date().toISOString(), totalTasks: TOTAL_TASKS, failed }, null, 2)
  );
}

// ---- Overpass chunk-layer fetch with retry/rotation ---------------------------------
async function fetchChunkLayer(layer, row, col) {
  const bbox = chunkBBox(row, col);
  const query = queryFor(layer, bbox);
  const body = new URLSearchParams({ data: query }).toString();
  const attempts = RETRY_DELAYS_MS.length + 1; // 5
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'nycroam-tile-builder/1.0',
        },
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${endpoint}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${endpoint}`);
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`invalid JSON from ${endpoint}`);
      }
      if (!Array.isArray(json.elements)) {
        throw new Error(`no elements[] from ${endpoint}`);
      }
      return { text, bytes: Buffer.byteLength(text, 'utf8'), endpoint, attempt };
    } catch (err) {
      lastErr = err;
      const isAbort = err && err.name === 'AbortError';
      console.log(
        `  [${layer} r${row}c${col}] attempt ${attempt}/${attempts} via ${endpoint} failed: ${
          isAbort ? 'timeout' : err.message
        }`
      );
      if (attempt < attempts) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }
  throw lastErr ?? new Error('unknown failure');
}

// ---- borough fetch (single, non-chunked, separate host) -----------------------------
async function fetchBorough() {
  const file = path.join(CACHE_DIR, 'borough.json');
  if (isValidGeoJSON(file)) {
    console.log('[borough] cached');
    return;
  }
  const delays = [2000, 6000, 15000];
  for (const url of BOROUGH_URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[borough] fetching (attempt ${attempt}/3) ${url}`);
        const res = await fetchWithTimeout(url, { method: 'GET' }, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error('invalid JSON');
        }
        if (!json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
          throw new Error('not a FeatureCollection');
        }
        writeAtomic(file, text);
        console.log(`[borough] ${fmtSize(Buffer.byteLength(text, 'utf8'))} ok via ${url}`);
        return;
      } catch (err) {
        console.log(`[borough] attempt ${attempt}/3 failed (${url}): ${err.message}`);
        if (attempt < 3) await sleep(delays[attempt - 1]);
      }
    }
    console.log(`[borough] all attempts exhausted for ${url}${url !== BOROUGH_URLS.at(-1) ? ', trying fallback URL' : ''}`);
  }
  console.log('[borough] PERMANENT FAILURE after trying all URLs — build-tiles.mjs will emit a fallback rectangle');
}

// ---- scheduler: max concurrency + stagger between request starts --------------------
async function runScheduled(tasks, worker) {
  let lastStart = 0;
  let active = 0;
  let idx = 0;
  let aborted = false;
  let attemptedThisRun = 0;
  let failedThisRun = 0;

  return new Promise((resolve) => {
    let remaining = tasks.length;
    if (remaining === 0) {
      resolve({ aborted, attemptedThisRun, failedThisRun });
      return;
    }
    function tick() {
      if (aborted) {
        if (active === 0) resolve({ aborted, attemptedThisRun, failedThisRun });
        return;
      }
      while (active < MAX_INFLIGHT && idx < tasks.length) {
        const now = Date.now();
        const wait = Math.max(0, lastStart + STAGGER_MS - now);
        if (wait > 0) {
          setTimeout(tick, wait);
          return;
        }
        const task = tasks[idx++];
        lastStart = Date.now();
        active++;
        Promise.resolve()
          .then(() => worker(task))
          .then((result) => {
            if (result && result.attempted) attemptedThisRun++;
            if (result && result.failed) {
              failedThisRun++;
              if (attemptedThisRun >= ABORT_MIN_ATTEMPTED && failedThisRun / attemptedThisRun > ABORT_FAIL_RATIO) {
                aborted = true;
              }
            }
          })
          .catch((err) => {
            console.error('unexpected worker error', err);
          })
          .finally(() => {
            active--;
            remaining--;
            if (remaining === 0 || (aborted && active === 0)) {
              resolve({ aborted, attemptedThisRun, failedThisRun });
            } else {
              tick();
            }
          });
      }
    }
    tick();
  });
}

// ---- main ----------------------------------------------------------------------------
async function main() {
  ensureDir(CACHE_DIR);
  loadFailures();

  const tasks = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      for (const layer of LAYERS) tasks.push({ layer, row, col });
    }
  }

  const layerProgress = Object.fromEntries(LAYERS.map((l) => [l, 0]));
  const layerTotal = ROWS * COLS;

  const boroughPromise = fetchBorough();

  const schedResult = await runScheduled(tasks, async (task) => {
    const { layer, row, col } = task;
    const file = path.join(CACHE_DIR, `${layer}_${row}_${col}.json`);
    const label = () => `[${layer} ${++layerProgress[layer]}/${layerTotal}]`;

    if (isValidElementsCache(file)) {
      console.log(`${label()} cached`);
      failures.delete(`${layer}_${row}_${col}`);
      return { attempted: false, failed: false };
    }

    try {
      const { text, bytes, endpoint, attempt } = await fetchChunkLayer(layer, row, col);
      writeAtomic(file, text);
      const extra = attempt > 1 ? ` (attempt ${attempt}, via ${endpoint})` : '';
      console.log(`${label()} ${fmtSize(bytes)} ok${extra}`);
      failures.delete(`${layer}_${row}_${col}`);
      writeFailures();
      return { attempted: true, failed: false };
    } catch (err) {
      console.log(`${label()} FAILED after all retries: ${err.message}`);
      failures.set(`${layer}_${row}_${col}`, {
        layer,
        row,
        col,
        bbox: chunkBBox(row, col),
        error: String(err.message || err),
        time: new Date().toISOString(),
      });
      writeFailures();
      return { attempted: true, failed: true };
    }
  });

  await boroughPromise;
  writeFailures();

  if (schedResult.aborted) {
    console.log(
      `ABORTING: ${schedResult.failedThisRun}/${schedResult.attemptedThisRun} attempted chunk-layers failed this run ` +
        `(>${Math.round(ABORT_FAIL_RATIO * 100)}%). See data/cache/failures.json. Fix connectivity and rerun.`
    );
    process.exit(1);
  }

  const missing = tasks.filter((t) => !isValidElementsCache(path.join(CACHE_DIR, `${t.layer}_${t.row}_${t.col}.json`)));
  if (missing.length === 0) {
    console.log('ALL LAYERS CACHED');
    process.exit(0);
  } else {
    console.log(
      `${TOTAL_TASKS - missing.length}/${TOTAL_TASKS} chunk-layers cached, ${missing.length} remaining — rerun to continue`
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
