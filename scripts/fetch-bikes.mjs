// Bike-share dock locations for the world, from NYC's public GBFS feed
// (station_information: positions, names, capacities — static data, no auth).
// The in-game presentation is unbranded; this is location data only.
//
//   node scripts/fetch-bikes.mjs
//
// Raw feed is cached in data/cache/ (delete to re-fetch). Output:
//   public/geo/bikes.json  { v: 1, docks: [{ n, c, p: [x, z] }] }
// with p in world meters (same local tangent projection as every other layer)
// and c the real dock capacity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache', 'bikes-gbfs.json');
const OUT_DIR = path.join(ROOT, 'public', 'geo');
const OUT = path.join(OUT_DIR, 'bikes.json');

const FEED = 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json';
const BBOX = { south: 40.698, west: -74.026, north: 40.882, east: -73.906 }; // matches fetch-osm

const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
function lonLatToXZ(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

async function main() {
  let raw;
  if (fs.existsSync(CACHE)) {
    console.log('bikes: using cached GBFS feed');
    raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } else {
    console.log('bikes: fetching GBFS station_information...');
    const res = await fetch(FEED, { headers: { 'User-Agent': 'nycroam-bikes-fetch/1.0 (+data pipeline script)' } });
    if (!res.ok) throw new Error(`GBFS HTTP ${res.status}`);
    raw = await res.json();
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(raw));
  }

  const stations = raw?.data?.stations ?? [];
  const docks = [];
  let skippedTiny = 0;
  for (const s of stations) {
    if (typeof s.lat !== 'number' || typeof s.lon !== 'number') continue;
    if (s.lat < BBOX.south || s.lat > BBOX.north || s.lon < BBOX.west || s.lon > BBOX.east) continue;
    const cap = s.capacity ?? 0;
    // capacity 0 = valet/virtual stations with no physical docks; the game
    // invariant (always a bike AND an empty slot) also needs a few real slots
    if (cap < 8) { skippedTiny++; continue; }
    const [x, z] = lonLatToXZ(s.lon, s.lat);
    docks.push({ n: s.name ?? 'Bike dock', c: cap, p: [Math.round(x * 10) / 10, Math.round(z * 10) / 10] });
  }
  docks.sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1]); // deterministic output

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ v: 1, docks }));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`bikes: ${docks.length} docks in bbox (${skippedTiny} skipped as virtual/tiny) -> public/geo/bikes.json (${kb}KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
