# Rendering quality and performance

This pass upgrades the existing procedural WebGL city. It does not replace the
city with a photogrammetry dataset or claim native AAA fidelity. Bespoke landmark
builders, tile suppression, measured attachment offsets, transit routes, and
collision remain the source of truth.

## Changes

- Buildings use physically based shading, with separate window/masonry
  roughness, environment reflections, room-to-room blinds, inset shading, and
  derivative-filtered window edges. A worker-provided ground datum keeps
  storefronts at street level on hills. Named historic towers retain masonry.
- Roads use calibrated asphalt albedo and restrained aggregate normals; concrete
  keeps its expansion joints. Brick courses use a more plausible 24 × 8 cm pitch.
- Landmark stone, brick, metal, and copper patina use shared meter-scaled finishes.
  Materials preserve the per-material merger; shader detail adds no geometry.
- Chrysler's upper masonry setbacks are separated from its stainless crown, with
  actual triangular sunburst window shapes. Empire State's observation tower now
  continues to 381 m, followed by its antenna to 443.2 m. Measured OSM attachment
  datums are preserved. These remain architectural approximations.
- Brooklyn Bridge and Trinity Church use pointed arch openings. Charging Bull
  uses curved muscle volumes; shared statue figures have smoother silhouettes.
  Other authored landmarks inherit the finish improvements without replacing
  their layouts or collision.
- Outdoor metals/glass reflect a prefiltered outdoor sky instead of having no
  environment. Subway interiors keep their room environment; train shells and
  doors have stainless finishes with filtered brushed detail.
- Water uses view-correct lighting, several traveling wave-normal frequencies,
  grazing-angle reflectance, estuary colors, and distance-dependent roughness.
  Waves animate shading, not mesh displacement. Reflections are an environment
  approximation, not reflections of nearby buildings; no second scene render.
- Tree canopies use individual alpha-tested leaf clusters in shared instanced
  geometry instead of faceted solid blobs.
- Local pedestrians animate their gait and walk along validated short sidewalk
  segments. Detailed cars are parked at curbs. They are ambient scenery, not a
  traffic/navigation simulation or collidable vehicles. Vehicles are excluded
  from pedestrian paths, plazas, bike paths, and bridge centerlines.

## Budgets and lifetime

Desktop starts with a 2048px sun shadow map over a tighter 300m-wide shadow
region, snapped in light space. The constrained tier omits shadows. The maximum
render target is 3.2 million pixels in addition to DPR caps; adaptive resolution
can fall below native resolution and recovers gradually when headroom returns.
The standard street load radii are 1000m and 700m; existing altitude/velocity
streaming and distance LOD continue to apply.

Ambient actors use two color-pass draws: up to 72 pedestrians and 24 parked cars
on desktop, or 28 and 10 on constrained devices. Cars add one instanced shadow
pass when shadows are enabled. Pedestrians have no dynamic shadows. Placement
admission yields between candidates under a 1.5ms per-frame target (one candidate
may exceed this target); existing buffers remain visible until admission finishes.
Population density decreases with render resolution and recovers with it.

Texture filtering follows device budgets. Shared canvas surface textures are not
freed when a tile or prop unloads. Per-tile sign materials are released only when
the tile owns their atlas. Engine shutdown releases its material/geometry and
indoor/outdoor environment targets. Cached surface atlases remain reusable.

## Validation

Run `npm test`, `npm run typecheck`, and `npm run build`. The regression suite
checks device detection, render target limits, historical material selection,
finite actor geometry/resource disposal, safe and blocked admissions, density
recovery, exclusion of non-street paths, open arch collision geometry, and fitted
crown heights/triangle limits.

The game canvas exposes a read-only `data-render-stats` JSON attribute refreshed
with the HUD: FPS, rolling p95 frame interval (last 120 visible-tab frames), draw
calls, triangle count, geometry/texture counts, current DPR, sun-shadow settings,
and actor counts. Unlike simulation time, FPS uses the unclamped frame interval.
This makes stalls visible rather than reporting a misleading minimum of 20fps.

Physical-device performance, sustained thermal throttling, Safari/Android GPU
behavior, and long traversal need separate hardware testing. A narrow desktop
browser viewport checks responsive layout; it does not emulate a phone GPU.

## Architectural references

- [Empire State Building architecture](https://www.esbnyc.com/about/architecture-design)
  and [facts and figures](https://www.esbnyc.com/es/about/facts-figures).
- [Chrysler Building designation report, hosted by the Art Deco Society](https://www.artdeco.org/_files/ugd/cfca41_b6cf603aa7cb4039a879d362b221c677.pdf):
  stainless arches and triangular windows.
- [NYC Landmarks Preservation Commission: Brooklyn Bridge](https://s-media.nyc.gov/agencies/lpc/lp/0098.pdf):
  stone towers and pointed Gothic arches.

Future fidelity work should use licensed architectural scans, photographic PBR
surfaces, rigged character assets, and vehicle LODs, with measured download and
GPU-memory budgets. Moving traffic requires directed street/intersection data;
the present minimap centerlines do not establish one-way legality or signals.

Local production snapshots are saved in
[`visual-quality-benchmark.json`](visual-quality-benchmark.json).
Desktop street samples ranged from 67 to 110 fps at the captured views; a 390×844
subway viewport reached 120 fps on the same desktop GPU. These are view-dependent
snapshots, not a cross-device guarantee or a measured improvement against baseline.
