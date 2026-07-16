// Manhattan neighborhood polygons for the live location label, from NYC Open
// Data's 2020 Neighborhood Tabulation Areas (dataset 9nt8-h7nd).
//
//   node scripts/fetch-hoods.mjs
//
// Raw geojson is cached in data/cache/ (delete to re-fetch). Output:
//   public/geo/hoods.json  { v: 1, hoods: [{ n, rings: [[x0,z0,...], ...] }] }
// Rings are world-meter flats, Douglas-Peucker simplified; holes are kept as
// extra rings — the client tests point-in-polygon with even-odd parity, so a
// hole ring simply flips the result back out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache', 'hoods-nta2020.geojson');
const OUT = path.join(ROOT, 'public', 'geo', 'hoods.json');
const FEED = 'https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?boroname=Manhattan&$limit=200';

const ORIGIN = { lat: 40.758, lon: -73.9855 };
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 84327;
const lonLatToXZ = (lon, lat) => [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];

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
    if (maxD > eps && maxI > 0) {
      keep[maxI] = true;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Geojson rings CLOSE on themselves (first point == last), which degenerates
// naive DP: the anchor chord has zero length, every deviation measures 0, and
// the whole ring simplifies away. Open the ring and split it at the point
// farthest from its start so both halves have real chords.
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

async function main() {
  let gj;
  if (fs.existsSync(CACHE)) {
    console.log('hoods: using cached NTA geojson');
    gj = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } else {
    console.log('hoods: fetching 2020 NTAs (Manhattan)...');
    const res = await fetch(FEED, { headers: { 'User-Agent': 'nycroam-hoods-fetch/1.0 (+data pipeline script)' } });
    if (!res.ok) throw new Error(`NTA HTTP ${res.status}`);
    gj = await res.json();
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(gj));
  }

  const hoods = [];
  let ringCount = 0, ptsBefore = 0, ptsAfter = 0;
  for (const f of gj.features ?? []) {
    const name = f.properties?.ntaname;
    const geom = f.geometry;
    if (!name || !geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    const rings = [];
    for (const poly of polys) {
      for (const ring of poly) { // outer + holes; even-odd PIP handles both
        const pts = ring.map(([lon, lat]) => lonLatToXZ(lon, lat));
        ptsBefore += pts.length;
        const simp = simplify(pts, 15);
        if (simp.length < 4) continue;
        ptsAfter += simp.length;
        rings.push(simp.flatMap((p) => [Math.round(p[0]), Math.round(p[1])]));
        ringCount++;
      }
    }
    if (rings.length) hoods.push({ n: name, rings });
  }
  hoods.sort((a, b) => a.n.localeCompare(b.n));

  fs.writeFileSync(OUT, JSON.stringify({ v: 1, hoods }));
  console.log(
    `hoods: ${hoods.length} neighborhoods, ${ringCount} rings, ${ptsBefore} -> ${ptsAfter} points ` +
      `(${(fs.statSync(OUT).size / 1024).toFixed(0)}KB)`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
