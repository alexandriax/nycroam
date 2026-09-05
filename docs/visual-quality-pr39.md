# PR 39: city and street detail

The branch merges main at `621c7bf0` and preserves its semantic tiles, authored
landmarks, streaming layers, temporal antialiasing, quality governor, traffic
and transit simulation. It also incorporates the road-depth compositor from
PR 38, which prevents terrain from hiding streets.

## What changes visually

- Six photographic PBR surfaces replace generated noise for brick, dressed
  stone, concrete, asphalt and roof ballast. Source classifications and palettes
  still control building appearance. Source/license inventory is in
  [the asset directory](../assets/materials/scans/README.md).
- Each building carries local wall distance, street-relative height, wall
  length and a stable identity seed. Windows fit whole bays onto actual
  footprint edges. Floor heights and opening proportions vary by building;
  hillside storefronts stay on the ground floor.
- Scanned wall normals use exactly the same window mask as color. Masonry
  relief no longer distorts the glass. Punched windows gain recessed-room,
  shade, curtain, sash and lintel detail; continuous curtain-glass reflection
  from main is preserved.
- Nearby prewar buildings gain cornice profiles, brownstone steps and bounded
  fire-escape platforms, rails and open treads. These are representative
  procedural details, not surveyed individual fire-escape locations.
- Shared landmark masonry materials and the Flatiron/Met Life stone palettes
  use the atlas. The authored footprints, heights, setbacks and crowns stay
  intact, including the newer landmark accuracy work already on main.
- Near people have shaped faces, hair, ears, eyes, noses, layered jackets,
  trousers, collars, bags and separate shoe soles. Skin and garment colors are
  independently preserved; animated limb normals follow the walking pose.
- Cars gain mirrors, door handles, trim, plate recesses, panel seams, painted
  roofs and separate sedan/SUV/van roof profiles. Opaque glass avoids
  transparent sorting across the vehicle pool.
- Near trees use individual curved leaf sprays with geometric gaps. Low,
  middle and distant silhouettes retain inexpensive closed geometry.
- Water gains filtered wind chop, an estuary palette, Schlick-style Fresnel and
  the correct world-to-view conversion for wave lighting.

## Performance contracts

All three material atlases remain 2048×2048 with the same sixteen regions,
mip chains and quality-dependent channel loading. Total KTX2 transfer is
6.12 MiB, up from 4.03 MiB; the compressed GPU upper bound stays 16 MiB.
Sources take 8.9 MiB in the repository and are not runtime assets.

Population remains sixteen color submissions, the same pool capacities and
update cadences, with no per-person skeletons or per-leaf objects. Full-pool
triangle ceilings are now 51,538 / 108,522 / 180,932 / 252,976 for
Low / Medium / High / Ultra. The test ceiling is explicitly 260,000; it is a
geometry budget increase, not a relaxation of the browser frame-time gates.
Road depth masking adds one depth-only draw per visible road layer and reuses
its existing vertex buffer. Building layout data adds sixteen bytes per vertex,
accounted for in worker transfer and scene residency telemetry.

Repeated neighborhood-density queries use a bounded exact-coordinate cache.
Traffic guards reject distant swept bounds cheaply and subdivide only ambiguous
rotating collision intervals. Continuous collision protection remains intact,
including dimension changes; randomized contact tests exercise the guard.

## Validation

Run `npm run test:engine`, `npm run build`, then:

```sh
node scripts/benchmarks/run.mjs --profiles mobile-low,mobile-medium,desktop-high
```

The engine suite checks real worker output for elevation-independent facade
coordinates, wall widths, deterministic variation, buffer transfer and byte
accounting. It also checks articulated geometry, foliage bounds/determinism,
material payload hashes, road composition, rendering and simulation contracts.

Benchmark results are recorded in [pr39-performance.json](pr39-performance.json).
Mobile profiles are Chromium device emulation on the host, not measurements on
physical phones. The game remains a streamed procedural city; these changes do
not turn its source data into surveyed photogrammetry or a full AAA asset set.

### Recorded outcome (September 5, 2026)

- 107 engine tests pass; production build and all KTX2 validation checks pass.
- Low passes all four routes. With game previews unloaded, Medium also passes
  all four routes (49–106 FPS 1% lows).
- High passes Central Park, waterfront and station. Times Square has a 104 FPS
  median but misses two gates: 30.25 FPS 1% low versus 45 required, and 9.60 ms
  CPU p95 versus 8 ms allowed. GPU p95 is 6.24 ms and its frame p95 gate passes.
- An earlier contemporary main run also failed desktop gates, but was not fully
  isolated from the local preview. That comparison does **not** establish parity
  or excuse the remaining Times Square hitching. Earlier loaded-host failures
  are retained alongside the final capture rather than discarded.
- The PR remains draft pending a clean desktop performance result. Frame-time
  thresholds were not weakened. No claim of smooth performance on every device
  or AAA photorealism is made.
- Visual checks on the production build covered roads, the Flatiron stone,
  people, foliage and waterfront water. Browser captures reported no shader or
  runtime errors. Vercel preview deployment succeeds.
