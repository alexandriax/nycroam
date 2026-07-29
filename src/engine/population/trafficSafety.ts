export interface TrafficFootprint {
  key: string;
  x: number;
  z: number;
  /** Unit world-space travel direction. */
  fx: number;
  fz: number;
  halfLength: number;
  halfWidth: number;
  speed: number;
  /** Transit and emergency vehicles win mixed-traffic conflict ties. */
  priority?: boolean;
}

function projectionRadius(
  footprint: TrafficFootprint,
  axisX: number,
  axisZ: number,
): number {
  const sideX = -footprint.fz;
  const sideZ = footprint.fx;
  return footprint.halfLength * Math.abs(footprint.fx * axisX + footprint.fz * axisZ)
    + footprint.halfWidth * Math.abs(sideX * axisX + sideZ * axisZ);
}

/** Exact 2D separating-axis test for two oriented traffic rectangles. */
export function trafficFootprintsOverlap(
  a: TrafficFootprint,
  b: TrafficFootprint,
  margin = 0,
): boolean {
  const tx = b.x - a.x;
  const tz = b.z - a.z;
  const axes: Array<readonly [number, number]> = [
    [a.fx, a.fz],
    [-a.fz, a.fx],
    [b.fx, b.fz],
    [-b.fz, b.fx],
  ];
  for (const [axisX, axisZ] of axes) {
    const distance = Math.abs(tx * axisX + tz * axisZ);
    const extent = projectionRadius(a, axisX, axisZ)
      + projectionRadius(b, axisX, axisZ)
      + margin;
    if (distance > extent) return false;
  }
  return true;
}

/**
 * Predict a near-term body conflict without allocating temporary objects.
 * Sampling three bounded horizons is cheaper and more robust on curved OSM
 * routes than an infinite-line closest-approach test.
 */
export function trafficSweptConflict(
  a: TrafficFootprint,
  b: TrafficFootprint,
  horizon = 1.35,
): boolean {
  if (trafficFootprintsOverlap(a, b, 0.35)) return true;
  const ax = a.x;
  const az = a.z;
  const bx = b.x;
  const bz = b.z;
  for (const fraction of [1 / 3, 2 / 3, 1]) {
    const t = horizon * fraction;
    a.x = ax + a.fx * a.speed * t;
    a.z = az + a.fz * a.speed * t;
    b.x = bx + b.fx * b.speed * t;
    b.z = bz + b.fz * b.speed * t;
    const overlap = trafficFootprintsOverlap(a, b, 0.55);
    a.x = ax;
    a.z = az;
    b.x = bx;
    b.z = bz;
    if (overlap) return true;
  }
  return false;
}

/** Stable right-of-way prevents two predicted cross-traffic conflicts deadlocking. */
export function yieldsTo(a: TrafficFootprint, b: TrafficFootprint): boolean {
  if (Boolean(a.priority) !== Boolean(b.priority)) return Boolean(b.priority);
  return a.key > b.key;
}
