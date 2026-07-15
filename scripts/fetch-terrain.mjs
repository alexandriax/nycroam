#!/usr/bin/env node
// scripts/fetch-terrain.mjs
//
// Downloads AWS Open Data Terrain Tiles (Terrarium PNG encoding, z=13, no auth)
// covering the Manhattan bbox plus a one-tile margin, caches the raw PNGs in
// data/cache/terrain/, decodes elevation, resamples onto a regular local-meter
// grid, box-blurs once, and writes public/geo/terrain.json.
//
// Shared constants below MUST match src/engine/geo.ts / scripts/build-tiles.mjs exactly.
//
// Usage: node scripts/fetch-terrain.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache', 'terrain');
const GEO_DIR = path.join(ROOT, 'public', 'geo');

// ---- shared constants (must match src/engine/geo.ts) --------------------------------
const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;

function lonLatToXZ(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}
function xzToLonLat(x, z) {
  return [x / M_PER_DEG_LON + ORIGIN.lon, ORIGIN.lat - z / M_PER_DEG_LAT];
}

const BBOX = { south: 40.698, west: -74.026, north: 40.882, east: -73.906 };

// ---- output grid spec (per mission spec) ---------------------------------------------
const STEP = 40;
const GRID_ORIGIN_X = -3600;
const GRID_ORIGIN_Z = -14200;
const NX = 261;
const NZ = 571;

// ---- terrarium tile source ------------------------------------------------------------
const ZOOM = 13;
const TILE_PX = 256;
const N_TILES = 2 ** ZOOM;
const RETRY_DELAYS_MS = [1000, 3000, 8000]; // 3 retries (4 attempts total) w/ backoff

function xFracAtZoom(lon) {
  return ((lon + 180) / 360) * N_TILES;
}
function yFracAtZoom(lat) {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * N_TILES;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function isValidPng(file) {
  try {
    const buf = fs.readFileSync(file);
    const png = PNG.sync.read(buf);
    return !!(png && png.width === TILE_PX && png.height === TILE_PX);
  } catch {
    return false;
  }
}

// ---- fetch + cache a single terrarium tile (skip if cached, retry w/ backoff) --------
async function fetchTerrainTile(z, x, y) {
  const file = path.join(CACHE_DIR, `${z}_${x}_${y}.png`);
  if (isValidPng(file)) return { file, cached: true };

  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const attempts = RETRY_DELAYS_MS.length + 1;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const png = PNG.sync.read(buf); // validate decodability before caching
      if (!png || png.width !== TILE_PX || png.height !== TILE_PX) {
        throw new Error(`unexpected PNG dimensions ${png && png.width}x${png && png.height}`);
      }
      const tmp = `${file}.tmp${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return { file, cached: false };
    } catch (err) {
      lastErr = err;
      console.log(`  [terrain z${z}/${x}/${y}] attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw new Error(`terrain tile z${z}/${x}/${y} failed after ${attempts} attempts: ${lastErr?.message}`);
}

function decodeElevation(png) {
  // Terrarium encoding: elevation_m = (R*256 + G + B/256) - 32768
  const { width, height, data } = png; // data: RGBA Buffer, 4 bytes/px
  const elev = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    elev[i] = r * 256 + g + b / 256 - 32768;
  }
  return elev;
}

// ======================================================================================
// MAIN
// ======================================================================================
async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(GEO_DIR, { recursive: true });

  // ---- covering z13 tile range for the bbox, + 1 tile margin on every side -----------
  const xW = Math.floor(xFracAtZoom(BBOX.west));
  const xE = Math.floor(xFracAtZoom(BBOX.east));
  const yN = Math.floor(yFracAtZoom(BBOX.north)); // north = max lat -> smallest y
  const yS = Math.floor(yFracAtZoom(BBOX.south)); // south = min lat -> largest y
  const xtileMin = Math.min(xW, xE) - 1;
  const xtileMax = Math.max(xW, xE) + 1;
  const ytileMin = Math.min(yN, yS) - 1;
  const ytileMax = Math.max(yN, yS) + 1;
  const tilesWide = xtileMax - xtileMin + 1;
  const tilesTall = ytileMax - ytileMin + 1;
  console.log(
    `Covering z${ZOOM} tiles x[${xtileMin}..${xtileMax}] y[${ytileMin}..${ytileMax}] = ${tilesWide}x${tilesTall} = ${
      tilesWide * tilesTall
    } tiles`
  );

  // ---- fetch + decode every tile into one big elevation mosaic ------------------------
  const mosaicW = tilesWide * TILE_PX;
  const mosaicH = tilesTall * TILE_PX;
  const mosaic = new Float32Array(mosaicW * mosaicH);

  let fetchedCount = 0;
  let cachedCount = 0;
  for (let ty = ytileMin; ty <= ytileMax; ty++) {
    for (let tx = xtileMin; tx <= xtileMax; tx++) {
      const { file, cached } = await fetchTerrainTile(ZOOM, tx, ty);
      if (cached) cachedCount++;
      else fetchedCount++;
      const buf = fs.readFileSync(file);
      const png = PNG.sync.read(buf);
      const elev = decodeElevation(png);
      const offX = (tx - xtileMin) * TILE_PX;
      const offY = (ty - ytileMin) * TILE_PX;
      for (let py = 0; py < TILE_PX; py++) {
        const srcRow = py * TILE_PX;
        const dstOff = (offY + py) * mosaicW + offX;
        mosaic.set(elev.subarray(srcRow, srcRow + TILE_PX), dstOff);
      }
    }
  }
  console.log(`  fetched ${fetchedCount} new tiles, ${cachedCount} already cached (${tilesWide * tilesTall} total)`);

  function sampleMosaicBilinear(lon, lat) {
    const fx = xFracAtZoom(lon) * TILE_PX - xtileMin * TILE_PX;
    const fy = yFracAtZoom(lat) * TILE_PX - ytileMin * TILE_PX;
    const x0 = Math.max(0, Math.min(mosaicW - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(mosaicH - 1, Math.floor(fy)));
    const x1 = Math.min(mosaicW - 1, x0 + 1);
    const y1 = Math.min(mosaicH - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fy - y0));
    const v00 = mosaic[y0 * mosaicW + x0];
    const v10 = mosaic[y0 * mosaicW + x1];
    const v01 = mosaic[y1 * mosaicW + x0];
    const v11 = mosaic[y1 * mosaicW + x1];
    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * tz;
  }

  // ---- resample onto the regular local grid (clamp negatives to 0) -------------------
  console.log(`Resampling to local grid ${NX}x${NZ} (step ${STEP}m)...`);
  const grid = new Float32Array(NX * NZ);
  for (let iz = 0; iz < NZ; iz++) {
    const z = GRID_ORIGIN_Z + iz * STEP;
    for (let ix = 0; ix < NX; ix++) {
      const x = GRID_ORIGIN_X + ix * STEP;
      const [lon, lat] = xzToLonLat(x, z);
      let e = sampleMosaicBilinear(lon, lat);
      if (e < 0) e = 0; // clamp water/bathymetry
      grid[iz * NX + ix] = e;
    }
  }

  // ---- single 3x3 box-blur pass over the whole grid -----------------------------------
  const blurred = new Float32Array(NX * NZ);
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const jz = iz + dz;
        if (jz < 0 || jz >= NZ) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx;
          if (jx < 0 || jx >= NX) continue;
          sum += grid[jz * NX + jx];
          count++;
        }
      }
      blurred[iz * NX + ix] = sum / count;
    }
  }

  // ---- convert to integer decimeters, write terrain.json ------------------------------
  const h = new Array(NX * NZ);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < blurred.length; i++) {
    const m = blurred[i];
    h[i] = Math.round(m * 10);
    if (m < min) min = m;
    if (m > max) max = m;
    sum += m;
  }
  const mean = sum / blurred.length;

  const out = { v: 1, originX: GRID_ORIGIN_X, originZ: GRID_ORIGIN_Z, step: STEP, nx: NX, nz: NZ, h };
  fs.writeFileSync(path.join(GEO_DIR, 'terrain.json'), JSON.stringify(out));
  const outBytes = fs.statSync(path.join(GEO_DIR, 'terrain.json')).size;
  console.log(`Wrote public/geo/terrain.json (${NX}x${NZ}=${h.length} points, ${(outBytes / 1024).toFixed(0)}KB)`);

  // ---- stats + sanity probes (sampled from the final written grid) -------------------
  function bilinearGridSampleMeters(x, z) {
    const fx = (x - GRID_ORIGIN_X) / STEP;
    const fz = (z - GRID_ORIGIN_Z) / STEP;
    const x0 = Math.max(0, Math.min(NX - 1, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(NZ - 1, Math.floor(fz)));
    const x1 = Math.min(NX - 1, x0 + 1);
    const z1 = Math.min(NZ - 1, z0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fz - z0));
    const v00 = h[z0 * NX + x0] / 10;
    const v10 = h[z0 * NX + x1] / 10;
    const v01 = h[z1 * NX + x0] / 10;
    const v11 = h[z1 * NX + x1] / 10;
    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * tz;
  }

  console.log(`\nElevation stats (post-blur): min=${min.toFixed(1)}m max=${max.toFixed(1)}m mean=${mean.toFixed(1)}m`);

  const probes = [
    { name: 'Washington Heights', lat: 40.852, lon: -73.938, expect: '> 20m' },
    { name: 'Battery', lat: 40.703, lon: -74.016, expect: '< 6m' },
    { name: 'Midtown', lat: 40.758, lon: -73.985, expect: '5-25m' },
  ];
  for (const p of probes) {
    const [x, z] = lonLatToXZ(p.lon, p.lat);
    const e = bilinearGridSampleMeters(x, z);
    console.log(`  ${p.name} (${p.lat},${p.lon}): ${e.toFixed(1)}m (expect ${p.expect})`);
  }
  console.log('DONE');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
