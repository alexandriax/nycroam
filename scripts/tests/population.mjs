import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POPULATION_BUDGETS,
  populationCeiling,
  populationRebuildDistance,
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
      low: 10036,
      medium: 20940,
      high: 35092,
      ultra: 49528,
    },
  );
  for (const level of Object.keys(POPULATION_BUDGETS)) {
    const ceiling = populationCeiling(level);
    assert.equal(ceiling.colorDrawCalls, 14);
    assert.ok(ceiling.shadowDrawCalls <= 2);
    assert.ok(ceiling.triangles < 55_000);
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(POPULATION_BUDGETS).map((level) => [
        level,
        populationCeiling(level).matrixWritesPerRebuild,
      ]),
    ),
    { low: 416, medium: 862, high: 1428, ultra: 2000 },
  );
});

test('population rebuild cadence preserves walking detail and amortizes fast travel', () => {
  assert.equal(populationRebuildDistance(5), 36);
  assert.equal(populationRebuildDistance(22), 82);
  assert.equal(populationRebuildDistance(130), 260);
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
