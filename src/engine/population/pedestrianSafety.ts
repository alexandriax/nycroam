interface TrafficFootprint {
  x: number;
  z: number;
  fx: number;
  fz: number;
  halfLength: number;
  halfWidth: number;
}

export interface PedestrianProgress {
  distance: number;
  direction: 1 | -1;
}

/**
 * Exact circle-versus-oriented-rectangle contact. Pedestrians use circular
 * ground footprints so their articulated render pose never changes collision.
 */
export function pedestrianTrafficOverlap(
  x: number,
  z: number,
  radius: number,
  traffic: TrafficFootprint,
  margin = 0,
): boolean {
  const dx = x - traffic.x;
  const dz = z - traffic.z;
  const along = dx * traffic.fx + dz * traffic.fz;
  const sideX = -traffic.fz;
  const sideZ = traffic.fx;
  const lateral = dx * sideX + dz * sideZ;
  const nearestAlong = Math.max(
    -traffic.halfLength,
    Math.min(traffic.halfLength, along),
  );
  const nearestLateral = Math.max(
    -traffic.halfWidth,
    Math.min(traffic.halfWidth, lateral),
  );
  const contactRadius = radius + margin;
  return (along - nearestAlong) ** 2 + (lateral - nearestLateral) ** 2
    <= contactRadius * contactRadius;
}

/**
 * Advance a walker along a finite sidewalk segment without wall-clock time.
 * The unfolded phase makes arbitrary steps deterministic across endpoint
 * bounces and prevents a suspended browser tab from teleporting pedestrians.
 */
export function advancePedestrianProgress(
  distance: number,
  direction: 1 | -1,
  step: number,
  length: number,
): PedestrianProgress {
  if (!(length > 0) || !(step > 0)) {
    return {
      distance: Math.max(0, Math.min(Math.max(0, length), distance)),
      direction,
    };
  }
  const period = length * 2;
  const unfolded = direction > 0 ? distance : period - distance;
  const phase = ((unfolded + step) % period + period) % period;
  return phase < length
    ? { distance: phase, direction: 1 }
    : { distance: period - phase, direction: -1 };
}

/**
 * NYC sidewalk traffic keeps right. On opposite travel headings this gives
 * walkers distinct lanes on the same sidewalk instead of one shared centerline.
 */
export function pedestrianLaneOffset(
  direction: 1 | -1,
  roadSide: 1 | -1,
  separation = 0.39,
): number {
  return direction * roadSide * separation;
}

/**
 * Continuous closest-approach test for two moving pedestrian discs. Testing
 * the sweep, rather than only the end positions, prevents walkers from swapping
 * sides of one another during a slow frame.
 */
export function pedestrianSweepsOverlap(
  ax0: number,
  az0: number,
  ax1: number,
  az1: number,
  ar: number,
  bx0: number,
  bz0: number,
  bx1: number,
  bz1: number,
  br: number,
  margin = 0,
): boolean {
  const startX = ax0 - bx0;
  const startZ = az0 - bz0;
  const velocityX = (ax1 - ax0) - (bx1 - bx0);
  const velocityZ = (az1 - az0) - (bz1 - bz0);
  const speedSq = velocityX * velocityX + velocityZ * velocityZ;
  const t = speedSq > 1e-12
    ? Math.max(
      0,
      Math.min(1, -(startX * velocityX + startZ * velocityZ) / speedSq),
    )
    : 0;
  const dx = startX + velocityX * t;
  const dz = startZ + velocityZ * t;
  const radius = ar + br + margin;
  return dx * dx + dz * dz <= radius * radius;
}

function segmentIntersectsAabb(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  let enter = 0;
  let exit = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;
  if (Math.abs(dx) < 1e-12) {
    if (x0 < minX || x0 > maxX) return false;
  } else {
    const a = (minX - x0) / dx;
    const b = (maxX - x0) / dx;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return false;
  }
  if (Math.abs(dz) < 1e-12) {
    return z0 >= minZ && z0 <= maxZ;
  }
  const a = (minZ - z0) / dz;
  const b = (maxZ - z0) / dz;
  enter = Math.max(enter, Math.min(a, b));
  exit = Math.min(exit, Math.max(a, b));
  return enter <= exit;
}

function segmentPointDistanceSq(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  px: number,
  pz: number,
): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 1e-12
    ? Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / lengthSq))
    : 0;
  return (x0 + dx * t - px) ** 2 + (z0 + dz * t - pz) ** 2;
}

/**
 * Exact segment-versus-rounded-rectangle sweep. In traffic-local space the
 * rectangle expanded by a pedestrian radius is two axis-aligned strips plus
 * four quarter-circle corners; testing all six pieces closes corner tunneling
 * without substeps or allocations.
 */
export function pedestrianStepHitsTraffic(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  radius: number,
  traffic: readonly TrafficFootprint[],
  margin = 0,
): boolean {
  const midX = (x0 + x1) * 0.5;
  const midZ = (z0 + z1) * 0.5;
  const halfStep = Math.hypot(x1 - x0, z1 - z0) * 0.5;
  for (const body of traffic) {
    const broadRadius = Math.hypot(body.halfLength, body.halfWidth)
      + radius + margin + halfStep;
    if (
      (body.x - midX) ** 2 + (body.z - midZ) ** 2
      > broadRadius * broadRadius
    ) continue;
    const dx0 = x0 - body.x;
    const dz0 = z0 - body.z;
    const dx1 = x1 - body.x;
    const dz1 = z1 - body.z;
    const sideX = -body.fz;
    const sideZ = body.fx;
    const lx0 = dx0 * body.fx + dz0 * body.fz;
    const lz0 = dx0 * sideX + dz0 * sideZ;
    const lx1 = dx1 * body.fx + dz1 * body.fz;
    const lz1 = dx1 * sideX + dz1 * sideZ;
    const expanded = radius + margin;
    if (
      segmentIntersectsAabb(
        lx0, lz0, lx1, lz1,
        -body.halfLength - expanded,
        body.halfLength + expanded,
        -body.halfWidth,
        body.halfWidth,
      )
      || segmentIntersectsAabb(
        lx0, lz0, lx1, lz1,
        -body.halfLength,
        body.halfLength,
        -body.halfWidth - expanded,
        body.halfWidth + expanded,
      )
    ) return true;
    const radiusSq = expanded * expanded;
    for (const cornerX of [-body.halfLength, body.halfLength]) {
      for (const cornerZ of [-body.halfWidth, body.halfWidth]) {
        if (
          segmentPointDistanceSq(
            lx0, lz0, lx1, lz1, cornerX, cornerZ,
          ) <= radiusSq
        ) return true;
      }
    }
  }
  return false;
}
