import type { RoadPaths } from '../tileTypes';

// Kept local so this deterministic graph module has no runtime dependency on
// the renderer schema module (and can run directly under node:test).
const PATH_KIND_ROAD = 0;
const PATH_KIND_BIKE = 1;
const ROAD_FLAG_ONEWAY = 1 << 8;

export interface GraphSegment {
  id: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  dx: number;
  dz: number;
  length: number;
  width: number;
  kind: number;
  flags: number;
  aNode: number;
  bNode: number;
}

export interface LaneRoute {
  id: number;
  points: Float32Array;
  cumulative: Float32Array;
  length: number;
  width: number;
  direction: 1 | -1;
  oneWay: boolean;
}

export interface RoadGraph {
  segments: GraphSegment[];
  trafficRoutes: LaneRoute[];
  cycleRoutes: LaneRoute[];
}

interface GraphNode {
  x: number;
  z: number;
  edges: number[];
}

interface DirectedEdge {
  segment: number;
  from: number;
  to: number;
  dx: number;
  dz: number;
}

const quantizedNodeKey = (x: number, z: number): string =>
  `${Math.round(x * 0.5)}:${Math.round(z * 0.5)}`;

function hashInt(value: number): number {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function segmentKey(ax: number, az: number, bx: number, bz: number, kind: number): string {
  const a = quantizedNodeKey(ax, az);
  const b = quantizedNodeKey(bx, bz);
  return a < b ? `${kind}:${a}:${b}` : `${kind}:${b}:${a}`;
}

/**
 * Builds a compact graph from the road geometry already resident around the
 * player. Segment and route ordering is stable across input-array order.
 */
export function buildRoadGraph(
  paths: RoadPaths[],
  centerX: number,
  centerZ: number,
  radius: number,
  maxTrafficRoutes: number,
  maxCycleRoutes: number,
): RoadGraph {
  const raw: Omit<GraphSegment, 'id' | 'aNode' | 'bNode'>[] = [];
  const seen = new Set<string>();
  const expandedRadiusSq = (radius + 100) ** 2;
  for (const path of paths) {
    for (let r = 0; r < path.start.length - 1; r++) {
      const kind = path.kind[r];
      if (kind !== PATH_KIND_ROAD && kind !== PATH_KIND_BIKE) continue;
      const width = path.width[r];
      const start = path.start[r];
      const end = path.start[r + 1];
      for (let i = start; i < end - 1; i++) {
        const ax = path.pts[i * 2];
        const az = path.pts[i * 2 + 1];
        const bx = path.pts[(i + 1) * 2];
        const bz = path.pts[(i + 1) * 2 + 1];
        const vx = bx - ax;
        const vz = bz - az;
        const length = Math.hypot(vx, vz);
        if (length < 3) continue;
        const mx = (ax + bx) * 0.5;
        const mz = (az + bz) * 0.5;
        if ((mx - centerX) ** 2 + (mz - centerZ) ** 2 > expandedRadiusSq) continue;
        const key = segmentKey(ax, az, bx, bz, kind);
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push({
          ax, az, bx, bz,
          dx: vx / length,
          dz: vz / length,
          length,
          width,
          kind,
          flags: path.flags?.[r] ?? 0,
        });
      }
    }
  }
  raw.sort((a, b) => {
    const ak = segmentKey(a.ax, a.az, a.bx, a.bz, a.kind);
    const bk = segmentKey(b.ax, b.az, b.bx, b.bz, b.kind);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const nodes: GraphNode[] = [];
  const nodeByKey = new Map<string, number>();
  const nodeFor = (x: number, z: number): number => {
    const key = quantizedNodeKey(x, z);
    const old = nodeByKey.get(key);
    if (old !== undefined) return old;
    const id = nodes.length;
    nodeByKey.set(key, id);
    nodes.push({ x, z, edges: [] });
    return id;
  };

  const segments: GraphSegment[] = raw.map((segment, id) => {
    const aNode = nodeFor(segment.ax, segment.az);
    const bNode = nodeFor(segment.bx, segment.bz);
    nodes[aNode].edges.push(id);
    nodes[bNode].edges.push(id);
    return { ...segment, id, aNode, bNode };
  });

  const makeDirected = (segment: GraphSegment, direction: 1 | -1): DirectedEdge =>
    direction === 1
      ? {
        segment: segment.id,
        from: segment.aNode,
        to: segment.bNode,
        dx: segment.dx,
        dz: segment.dz,
      }
      : {
        segment: segment.id,
        from: segment.bNode,
        to: segment.aNode,
        dx: -segment.dx,
        dz: -segment.dz,
      };

  const buildRoutes = (kind: number, limit: number, desiredLength: number): LaneRoute[] => {
    const starts: DirectedEdge[] = [];
    for (const segment of segments) {
      if (segment.kind !== kind) continue;
      starts.push(makeDirected(segment, 1));
      if ((segment.flags & ROAD_FLAG_ONEWAY) === 0) {
        starts.push(makeDirected(segment, -1));
      }
    }
    starts.sort((a, b) => {
      const ah = hashInt(a.segment * 2 + (a.from > a.to ? 1 : 0));
      const bh = hashInt(b.segment * 2 + (b.from > b.to ? 1 : 0));
      return ah - bh;
    });

    const routes: LaneRoute[] = [];
    const usedStarts = new Set<string>();
    for (const first of starts) {
      if (routes.length >= limit) break;
      const firstKey = `${first.segment}:${first.from}`;
      if (usedStarts.has(firstKey)) continue;
      const edges: DirectedEdge[] = [first];
      const visited = new Set<number>([first.segment]);
      let cursor = first;
      let distance = segments[first.segment].length;
      while (distance < desiredLength && edges.length < 24) {
        const choices: DirectedEdge[] = [];
        for (const segmentId of nodes[cursor.to].edges) {
          if (visited.has(segmentId)) continue;
          const segment = segments[segmentId];
          if (segment.kind !== kind) continue;
          if (
            (segment.flags & ROAD_FLAG_ONEWAY) !== 0
            && segment.aNode !== cursor.to
          ) continue;
          const next = makeDirected(
            segment,
            segment.aNode === cursor.to ? 1 : -1,
          );
          // Avoid U-turns. NYC's mostly orthogonal graph then naturally picks
          // the straight-through continuation at split OSM ways.
          if (cursor.dx * next.dx + cursor.dz * next.dz < -0.25) continue;
          choices.push(next);
        }
        if (!choices.length) break;
        choices.sort((a, b) => {
          const turnA = cursor.dx * a.dx + cursor.dz * a.dz;
          const turnB = cursor.dx * b.dx + cursor.dz * b.dz;
          if (Math.abs(turnA - turnB) > 1e-5) return turnB - turnA;
          return hashInt(a.segment + edges.length * 131) - hashInt(b.segment + edges.length * 131);
        });
        cursor = choices[0];
        edges.push(cursor);
        visited.add(cursor.segment);
        distance += segments[cursor.segment].length;
      }
      if (distance < (kind === PATH_KIND_BIKE ? 24 : 55)) continue;

      const points = new Float32Array(edges.length * 2 + 2);
      const cumulative = new Float32Array(edges.length + 1);
      const startNode = nodes[edges[0].from];
      points[0] = startNode.x;
      points[1] = startNode.z;
      let total = 0;
      let widthTotal = 0;
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const segment = segments[edge.segment];
        const endNode = nodes[edge.to];
        total += segment.length;
        widthTotal += segment.width;
        cumulative[i + 1] = total;
        points[(i + 1) * 2] = endNode.x;
        points[(i + 1) * 2 + 1] = endNode.z;
        usedStarts.add(`${edge.segment}:${edge.from}`);
      }
      routes.push({
        id: routes.length,
        points,
        cumulative,
        length: total,
        width: widthTotal / edges.length,
        direction: 1,
        oneWay: edges.some(
          (edge) => (segments[edge.segment].flags & ROAD_FLAG_ONEWAY) !== 0,
        ),
      });
    }
    return routes;
  };

  return {
    segments,
    trafficRoutes: buildRoutes(PATH_KIND_ROAD, maxTrafficRoutes, 260),
    cycleRoutes: buildRoutes(PATH_KIND_BIKE, maxCycleRoutes, 180),
  };
}

export interface RouteSample {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

export interface LaneProgress {
  distance: number;
  direction: 1 | -1;
  finished: boolean;
}

/**
 * Advance without ever wrapping a visible open endpoint. Two-way local routes
 * turn back; one-way routes stop at their streamed-graph boundary until the
 * next graph extension/rebuild gives them a continuation.
 */
export function advanceLaneProgress(
  progress: LaneProgress,
  route: Pick<LaneRoute, 'length' | 'oneWay'>,
  delta: number,
): void {
  if (progress.finished || route.length <= 0) return;
  let nextDistance = progress.distance + delta * progress.direction;
  if (route.oneWay) {
    if (nextDistance >= route.length) {
      nextDistance = route.length;
      progress.finished = true;
    }
  } else if (nextDistance >= route.length) {
    nextDistance = Math.max(0, route.length * 2 - nextDistance);
    progress.direction = -1;
  } else if (nextDistance <= 0) {
    nextDistance = Math.min(route.length, -nextDistance);
    progress.direction = 1;
  }
  progress.distance = nextDistance;
}

export function sampleLaneRoute(
  route: LaneRoute,
  rawDistance: number,
  out: RouteSample = { x: 0, z: 0, dx: 1, dz: 0 },
): RouteSample {
  const distance = route.length > 0
    ? ((rawDistance % route.length) + route.length) % route.length
    : 0;
  let lo = 0;
  let hi = route.cumulative.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (route.cumulative[mid] <= distance) lo = mid;
    else hi = mid;
  }
  const segment = Math.min(lo, route.cumulative.length - 2);
  const start = route.cumulative[segment];
  const end = route.cumulative[segment + 1];
  const t = end > start ? (distance - start) / (end - start) : 0;
  const ax = route.points[segment * 2];
  const az = route.points[segment * 2 + 1];
  const bx = route.points[(segment + 1) * 2];
  const bz = route.points[(segment + 1) * 2 + 1];
  const length = Math.hypot(bx - ax, bz - az) || 1;
  out.x = ax + (bx - ax) * t;
  out.z = az + (bz - az) * t;
  out.dx = (bx - ax) / length;
  out.dz = (bz - az) / length;
  return out;
}
