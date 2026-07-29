import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeTileBinary } from '../../src/engine/tileBinary.ts';
import {
  buildSidewalkTopology,
  sidewalkSpansForRoad,
  SIDEWALK_TOPOLOGY_DIMENSIONS,
} from '../../src/engine/sidewalkTopology.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SURFACE_STREETS = new Set([
  'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
]);
const DEFAULT_WIDTH = {
  primary: 17,
  secondary: 14,
  tertiary: 12,
  unclassified: 10,
  residential: 10,
  living_street: 8,
};

function road(pts, halfWidth, overrides = {}) {
  return {
    pts,
    ys: new Array(pts.length / 2).fill(0),
    halfWidth,
    participates: true,
    sidewalkLeft: true,
    sidewalkRight: true,
    junctionStart: false,
    junctionEnd: false,
    ...overrides,
  };
}

function pointToIncidentRayDistance(x, z, junction, approach) {
  const dx = x - junction.x, dz = z - junction.z;
  const projection = dx * approach.dx + dz * approach.dz;
  return projection >= 0
    ? Math.abs(dx * approach.dz - dz * approach.dx)
    : Math.hypot(dx, dz);
}

function assertCornerEdgesClearRoadbeds(junction) {
  for (const corner of junction.corners) {
    const points = corner.paving;
    for (let edge = 0; edge < points.length / 2; edge++) {
      const next = (edge + 1) % (points.length / 2);
      const x0 = points[edge * 2], z0 = points[edge * 2 + 1];
      const x1 = points[next * 2], z1 = points[next * 2 + 1];
      for (let sample = 0; sample <= 40; sample++) {
        const t = sample / 40;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        for (const approach of junction.approaches) {
          assert.ok(
            pointToIncidentRayDistance(x, z, junction, approach) >= approach.halfWidth - 1e-5,
            `corner ${corner.junctionKey} entered an incident ${approach.halfWidth}m half-road`,
          );
        }
      }
    }
    for (let edge = 0; edge + 3 < corner.curb.length; edge += 2) {
      const x0 = corner.curb[edge], z0 = corner.curb[edge + 1];
      const x1 = corner.curb[edge + 2], z1 = corner.curb[edge + 3];
      for (let sample = 0; sample <= 40; sample++) {
        const t = sample / 40;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        for (const approach of junction.approaches) {
          assert.ok(
            pointToIncidentRayDistance(x, z, junction, approach)
              >= approach.halfWidth + 0.159 - 1e-5,
            `curb return ${corner.junctionKey} entered an incident road footprint`,
          );
        }
      }
    }
  }
}

function terminalPoint(junction, approach, side) {
  const offset = approach.halfWidth + SIDEWALK_TOPOLOGY_DIMENSIONS.innerFromCurb;
  const trim = side === 1 ? approach.trimLeft : approach.trimRight;
  return [
    junction.x + approach.dx * trim - approach.dz * side * offset,
    junction.z + approach.dz * trim + approach.dx * side * offset,
  ];
}

function minimumCornerVertexDistance(junction, point) {
  let best = Infinity;
  for (const corner of junction.corners) {
    for (let i = 0; i < corner.paving.length; i += 2) {
      best = Math.min(
        best,
        Math.hypot(point[0] - corner.paving[i], point[1] - corner.paving[i + 1]),
      );
    }
  }
  return best;
}

function assertApproachTerminalsClearRoadbeds(junction) {
  for (const approach of junction.approaches) {
    for (const side of [1, -1]) {
      if ((side === 1 && !approach.left) || (side === -1 && !approach.right)) continue;
      for (const fromCurb of [
        0,
        0.32,
        SIDEWALK_TOPOLOGY_DIMENSIONS.innerFromCurb,
        SIDEWALK_TOPOLOGY_DIMENSIONS.outerFromCurb,
      ]) {
        const offset = approach.halfWidth + fromCurb;
        const trim = side === 1 ? approach.trimLeft : approach.trimRight;
        const x = junction.x + approach.dx * trim - approach.dz * side * offset;
        const z = junction.z + approach.dz * trim + approach.dx * side * offset;
        for (const incident of junction.approaches) {
          assert.ok(
            pointToIncidentRayDistance(x, z, junction, incident) >= incident.halfWidth - 1e-5,
            `terminal at ${trim}m entered an incident ${incident.halfWidth}m half-road`,
          );
        }
      }
    }
  }
}

test('unequal-width crossing is split once and its four sidewalk corners meet within 5cm', () => {
  const roads = [
    road([-30, 0, 0, 0, 30, 0], 7),
    road([0, -30, 0, 0, 0, 30], 4),
  ];
  const topology = buildSidewalkTopology(roads);
  assert.equal(topology.junctions.size, 1);
  const junction = [...topology.junctions.values()][0];
  assert.equal(junction.approaches.length, 4);
  assert.equal(junction.corners.length, 4);
  assert.equal(new Set(junction.corners.map((corner) => corner.junctionKey)).size, 1);

  assert.deepEqual(sidewalkSpansForRoad(topology, 0).map((span) => span.pts), [
    [-30, 0, 0, 0],
    [0, 0, 30, 0],
  ]);
  assert.deepEqual(sidewalkSpansForRoad(topology, 1).map((span) => span.pts), [
    [0, -30, 0, 0],
    [0, 0, 0, 30],
  ]);

  for (const approach of junction.approaches) {
    if (approach.left) {
      assert.ok(minimumCornerVertexDistance(junction, terminalPoint(junction, approach, 1)) <= 0.05);
    }
    if (approach.right) {
      assert.ok(minimumCornerVertexDistance(junction, terminalPoint(junction, approach, -1)) <= 0.05);
    }
  }
  assertCornerEdgesClearRoadbeds(junction);
});

test('skew T-junction owns three safe corners including the straight-through back sidewalk', () => {
  const topology = buildSidewalkTopology([
    road([-35, 0, 0, 0, 35, 0], 8),
    road([0, 0, 15, 25.9808], 3),
  ]);
  assert.equal(topology.junctions.size, 1);
  const junction = [...topology.junctions.values()][0];
  assert.equal(junction.approaches.length, 3);
  assert.equal(junction.corners.length, 3);
  assert.ok(junction.corners.every((corner) =>
    corner.paving.every(Number.isFinite) && corner.curb.every(Number.isFinite)));
  assertCornerEdgesClearRoadbeds(junction);
});

test('acute wide-road retains only a clearance-proven middle and never emits capped corners', () => {
  for (const degrees of [3, 10, 20]) {
    const radians = degrees * Math.PI / 180;
    const topology = buildSidewalkTopology([
      road([0, 0, 120, 0], 8.5, { junctionStart: true }),
      road([0, 0, Math.cos(radians) * 120, Math.sin(radians) * 120], 8.5, {
        junctionStart: true,
      }),
    ]);
    assert.equal(topology.junctions.size, 1, `${degrees}° fixture remains a known junction`);
    const junction = [...topology.junctions.values()][0];
    assert.ok(
      junction.approaches.some((approach) =>
        !Number.isFinite(approach.trimLeft)
        || !Number.isFinite(approach.trimRight)
        || approach.trimLeft > 48
        || approach.trimRight > 48),
      `${degrees}° fixture proves the uncapped clearance requirement`,
    );
    assert.equal(junction.corners.length, 0, `${degrees}° emits no capped unsafe corner`);
    assertApproachTerminalsClearRoadbeds(junction);
    for (const roadIndex of [0, 1]) {
      const spans = sidewalkSpansForRoad(topology, roadIndex);
      assert.equal(spans.length, 1, `${degrees}° retains at least its safe outside sidewalk`);
      const span = spans[0];
      if (span.renderLeft) assert.ok(span.trimStartLeft + 1.25 <= 120);
      if (span.renderRight) assert.ok(span.trimStartRight + 1.25 <= 120);
    }
    if (degrees === 3) {
      const [first, second] = [0, 1].map((roadIndex) =>
        sidewalkSpansForRoad(topology, roadIndex)[0]);
      assert.equal(first.renderLeft, false, 'first fork leg suppresses only its acute inside');
      assert.equal(first.renderRight, true, 'first fork leg preserves its outside sidewalk');
      assert.equal(second.renderLeft, true, 'second fork leg preserves its outside sidewalk');
      assert.equal(second.renderRight, false, 'second fork leg suppresses only its acute inside');
      assert.deepEqual([...topology.suppressedSides].sort(), [
        '0:0:1:left',
        '1:0:1:right',
      ]);
      assert.equal(topology.suppressedSpans.size, 0);
    }
  }
});

test('reversing a source way and swapping its side flags preserves world-side topology', () => {
  const branch = road([0, 0, 0, 45], 4);
  const forward = buildSidewalkTopology([
    road([-45, 0, 0, 0, 45, 0], 5, {
      sidewalkLeft: true,
      sidewalkRight: false,
    }),
    branch,
  ]);
  const reversed = buildSidewalkTopology([
    road([45, 0, 0, 0, -45, 0], 5, {
      sidewalkLeft: false,
      sidewalkRight: true,
    }),
    branch,
  ]);
  const snapshot = (topology) => {
    const junction = [...topology.junctions.values()][0];
    return junction.approaches.map((approach) => ({
      dx: Number(approach.dx.toFixed(6)),
      dz: Number(approach.dz.toFixed(6)),
      trimLeft: Number(approach.trimLeft.toFixed(6)),
      trimRight: Number(approach.trimRight.toFixed(6)),
      renderLeft: approach.renderLeft,
      renderRight: approach.renderRight,
    }));
  };
  assert.deepEqual(snapshot(reversed), snapshot(forward));
  assert.ok(sidewalkSpansForRoad(forward, 0).every((span) =>
    span.renderLeft && !span.renderRight));
  assert.ok(sidewalkSpansForRoad(reversed, 0).every((span) =>
    !span.renderLeft && span.renderRight));
});

test('short 2m, 4m, and 6m approaches cannot own floating corner islands', () => {
  for (const length of [2, 4, 6]) {
    const topology = buildSidewalkTopology([
      road([0, 0, length, 0], 5, { junctionStart: true }),
      road([0, 0, 0, 30], 5, { junctionStart: true }),
    ]);
    const junction = [...topology.junctions.values()][0];
    assert.ok(junction, `${length}m fixture remains a known junction`);
    const shortSpans = sidewalkSpansForRoad(topology, 0);
    assert.equal(shortSpans.length, 1, `${length}m source retains its clearance-proven outside`);
    assert.equal(shortSpans[0].renderLeft, false, 'unsafe inside side is suppressed');
    assert.equal(shortSpans[0].renderRight, true, 'safe outside side stays source-connected');
    assert.ok(shortSpans[0].trimStartRight + 1.25 <= length);
    assert.equal(junction.corners.length, 0, `${length}m source cannot leave a detached wedge`);
    assert.equal(sidewalkSpansForRoad(topology, 1).length, 1, 'unrelated long span remains renderable');
  }
});

test('two close junction trims share one 1.25m survival budget', () => {
  const topology = buildSidewalkTopology([
    road([-30, 0, 0, 0, 6, 0, 30, 0], 5),
    road([0, 0, 0, 30], 5),
    road([6, 0, 6, 30], 5),
  ]);
  const mainSpans = sidewalkSpansForRoad(topology, 0);
  assert.deepEqual(mainSpans.map((span) => span.pts), [
    [-30, 0, 0, 0],
    [0, 0, 6, 0],
    [6, 0, 30, 0],
  ]);
  assert.equal(mainSpans[1].renderLeft, false, 'the two north-side corner mouths do not fit');
  assert.equal(mainSpans[1].renderRight, true, 'the straight-through south sidewalk remains');
  assert.ok(topology.suppressedSides.has('0:1:2:left'));
  assert.equal(topology.suppressedSpans.has('0:1:2'), false);
  for (const junction of topology.junctions.values()) {
    assert.equal(junction.corners.length, 2, 'only wedges backed by surviving sides remain');
    assertCornerEdgesClearRoadbeds(junction);
  }
});

test('two close acute forks suppress one inside side without erasing the safe outside', () => {
  const radians = 10 * Math.PI / 180;
  const topology = buildSidewalkTopology([
    road([-120, 0, 0, 0, 40, 0, 160, 0], 5),
    road([0, 0, Math.cos(radians) * 120, Math.sin(radians) * 120], 5),
    road([
      40,
      0,
      40 + Math.cos(Math.PI - radians) * 120,
      Math.sin(Math.PI - radians) * 120,
    ], 5),
  ]);
  const middle = sidewalkSpansForRoad(topology, 0).find((span) =>
    span.pts[0] === 0 && span.pts[2] === 40);
  assert.ok(middle);
  assert.equal(middle.renderLeft, false, 'overlapping acute inside clearances cannot fit');
  assert.equal(middle.renderRight, true, 'the independently solved outside remains continuous');
  assert.ok(middle.trimStartRight + middle.trimEndRight + 1.25 <= 40);
  assert.ok(topology.suppressedSides.has('0:1:2:left'));
  assert.equal(topology.suppressedSpans.has('0:1:2'), false);
  for (const junction of topology.junctions.values()) assertCornerEdgesClearRoadbeds(junction);
});

test('a driveway ray cannot split a continuous attached sidewalk', () => {
  const topology = buildSidewalkTopology([
    road([-30, 0, 0, 0, 30, 0], 5),
    road([0, 0, 0, 12], 2.75, {
      participates: false,
      sidewalkLeft: false,
      sidewalkRight: false,
      junctionStart: true,
    }),
  ]);
  assert.equal(topology.junctions.size, 0);
  assert.equal(sidewalkSpansForRoad(topology, 0).length, 1);
});

test('serialized global endpoint degree rejects an incomplete tile-local T-junction', () => {
  const topology = buildSidewalkTopology([
    road([50, 50, 90, 50], 5, {
      junctionStart: true,
      expectedDegreeStart: 3,
    }),
    road([50, 50, 50, 90], 5, {
      junctionStart: true,
      expectedDegreeStart: 3,
    }),
  ], { minX: 0, minZ: 0, maxX: 256, maxZ: 256 });
  assert.equal(topology.junctions.size, 0, 'the missing third global ray prevents local corner ownership');
  assert.ok(topology.blockedNodes.has('500,500'));
  assert.equal(sidewalkSpansForRoad(topology, 0).length, 0);
  assert.equal(sidewalkSpansForRoad(topology, 1).length, 0);
});

test('a complete serialized three-ray junction remains eligible away from tile borders', () => {
  const overrides = { junctionStart: true, expectedDegreeStart: 3 };
  const topology = buildSidewalkTopology([
    road([50, 50, 90, 50], 5, overrides),
    road([50, 50, 50, 90], 5, overrides),
    road([50, 50, 10, 50], 5, overrides),
  ], { minX: 0, minZ: 0, maxX: 256, maxZ: 256 });
  assert.equal(topology.junctions.size, 1);
  assert.equal([...topology.junctions.values()][0].corners.length, 3);
});

test('serialized degree counts a through-way interior vertex plus its endpoint branch', () => {
  const topology = buildSidewalkTopology([
    road([-50, 50, 50, 50, 150, 50], 5),
    road([50, 50, 50, 130], 5, {
      junctionStart: true,
      expectedDegreeStart: 2,
    }),
  ], { minX: -100, minZ: 0, maxX: 200, maxZ: 200 });
  assert.equal(topology.blockedNodes.size, 0);
  assert.equal(topology.junctions.size, 1);
  const junction = topology.junctions.get('500,500');
  assert.ok(junction);
  assert.equal(junction.approaches.length, 3);
  assert.equal(junction.corners.length, 3);
  assert.deepEqual(sidewalkSpansForRoad(topology, 0).map((span) => span.pts), [
    [-50, 50, 50, 50],
    [50, 50, 150, 50],
  ]);
  assertCornerEdgesClearRoadbeds(junction);
});

test('a complete junction exactly on a tile grid line has no duplicate local owner', () => {
  const overrides = { junctionStart: true, expectedDegreeStart: 3 };
  const topology = buildSidewalkTopology([
    road([768, 567.6, 800, 567.6], 5, overrides),
    road([768, 567.6, 768, 600], 5, overrides),
    road([768, 567.6, 740, 567.6], 5, overrides),
  ], { minX: 768, minZ: 512, maxX: 1024, maxZ: 768 });
  assert.equal(topology.junctions.size, 0);
  assert.ok(topology.blockedNodes.has('7680,5676'));
  assert.equal(sidewalkSpansForRoad(topology, 0).length, 0);
  assert.equal(sidewalkSpansForRoad(topology, 1).length, 0);
  assert.equal(sidewalkSpansForRoad(topology, 2).length, 0);
});

test('a blocked border endpoint trims at most 48m instead of erasing a 300m sidewalk', () => {
  const topology = buildSidewalkTopology([
    road([0, 128, 300, 128], 5, {
      junctionStart: true,
      expectedDegreeStart: 3,
    }),
  ], { minX: 0, minZ: 0, maxX: 512, maxZ: 256 });
  assert.ok(topology.blockedNodes.has('0,1280'));
  assert.equal(topology.junctions.size, 0);
  assert.equal(topology.suppressedSpans.size, 0);
  assert.deepEqual(sidewalkSpansForRoad(topology, 0), [{
    pts: [0, 128, 300, 128],
    ys: [0, 0],
    renderLeft: true,
    renderRight: true,
    trimStartLeft: 48,
    trimEndLeft: 0,
    trimStartRight: 48,
    trimEndRight: 0,
  }]);
});

const SHIPPING_TILE_INDEX = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public/tiles/index.json'), 'utf8'),
);

function decodeShippingTile(key) {
  const region = Object.values(SHIPPING_TILE_INDEX.regions).find((candidate) => candidate.t[key]);
  assert.ok(region, `shipping region for tile ${key}`);
  const [offset, length] = region.t[key];
  const bytes = fs.readFileSync(path.join(ROOT, 'public/tiles', region.f));
  const slice = bytes.subarray(offset, offset + length);
  return decodeTileBinary(
    slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
  );
}

function shippingSidewalkRoads(tile) {
  return (tile.roads ?? []).map((source) => {
    const flags = source.f ?? (!source.b && SURFACE_STREETS.has(source.c) ? 3 : 0);
    const width = source.w !== undefined
      ? source.w / 10
      : (DEFAULT_WIDTH[source.c] ?? 10);
    return {
      pts: source.p.map((value, index) =>
        (index % 2 === 0 ? tile.x : tile.z) * 256 + value / 10),
      ys: new Array(source.p.length / 2).fill(0),
      halfWidth: width * 0.5,
      participates: !source.b && SURFACE_STREETS.has(source.c) && !(flags & 4),
      sidewalkLeft: SURFACE_STREETS.has(source.c) && Boolean(flags & 1),
      sidewalkRight: SURFACE_STREETS.has(source.c) && Boolean(flags & 2),
      junctionStart: Boolean(flags & 32),
      junctionEnd: Boolean(flags & 64),
      expectedDegreeStart: source.i?.[0] ?? 0,
      expectedDegreeEnd: source.i?.[1] ?? 0,
    };
  });
}

test('shipping Broadway/W 38 tile resolves the reported four-approach sidewalk junction', () => {
  const tile = decodeShippingTile('-1_2');
  const roads = shippingSidewalkRoads(tile);
  const topology = buildSidewalkTopology(roads);
  const junction = topology.junctions.get('-1555,5683');
  assert.ok(junction, 'reported shared decimetre node remains in the shipping bundle');
  assert.equal(junction.approaches.length, 4);
  assert.equal(junction.corners.length, 4);
  assertCornerEdgesClearRoadbeds(junction);
});

test('shipping x=768 boundary fixture never claims the partial cross-tile junction', () => {
  for (const key of ['2_2', '3_2']) {
    const tile = decodeShippingTile(key);
    const topology = buildSidewalkTopology(shippingSidewalkRoads(tile), {
      minX: tile.x * 256,
      minZ: tile.z * 256,
      maxX: (tile.x + 1) * 256,
      maxZ: (tile.z + 1) * 256,
    });
    assert.equal(
      topology.junctions.has('7680,5676'),
      false,
      `${key} does not duplicate or infer the grid-line corner owner`,
    );
  }
});

function sourceSpanLength(road, start, end) {
  let length = 0;
  for (let index = start + 1; index <= end; index++) {
    length += Math.hypot(
      road.pts[index * 2] - road.pts[(index - 1) * 2],
      road.pts[index * 2 + 1] - road.pts[(index - 1) * 2 + 1],
    );
  }
  return length;
}

function sourceNodeKey(road, vertexIndex) {
  return `${Math.round(road.pts[vertexIndex * 2] * 10)},${
    Math.round(road.pts[vertexIndex * 2 + 1] * 10)
  }`;
}

function sourceApproach(topology, roadIndex, vertexIndex, neighborIndex) {
  const junction = topology.junctions.get(
    sourceNodeKey(topology.roads[roadIndex], vertexIndex),
  );
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

function sourceTrimForRoadSide(topology, roadIndex, vertexIndex, neighborIndex, roadSide) {
  const owner = sourceApproach(topology, roadIndex, vertexIndex, neighborIndex);
  if (!owner) return 0;
  const approachSide = neighborIndex > vertexIndex
    ? roadSide
    : roadSide === 'left' ? 'right' : 'left';
  return approachSide === 'left' ? owner.approach.trimLeft : owner.approach.trimRight;
}

test('shipping-wide sidewalk suppression stays inside the audited safety budget', (context) => {
  const metrics = {
    tiles: 0,
    participatingRoadMeters: 0,
    attachedSideMeters: 0,
    blockedNodes: 0,
    suppressedSpans: 0,
    suppressedMeters: 0,
    maxSuppressedSpanMeters: 0,
    suppressedSides: 0,
    suppressedSideMeters: 0,
    maxSuppressedSideMeters: 0,
    blockedShortSides: 0,
    blockedShortSideMeters: 0,
    clearanceDoesNotFitSides: 0,
    clearanceDoesNotFitMeters: 0,
    nonFiniteClearanceSides: 0,
    nonFiniteClearanceMeters: 0,
    singleSideSpans: 0,
    blockedTrimSideEnds: 0,
    blockedTrimMeters: 0,
    maxBlockedTrimMeters: 0,
  };
  for (const region of Object.values(SHIPPING_TILE_INDEX.regions)) {
    const bytes = fs.readFileSync(path.join(ROOT, 'public/tiles', region.f));
    for (const [offset, length] of Object.values(region.t)) {
      const slice = bytes.subarray(offset, offset + length);
      const tile = decodeTileBinary(
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      );
      const roads = shippingSidewalkRoads(tile);
      const topology = buildSidewalkTopology(roads, {
        minX: tile.x * 256,
        minZ: tile.z * 256,
        maxX: (tile.x + 1) * 256,
        maxZ: (tile.z + 1) * 256,
      });
      metrics.tiles++;
      metrics.blockedNodes += topology.blockedNodes.size;
      metrics.suppressedSpans += topology.suppressedSpans.size;
      for (const road of roads) {
        if (road.participates) {
          const meters = sourceSpanLength(road, 0, road.pts.length / 2 - 1);
          metrics.participatingRoadMeters += meters;
          if (road.sidewalkLeft) metrics.attachedSideMeters += meters;
          if (road.sidewalkRight) metrics.attachedSideMeters += meters;
        }
      }
      for (const key of topology.suppressedSpans) {
        const [roadIndex, start, end] = key.split(':').map(Number);
        const road = roads[roadIndex];
        const meters = sourceSpanLength(road, start, end);
        metrics.suppressedMeters += meters;
        metrics.maxSuppressedSpanMeters = Math.max(metrics.maxSuppressedSpanMeters, meters);
      }
      metrics.suppressedSides += topology.suppressedSides.size;
      for (const key of topology.suppressedSides) {
        const [roadIndexText, startText, endText, side] = key.split(':');
        const roadIndex = Number(roadIndexText);
        const start = Number(startText);
        const end = Number(endText);
        const road = roads[roadIndex];
        const meters = sourceSpanLength(road, start, end);
        metrics.suppressedSideMeters += meters;
        metrics.maxSuppressedSideMeters = Math.max(metrics.maxSuppressedSideMeters, meters);
        const startKey = sourceNodeKey(road, start);
        const endKey = sourceNodeKey(road, end);
        if (topology.blockedNodes.has(startKey) || topology.blockedNodes.has(endKey)) {
          metrics.blockedShortSides++;
          metrics.blockedShortSideMeters += meters;
        } else {
          const trimStart = sourceTrimForRoadSide(
            topology, roadIndex, start, start + 1, side,
          );
          const trimEnd = sourceTrimForRoadSide(
            topology, roadIndex, end, end - 1, side,
          );
          if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd)) {
            metrics.nonFiniteClearanceSides++;
            metrics.nonFiniteClearanceMeters += meters;
          } else {
            metrics.clearanceDoesNotFitSides++;
            metrics.clearanceDoesNotFitMeters += meters;
          }
        }
      }
      for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
        for (const span of sidewalkSpansForRoad(topology, roadIndex)) {
          if (span.renderLeft !== span.renderRight) metrics.singleSideSpans++;
          const last = span.pts.length - 2;
          const startKey = `${Math.round(span.pts[0] * 10)},${Math.round(span.pts[1] * 10)}`;
          const endKey = `${Math.round(span.pts[last] * 10)},${Math.round(span.pts[last + 1] * 10)}`;
          if (topology.blockedNodes.has(startKey)) {
            for (const trim of [
              span.renderLeft ? span.trimStartLeft : null,
              span.renderRight ? span.trimStartRight : null,
            ]) {
              if (trim === null) continue;
              metrics.blockedTrimSideEnds++;
              metrics.blockedTrimMeters += trim;
              metrics.maxBlockedTrimMeters = Math.max(metrics.maxBlockedTrimMeters, trim);
            }
          }
          if (topology.blockedNodes.has(endKey)) {
            for (const trim of [
              span.renderLeft ? span.trimEndLeft : null,
              span.renderRight ? span.trimEndRight : null,
            ]) {
              if (trim === null) continue;
              metrics.blockedTrimSideEnds++;
              metrics.blockedTrimMeters += trim;
              metrics.maxBlockedTrimMeters = Math.max(metrics.maxBlockedTrimMeters, trim);
            }
          }
        }
      }
    }
  }
  const rounded = {
    ...metrics,
    participatingRoadMeters: Number(metrics.participatingRoadMeters.toFixed(2)),
    attachedSideMeters: Number(metrics.attachedSideMeters.toFixed(2)),
    suppressedMeters: Number(metrics.suppressedMeters.toFixed(2)),
    maxSuppressedSpanMeters: Number(metrics.maxSuppressedSpanMeters.toFixed(2)),
    suppressedSideMeters: Number(metrics.suppressedSideMeters.toFixed(2)),
    maxSuppressedSideMeters: Number(metrics.maxSuppressedSideMeters.toFixed(2)),
    blockedShortSideMeters: Number(metrics.blockedShortSideMeters.toFixed(2)),
    clearanceDoesNotFitMeters: Number(metrics.clearanceDoesNotFitMeters.toFixed(2)),
    nonFiniteClearanceMeters: Number(metrics.nonFiniteClearanceMeters.toFixed(2)),
    suppressedPercent: Number(
      (metrics.suppressedMeters / metrics.participatingRoadMeters * 100).toFixed(3),
    ),
    suppressedSidePercent: Number(
      (metrics.suppressedSideMeters / metrics.attachedSideMeters * 100).toFixed(3),
    ),
  };
  context.diagnostic(`shipping sidewalk audit ${JSON.stringify(rounded)}`);
  assert.equal(metrics.tiles, 3_237);
  assert.ok(metrics.blockedNodes <= 650, `blocked nodes regressed to ${metrics.blockedNodes}`);
  assert.ok(metrics.suppressedSpans <= 3_000, `suppressed spans regressed to ${metrics.suppressedSpans}`);
  assert.ok(metrics.suppressedMeters <= 30_000, `suppressed metres regressed to ${metrics.suppressedMeters}`);
  assert.ok(
    metrics.suppressedMeters / metrics.participatingRoadMeters <= 0.0125,
    `whole-span suppression exceeded 1.25% of ${metrics.participatingRoadMeters} source metres`,
  );
  assert.ok(
    metrics.maxSuppressedSpanMeters <= 140,
    `largest wholly suppressed span regressed to ${metrics.maxSuppressedSpanMeters}m`,
  );
  assert.ok(metrics.suppressedSides <= 7_000, `suppressed sides regressed to ${metrics.suppressedSides}`);
  assert.ok(metrics.suppressedSideMeters <= 66_000, `suppressed side metres regressed to ${metrics.suppressedSideMeters}`);
  assert.ok(
    metrics.suppressedSideMeters / metrics.attachedSideMeters <= 0.0155,
    `side suppression exceeded 1.55% of ${metrics.attachedSideMeters} attached-side metres`,
  );
  assert.ok(
    metrics.maxSuppressedSideMeters <= 180,
    `largest suppressed side regressed to ${metrics.maxSuppressedSideMeters}m`,
  );
  assert.equal(
    metrics.blockedShortSides
      + metrics.clearanceDoesNotFitSides
      + metrics.nonFiniteClearanceSides,
    metrics.suppressedSides,
  );
  assert.ok(
    Math.abs(
      metrics.blockedShortSideMeters
      + metrics.clearanceDoesNotFitMeters
      + metrics.nonFiniteClearanceMeters
      - metrics.suppressedSideMeters,
    ) < 1e-5,
  );
  assert.ok(metrics.blockedShortSides <= 1_225, `blocked short sides regressed to ${metrics.blockedShortSides}`);
  assert.ok(metrics.blockedShortSideMeters <= 14_300, `blocked short side metres regressed to ${metrics.blockedShortSideMeters}`);
  assert.equal(metrics.nonFiniteClearanceSides, 0, 'non-finite junction solve reached shipping data');
  assert.ok(
    metrics.clearanceDoesNotFitMeters <= 52_100,
    `clearance-limited metres regressed to ${metrics.clearanceDoesNotFitMeters}`,
  );
  assert.ok(metrics.singleSideSpans >= 3_000, `safe one-side retention regressed to ${metrics.singleSideSpans}`);
  assert.ok(metrics.singleSideSpans <= 4_500, `one-side span count grew to ${metrics.singleSideSpans}`);
  assert.ok(metrics.blockedTrimSideEnds <= 440, `blocked trim side-ends regressed to ${metrics.blockedTrimSideEnds}`);
  assert.ok(metrics.blockedTrimMeters <= 21_000, `blocked trim metres regressed to ${metrics.blockedTrimMeters}`);
  assert.ok(
    metrics.maxBlockedTrimMeters <= 48,
    `blocked endpoint trim exceeded the 48m safety cap: ${metrics.maxBlockedTrimMeters}m`,
  );
});
