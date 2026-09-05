# Transit and vegetation follow-up

Based on main after PR 39 (`67a3a7e8`). This pass addresses close-range transit
geometry, missing station surface detail, tree LOD selection, and arrival clocks.

## Visible changes

- Subway car floors now sit 1.10 m above the rail datum, matching the existing
  underground and elevated platform heights. Wheels follow the rail gauge.
- IRT cars have three door bays per side; the longer B-division model has four.
  Paired steel frames cover the full 1.30 m opening, with continuous stiles,
  glazing, sills and jambs. Only the platform side opens. Both sides have windows.
- Stainless bodies gain rounded roofs, roof equipment, couplers, interior end
  walls, seat backs and grab rails. The ride cabin adds molded seats, armrests,
  ceiling joints, vents, door seals, glazing, and a speckled rubber floor.
- Buses gain physical curved wheel openings, arch trim, body seams and latches,
  smoother tires and hubs, rounded roof equipment, thin glazing, and rounded
  seats in a less saturated blue.
- Stations gain properly scaled wall tiles, tactile domes at track-facing edges,
  sleepers and rail fastening plates. The architecture optimizer now preserves
  custom material shaders when cloning materials for vertex occlusion; it had
  been removing the platform floor texture. Elevated platforms gain floor grain,
  visible canopy ribs and light housings; improved ground bounce keeps their
  undersides from reading as black voids.
- Near trees have folded leaf clusters and tapered branches. LOD follows each
  tree's position rather than its 256 m tile center, with hysteresis around the
  70 m near-detail boundary. Distant crowns now supply vertex colors to their
  shared shader, fixing black tree silhouettes.

These remain representative procedural vehicles, not a surveyed model of every
fleet variant. Door layout and transit proportions use the existing IRT and
B-division model families. Reference context: [MTA vehicle requirements](https://www.mta.info/document/172206),
[Kawasaki subway fleet](https://global.kawasaki.com/en/corp/newsroom/news/detail/?f=20230306_7827),
and [New Flyer Xcelsior](https://www.newflyer.com/new-flyer-buses-meet-the-xcelsior-family/).

## Arrival behavior

One displayed **MIN** is one gameplay second. The board and moving train read
the same deterministic phase clock. “Now” means the doors are fully open for
boarding. Future rows continue counting down while the current train dwells.
The scheduler carries elapsed time across phase and spawn boundaries, removing
frame-rate-dependent drift and random dwell/departure offsets. Stepping off a
ride reseeds both the visible train and the next forecast consistently. Boards
retain their existing half-second refresh and redraw only when text changes.

## Rendering costs and validation

Car geometry and glazing remain shared and batched. Station track hardware is
one instanced submission per track. Static ride fittings are merged by material;
moving leaves retain separate frame, seal and glass batches. Glass uses low
opacity and a single pass without transmission buffers. Station and ride
instance buffers are disposed on exit. Tree selections compact existing instance
buffers and upload only when a selection changes; source matrix snapshots add
roughly 304 CPU bytes per tree plus indices and LOD metadata.

The final production build and 118 engine tests pass. Tests cover actual arrival
forecasts through route rotations and reboarding, coarse/fine frame partitions,
door coverage and height, wheel clearance, material shader preservation, cabin
batching, and tree LOD transitions and colors. Muted browser checks cover station
surfaces, subway boarding/exit, bus interiors/exteriors, and nearby foliage.

Performance measurements use the unchanged repository contracts. Mobile results
are Chromium device emulation on this host, not physical-phone measurements.


### Final capture

All 12 route/profile checks pass for implementation commit `fdc96caf`.
The measured host is an Apple M1 Max using ANGLE Metal. No frame-time, draw-call,
triangle, memory, or streaming limits were relaxed. The full contract metrics are
recorded in [transit-fidelity-performance.json](transit-fidelity-performance.json).

| Profile | Route | 1% low FPS | CPU p95 (ms) | GPU p95 (ms) | Draws p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| mobile-low | times-square | 93.3 | 2.10 | 1.61 | 117 |
| mobile-low | central-park | 107.5 | 1.30 | 1.36 | 59 |
| mobile-low | waterfront | 107.5 | 1.50 | 2.15 | 82 |
| mobile-low | times-square-station | 107.5 | 1.30 | 2.24 | 117 |
| mobile-medium | times-square | 106.3 | 2.71 | 2.48 | 123 |
| mobile-medium | central-park | 106.4 | 1.60 | 2.06 | 69 |
| mobile-medium | waterfront | 107.5 | 2.00 | 2.58 | 101 |
| mobile-medium | times-square-station | 106.4 | 1.10 | 2.58 | 79 |
| desktop-high | times-square | 106.3 | 3.70 | 4.98 | 233 |
| desktop-high | central-park | 106.4 | 2.50 | 5.92 | 141 |
| desktop-high | waterfront | 106.3 | 2.80 | 4.72 | 194 |
| desktop-high | times-square-station | 106.4 | 1.70 | 3.25 | 172 |
