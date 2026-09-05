# Living transit follow-up

Based on merged PR 40 (`6c3c96ff`). This pass focuses on the occupied transit
experience, close-range cabin geometry, and the agreement between a ride's
windows, platform, doors and countdowns.

## Service and travel

- A displayed service minute is now **40 gameplay seconds**. Initial boarding
  occurs in about **15–20 seconds**, followed by service at **30-second** intervals.
  The live timeline still determines the forecast: Now means boardable, and rows
  are not artificially clamped to hide a longer wait. The nearest services
  normally read Now, 1 or 2 MIN; a later forecast can briefly read 3 MIN.
- Train motion and door animation speeds are preserved. The scheduler exposes
  its live car layouts, door readiness and remaining boarding time to passengers.
- The ride uses the authored track group, service direction and platform cross
  section, including Times Square local/express sides and 7 Av's stacked levels.
  Exiting a terminal preserves a train ready for the return trip.
- Platforms now extend to an 8 cm nominal exterior-body clearance. Slabs, tactile
  strips, collision floors and passenger paths use the same bounds in ordinary,
  complex, elevated and ride scenes. Existing tracks and stairs retain their
  authored positions.
- The window view accelerates out of the origin and decelerates past the next
  platform. Tunnel walls and utilities are clipped around the platform footprint.
  Origin and destination scenery are cached during dwell, with at most two
  stations retained. Elevated views have open sky and platform architecture;
  their surrounding city is not yet streamed along the ride route.

## People and close-range details

- Platforms, fare areas and station trains share bounded instanced commuter pools.
  People wait, walk around stairs and furniture, alight through actual open bays,
  then board after the first wave clears. Door reservations, closing deadlines
  and train recycling prevent continued crossings through closed or moving cars.
- Ride cabins have seated and standing occupants and doorway exchanges. Character
  segments have joint metadata for connected seated legs and a driver arm pose.
  Clothing, skin, hair and shoes preserve distinct colors. Coat/arm proportions
  fit the seats, and the player remains in the clear aisle between door bays.
- Seat-edge poles reach the ceiling and join the overhead rails. The rails break
  around the cased next-stop indicator. Initial open doors immediately match the
  boarding state, and walk-off exits require the correct open doorway.
- Buses gain adult-width seats, seat-back handholds, connected grab rails, a
  speckled rubber floor, a seated driver holding the wheel, and seated riders.
  Occupants remain inside the detailed bus LOD, adding two instanced submissions.
  Detailed axles also respect that LOD after idle loading. A curb-side passage
  reaches the front doorway while excluding the driver cab; walking off requires
  a real open doorway instead of an adjacent body panel.
- Embedded-browser pointer-lock rejection now leaves drag-to-look working without
  an unhandled promise rejection.

The vehicles and characters remain procedural models. This is an improvement to
geometry, activity and consistency, rather than a claim of AAA photorealism or a
surveyed reconstruction of every fleet variant. Passenger identities are local
to each scene, not a persistent citywide population simulation.

## Validation and performance

Engine regressions cover countdowns, route rotation, reboarding, coarse frames,
all authored platform clearances, correct stacked levels, terminal direction,
rail/sign clearance, seat and doorway movement bounds, scenery caching, passenger
navigation, exchange order, unique seats, joint metadata and resource reuse.

The benchmark suite now includes a 32-second moving-train capture. The station
capture moves to the platform and lasts 36 seconds, covering an arrival and
passenger exchange instead of only an empty mezzanine. It is therefore a stricter
scene than the prior station baseline. Benchmark captures retain up to 12,000
frames and require at least 30 seconds of transit history, so a fast display
cannot roll the arrival out of the normal 1,200-frame window. The normal runtime
capacity is restored after capture. Paused surface queues remain in raw streaming
diagnostics but no longer drive active underground streaming pressure or the
quality governor. The existing draw, triangle, frame-time,
memory and streaming limits are unchanged; rides use station limits.

Final measured results will be recorded in `living-transit-performance.json`.
Mobile profiles are Chromium emulation on the measured desktop host, not physical
phone or thermal measurements. Browser visual checks are performed with sound
muted.
