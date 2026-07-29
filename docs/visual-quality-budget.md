# Visual quality and performance contract

NYC Roam renders a city-scale data set on phones and desktop GPUs. Fidelity is
therefore allocated by perceptual distance rather than applied uniformly:

- **Near (0–120 m):** semantic façades, windows, curbs, gutters, traffic,
  furniture, full material response, and contact shadows.
- **Mid (120–420 m):** semantic massing, roofs, compressed surface detail, and
  simplified vegetation.
- **Far (420 m+):** silhouette, terrain, water, skyline, and atmosphere.

New features must improve one of these bands without increasing draw calls per
source object. Prefer merged tile geometry, instancing, texture arrays, vertex
attributes, and baked detail over independent meshes and materials.

## Sustained targets

Targets are evaluated over a five-minute route after shader warm-up. Report
median, p95, p99, and one-percent-low frame time; an average FPS alone is not a
release criterion.

| Profile | Frame target | Street draws | Station draws | Visible triangles | Resident GPU assets |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mobile Low | stable 30 FPS | 250–350 | ≤300 | 0.5–0.9 M | ≤160 MB |
| Mobile Medium | 45 FPS when thermally sustainable | 300–450 | ≤400 | 0.7–1.2 M | ≤220 MB |
| Desktop High | locked 60 FPS | 600–900 | ≤700 | 1.5–3.0 M | ≤500 MB |
| Desktop Ultra | 60 FPS on a discrete GPU | ≤1,200 | ≤900 | ≤5.0 M | ≤800 MB |

Desktop High should keep CPU submission below 8 ms and GPU work below
13–14 ms at p95. Mobile Medium should keep sustained GPU work below roughly
19–20 ms and avoid monotonically increasing memory or frame time during the
five-minute route.

## Quality ladder

Runtime adaptation treats CPU, GPU, and streaming pressure separately:

- GPU pressure reduces optional effects and shadow cost before render scale.
- CPU pressure reduces simulated population and near-detail distance while
  protecting image resolution.
- Streaming pressure reduces speculative prefetch independently of visible
  tile residency.
- Recovery is deliberately slower than degradation and restores the most
  recently reduced setting first.

Mobile tiers use baked/contact approximations wherever a full shadow or
screen-space pass is not visible at phone scale. No tier may enable an effect
whose degradation rung is a no-op.

## Content rules

- Façade archetype IDs are stable: `0` brick/prewar, `1` glass curtain,
  `2` limestone/stone, `3` concrete/postwar, `4` industrial/loft,
  `5` brownstone/rowhouse, `6` metal/commercial, `7` mixed-use/storefront.
- Existing tile files without semantic fields must retain deterministic visual
  output through runtime inference.
- Materials are shared. Per-building or per-prop material instances are not
  allowed in streamed city layers.
- Repeated props use `InstancedMesh`, merged geometry, or an equivalent pooled
  representation.
- Static stations are batched before dynamic trains and countdown content are
  attached.
- Hero landmarks may use authored LODs and baked maps, but require a shadow
  proxy and a measured residency/draw-call budget.
- Texture additions should use KTX2/Basis and mesh additions should prefer
  Meshopt when the asset pipeline is introduced. Unique multi-megabyte textures
  per building are not acceptable.

## Golden routes

Every visual or performance PR should test at least:

1. Columbus Circle opening and Central Park edge.
2. Times Square street level.
3. A waterfront view with water and long-distance skyline.
4. A representative simple subway station.
5. The Times Square station complex.
6. Forced-mobile rendering via `?touch=1`.

Interactive automated tests must set `nycroam-muted=1` in local storage before
the first user gesture. Capture renderer draw calls, triangles, loaded/pending
tiles, quality decisions, and screenshots at repeatable camera links.
