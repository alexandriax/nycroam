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
  findTrafficLateralEscape,
  resolveTrafficMotionTransactions,
  trafficFootprintsOverlap,
  trafficForwardClearance,
  trafficLateralEscape,
  trafficMotionConflicts,
  trafficPairMotionsConflict,
  trafficPairKey,
  trafficSweptConflict,
  yieldsTo,
} from '../../src/engine/population/trafficSafety.ts';
import {
  advancePedestrianProgress,
  pedestrianLaneOffset,
  pedestrianStepHitsTraffic,
  pedestrianSweepsOverlap,
  pedestrianTrafficOverlap,
} from '../../src/engine/population/pedestrianSafety.ts';
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
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(POPULATION_BUDGETS).map((level) => [
        level,
        populationCeiling(level).dynamicMatrixWritesPerNearTick,
      ]),
    ),
    { low: 142, medium: 284, high: 468, ultra: 648 },
  );
  assert.equal(populationCeiling('ultra').dynamicMatrixWritesPerFarTick, 0);
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

test('continuous traffic SAT catches conflicts between old sample times', () => {
  const a = {
    key: 'car:a',
    x: -7.4197958456,
    z: 1.4020831953,
    fx: 0.2164656637,
    fz: -0.9762902317,
    halfLength: 2.3,
    halfWidth: 0.95,
    speed: 7.0762880566,
  };
  const b = {
    key: 'car:b',
    x: -14.8721952341,
    z: -3.6899288138,
    fx: 0.9259713766,
    fz: 0.37759371,
    halfLength: 2.3,
    halfWidth: 0.95,
    speed: 6.7754101537,
  };
  const beforeA = { ...a };
  const beforeB = { ...b };
  assert.equal(trafficSweptConflict(a, b, 1.35), true);
  assert.deepEqual(a, beforeA, 'swept SAT cannot mutate actor snapshots');
  assert.deepEqual(b, beforeB, 'swept SAT cannot mutate actor snapshots');
  assert.notEqual(
    trafficPairKey(1, 1_048_578),
    trafficPairKey(2, 2),
    'large bus ids cannot alias a remembered separation pair',
  );
});

test('committed traffic motion catches endpoint turns and routes around parked bodies', () => {
  const start = {
    key: 'car:turning',
    x: -1.7,
    z: -3.2,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 8,
  };
  const end = {
    ...start,
    x: 1.7,
    z: 3.2,
    fx: -1,
    fz: 0,
  };
  const pedestrian = {
    key: 'ped:crossing',
    x: 0,
    z: 0,
    fx: 0,
    fz: 1,
    halfLength: 0.31,
    halfWidth: 0.31,
    speed: 0,
    priority: true,
  };
  assert.equal(
    trafficFootprintsOverlap(start, pedestrian, 0.18),
    false,
  );
  assert.equal(
    trafficFootprintsOverlap(end, pedestrian, 0.18),
    false,
  );
  assert.equal(
    trafficMotionConflicts(start, end, pedestrian, 0.18),
    true,
    'a lane reversal cannot tunnel through a pedestrian between clear endpoints',
  );

  const bus = {
    key: 'bus:1',
    x: 0,
    z: 0,
    fx: 1,
    fz: 0,
    halfLength: 6.1,
    halfWidth: 1.35,
    speed: 5,
    priority: true,
  };
  const parked = {
    key: 'parked:1',
    x: 8,
    z: 1.2,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 0,
    priority: true,
    immovable: true,
  };
  assert.ok(
    trafficLateralEscape(bus, parked) < 0,
    'a parked body on the right produces a leftward bus lane-change target',
  );
  assert.equal(
    trafficLateralEscape(bus, { ...parked, immovable: false }),
    0,
    'moving actors remain longitudinal yielding conflicts, not lane geometry',
  );
  const leftCorridorCar = {
    ...parked,
    key: 'parked:left',
    x: 8,
    z: -2.42,
  };
  const rightCorridorCar = {
    ...parked,
    key: 'parked:right',
    x: 9,
    z: 2.42,
  };
  assert.equal(trafficLateralEscape(bus, leftCorridorCar), 0);
  assert.equal(trafficLateralEscape(bus, rightCorridorCar), 0);
  assert.equal(
    trafficForwardClearance(bus, leftCorridorCar, 0.08),
    null,
  );
  assert.equal(
    trafficForwardClearance(bus, rightCorridorCar, 0.08),
    null,
    'a bus preserves a centered corridor with exact two-sided clearance',
  );

  const turningBusStart = {
    ...bus,
    x: 0,
    z: 0,
    fx: 1,
    fz: 0,
  };
  const turnYaw = 13.5 * Math.PI / 180;
  const turningBusEnd = {
    ...turningBusStart,
    x: 0.7,
    z: 0.7,
    fx: Math.cos(turnYaw),
    fz: -Math.sin(turnYaw),
  };
  const outerCornerCar = {
    ...parked,
    key: 'parked:outer-corner',
    x: -3.925,
    z: 2.55,
  };
  assert.equal(
    trafficMotionConflicts(
      turningBusStart,
      turningBusEnd,
      outerCornerCar,
      0.08,
    ),
    true,
  );
  const evasive = findTrafficLateralEscape(
    turningBusStart,
    turningBusEnd,
    [outerCornerCar],
    0.4,
    0.08,
  );
  assert.ok(evasive);
  assert.equal(evasive.heldRoute, true);
  assert.equal(
    trafficMotionConflicts(
      turningBusStart,
      evasive.end,
      outerCornerCar,
      0.08,
    ),
    false,
    'a blocked tail swing can make a bounded lateral-only escape',
  );
});

test('sequential traffic transactions close rollback chains to a safe fixed state', () => {
  const body = (key, z) => ({
    key,
    x: 0,
    z,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 5,
  });
  // Deliberately provide reverse array order. C's proposal is blocked by the
  // fixed body; A must then see C's restored start, and B must see A's restored
  // start. A fixed two-pass iterator left B stacked on A in this exact chain.
  const starts = [
    body('car:2', -5),
    body('car:1', -2.5),
    body('car:0', 0),
  ];
  const ends = [
    body('car:2', -2.5),
    body('car:1', 0),
    body('car:0', 2.5),
  ];
  const fixed = [{
    ...body('parked:blocker', 2.5),
    speed: 0,
    priority: true,
    immovable: true,
  }];
  assert.deepEqual(
    [...resolveTrafficMotionTransactions(starts, ends, fixed)],
    [1, 1, 1],
  );
});

test('synchronized turning bodies cannot cross between clear endpoints', () => {
  const carAStart = {
    key: 'car:z',
    x: 0,
    z: 0,
    fx: -0.34266545057553005,
    fz: 0.9394574971662469,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 4.235201541334391,
  };
  const carAEnd = {
    ...carAStart,
    x: -0.4516084939185256,
    z: 0.6739295542400623,
    fx: -0.7965235114083169,
    fz: 0.6046075551742344,
  };
  const carBStart = {
    key: 'car:a',
    x: 4.2367981195922075,
    z: -0.032770313418475826,
    fx: 0.9612843804411594,
    fz: 0.2755582332645067,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 3.2062693550251424,
  };
  const carBEnd = {
    ...carBStart,
    x: 4.306226918867602,
    z: 0.036170600615641986,
    fx: 0.36809109927518224,
    fz: 0.9297897303339008,
  };
  assert.equal(
    trafficFootprintsOverlap(carAStart, carBStart, 0.12),
    false,
  );
  assert.equal(
    trafficFootprintsOverlap(carAEnd, carBEnd, 0.12),
    false,
  );
  assert.equal(
    trafficPairMotionsConflict(
      carAStart,
      carAEnd,
      carBStart,
      carBEnd,
      0.12,
    ),
    true,
  );
  assert.ok(
    [...resolveTrafficMotionTransactions(
      [carAStart, carBStart],
      [carAEnd, carBEnd],
      [],
    )].some(Boolean),
    'one synchronized car proposal must yield',
  );

  const busAStart = {
    key: 'bus:a',
    x: 0,
    z: 0,
    fx: 0.9857607807896446,
    fz: 0.16815374826922602,
    halfLength: 6.1,
    halfWidth: 1.35,
    speed: 5,
    priority: true,
  };
  const busAEnd = {
    ...busAStart,
    x: 1.464848027543334,
    z: 0.9467898738526568,
    fx: 0.9199481553475183,
    fz: 0.392040038099042,
  };
  const busBStart = {
    key: 'bus:b',
    x: -5.062957670614499,
    z: -9.432095378900291,
    fx: -0.08841928973250265,
    fz: -0.9960833445064724,
    halfLength: 6.1,
    halfWidth: 1.35,
    speed: 5,
    priority: true,
  };
  const busBEnd = {
    ...busBStart,
    x: -5.366389722772262,
    z: -8.382450772234545,
    fx: 0.30083779728563653,
    fz: -0.9536753219646225,
  };
  assert.equal(
    trafficPairMotionsConflict(
      busAStart,
      busAEnd,
      busBStart,
      busBEnd,
      0.08,
    ),
    true,
    'synchronized bus turns cannot pass through one another',
  );
});

test('rotating traffic sweeps inflate samples enough to catch thin pedestrians', () => {
  const start = {
    key: 'car:rotating',
    x: 1.2577549918,
    z: 1.5719351005,
    fx: -0.8524800276,
    fz: 0.5227597944,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 4,
  };
  const end = {
    ...start,
    x: 1.2527256879,
    z: 1.6161071987,
    fx: -0.9166398457,
    fz: 0.3997141394,
  };
  const pedestrian = {
    key: 'ped:thin',
    x: -1.6572145205,
    z: 2.0414264401,
    fx: 1,
    fz: 0,
    halfLength: 0.31,
    halfWidth: 0.31,
    speed: 0,
    priority: true,
  };
  assert.equal(
    trafficMotionConflicts(start, end, pedestrian, 0.12),
    true,
  );
});

test('rotating traffic sweeps preserve valid bend-away clearance', () => {
  const start = {
    key: 'car:bend-away',
    x: 0,
    z: 0,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 3,
  };
  const end = {
    ...start,
    z: -0.5,
    fx: Math.cos(-0.12),
    fz: Math.sin(-0.12),
  };
  const parked = {
    key: 'parked:nearby',
    x: 0,
    z: 2.18,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 0,
    priority: true,
    immovable: true,
  };
  assert.equal(trafficFootprintsOverlap(start, parked, 0.18), false);
  assert.equal(trafficFootprintsOverlap(end, parked, 0.18), false);
  assert.equal(
    trafficMotionConflicts(start, end, parked, 0.18),
    false,
    'conservative rotation inflation must not permanently block a safe turn away',
  );
});

test('bus, pedestrian, and car motion snapshots close cross-system sweeps', () => {
  const carStart = {
    key: 'car',
    x: 0,
    z: 0,
    fx: 0.6625088263903288,
    fz: 0.7490541068273434,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 3.731988565530628,
  };
  const carEnd = {
    ...carStart,
    x: 0.4662167097764804,
    z: 0.17397565303003526,
    fx: 0.9814248637284945,
    fz: -0.1918469099451591,
  };
  const pedestrianStart = {
    key: 'ped',
    x: -2.6285226326435804,
    z: 0.2534427270293236,
    fx: 1,
    fz: 0,
    halfLength: 0.31,
    halfWidth: 0.31,
    speed: 1.6144840238150209,
    priority: true,
  };
  const pedestrianEnd = {
    ...pedestrianStart,
    x: -2.8435189073651075,
    z: 0.3152184260359938,
  };
  assert.equal(
    trafficPairMotionsConflict(
      carStart,
      carEnd,
      pedestrianStart,
      pedestrianEnd,
      0.18,
    ),
    true,
  );
  assert.deepEqual(
    [...resolveTrafficMotionTransactions(
      [carStart],
      [carEnd],
      [],
      [{ start: pedestrianStart, end: pedestrianEnd }],
    )],
    [1],
    'a car must see the pedestrian motion committed earlier in StreetLife',
  );

  const busStart = {
    key: 'bus',
    x: 0,
    z: 0,
    fx: -0.8131617172,
    fz: 0.5820378181,
    halfLength: 6.1,
    halfWidth: 1.35,
    speed: 3.5,
    priority: true,
  };
  const busEnd = {
    ...busStart,
    x: 0.8298605301,
    z: -0.4639230007,
    fx: -0.6519318627,
    fz: 0.7582775524,
  };
  const walkerStart = {
    key: 'ped:bus',
    x: -2.4621019403,
    z: 5.6154716141,
    fx: 1,
    fz: 0,
    halfLength: 0.31,
    halfWidth: 0.31,
    speed: 1.4,
    priority: true,
  };
  const walkerEnd = {
    ...walkerStart,
    x: -2.6540197829,
    z: 5.1361153054,
  };
  assert.equal(
    trafficPairMotionsConflict(
      walkerStart,
      walkerEnd,
      busStart,
      busEnd,
      0.08,
    ),
    true,
    'a pedestrian must see the bus motion already committed this frame',
  );
});

test('pedestrian progress, lanes and sweeps prevent walker phasing', () => {
  const upperBounce = advancePedestrianProgress(9.8, 1, 0.4, 10);
  assert.equal(upperBounce.direction, -1);
  assert.ok(Math.abs(upperBounce.distance - 9.8) < 1e-9);
  const lowerBounce = advancePedestrianProgress(0.1, -1, 0.4, 10);
  assert.equal(lowerBounce.direction, 1);
  assert.ok(Math.abs(lowerBounce.distance - 0.3) < 1e-9);
  assert.equal(pedestrianLaneOffset(1, 1), 0.39);
  assert.equal(pedestrianLaneOffset(-1, 1), -0.39);
  assert.equal(pedestrianLaneOffset(1, -1), -0.39);
  assert.equal(
    pedestrianSweepsOverlap(
      -0.5, 0, 0.5, 0, 0.31,
      0.5, 0, -0.5, 0, 0.31,
      0.08,
    ),
    true,
    'walkers cannot swap positions through one another',
  );
  assert.equal(
    pedestrianSweepsOverlap(
      -0.5, -0.39, 0.5, -0.39, 0.31 * 1.06,
      0.5, 0.39, -0.5, 0.39, 0.31 * 1.06,
      0.08,
    ),
    false,
    'opposite keep-right lanes retain passing clearance',
  );
});

test('pedestrian, car and bus footprints share exact contact geometry', () => {
  const bus = {
    key: 'bus:1',
    x: 0,
    z: 0,
    fx: 1,
    fz: 0,
    halfLength: 6.1,
    halfWidth: 1.35,
    speed: 0,
    priority: true,
  };
  assert.equal(pedestrianTrafficOverlap(0, 1.5, 0.31, bus, 0.08), true);
  assert.equal(pedestrianTrafficOverlap(0, 1.8, 0.31, bus, 0.08), false);
  assert.equal(
    pedestrianStepHitsTraffic(-7, 0, -5.5, 0, 0.31, [bus], 0.08),
    true,
    'a pedestrian step cannot enter a bus body',
  );
  assert.equal(
    pedestrianStepHitsTraffic(
      -2.7772550516,
      0.6708976096,
      -2.6202347097,
      1.1244314018,
      0.2852,
      [{
        key: 'car:corner',
        x: 0,
        z: 0,
        fx: 1,
        fz: 0,
        halfLength: 2.3,
        halfWidth: 0.94,
        speed: 0,
      }],
      0.08,
    ),
    true,
    'a short diagonal step cannot tunnel through a rounded vehicle corner',
  );
  const pedestrian = {
    key: 'ped:1',
    x: 8,
    z: 0,
    fx: 0,
    fz: 1,
    halfLength: 0.31,
    halfWidth: 0.31,
    speed: 1.2,
    priority: true,
  };
  assert.ok(trafficForwardClearance(bus, pedestrian, 0.25) > 1);
  pedestrian.z = 3;
  assert.equal(
    trafficForwardClearance(bus, pedestrian, 0.25),
    null,
    'a body outside the lane does not stop traffic',
  );
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
