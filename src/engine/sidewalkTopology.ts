/**
 * Tile-local attached-sidewalk topology.
 *
 * OSM commonly represents a junction as several independent ways, and it also
 * commonly leaves the shared node in the middle of a through-way.  Rendering
 * an offset ribbon for each whole way cannot form a curb return: independently
 * trimmed ribbons either stop short or overlap the crossing carriageway.
 *
 * This module has no Three.js dependency.  It resolves the incident road rays
 * once, splits through-way sidewalks at real junction vertices, and owns each
 * paved corner exactly once.  The resulting points are appended to the tile's
 * existing merged walk mesh by tileWorker.
 */

const SIDEWALK_INNER_FROM_CURB = 0.33;
const SIDEWALK_OUTER_FROM_CURB = 2.33;
const CURB_CENTER_FROM_ROAD = 0.16;
const MAX_TRIM = 48;
const MIN_RENDERED_SPAN = 1.25;
const CLEARANCE_STEP = 0.05;
const DIRECTION_MERGE_DOT = 0.999;
const STRAIGHT_SECTOR_EPSILON = 0.2;
const TILE_BORDER_EPSILON = 0.15;

export interface SidewalkTopologyRoad {
  pts: number[];
  ys: number[];
  halfWidth: number;
  participates: boolean;
  sidewalkLeft: boolean;
  sidewalkRight: boolean;
  junctionStart: boolean;
  junctionEnd: boolean;
  /** Global OSM way degree serialized at genuine source endpoints. */
  expectedDegreeStart?: number;
  expectedDegreeEnd?: number;
}

interface RayMember {
  roadIndex: number;
  vertexIndex: number;
  neighborIndex: number;
  left: boolean;
  right: boolean;
}

export interface SidewalkApproach {
  dx: number;
  dz: number;
  halfWidth: number;
  y: number;
  left: boolean;
  right: boolean;
  /** Clearance along this outward ray for its left/right attached sidewalk. */
  trimLeft: number;
  trimRight: number;
  members: RayMember[];
  /** A corner side is emitted only when at least one source member reaches it. */
  renderLeft: boolean;
  renderRight: boolean;
}

export interface SidewalkCorner {
  junctionKey: string;
  y: number;
  /** [aInner, aOuter, bOuter, bInner] in flat x/z pairs. */
  paving: number[];
  /** Curb-return centerline from approach A to approach B. */
  curb: number[];
}

export interface SidewalkJunction {
  key: string;
  x: number;
  z: number;
  approaches: SidewalkApproach[];
  corners: SidewalkCorner[];
}

export interface SidewalkSpan {
  pts: number[];
  ys: number[];
  renderLeft: boolean;
  renderRight: boolean;
  trimStartLeft: number;
  trimEndLeft: number;
  trimStartRight: number;
  trimEndRight: number;
}

export interface SidewalkTopology {
  roads: readonly SidewalkTopologyRoad[];
  junctions: Map<string, SidewalkJunction>;
  /** Ambiguous global/border nodes: no corners, only bounded terminal clearance. */
  blockedNodes: Set<string>;
  /** Individual road-relative sides that cannot retain a safe middle. */
  suppressedSides: Set<string>;
  /** Source spans for which neither attached-sidewalk side can survive. */
  suppressedSpans: Set<string>;
}

export interface SidewalkTopologyBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

interface RawRay extends SidewalkApproach {
  flagged: boolean;
  expectedDegree: number;
}

function nodeKey(x: number, z: number): string {
  // Shipping road points are decimetre-quantized.  Keeping that same identity
  // prevents close parallel roads from being mistaken for one junction.
  return `${Math.round(x * 10)},${Math.round(z * 10)}`;
}

function normalizedRay(
  road: SidewalkTopologyRoad,
  roadIndex: number,
  vertexIndex: number,
  neighborIndex: number,
): RawRay | null {
  const x = road.pts[vertexIndex * 2], z = road.pts[vertexIndex * 2 + 1];
  const nx = road.pts[neighborIndex * 2], nz = road.pts[neighborIndex * 2 + 1];
  const length = Math.hypot(nx - x, nz - z);
  if (length < 0.05) return null;
  const forward = neighborIndex > vertexIndex;
  return {
    dx: (nx - x) / length,
    dz: (nz - z) / length,
    halfWidth: road.halfWidth,
    y: road.ys[vertexIndex] ?? 0,
    // A ray pointing toward the previous vertex reverses road-relative sides.
    left: forward ? road.sidewalkLeft : road.sidewalkRight,
    right: forward ? road.sidewalkRight : road.sidewalkLeft,
    trimLeft: 0,
    trimRight: 0,
    members: [{
      roadIndex,
      vertexIndex,
      neighborIndex,
      left: forward ? road.sidewalkLeft : road.sidewalkRight,
      right: forward ? road.sidewalkRight : road.sidewalkLeft,
    }],
    renderLeft: false,
    renderRight: false,
    flagged: (vertexIndex === 0 && road.junctionStart)
      || (vertexIndex === road.pts.length / 2 - 1 && road.junctionEnd),
    expectedDegree: vertexIndex === 0
      ? (road.expectedDegreeStart ?? 0)
      : vertexIndex === road.pts.length / 2 - 1
        ? (road.expectedDegreeEnd ?? 0)
        : 0,
  };
}

function mergeRays(rays: RawRay[]): RawRay[] {
  const merged: RawRay[] = [];
  for (const ray of rays) {
    const existing = merged.find((candidate) =>
      candidate.dx * ray.dx + candidate.dz * ray.dz >= DIRECTION_MERGE_DOT);
    if (!existing) {
      merged.push({ ...ray, members: [...ray.members] });
      continue;
    }
    // Coincident OSM ways occasionally duplicate a physical approach.  The
    // widest carriageway is the safe boundary; either source sidewalk keeps
    // that side available without creating a second corner owner.
    existing.halfWidth = Math.max(existing.halfWidth, ray.halfWidth);
    existing.y = Math.max(existing.y, ray.y);
    existing.left ||= ray.left;
    existing.right ||= ray.right;
    existing.flagged ||= ray.flagged;
    existing.expectedDegree = Math.max(existing.expectedDegree, ray.expectedDegree);
    existing.members.push(...ray.members);
  }
  return merged;
}

function sectorAngle(a: SidewalkApproach, b: SidewalkApproach): number {
  let delta = Math.atan2(b.dz, b.dx) - Math.atan2(a.dz, a.dx);
  if (delta <= 0) delta += Math.PI * 2;
  return delta;
}

function approachPoint(
  junction: SidewalkJunction,
  approach: SidewalkApproach,
  side: 1 | -1,
  fromRoadCenter: number,
): [number, number] {
  const normalX = -approach.dz * side;
  const normalZ = approach.dx * side;
  const trim = side === 1 ? approach.trimLeft : approach.trimRight;
  return [
    junction.x + approach.dx * trim + normalX * fromRoadCenter,
    junction.z + approach.dz * trim + normalZ * fromRoadCenter,
  ];
}

function lastUnsafeDistance(
  approach: SidewalkApproach,
  offset: number,
  other: SidewalkApproach,
): number {
  const roadHalf = other.halfWidth + 0.02;
  const normalX = -approach.dz, normalZ = approach.dx;
  const crossSlope = approach.dx * other.dz - approach.dz * other.dx;
  const crossOffset = offset * (normalX * other.dz - normalZ * other.dx);
  const projectionSlope = approach.dx * other.dx + approach.dz * other.dz;
  const projectionOffset = offset * (normalX * other.dx + normalZ * other.dz);
  let last = -1;

  // Portion whose nearest point lies on the other road ray, rather than at
  // its junction origin: |cross| < halfWidth and projection >= 0.
  if (Math.abs(crossSlope) > 1e-7) {
    const rootA = (-roadHalf - crossOffset) / crossSlope;
    const rootB = (roadHalf - crossOffset) / crossSlope;
    let lo = Math.max(0, Math.min(rootA, rootB));
    let hi = Math.max(rootA, rootB);
    if (projectionSlope > 1e-7) lo = Math.max(lo, -projectionOffset / projectionSlope);
    else if (projectionSlope < -1e-7) hi = Math.min(hi, -projectionOffset / projectionSlope);
    else if (projectionOffset < 0) hi = -1;
    if (hi >= lo) last = Math.max(last, hi);
  } else if (Math.abs(crossOffset) < roadHalf && projectionSlope > 1e-7) {
    // Nearly coincident forward rays are normally merged. Keep the analytic
    // fallback conservative for a source ray just outside the merge tolerance.
    last = Infinity;
  }

  // Before the projection reaches the ray, its origin is the nearest point.
  // Since approach direction and its normal are orthonormal, distance² is
  // simply t² + offset².
  if (Math.abs(offset) < roadHalf) {
    let lo = 0;
    let hi = Math.min(MAX_TRIM, Math.sqrt(roadHalf * roadHalf - offset * offset));
    if (projectionSlope > 1e-7) hi = Math.min(hi, -projectionOffset / projectionSlope);
    else if (projectionSlope < -1e-7) lo = Math.max(lo, -projectionOffset / projectionSlope);
    else if (projectionOffset >= 0) hi = -1;
    if (hi >= lo) last = Math.max(last, hi);
  }
  return last;
}

function solveJunction(junction: SidewalkJunction): void {
  const approaches = junction.approaches;
  approaches.sort((a, b) => Math.atan2(a.dz, a.dx) - Math.atan2(b.dz, b.dx));

  // The inner sidewalk boundaries of adjacent approaches define the exact
  // curb-corner meeting distance. Keep the two approach sides independent:
  // an acute fork's long inside clearance must not erase its safe outside.
  for (let i = 0; i < approaches.length; i++) {
    const a = approaches[i];
    const b = approaches[(i + 1) % approaches.length];
    const angle = sectorAngle(a, b);
    if (angle >= Math.PI - STRAIGHT_SECTOR_EPSILON || angle > Math.PI + 1e-5) continue;
    const sin = Math.sin(angle);
    if (sin < 1e-4) continue;
    const cos = Math.cos(angle);
    const aInner = a.halfWidth + SIDEWALK_INNER_FROM_CURB;
    const bInner = b.halfWidth + SIDEWALK_INNER_FROM_CURB;
    const aDistance = (bInner + aInner * cos) / sin;
    const bDistance = (aInner + bInner * cos) / sin;
    if (aDistance > 0) a.trimLeft = Math.max(a.trimLeft, aDistance);
    if (bDistance > 0) b.trimRight = Math.max(b.trimRight, bDistance);
  }

  // The line-intersection solve connects the inner edges, but at a skewed
  // junction the far edge of a 2m sidewalk can still clip a neighboring
  // carriageway. Find the final unsafe cross-section against every incident
  // half-ray, then stop that sidewalk side just beyond it. The 5cm increment
  // is also the maximum permitted terminal join tolerance.
  for (const approach of approaches) {
    for (const side of [1, -1] as const) {
      if ((side === 1 && !approach.left) || (side === -1 && !approach.right)) continue;
      const offsets = [
        // The raised curb is a 32cm ribbon centered 16cm beyond the road,
        // so audit both footprint edges as well as the sidewalk slab.
        side * approach.halfWidth,
        side * (approach.halfWidth + 0.32),
        side * (approach.halfWidth + SIDEWALK_INNER_FROM_CURB),
        side * (
          approach.halfWidth
          + (SIDEWALK_INNER_FROM_CURB + SIDEWALK_OUTER_FROM_CURB) * 0.5
        ),
        side * (approach.halfWidth + SIDEWALK_OUTER_FROM_CURB),
      ];
      let lastUnsafe = -1;
      for (const offset of offsets) {
        for (const other of approaches) {
          if (other === approach) continue;
          const parallel = approach.dx * other.dx + approach.dz * other.dz;
          if (parallel > DIRECTION_MERGE_DOT) continue;
          lastUnsafe = Math.max(lastUnsafe, lastUnsafeDistance(approach, offset, other));
        }
      }
      if (lastUnsafe >= 0) {
        const solved = lastUnsafe + CLEARANCE_STEP;
        if (side === 1) approach.trimLeft = Math.max(approach.trimLeft, solved);
        else approach.trimRight = Math.max(approach.trimRight, solved);
      }
    }
  }
}

function pointToRayDistance(
  x: number,
  z: number,
  junction: SidewalkJunction,
  approach: SidewalkApproach,
): number {
  const dx = x - junction.x, dz = z - junction.z;
  const projection = dx * approach.dx + dz * approach.dz;
  return projection >= 0
    ? Math.abs(dx * approach.dz - dz * approach.dx)
    : Math.hypot(dx, dz);
}

function pointToSegmentDistance(
  x: number,
  z: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number {
  const dx = x1 - x0, dz = z1 - z0;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 1e-10
    ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / lengthSq))
    : 0;
  return Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t));
}

function segmentIntersectsRay(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  junction: SidewalkJunction,
  approach: SidewalkApproach,
): boolean {
  const sx = x1 - x0, sz = z1 - z0;
  const qx = junction.x - x0, qz = junction.z - z0;
  const cross = sx * approach.dz - sz * approach.dx;
  if (Math.abs(cross) < 1e-9) return false;
  const segmentT = (qx * approach.dz - qz * approach.dx) / cross;
  const rayT = (qx * sz - qz * sx) / cross;
  return segmentT >= -1e-8 && segmentT <= 1 + 1e-8 && rayT >= -1e-8;
}

function segmentToRayDistance(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  junction: SidewalkJunction,
  approach: SidewalkApproach,
): number {
  if (segmentIntersectsRay(x0, z0, x1, z1, junction, approach)) return 0;
  return Math.min(
    pointToRayDistance(x0, z0, junction, approach),
    pointToRayDistance(x1, z1, junction, approach),
    pointToSegmentDistance(junction.x, junction.z, x0, z0, x1, z1),
  );
}

function geometryClearsRoadbeds(
  junction: SidewalkJunction,
  points: number[],
  closed: boolean,
  footprintClearance = 0.01,
): boolean {
  const pointCount = points.length / 2;
  const edgeCount = closed ? pointCount : pointCount - 1;
  for (let edge = 0; edge < edgeCount; edge++) {
    const next = closed ? (edge + 1) % pointCount : edge + 1;
    const x0 = points[edge * 2], z0 = points[edge * 2 + 1];
    const x1 = points[next * 2], z1 = points[next * 2 + 1];
    for (const approach of junction.approaches) {
      if (segmentToRayDistance(x0, z0, x1, z1, junction, approach)
        < approach.halfWidth + footprintClearance) return false;
    }
  }
  return true;
}

function emitSafeCorners(junction: SidewalkJunction): void {
  const approaches = junction.approaches;
  for (let i = 0; i < approaches.length; i++) {
    const a = approaches[i];
    const b = approaches[(i + 1) % approaches.length];
    const angle = sectorAngle(a, b);
    if (angle > Math.PI + 1e-5 || angle < 0.04) continue;
    // In the counter-clockwise sector, A contributes its left sidewalk and B
    // contributes its right sidewalk.
    if (!a.renderLeft || !b.renderRight) continue;
    if (!Number.isFinite(a.trimLeft) || !Number.isFinite(b.trimRight)
      || a.trimLeft > MAX_TRIM || b.trimRight > MAX_TRIM) continue;

    const aInner = approachPoint(
      junction, a, 1, a.halfWidth + SIDEWALK_INNER_FROM_CURB,
    );
    const aOuter = approachPoint(
      junction, a, 1, a.halfWidth + SIDEWALK_OUTER_FROM_CURB,
    );
    const bOuter = approachPoint(
      junction, b, -1, b.halfWidth + SIDEWALK_OUTER_FROM_CURB,
    );
    const bInner = approachPoint(
      junction, b, -1, b.halfWidth + SIDEWALK_INNER_FROM_CURB,
    );
    const aCurb = approachPoint(
      junction, a, 1, a.halfWidth + CURB_CENTER_FROM_ROAD,
    );
    const bCurb = approachPoint(
      junction, b, -1, b.halfWidth + CURB_CENTER_FROM_ROAD,
    );
    const paving = [...aInner, ...aOuter, ...bOuter, ...bInner];
    const curb = [...aCurb, ...bCurb];
    // The terminal solve covers adjacent inner/outer offsets. The exact
    // segment audit below is the final authority: no quadrilateral edge or
    // curb return may cross any incident road half-ray.
    if (!geometryClearsRoadbeds(junction, paving, true)
      // The return is rendered as a 32cm ribbon. Audit its centerline with
      // a 15.9cm footprint so the full curb, not merely its center, clears
      // every carriageway while allowing a 1mm numerical join tolerance.
      || !geometryClearsRoadbeds(junction, curb, false, 0.159)) continue;
    junction.corners.push({
      junctionKey: junction.key,
      y: Math.max(a.y, b.y),
      paving,
      curb,
    });
  }
}

function spanKey(roadIndex: number, start: number, end: number): string {
  return `${roadIndex}:${start}:${end}`;
}

type RoadSide = 'left' | 'right';

function sideKey(roadIndex: number, start: number, end: number, side: RoadSide): string {
  return `${spanKey(roadIndex, start, end)}:${side}`;
}

function approachForMember(
  junction: SidewalkJunction | undefined,
  roadIndex: number,
  vertexIndex: number,
  neighborIndex: number,
): { approach: SidewalkApproach; member: RayMember } | null {
  if (!junction) return null;
  for (const approach of junction.approaches) {
    const member = approach.members.find((candidate) =>
      candidate.roadIndex === roadIndex
      && candidate.vertexIndex === vertexIndex
      && candidate.neighborIndex === neighborIndex);
    if (member) return { approach, member };
  }
  return null;
}

function approachSideForRoadSide(
  vertexIndex: number,
  neighborIndex: number,
  roadSide: RoadSide,
): RoadSide {
  const forward = neighborIndex > vertexIndex;
  return forward
    ? roadSide
    : roadSide === 'left' ? 'right' : 'left';
}

function ownerTrimForRoadSide(
  owner: { approach: SidewalkApproach; member: RayMember } | null,
  vertexIndex: number,
  neighborIndex: number,
  roadSide: RoadSide,
): number {
  if (!owner) return 0;
  return approachSideForRoadSide(vertexIndex, neighborIndex, roadSide) === 'left'
    ? owner.approach.trimLeft
    : owner.approach.trimRight;
}

function markOwnerSideRenderable(
  owner: { approach: SidewalkApproach; member: RayMember } | null,
  vertexIndex: number,
  neighborIndex: number,
  roadSide: RoadSide,
): void {
  if (!owner) return;
  const approachSide = approachSideForRoadSide(vertexIndex, neighborIndex, roadSide);
  if (approachSide === 'left' && owner.member.left) owner.approach.renderLeft = true;
  if (approachSide === 'right' && owner.member.right) owner.approach.renderRight = true;
}

function polylineLengthBetween(road: SidewalkTopologyRoad, start: number, end: number): number {
  let length = 0;
  for (let i = start + 1; i <= end; i++) {
    length += Math.hypot(
      road.pts[i * 2] - road.pts[(i - 1) * 2],
      road.pts[i * 2 + 1] - road.pts[(i - 1) * 2 + 1],
    );
  }
  return length;
}

function finalizeSpanFeasibility(topology: SidewalkTopology): void {
  for (let roadIndex = 0; roadIndex < topology.roads.length; roadIndex++) {
    const road = topology.roads[roadIndex];
    const count = road.pts.length / 2;
    if (!road.participates || count < 2) continue;
    const cuts = [0];
    for (let i = 1; i < count - 1; i++) {
      const key = nodeKey(road.pts[i * 2], road.pts[i * 2 + 1]);
      if (topology.junctions.has(key) || topology.blockedNodes.has(key)) cuts.push(i);
    }
    cuts.push(count - 1);
    for (let cutIndex = 1; cutIndex < cuts.length; cutIndex++) {
      const start = cuts[cutIndex - 1], end = cuts[cutIndex];
      if (end <= start) continue;
      const startKey = nodeKey(road.pts[start * 2], road.pts[start * 2 + 1]);
      const endKey = nodeKey(road.pts[end * 2], road.pts[end * 2 + 1]);
      const startJunction = topology.junctions.get(startKey);
      const endJunction = topology.junctions.get(endKey);
      const startOwner = approachForMember(startJunction, roadIndex, start, start + 1);
      const endOwner = approachForMember(endJunction, roadIndex, end, end - 1);
      // A blocked node cannot safely own inferred corner paving.  It should
      // not, however, erase an otherwise valid 100-300m sidewalk way. Keep
      // the safe middle and omit at most the same conservative distance used
      // as the corner-owner cap. Very short remainders still
      // fail closed below rather than becoming detached concrete slivers.
      const length = polylineLengthBetween(road, start, end);
      let activeSides = 0;
      let survivingSides = 0;
      for (const side of ['left', 'right'] as const) {
        if (side === 'left' ? !road.sidewalkLeft : !road.sidewalkRight) continue;
        activeSides++;
        const trimStart = topology.blockedNodes.has(startKey)
          ? MAX_TRIM
          : ownerTrimForRoadSide(startOwner, start, start + 1, side);
        const trimEnd = topology.blockedNodes.has(endKey)
          ? MAX_TRIM
          : ownerTrimForRoadSide(endOwner, end, end - 1, side);
        const safe = Number.isFinite(trimStart)
          && Number.isFinite(trimEnd)
          && trimStart + trimEnd + MIN_RENDERED_SPAN <= length + 1e-6;
        if (!safe) {
          topology.suppressedSides.add(sideKey(roadIndex, start, end, side));
          continue;
        }
        survivingSides++;
        markOwnerSideRenderable(startOwner, start, start + 1, side);
        markOwnerSideRenderable(endOwner, end, end - 1, side);
      }
      if (activeSides > 0 && survivingSides === 0) {
        topology.suppressedSpans.add(spanKey(roadIndex, start, end));
      }
    }
  }
}

export function buildSidewalkTopology(
  roads: readonly SidewalkTopologyRoad[],
  bounds?: SidewalkTopologyBounds,
): SidewalkTopology {
  const endpointInfo = new Map<string, { expectedDegree: number; observedRoads: Set<number> }>();
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    const count = road.pts.length / 2;
    if (count < 2) continue;
    const endpoints: Array<[number, number]> = [
      [0, road.expectedDegreeStart ?? 0],
      [count - 1, road.expectedDegreeEnd ?? 0],
    ];
    for (const [vertexIndex, expectedDegree] of endpoints) {
      if (expectedDegree <= 0) continue;
      const key = nodeKey(road.pts[vertexIndex * 2], road.pts[vertexIndex * 2 + 1]);
      let info = endpointInfo.get(key);
      if (!info) {
        info = { expectedDegree: 0, observedRoads: new Set() };
        endpointInfo.set(key, info);
      }
      info.expectedDegree = Math.max(info.expectedDegree, expectedDegree);
      info.observedRoads.add(roadIndex);
    }
  }

  const raysByNode = new Map<string, { x: number; z: number; rays: RawRay[] }>();
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    if (!road.participates || road.pts.length < 4) continue;
    const count = road.pts.length / 2;
    for (let vertexIndex = 0; vertexIndex < count; vertexIndex++) {
      const x = road.pts[vertexIndex * 2], z = road.pts[vertexIndex * 2 + 1];
      const key = nodeKey(x, z);
      let node = raysByNode.get(key);
      if (!node) {
        node = { x, z, rays: [] };
        raysByNode.set(key, node);
      }
      if (vertexIndex > 0) {
        const ray = normalizedRay(road, roadIndex, vertexIndex, vertexIndex - 1);
        if (ray) node.rays.push(ray);
      }
      if (vertexIndex + 1 < count) {
        const ray = normalizedRay(road, roadIndex, vertexIndex, vertexIndex + 1);
        if (ray) node.rays.push(ray);
      }
    }
  }

  const junctions = new Map<string, SidewalkJunction>();
  const blockedNodes = new Set<string>();
  for (const [key, node] of raysByNode) {
    const approaches = mergeRays(node.rays);
    const flagged = approaches.some((approach) => approach.flagged);
    const endpoint = endpointInfo.get(key);
    const expectedDegree = endpoint?.expectedDegree
      ?? Math.max(0, ...approaches.map((approach) => approach.expectedDegree));
    // `expectedDegree` is the number of distinct source ways at the OSM node,
    // not the number of serialized endpoint records. A through-way contributes
    // two rays while keeping the junction node as an interior vertex, so it
    // never appeared in endpointInfo. Union every RayMember source id with
    // the endpoint ids before declaring a tile-local junction incomplete.
    const observedRoads = new Set(endpoint?.observedRoads ?? []);
    for (const ray of node.rays) {
      for (const member of ray.members) observedRoads.add(member.roadIndex);
    }
    const incomplete = expectedDegree > 0
      && observedRoads.size < expectedDegree;
    const onTileBorder = Boolean(bounds && (
      node.x <= bounds.minX + TILE_BORDER_EPSILON
      || node.x >= bounds.maxX - TILE_BORDER_EPSILON
      || node.z <= bounds.minZ + TILE_BORDER_EPSILON
      || node.z >= bounds.maxZ - TILE_BORDER_EPSILON
    ));
    // At an incomplete or grid-line source junction, even a straight local
    // ribbon could cross a carriageway whose direction is available only in a
    // neighboring tile. Omit incident spans instead of guessing that direction.
    if (incomplete || (onTileBorder && (flagged || expectedDegree > 0 || approaches.length >= 2))) {
      blockedNodes.add(key);
      continue;
    }
    // Three distinct rays form a T or skew junction even when the source kept
    // the node in the middle of a through-way.
    if (!flagged && approaches.length < 3) continue;
    if (approaches.length < 2) continue;
    // Exact grid-line junctions can be present in both adjacent tile payloads.
    // Suppressing the ambiguous local owner avoids both duplicate paving and a
    // corner inferred without the neighboring tile's incident carriageway.
    if (onTileBorder) continue;
    const junction: SidewalkJunction = {
      key,
      x: node.x,
      z: node.z,
      approaches,
      corners: [],
    };
    solveJunction(junction);
    junctions.set(key, junction);
  }
  const topology: SidewalkTopology = {
    roads,
    junctions,
    blockedNodes,
    suppressedSides: new Set(),
    suppressedSpans: new Set(),
  };
  finalizeSpanFeasibility(topology);
  for (const junction of junctions.values()) emitSafeCorners(junction);
  return topology;
}

function trimForRoadSide(
  topology: SidewalkTopology,
  roadIndex: number,
  vertexIndex: number,
  neighborIndex: number,
  roadSide: RoadSide,
): number {
  const road = topology.roads[roadIndex];
  const key = nodeKey(road.pts[vertexIndex * 2], road.pts[vertexIndex * 2 + 1]);
  if (topology.blockedNodes.has(key)) return MAX_TRIM;
  const junction = topology.junctions.get(key);
  return ownerTrimForRoadSide(
    approachForMember(junction, roadIndex, vertexIndex, neighborIndex),
    vertexIndex,
    neighborIndex,
    roadSide,
  );
}

/**
 * Split one attached-sidewalk centerline at every tile-local junction.  Road
 * asphalt, gutters, markings and OSM crossing ways deliberately remain on
 * their original geography; only the offset sidewalk/curb ribbons are split.
 */
export function sidewalkSpansForRoad(
  topology: SidewalkTopology,
  roadIndex: number,
): SidewalkSpan[] {
  const road = topology.roads[roadIndex];
  const count = road.pts.length / 2;
  if (!road.participates || count < 2) return [];
  const cuts = [0];
  for (let i = 1; i < count - 1; i++) {
    const key = nodeKey(road.pts[i * 2], road.pts[i * 2 + 1]);
    if (topology.junctions.has(key) || topology.blockedNodes.has(key)) cuts.push(i);
  }
  cuts.push(count - 1);

  const spans: SidewalkSpan[] = [];
  for (let cutIndex = 1; cutIndex < cuts.length; cutIndex++) {
    const start = cuts[cutIndex - 1], end = cuts[cutIndex];
    if (end <= start) continue;
    const key = spanKey(roadIndex, start, end);
    if (topology.suppressedSpans.has(key)) continue;
    const renderLeft = road.sidewalkLeft
      && !topology.suppressedSides.has(sideKey(roadIndex, start, end, 'left'));
    const renderRight = road.sidewalkRight
      && !topology.suppressedSides.has(sideKey(roadIndex, start, end, 'right'));
    if (!renderLeft && !renderRight) continue;
    const pts = road.pts.slice(start * 2, end * 2 + 2);
    const ys = road.ys.slice(start, end + 1);
    spans.push({
      pts,
      ys,
      renderLeft,
      renderRight,
      trimStartLeft: renderLeft
        ? trimForRoadSide(topology, roadIndex, start, start + 1, 'left') : 0,
      trimEndLeft: renderLeft
        ? trimForRoadSide(topology, roadIndex, end, end - 1, 'left') : 0,
      trimStartRight: renderRight
        ? trimForRoadSide(topology, roadIndex, start, start + 1, 'right') : 0,
      trimEndRight: renderRight
        ? trimForRoadSide(topology, roadIndex, end, end - 1, 'right') : 0,
    });
  }
  return spans;
}

export const SIDEWALK_TOPOLOGY_DIMENSIONS = {
  innerFromCurb: SIDEWALK_INNER_FROM_CURB,
  outerFromCurb: SIDEWALK_OUTER_FROM_CURB,
  curbCenterFromRoad: CURB_CENTER_FROM_ROAD,
} as const;
