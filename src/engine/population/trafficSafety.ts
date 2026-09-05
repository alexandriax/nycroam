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
  /** Static world body that moving traffic must route around, never displace. */
  immovable?: boolean;
}

export interface TrafficMotion {
  start: TrafficFootprint;
  end: TrafficFootprint;
}

export interface TrafficEscape {
  end: TrafficFootprint;
  shiftX: number;
  shiftZ: number;
  heldRoute: boolean;
  blockerKey: string;
}

// Adaptive interval midpoints are inflated by the maximum travel to either
// endpoint. Stop subdivision at five centimetres of conservative inflation
// so valid bend-away clearance does not become a permanent rollback.
const ROTATING_SWEEP_SAMPLE_DISTANCE = 0.1;

interface TrafficMotionBucket {
  fixed: TrafficFootprint[];
  moving: TrafficMotion[];
}

/** Collision-free deterministic key for numeric traffic actors at any scale. */
export function trafficPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
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

/**
 * Signed daylight from the front of `mover` to `obstacle`, measured along the
 * mover's heading. Null means the obstacle is outside the mover's lane width.
 */
export function trafficForwardClearance(
  mover: TrafficFootprint,
  obstacle: TrafficFootprint,
  lateralMargin = 0,
): number | null {
  const dx = obstacle.x - mover.x;
  const dz = obstacle.z - mover.z;
  const sideX = -mover.fz;
  const sideZ = mover.fx;
  const lateral = Math.abs(dx * sideX + dz * sideZ);
  const obstacleLateralExtent = projectionRadius(obstacle, sideX, sideZ);
  if (
    lateral
    >= mover.halfWidth + obstacleLateralExtent + lateralMargin
  ) return null;
  const along = dx * mover.fx + dz * mover.fz;
  const obstacleForwardExtent = projectionRadius(
    obstacle,
    mover.fx,
    mover.fz,
  );
  return along - mover.halfLength - obstacleForwardExtent;
}

/**
 * Signed displacement along `mover`'s right axis that clears an immovable body.
 * Zero means the body is either movable, outside the local forward corridor, or
 * already has enough lateral daylight. Buses use this as a bounded lane-change
 * target while their longitudinal guard waits short of parked curb traffic.
 */
export function trafficLateralEscape(
  mover: TrafficFootprint,
  obstacle: TrafficFootprint,
  lookahead = 20,
  margin = 0.08,
): number {
  if (!obstacle.immovable) return 0;
  const dx = obstacle.x - mover.x;
  const dz = obstacle.z - mover.z;
  const along = dx * mover.fx + dz * mover.fz;
  const obstacleForwardExtent = projectionRadius(
    obstacle,
    mover.fx,
    mover.fz,
  );
  if (
    along < -mover.halfLength - obstacleForwardExtent
    || along > lookahead + mover.halfLength + obstacleForwardExtent
  ) return 0;
  const sideX = -mover.fz;
  const sideZ = mover.fx;
  const lateral = dx * sideX + dz * sideZ;
  const obstacleLateralExtent = projectionRadius(obstacle, sideX, sideZ);
  const penetration = mover.halfWidth + obstacleLateralExtent + margin
    - Math.abs(lateral);
  if (penetration <= 0) return 0;
  if (Math.abs(lateral) > 1e-6) {
    return lateral > 0 ? -penetration : penetration;
  }
  return mover.key < obstacle.key ? -penetration : penetration;
}

/** Exact 2D separating-axis test for two oriented traffic rectangles. */
export function trafficFootprintsOverlap(
  a: TrafficFootprint,
  b: TrafficFootprint,
  margin = 0,
): boolean {
  const tx = b.x - a.x;
  const tz = b.z - a.z;
  const reach = a.halfLength + a.halfWidth + b.halfLength + b.halfWidth + margin;
  if (Math.abs(tx) > reach || Math.abs(tz) > reach) return false;
  for (let axisIndex = 0; axisIndex < 4; axisIndex++) {
    let axisX: number;
    let axisZ: number;
    if (axisIndex === 0) {
      axisX = a.fx; axisZ = a.fz;
    } else if (axisIndex === 1) {
      axisX = -a.fz; axisZ = a.fx;
    } else if (axisIndex === 2) {
      axisX = b.fx; axisZ = b.fz;
    } else {
      axisX = -b.fz; axisZ = b.fx;
    }
    const distance = Math.abs(tx * axisX + tz * axisZ);
    const extent = projectionRadius(a, axisX, axisZ)
      + projectionRadius(b, axisX, axisZ)
      + margin;
    if (distance > extent) return false;
  }
  return true;
}

/**
 * Exact continuous SAT for two oriented rectangles moving with fixed headings
 * over a bounded horizon. This catches short crossing conflicts between sample
 * times and never mutates the caller's footprint snapshot.
 */
export function trafficSweptConflict(
  a: TrafficFootprint,
  b: TrafficFootprint,
  horizon = 1.35,
): boolean {
  const tx = b.x - a.x;
  const tz = b.z - a.z;
  const relativeVelocityX = b.fx * b.speed - a.fx * a.speed;
  const relativeVelocityZ = b.fz * b.speed - a.fz * a.speed;
  let enter = 0;
  let exit = horizon;
  for (let axisIndex = 0; axisIndex < 4; axisIndex++) {
    let axisX: number;
    let axisZ: number;
    if (axisIndex === 0) {
      axisX = a.fx; axisZ = a.fz;
    } else if (axisIndex === 1) {
      axisX = -a.fz; axisZ = a.fx;
    } else if (axisIndex === 2) {
      axisX = b.fx; axisZ = b.fz;
    } else {
      axisX = -b.fz; axisZ = b.fx;
    }
    const center = tx * axisX + tz * axisZ;
    const velocity =
      relativeVelocityX * axisX + relativeVelocityZ * axisZ;
    const extent = projectionRadius(a, axisX, axisZ)
      + projectionRadius(b, axisX, axisZ)
      + 0.55;
    if (Math.abs(velocity) < 1e-9) {
      if (Math.abs(center) > extent) return false;
      continue;
    }
    const first = (-extent - center) / velocity;
    const second = (extent - center) / velocity;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return false;
  }
  return exit >= 0 && enter <= horizon;
}

function shortestHeadingDelta(
  start: TrafficFootprint,
  end: TrafficFootprint,
): number {
  let delta = Math.atan2(end.fz, end.fx) - Math.atan2(start.fz, start.fx);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  // A traffic footprint is an unoriented rectangle: reversing its forward
  // vector by 180° leaves the occupied geometry exactly unchanged. Endpoint
  // ping-pong therefore needs the linear sweep, not an expensive fictitious
  // full-body pirouette between two geometrically identical poses.
  if (Math.abs(Math.abs(delta) - Math.PI) < 1e-6) return 0;
  return delta;
}

function trafficMotionBound(
  start: TrafficFootprint,
  end: TrafficFootprint,
  angleDelta: number,
): number {
  const radius = Math.max(
    Math.hypot(start.halfLength, start.halfWidth),
    Math.hypot(end.halfLength, end.halfWidth),
  );
  return Math.hypot(end.x - start.x, end.z - start.z)
    + Math.abs(angleDelta) * radius
    + Math.hypot(end.halfLength - start.halfLength, end.halfWidth - start.halfWidth);
}

function interpolateTrafficFootprint(
  start: TrafficFootprint,
  end: TrafficFootprint,
  angleDelta: number,
  t: number,
  out: TrafficFootprint,
): void {
  const angle = Math.atan2(start.fz, start.fx) + angleDelta * t;
  out.x = start.x + (end.x - start.x) * t;
  out.z = start.z + (end.z - start.z) * t;
  out.fx = Math.cos(angle);
  out.fz = Math.sin(angle);
  out.halfLength =
    start.halfLength + (end.halfLength - start.halfLength) * t;
  out.halfWidth =
    start.halfWidth + (end.halfWidth - start.halfWidth) * t;
  out.speed = start.speed + (end.speed - start.speed) * t;
}

/**
 * Exact continuous SAT for two fixed-heading OBBs moving between committed
 * endpoints over normalized time [0, 1]. Most frame-to-frame actor motion is
 * linear, so this avoids approximating straight travel with dozens of samples.
 */
function trafficLinearMotionsConflict(
  aStart: TrafficFootprint,
  aEnd: TrafficFootprint,
  bStart: TrafficFootprint,
  bEnd: TrafficFootprint,
  margin: number,
): boolean {
  const centerX = bStart.x - aStart.x;
  const centerZ = bStart.z - aStart.z;
  const relativeX = (bEnd.x - bStart.x) - (aEnd.x - aStart.x);
  const relativeZ = (bEnd.z - bStart.z) - (aEnd.z - aStart.z);
  let enter = 0;
  let exit = 1;
  for (let axisIndex = 0; axisIndex < 4; axisIndex++) {
    let axisX: number;
    let axisZ: number;
    if (axisIndex === 0) {
      axisX = aStart.fx; axisZ = aStart.fz;
    } else if (axisIndex === 1) {
      axisX = -aStart.fz; axisZ = aStart.fx;
    } else if (axisIndex === 2) {
      axisX = bStart.fx; axisZ = bStart.fz;
    } else {
      axisX = -bStart.fz; axisZ = bStart.fx;
    }
    const center = centerX * axisX + centerZ * axisZ;
    const velocity = relativeX * axisX + relativeZ * axisZ;
    const extent = projectionRadius(aStart, axisX, axisZ)
      + projectionRadius(bStart, axisX, axisZ)
      + margin;
    if (Math.abs(velocity) < 1e-9) {
      if (Math.abs(center) > extent) return false;
      continue;
    }
    const first = (-extent - center) / velocity;
    const second = (extent - center) / velocity;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return false;
  }
  return exit >= 0 && enter <= 1;
}

function footprintShapeIsConstant(
  start: TrafficFootprint,
  end: TrafficFootprint,
): boolean {
  return Math.abs(start.halfLength - end.halfLength) < 1e-9
    && Math.abs(start.halfWidth - end.halfWidth) < 1e-9;
}

/** Reject a whole time interval when its midpoint shapes, inflated by
 * their maximum travel to either endpoint, are separated. Subdivide only
 * ambiguous intervals. This preserves the continuous collision guarantee
 * without marching through hundreds of samples for a clear rotating turn. */
function rotatingIntervalsConflict(
  motionBound: number,
  overlapAt: (time: number, inflation: number) => boolean,
): boolean {
  const visit = (lo: number, hi: number, depth: number): boolean => {
    const inflation = motionBound * (hi - lo) * 0.5 + 1e-6;
    const mid = (lo + hi) * .5;
    if (!overlapAt(mid, inflation)) return false;
    // Conservatively hold an unresolved contact. Depth bounds also protect
    // a malformed long route from unbounded work on the render thread.
    if (inflation <= ROTATING_SWEEP_SAMPLE_DISTANCE * .5 || depth >= 16) return true;
    return visit(lo, mid, depth + 1) || visit(mid, hi, depth + 1);
  };
  return visit(0, 1, 0);
}

/** Cheap conservative swept bounds before the exact SAT/rotation guards.
 * The L1 half-extent contains every rotated corner; linear interpolation of
 * centers and dimensions stays inside these endpoint bounds. Distant city
 * buses can therefore be rejected without five hypots and two heading angles
 * for every pedestrian, while nearby interactions retain the exact guards. */
export function trafficSweptBoundsOverlap(
  aStart: TrafficFootprint, aEnd: TrafficFootprint,
  bStart: TrafficFootprint, bEnd: TrafficFootprint, margin = 0,
): boolean {
  const aRadius = Math.max(aStart.halfLength + aStart.halfWidth, aEnd.halfLength + aEnd.halfWidth);
  const bRadius = Math.max(bStart.halfLength + bStart.halfWidth, bEnd.halfLength + bEnd.halfWidth);
  const reach = aRadius + bRadius + margin;
  return Math.min(aStart.x, aEnd.x) - Math.max(bStart.x, bEnd.x) <= reach
    && Math.min(bStart.x, bEnd.x) - Math.max(aStart.x, aEnd.x) <= reach
    && Math.min(aStart.z, aEnd.z) - Math.max(bStart.z, bEnd.z) <= reach
    && Math.min(bStart.z, bEnd.z) - Math.max(aStart.z, aEnd.z) <= reach;
}

/**
 * Conservative committed-motion guard for route turns and endpoint U-turns.
 * The SAT margin at each interval midpoint bounds the maximum motion of any
 * footprint point to either endpoint, including rotating corners. Clear
 * intervals are pruned; ambiguous intervals are subdivided conservatively.
 */
export function trafficMotionConflicts(
  start: TrafficFootprint,
  end: TrafficFootprint,
  obstacle: TrafficFootprint,
  margin = 0,
): boolean {
  if (!trafficSweptBoundsOverlap(start, end, obstacle, obstacle, margin)) return false;
  const distance = Math.hypot(end.x - start.x, end.z - start.z);
  const midX = (start.x + end.x) * 0.5;
  const midZ = (start.z + end.z) * 0.5;
  const reach = Math.max(
    Math.hypot(start.halfLength, start.halfWidth),
    Math.hypot(end.halfLength, end.halfWidth),
  ) + Math.hypot(obstacle.halfLength, obstacle.halfWidth)
    + margin + distance * 0.5;
  if (
    (obstacle.x - midX) ** 2 + (obstacle.z - midZ) ** 2
    > reach * reach
  ) return false;
  const angleDelta = shortestHeadingDelta(start, end);
  if (
    Math.abs(angleDelta) < 1e-9
    && footprintShapeIsConstant(start, end)
  ) {
    return trafficLinearMotionsConflict(
      start,
      end,
      obstacle,
      obstacle,
      margin,
    );
  }
  const motionBound = trafficMotionBound(start, end, angleDelta);
  const probe: TrafficFootprint = { ...start, speed: 0 };
  return rotatingIntervalsConflict(motionBound, (t, inflation) => {
    interpolateTrafficFootprint(start, end, angleDelta, t, probe);
    return trafficFootprintsOverlap(probe, obstacle, margin + inflation);
  });
}

/**
 * Synchronized motion guard for two translating/rotating OBBs. Static endpoint
 * checks miss two actors that enter the same space midway through a frame; the
 * combined interval inflation bounds both bodies' motion and closes that gap.
 */
export function trafficPairMotionsConflict(
  aStart: TrafficFootprint,
  aEnd: TrafficFootprint,
  bStart: TrafficFootprint,
  bEnd: TrafficFootprint,
  margin = 0,
): boolean {
  if (!trafficSweptBoundsOverlap(aStart, aEnd, bStart, bEnd, margin)) return false;
  const aMidX = (aStart.x + aEnd.x) * 0.5;
  const aMidZ = (aStart.z + aEnd.z) * 0.5;
  const bMidX = (bStart.x + bEnd.x) * 0.5;
  const bMidZ = (bStart.z + bEnd.z) * 0.5;
  const aReach = Math.hypot(aEnd.x - aStart.x, aEnd.z - aStart.z) * 0.5
    + Math.max(
      Math.hypot(aStart.halfLength, aStart.halfWidth),
      Math.hypot(aEnd.halfLength, aEnd.halfWidth),
    );
  const bReach = Math.hypot(bEnd.x - bStart.x, bEnd.z - bStart.z) * 0.5
    + Math.max(
      Math.hypot(bStart.halfLength, bStart.halfWidth),
      Math.hypot(bEnd.halfLength, bEnd.halfWidth),
    );
  const broadReach = aReach + bReach + margin;
  if (
    (bMidX - aMidX) ** 2 + (bMidZ - aMidZ) ** 2
    > broadReach * broadReach
  ) return false;
  const aAngleDelta = shortestHeadingDelta(aStart, aEnd);
  const bAngleDelta = shortestHeadingDelta(bStart, bEnd);
  if (
    Math.abs(aAngleDelta) < 1e-9
    && Math.abs(bAngleDelta) < 1e-9
    && footprintShapeIsConstant(aStart, aEnd)
    && footprintShapeIsConstant(bStart, bEnd)
  ) {
    return trafficLinearMotionsConflict(
      aStart,
      aEnd,
      bStart,
      bEnd,
      margin,
    );
  }
  const motionBound = trafficMotionBound(aStart, aEnd, aAngleDelta)
    + trafficMotionBound(bStart, bEnd, bAngleDelta);
  const aProbe: TrafficFootprint = { ...aStart };
  const bProbe: TrafficFootprint = { ...bStart };
  return rotatingIntervalsConflict(motionBound, (t, inflation) => {
    interpolateTrafficFootprint(aStart, aEnd, aAngleDelta, t, aProbe);
    interpolateTrafficFootprint(bStart, bEnd, bAngleDelta, t, bProbe);
    return trafficFootprintsOverlap(aProbe, bProbe, margin + inflation);
  });
}

/**
 * Find a bounded side-step around an immovable body when a normal proposal's
 * rotating tail or corner sweep is blocked. The first phase preserves the route
 * proposal; the fallback holds route progress and commits lateral-only motion,
 * allowing a bus to work around an outer-corner parked car over several frames.
 */
function findTrafficLateralEscapeWithFilter(
  start: TrafficFootprint,
  proposed: TrafficFootprint,
  obstacles: readonly TrafficFootprint[],
  maxShift: number,
  margin: number,
  blockerEligible: (obstacle: TrafficFootprint) => boolean,
  preferredSide = 0,
  holdRouteOnly = false,
  blockerMargin = margin,
  preferredSideOnly = false,
): TrafficEscape | null {
  if (!(maxShift > 0)) return null;
  const blocker = obstacles.find((obstacle) => (
    blockerEligible(obstacle)
    && trafficMotionConflicts(start, proposed, obstacle, blockerMargin)
  ));
  if (!blocker) return null;
  const clears = (end: TrafficFootprint): boolean => (
    obstacles.every((obstacle) => (
      !trafficMotionConflicts(start, end, obstacle, margin)
    ))
  );
  const attempt = (
    base: TrafficFootprint,
    heldRoute: boolean,
  ): TrafficEscape | null => {
    const sideX = -base.fz;
    const sideZ = base.fx;
    const lateral = (blocker.x - base.x) * sideX
      + (blocker.z - base.z) * sideZ;
    const preferred = preferredSide || (lateral >= 0 ? -1 : 1);
    const stepSize = Math.min(0.05, maxShift);
    const signs = preferredSideOnly && preferredSide
      ? [preferred]
      : [preferred, -preferred];
    for (const sign of signs) {
      for (
        let distance = stepSize;
        distance <= maxShift + 1e-9;
        distance += stepSize
      ) {
        const boundedDistance = Math.min(distance, maxShift);
        const shiftX = sideX * boundedDistance * sign;
        const shiftZ = sideZ * boundedDistance * sign;
        const end: TrafficFootprint = {
          ...base,
          x: base.x + shiftX,
          z: base.z + shiftZ,
        };
        if (clears(end)) {
          return {
            end,
            shiftX,
            shiftZ,
            heldRoute,
            blockerKey: blocker.key,
          };
        }
        if (boundedDistance >= maxShift) break;
      }
    }
    return null;
  };
  return holdRouteOnly
    ? attempt(start, true)
    : attempt(proposed, false) ?? attempt(start, true);
}

export function findTrafficLateralEscape(
  start: TrafficFootprint,
  proposed: TrafficFootprint,
  obstacles: readonly TrafficFootprint[],
  maxShift: number,
  margin = 0.08,
): TrafficEscape | null {
  return findTrafficLateralEscapeWithFilter(
    start,
    proposed,
    obstacles,
    maxShift,
    margin,
    (obstacle) => obstacle.immovable === true,
    0,
    false,
    margin,
    false,
  );
}

/**
 * Work a stalled traffic body around a stopped vehicle without ever relaxing
 * continuous collision checks. Pedestrians are deliberately excluded: a bus
 * waits for people, while it may change lanes around a stopped car or bus.
 */
export function findStalledTrafficEscape(
  start: TrafficFootprint,
  proposed: TrafficFootprint,
  obstacles: readonly TrafficFootprint[],
  maxShift: number,
  margin = 0.08,
  preferredSide = 0,
  holdRouteOnly = false,
  blockerMargin = margin,
  blockerAllowed: (obstacle: TrafficFootprint) => boolean = () => true,
): TrafficEscape | null {
  return findTrafficLateralEscapeWithFilter(
    start,
    proposed,
    obstacles,
    maxShift,
    margin,
    (obstacle) => (
      !obstacle.key.startsWith('ped:')
      && (obstacle.immovable === true || obstacle.speed <= 0.15)
      && blockerAllowed(obstacle)
    ),
    preferredSide,
    holdRouteOnly,
    blockerMargin,
    true,
  );
}

/** Full fixed + synchronized-motion validation for a replacement proposal. */
export function trafficMotionClearsObstacles(
  start: TrafficFootprint,
  end: TrafficFootprint,
  fixedObstacles: readonly TrafficFootprint[],
  movingObstacles: readonly TrafficMotion[] = [],
  margin = 0.08,
): boolean {
  return fixedObstacles.every((obstacle) => (
    !trafficMotionConflicts(start, end, obstacle, margin)
  )) && movingObstacles.every((motion) => (
    !trafficPairMotionsConflict(
      start,
      end,
      motion.start,
      motion.end,
      margin,
    )
  ));
}

/**
 * Stable sequential commit for a set of actor proposals. Earlier accepted
 * targets and later actors' safe starts are both treated as occupied, so a
 * rollback can never expose a new overlap behind a fixed-pass iterator.
 */
export function resolveTrafficMotionTransactions(
  starts: readonly TrafficFootprint[],
  ends: readonly TrafficFootprint[],
  fixedObstacles: readonly TrafficFootprint[],
  movingObstacles: readonly TrafficMotion[] = [],
  fixedMargin = 0.18,
  actorMargin = 0.12,
): Uint8Array {
  if (starts.length !== ends.length) {
    throw new Error('Traffic motion snapshots must have matching lengths');
  }
  const blocked = new Uint8Array(starts.length);
  const accepted: Array<TrafficFootprint | null> =
    new Array(starts.length).fill(null);
  const order = starts.map((_, index) => index).sort((a, b) => (
    ends[a].key.localeCompare(ends[b].key)
  ));
  // Obstacles are indexed by their center/motion midpoint. Per-proposal query
  // bounds include that proposal's full swept radius and the largest obstacle
  // radius, removing the former all-cars × all-pedestrians scan without
  // approximating the collision result. The exact continuous guards below
  // still decide every candidate that survives this conservative broadphase.
  const obstacleCellSize = 12;
  const obstacleCells = new Map<string, TrafficMotionBucket>();
  const bucketAt = (
    x: number,
    z: number,
  ): TrafficMotionBucket => {
    const key = `${Math.floor(x / obstacleCellSize)}:${Math.floor(z / obstacleCellSize)}`;
    let bucket = obstacleCells.get(key);
    if (!bucket) {
      bucket = { fixed: [], moving: [] };
      obstacleCells.set(key, bucket);
    }
    return bucket;
  };
  let maximumFixedReach = 0;
  for (const obstacle of fixedObstacles) {
    maximumFixedReach = Math.max(
      maximumFixedReach,
      Math.hypot(obstacle.halfLength, obstacle.halfWidth),
    );
    bucketAt(obstacle.x, obstacle.z).fixed.push(obstacle);
  }
  let maximumMovingReach = 0;
  for (const motion of movingObstacles) {
    maximumMovingReach = Math.max(
      maximumMovingReach,
      Math.hypot(motion.end.x - motion.start.x, motion.end.z - motion.start.z) * 0.5
        + Math.max(
          Math.hypot(motion.start.halfLength, motion.start.halfWidth),
          Math.hypot(motion.end.halfLength, motion.end.halfWidth),
        ),
    );
    bucketAt(
      (motion.start.x + motion.end.x) * 0.5,
      (motion.start.z + motion.end.z) * 0.5,
    ).moving.push(motion);
  }
  const fixedCandidates: TrafficFootprint[] = [];
  const movingCandidates: TrafficMotion[] = [];
  const collectCandidates = <T>(
    out: T[],
    midpointX: number,
    midpointZ: number,
    radius: number,
    all: readonly T[],
    select: (bucket: TrafficMotionBucket) => readonly T[],
  ) => {
    out.length = 0;
    const minX = Math.floor((midpointX - radius) / obstacleCellSize);
    const maxX = Math.floor((midpointX + radius) / obstacleCellSize);
    const minZ = Math.floor((midpointZ - radius) / obstacleCellSize);
    const maxZ = Math.floor((midpointZ + radius) / obstacleCellSize);
    // An anomalous long proposal is rare and will normally be rejected. Avoid
    // walking thousands of empty cells when a direct scan is cheaper.
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > all.length) {
      out.push(...all);
      return;
    }
    for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
      for (let cellX = minX; cellX <= maxX; cellX++) {
        const bucket = obstacleCells.get(`${cellX}:${cellZ}`);
        if (bucket) out.push(...select(bucket));
      }
    }
  };
  for (const index of order) {
    const start = starts[index];
    const end = ends[index];
    const midpointX = (start.x + end.x) * 0.5;
    const midpointZ = (start.z + end.z) * 0.5;
    const moverReach = Math.hypot(end.x - start.x, end.z - start.z) * 0.5
      + Math.max(
        Math.hypot(start.halfLength, start.halfWidth),
        Math.hypot(end.halfLength, end.halfWidth),
      );
    collectCandidates(
      fixedCandidates,
      midpointX,
      midpointZ,
      moverReach + maximumFixedReach + fixedMargin,
      fixedObstacles,
      (bucket) => bucket.fixed,
    );
    collectCandidates(
      movingCandidates,
      midpointX,
      midpointZ,
      moverReach + maximumMovingReach + fixedMargin,
      movingObstacles,
      (bucket) => bucket.moving,
    );
    let conflict = fixedCandidates.some((obstacle) => (
      trafficMotionConflicts(start, end, obstacle, fixedMargin)
    ));
    if (!conflict) {
      conflict = movingCandidates.some((motion) => (
        trafficPairMotionsConflict(
          start,
          end,
          motion.start,
          motion.end,
          fixedMargin,
        )
      ));
    }
    if (!conflict) {
      for (let other = 0; other < starts.length; other++) {
        if (other === index) continue;
        const acceptedEnd = accepted[other];
        const pairConflict = acceptedEnd
          ? trafficPairMotionsConflict(
            start,
            end,
            starts[other],
            acceptedEnd,
            actorMargin,
          )
          : trafficMotionConflicts(
            start,
            end,
            starts[other],
            actorMargin,
          );
        if (pairConflict) {
          conflict = true;
          break;
        }
      }
    }
    if (conflict) blocked[index] = 1;
    accepted[index] = conflict ? start : end;
  }
  return blocked;
}

/** Stable right-of-way prevents two predicted cross-traffic conflicts deadlocking. */
export function yieldsTo(a: TrafficFootprint, b: TrafficFootprint): boolean {
  if (Boolean(a.priority) !== Boolean(b.priority)) return Boolean(b.priority);
  return a.key > b.key;
}
