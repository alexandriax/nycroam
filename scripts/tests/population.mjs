import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POPULATION_BUDGETS,
  populationCeiling,
  populationRebuildDistance,
  populationRebuildRequired,
  populationStreamSettled,
} from '../../src/engine/population/budgets.ts';
import {
  advanceLaneProgress,
  buildRoadGraph,
  sampleLaneRoute,
} from '../../src/engine/population/roadGraph.ts';
import {
  composePopulationDensity,
  populationAnchorKey,
  smoothDensityFalloff,
} from '../../src/engine/population/densityKernel.ts';
import {
  trafficFootprintsOverlap,
  trafficSweptConflict,
  yieldsTo,
} from '../../src/engine/population/trafficSafety.ts';
import { buildVehicleBodyGeometry } from '../../src/engine/population/vehicleGeometry.ts';
import {
  buildCyclistGeometry,
  CYCLIST_GEOMETRY_TRIANGLES,
  CYCLIST_PART_COLORS,
} from '../../src/engine/population/cyclistGeometry.ts';
import {
  cyclistBikeLaneOffset,
  cyclistCadencePose,
  cyclistLookaheadDistance,
} from '../../src/engine/population/cyclistMotion.ts';

function path(kind, width, points, flags = 0) {
  return {
    start: new Uint32Array([0, points.length / 2]),
    pts: new Float32Array(points),
    width: new Float32Array([width]),
    kind: new Uint8Array([kind]),
    flags: new Uint16Array([flags]),
  };
}

test('population ceilings are explicit and remain below the street budget', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(POPULATION_BUDGETS).map((level) => [
        level,
        populationCeiling(level).triangles,
      ]),
    ),
    {
      low: 31802,
      medium: 66702,
      high: 111136,
      ultra: 156400,
    },
  );
  for (const level of Object.keys(POPULATION_BUDGETS)) {
    const ceiling = populationCeiling(level);
    assert.equal(ceiling.colorDrawCalls, 16);
    assert.ok(ceiling.shadowDrawCalls <= 2);
    assert.ok(ceiling.triangles < 160_000);
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(POPULATION_BUDGETS).map((level) => [
        level,
        populationCeiling(level).matrixWritesPerRebuild,
      ]),
    ),
    { low: 470, medium: 978, high: 1622, ultra: 2272 },
  );
});

test('cyclist pool keeps a rounded riding silhouette in one bounded geometry', () => {
  const geometry = buildCyclistGeometry();
  const position = geometry.getAttribute('position');
  const colors = geometry.getAttribute('cyclistBaseColor');
  const tintWeights = geometry.getAttribute('cyclistTintWeight');
  const index = geometry.getIndex();

  assert.ok(index);
  assert.equal(index.count / 3, CYCLIST_GEOMETRY_TRIANGLES);
  assert.ok(index.count / 3 <= 600);
  assert.equal(colors.count, position.count);
  assert.equal(tintWeights.count, position.count);

  const uniqueBaseColors = new Set();
  let tintableVertices = 0;
  let fixedVertices = 0;
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    const ax = position.getX(ia);
    const ay = position.getY(ia);
    const az = position.getZ(ia);
    const abx = position.getX(ib) - ax;
    const aby = position.getY(ib) - ay;
    const abz = position.getZ(ib) - az;
    const acx = position.getX(ic) - ax;
    const acy = position.getY(ic) - ay;
    const acz = position.getZ(ic) - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    const doubledArea = Math.hypot(crossX, crossY, crossZ);
    assert.ok(Number.isFinite(doubledArea), `triangle ${i / 3} must be finite`);
    assert.ok(doubledArea > 1e-8, `triangle ${i / 3} must have nonzero area`);
  }
  for (let i = 0; i < position.count; i++) {
    uniqueBaseColors.add([
      colors.getX(i).toFixed(3),
      colors.getY(i).toFixed(3),
      colors.getZ(i).toFixed(3),
    ].join(':'));
    if (tintWeights.getX(i) > 0.5) tintableVertices++;
    else fixedVertices++;
  }
  assert.equal(uniqueBaseColors.size, Object.keys(CYCLIST_PART_COLORS).length);
  assert.ok(tintableVertices > 0, 'jersey pieces retain per-rider color variation');
  assert.ok(fixedVertices > tintableVertices, 'bike, skin, and trousers keep stable materials');

  geometry.computeBoundingBox();
  assert.ok(geometry.boundingBox);
  assert.ok(geometry.boundingBox.min.x <= -1);
  assert.ok(geometry.boundingBox.max.x >= 1);
  assert.ok(geometry.boundingBox.max.y >= 1.7);
  assert.ok(geometry.boundingBox.max.z <= 0.25);
  assert.ok(geometry.boundingBox.min.z >= -0.25);
});

test('cyclist cadence and lane separation stay subtle and deterministic', () => {
  assert.equal(cyclistBikeLaneOffset(-1), 0.28);
  assert.ok(Math.abs(cyclistBikeLaneOffset(2) - 0.42) < 1e-9);
  assert.ok(Math.abs(cyclistBikeLaneOffset(0.5) - 0.35) < 1e-9);

  const first = cyclistCadencePose(12.5, 4.8, 1.2, 0.35);
  assert.deepEqual(first, cyclistCadencePose(12.5, 4.8, 1.2, 0.35));
  assert.ok(Math.abs(first.bob) <= 0.006);
  assert.ok(Math.abs(first.lean) <= 0.11);
  assert.ok(cyclistCadencePose(0, 4, 0, 1).lean > 0);
  assert.ok(cyclistCadencePose(0, 4, 0, -1).lean < 0);
});

test('cyclist lookahead never wraps a route endpoint to its start', () => {
  assert.equal(cyclistLookaheadDistance(0, -1, 100), 0);
  assert.equal(cyclistLookaheadDistance(50, 1, 100), 51.8);
  const endpoint = cyclistLookaheadDistance(99.5, 1, 100);
  assert.ok(endpoint < 100);
  assert.ok(endpoint > 99.99);
  assert.equal(cyclistLookaheadDistance(0, 1, 0), 0);
});

test('vehicle body is a closed outward-facing shell from every exterior angle', () => {
  const geometry = buildVehicleBodyGeometry();
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  assert.ok(index);
  assert.equal(index.count / 3, 92);

  const center = [0, 0.55, 0];
  const edgeUses = new Map();
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    for (const [from, to] of [[ia, ib], [ib, ic], [ic, ia]]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
    const a = [position.getX(ia), position.getY(ia), position.getZ(ia)];
    const b = [position.getX(ib), position.getY(ib), position.getZ(ib)];
    const c = [position.getX(ic), position.getY(ic), position.getZ(ic)];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const radial = [
      (a[0] + b[0] + c[0]) / 3 - center[0],
      (a[1] + b[1] + c[1]) / 3 - center[1],
      (a[2] + b[2] + c[2]) / 3 - center[2],
    ];
    assert.ok(
      normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2] > 0,
      `triangle ${i / 3} faces into the vehicle`,
    );
  }
  assert.ok(
    [...edgeUses.values()].every((uses) => uses === 2),
    'every shell edge must be shared by exactly two panels',
  );
});

test('population rebuild cadence preserves walking detail and amortizes fast travel', () => {
  assert.equal(populationRebuildDistance(5), 36);
  assert.equal(populationRebuildDistance(22), 82);
  assert.equal(populationRebuildDistance(130), 260);
  assert.equal(populationRebuildRequired(Number.NaN, 36, false, 0), true);
  assert.equal(populationRebuildRequired(0, 36, false, 300), false);
  assert.equal(populationRebuildRequired(0, 36, true, 0.74), false);
  assert.equal(populationRebuildRequired(0, 36, true, 0.75), true);
  assert.equal(populationRebuildRequired(37 ** 2, 36, false, 0.1), true);
  assert.equal(populationStreamSettled(true, 1.49), false);
  assert.equal(populationStreamSettled(true, 1.5), true);
  assert.equal(populationStreamSettled(false, 20), false);
});

test('oriented traffic bodies prevent car, cross-traffic, and transit phasing', () => {
  const car = {
    key: 'car:b', x: 0, z: 0, fx: 1, fz: 0,
    halfLength: 2.3, halfWidth: 0.95, speed: 9,
  };
  const leader = {
    key: 'car:a', x: 4.2, z: 0, fx: 1, fz: 0,
    halfLength: 2.3, halfWidth: 0.95, speed: 0,
  };
  assert.equal(trafficFootprintsOverlap(car, leader), true);
  leader.x = 5;
  assert.equal(trafficFootprintsOverlap(car, leader), false);

  const crossing = {
    key: 'car:c', x: 8, z: -8, fx: 0, fz: 1,
    halfLength: 2.3, halfWidth: 0.95, speed: 9,
  };
  assert.equal(trafficSweptConflict(car, crossing), true);
  crossing.x = 18;
  assert.equal(trafficSweptConflict(car, crossing), false);

  const bus = {
    key: 'bus:1', x: 6, z: 0, fx: 1, fz: 0,
    halfLength: 6.1, halfWidth: 1.35, speed: 0, priority: true,
  };
  assert.equal(yieldsTo(car, bus), true);
  assert.equal(yieldsTo(bus, car), false);
  assert.equal(yieldsTo(car, crossing), car.key > crossing.key);
});

test('one-way topology and open endpoints never create visible wraps', () => {
  const graph = buildRoadGraph(
    [path(0, 10, [0, 0, 100, 0], 1 << 8)],
    50,
    0,
    120,
    4,
    0,
  );
  assert.equal(graph.trafficRoutes.length, 1);
  assert.equal(graph.trafficRoutes[0].oneWay, true);
  assert.deepEqual([...graph.trafficRoutes[0].points], [0, 0, 100, 0]);

  const oneWay = { distance: 98, direction: 1, finished: false };
  advanceLaneProgress(oneWay, { length: 100, oneWay: true }, 5);
  assert.deepEqual(oneWay, { distance: 100, direction: 1, finished: true });

  const twoWay = { distance: 98, direction: 1, finished: false };
  advanceLaneProgress(twoWay, { length: 100, oneWay: false }, 5);
  assert.deepEqual(twoWay, { distance: 97, direction: -1, finished: false });
});

test('road graph deterministically follows connected OSM centerlines', () => {
  const inputs = [
    path(0, 12, [-100, 0, 0, 0, 100, 0]),
    path(0, 10, [0, -80, 0, 0, 0, 80]),
    path(1, 2.4, [-80, 6, 0, 6, 80, 6]),
  ];
  const first = buildRoadGraph(inputs, 0, 0, 180, 8, 4);
  const reversed = buildRoadGraph([...inputs].reverse(), 0, 0, 180, 8, 4);
  assert.equal(first.segments.length, 6);
  assert.ok(first.trafficRoutes.some((route) => route.points.length >= 6));
  assert.ok(first.cycleRoutes.length > 0);
  assert.deepEqual(
    first.trafficRoutes.map((route) => [...route.points]),
    reversed.trafficRoutes.map((route) => [...route.points]),
  );
});

test('lane route sampling is stable at boundaries and wraps', () => {
  const route = {
    id: 0,
    points: new Float32Array([0, 0, 10, 0, 10, 10]),
    cumulative: new Float32Array([0, 10, 20]),
    length: 20,
    width: 10,
    direction: 1,
  };
  assert.deepEqual(sampleLaneRoute(route, 5), { x: 5, z: 0, dx: 1, dz: 0 });
  assert.deepEqual(sampleLaneRoute(route, 15), { x: 10, z: 5, dx: 0, dz: 1 });
  assert.deepEqual(sampleLaneRoute(route, 25), sampleLaneRoute(route, 5));
});

test('context raises the right activity channels with smooth bounded falloff', () => {
  assert.equal(smoothDensityFalloff(0, 100), 1);
  assert.equal(smoothDensityFalloff(100, 100), 0);
  assert.equal(smoothDensityFalloff(50, 100), 0.5);
  const baseline = composePopulationDensity(0, 0, 0, 0);
  const station = composePopulationDensity(1, 0, 0, 0);
  const park = composePopulationDensity(0, 0, 1, 0);
  const bike = composePopulationDensity(0, 0, 0, 1);
  assert.equal(baseline.pedestrian, 0.18);
  assert.ok(station.pedestrian > baseline.pedestrian);
  assert.ok(station.commerce > baseline.commerce);
  assert.ok(park.park > baseline.park);
  assert.ok(bike.cycling > baseline.cycling);
});

test('streamed context anchors are idempotent across tile upgrades and reloads', () => {
  assert.equal(
    populationAnchorKey('retail', 12.24, -4.20),
    populationAnchorKey('retail', 12.23, -4.21),
  );
  assert.notEqual(
    populationAnchorKey('retail', 12.24, -4.26),
    populationAnchorKey('retail', 13.1, -4.2),
  );
  assert.notEqual(
    populationAnchorKey('retail', 12.24, -4.26),
    populationAnchorKey('station', 12.24, -4.26),
  );
});
