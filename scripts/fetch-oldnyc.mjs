#!/usr/bin/env node
// scripts/fetch-oldnyc.mjs
//
// Downloads OldNYC's public marker table and extracts a compact geocoded-marker
// index used at BUILD TIME ONLY (scripts/build-plaques.mjs snaps each building to
// the nearest marker and bakes the exact key string into the plaque record, so
// nothing from OldNYC ships to the browser except the resulting deep-link URL).
//
// Source: https://www.oldnyc.org/static/lat-lon-counts.js  (a single
//   `var lat_lons = { "lat,lon": {year: count, ...}, ... };` assignment).
// OldNYC (github.com/oldnyc/oldnyc.github.io, github.com/danvk/oldnyc) is
// Apache-2.0; the coordinates are uncopyrightable facts. We redistribute NO NYPL
// images and only link out to oldnyc.org. Attribution lives in
// public/geo/OLDNYC_NOTICE.txt (written by build-plaques.mjs).
//
// The URL contract (#g:lat,lon, exact 6-decimal keys) is an implementation detail
// of the current site, not a documented API — re-run this occasionally to stay in
// sync. Marker set last regenerated upstream 2024-09-14.
//
// Usage: node scripts/fetch-oldnyc.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const RAW_FILE = path.join(CACHE_DIR, 'oldnyc-latloncounts.js');
const OUT_FILE = path.join(CACHE_DIR, 'oldnyc-markers.json');
const SOURCE_URL = 'https://www.oldnyc.org/static/lat-lon-counts.js';

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let raw;
  if (fs.existsSync(RAW_FILE)) {
    console.log(`Using cached ${path.relative(ROOT, RAW_FILE)}`);
    raw = fs.readFileSync(RAW_FILE, 'utf8');
  } else {
    console.log(`Fetching ${SOURCE_URL} ...`);
    const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'nycroam-build/1.0' } });
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    raw = await res.text();
    fs.writeFileSync(RAW_FILE, raw);
    console.log(`  cached ${(raw.length / 1024).toFixed(0)}KB -> ${path.relative(ROOT, RAW_FILE)}`);
  }

  // Extract the object literal assigned to `lat_lons`. Anchor the close on the
  // trailing `; ... var timestamps` block so the greedy body stops at the right
  // brace (the file has a second `};`-terminated object after this one).
  let m = raw.match(/var\s+lat_lons\s*=\s*(\{[\s\S]*\})\s*;\s*var\s+timestamps/);
  if (!m) m = raw.match(/var\s+lat_lons\s*=\s*(\{[\s\S]*\})\s*;\s*$/);
  if (!m) throw new Error('could not locate `var lat_lons = {...};` in source');
  const table = JSON.parse(m[1]);

  const markers = []; // [latStr, lonStr, totalPhotos]
  for (const key of Object.keys(table)) {
    const comma = key.indexOf(',');
    if (comma < 0) continue;
    const latStr = key.slice(0, comma);
    const lonStr = key.slice(comma + 1);
    const lat = parseFloat(latStr), lon = parseFloat(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let total = 0;
    for (const c of Object.values(table[key])) total += c;
    // Preserve the EXACT key strings (incl. trailing zeros) — the OldNYC app
    // requires a byte-exact match to open a marker.
    markers.push([latStr, lonStr, total]);
  }

  const out = {
    v: 1,
    source: SOURCE_URL,
    license: 'Apache-2.0 (OldNYC / Dan Vanderkam). Coordinates are facts; no NYPL images redistributed.',
    count: markers.length,
    markers,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(
    `  extracted ${markers.length} markers -> ${path.relative(ROOT, OUT_FILE)} ` +
      `(${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)}KB)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
