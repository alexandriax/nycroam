# NYC World — Manhattan

A browser-based, first-person explorable 3D Manhattan at 1:1 scale — every street,
building, and park from OpenStreetMap on real USGS terrain — with a fully rideable
subway network: walk into any entrance, board trains on all 22 Manhattan services
(correct bullets, strip maps, and headways), ride between real GTFS stop sequences,
and step off at any station, underground or elevated.

## Quick start

```bash
npm install
npm run data:all   # one-time: downloads OSM + NYC Open Data + MTA data, builds tiles
                   # (20–90 min depending on Overpass API load; fully resumable — just rerun)
npm run dev        # http://localhost:3000
```

Raw downloads are cached in `data/cache/`, so re-running the pipeline is fast and
resumable. Generated world data lands in `public/tiles/`, `public/geo/`, `public/subway/`.

## Controls

| | Desktop | Mobile |
|---|---|---|
| Look | click (pointer lock) or drag | drag right side |
| Move | WASD / arrows | left joystick |
| Run | Shift | — |
| Fly | F (Space/C for up/down) | FLY button |
| Subway | walk into a green-globe stairway, or E | walk in, or GO button |
| Board a train | stand by the open doors, press E | GO button |
| Ride / exit | E during a stop steps off; ride to the end auto-exits | GO button |
| Teleport | "Jump to…" menu | same |

## Architecture

- **Data pipeline** (`scripts/`) — chunked Overpass API fetch of all Manhattan
  buildings (incl. `building:part` for skyscrapers), roads, parks/water, and trees;
  NYC Open Data borough boundary for the shoreline-clipped island ground; MTA
  Stations CSV + OSM subway entrances for the subway system. Everything is
  reprojected to local meters, pre-triangulated where possible, and binned into
  256 m tiles as compact integer-decimeter JSON.
- **Streaming engine** (`src/engine/`) — Three.js. A pool of web workers fetches and
  builds merged per-tile geometry off the main thread (extrusion, roofs via earcut,
  road ribbons, procedural rooftop water towers, instanced trees). Tiles stream in
  by distance, capped per frame, and dispose beyond the fog. A low-poly skyline layer
  (every building ≥ 70 m island-wide) renders beyond the fog with a distance haze so
  the Midtown/Downtown skylines are always on the horizon.
- **Facades** — one shared Lambert material with an injected shader that carves
  per-floor window grids (and ground-floor storefronts) from world position: zero
  textures, one draw call per tile layer.
- **Subway** (`src/engine/subway/`) — station interiors are generated from each
  station's real spec: IRT vs IND/BMT platform lengths, side/island/dual-island
  platform types (curated for ~35 major stations, heuristic elsewhere), express
  pass-through tracks, trunk-color tile bands, station-name mosaics, columns,
  benches, fare control with turnstiles and booth, and animated arriving trains
  with the correct route bullets. Exit stairs return you to the sidewalk entrance
  you came from.
- **Performance** — fog-matched draw distance, mobile-specific pixel ratio/radius,
  frustum culling, merged geometry (~2 draw calls per tile + instancing), and
  localStorage position persistence.

## Data sources

- © OpenStreetMap contributors (ODbL) — buildings, roads, parks, trees, subway entrances
- NYC Open Data — borough boundaries (water-clipped)
- MTA — subway stations, routes, structure types
- Station interiors are stylized approximations informed by public documentation of
  NYC station layouts (see e.g. Project Subway NYC for the real things).

## Data sources (additions)

- USGS/AWS Terrain Tiles (Terrarium) — elevation
- MTA GTFS static — route stop sequences and travel times

## Known limitations

- Riding between stations is a stylized car-interior experience (scrolling tunnel +
  arrival backdrops), not a continuous modeled tunnel network.
- Bridges render elevated but aren't walkable; station complexes model the primary
  platform set rather than full passageway networks; procedural trees approximate
  real planting.
- Headways are gamified (~30 s per direction) rather than schedule-accurate.
