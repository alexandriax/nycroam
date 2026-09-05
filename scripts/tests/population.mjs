import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';
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
  findStalledTrafficEscape,
  resolveTrafficMotionTransactions,
  trafficFootprintsOverlap,
  trafficForwardClearance,
  trafficLateralEscape,
  trafficMotionConflicts,
  trafficMotionClearsObstacles,
  trafficPairMotionsConflict,
  trafficPairKey,
  trafficSweptConflict,
  yieldsTo,
} from '../../src/engine/population/trafficSafety.ts';
import {
  BUS_DEADLOCK_RETIRE_AFTER,
  BUS_HEADWAY_RANGE,
  BUS_MAX_SLOTS_PER_DIRECTION,
  BUS_TERMINAL_LAYOVER,
  breakBusLeaderCycles,
  busDeadlockEscapeReady,
  busHeadwaySeconds,
  busMeshCap,
  busRecoveryWins,
  busScheduleDensity,
  busYieldsAtConflict,
} from '../../src/engine/bus/flow.ts';
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      if (specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      if (/^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { BusSystem } = await import('../../src/engine/bus/BusSystem.ts');

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

test('bus service headways reduce bunching and crossing priority cannot cycle', () => {
  for (let route = 0; route < 54; route++) {
    for (let direction = 0; direction < 2; direction++) {
      const sbs = route % 5 === 0;
      const headway = busHeadwaySeconds(route, direction, sbs);
      const range = sbs ? BUS_HEADWAY_RANGE.sbs : BUS_HEADWAY_RANGE.local;
      assert.ok(headway >= range.min);
      assert.ok(headway < range.max);
    }
  }
  assert.ok(BUS_HEADWAY_RANGE.sbs.min > 90);
  assert.ok(BUS_HEADWAY_RANGE.local.min > BUS_HEADWAY_RANGE.sbs.min);
  const longest = busScheduleDensity(3600, 4, 1, false);
  assert.equal(longest.slots, BUS_MAX_SLOTS_PER_DIRECTION);
  assert.equal(longest.headway, 363);
  assert.equal(longest.cycle, 3630);
  assert.ok(longest.cycle - 3600 >= BUS_TERMINAL_LAYOVER);
  for (let runSeconds = 30; runSeconds <= 5400; runSeconds += 17) {
    const schedule = busScheduleDensity(
      runSeconds,
      runSeconds % 54,
      runSeconds % 2,
      runSeconds % 5 === 0,
    );
    assert.ok(schedule.slots <= BUS_MAX_SLOTS_PER_DIRECTION);
    assert.ok(
      schedule.cycle - runSeconds >= BUS_TERMINAL_LAYOVER - 1e-9,
      `run ${runSeconds}s retains a terminal recovery window`,
    );
  }
  assert.deepEqual(
    ['low', 'medium', 'high', 'ultra'].map(busMeshCap),
    [12, 16, 24, 32],
  );

  const cluster = [
    { keyNum: 9, renderSpeed: 0 },
    { keyNum: 4, renderSpeed: 0 },
    { keyNum: 7, renderSpeed: 0 },
    { keyNum: 2, renderSpeed: 0 },
  ];
  const winners = cluster.filter((candidate) => (
    cluster.every((other) => (
      other === candidate || !busYieldsAtConflict(candidate, other)
    ))
  ));
  assert.deepEqual(winners.map(({ keyNum }) => keyNum), [2]);
  assert.equal(
    busYieldsAtConflict(
      { keyNum: 1, renderSpeed: 0 },
      { keyNum: 99, renderSpeed: 2 },
    ),
    true,
    'a stopped bus lets one already clearing the junction continue',
  );
  assert.equal(busDeadlockEscapeReady(3.99), false);
  assert.equal(busDeadlockEscapeReady(4), true);
  assert.ok(BUS_DEADLOCK_RETIRE_AFTER >= 30);
  const recoverers = cluster.filter((candidate) => (
    cluster.every((other) => (
      other === candidate || busRecoveryWins(
        { ...candidate, ridden: false },
        { ...other, ridden: false },
      )
    ))
  ));
  assert.deepEqual(recoverers.map(({ keyNum }) => keyNum), [2]);
  assert.equal(
    busRecoveryWins(
      { keyNum: 99, ridden: true },
      { keyNum: 1, ridden: false },
    ),
    true,
  );
  assert.equal(
    busRecoveryWins(
      { keyNum: 99, ridden: false },
      { keyNum: 1, ridden: false },
    ),
    false,
  );

  const leaders = Int32Array.from([1, 2, 0, 2]);
  breakBusLeaderCycles(leaders, [8, 3, 6, 10]);
  assert.deepEqual(
    [...leaders],
    [1, -1, 0, 2],
    'the lowest-key member clears a curved-lane cycle first',
  );
});

test('a stalled bus can make an exact-sweep lane escape around another bus', () => {
  const start = {
    key: 'bus:waiting',
    x: 0,
    z: 0,
    fx: 1,
    fz: 0,
    halfLength: 6.1,
    halfWidth: 1.3,
    speed: 0,
    priority: true,
  };
  const proposed = { ...start, x: 1, speed: 1 };
  const blocker = {
    ...start,
    key: 'bus:blocker',
    x: 12.5,
    z: 0.4,
  };
  assert.equal(
    findTrafficLateralEscape(start, proposed, [blocker], 4, 0.08),
    null,
    'normal parked-vehicle escape does not treat transit as static geometry',
  );
  const escape = findStalledTrafficEscape(
    start,
    proposed,
    [blocker],
    4,
    0.08,
  );
  assert.ok(escape);
  assert.notEqual(escape.shiftZ, 0);
  assert.equal(
    trafficMotionConflicts(start, escape.end, blocker, 0.08),
    false,
    'the deadlock escape remains continuously collision-free',
  );
  assert.equal(
    findStalledTrafficEscape(
      start,
      proposed,
      [blocker],
      4,
      0.08,
      -1,
      false,
      0.08,
      () => false,
    ),
    null,
    'a non-owner cannot start a competing bus-to-bus recovery',
  );
  const crossingStart = {
    ...start,
    key: 'bus:crossing',
    x: 0,
    z: -15,
    fx: 0,
    fz: 1,
    speed: 4,
  };
  const crossingEnd = { ...crossingStart, z: 15 };
  assert.equal(trafficFootprintsOverlap(start, crossingStart, 0.08), false);
  assert.equal(trafficFootprintsOverlap(escape.end, crossingEnd, 0.08), false);
  assert.equal(
    trafficMotionClearsObstacles(
      start,
      escape.end,
      [],
      [{ start: crossingStart, end: crossingEnd }],
      0.08,
    ),
    false,
    'a lateral recovery is rejected when it crosses another accepted bus sweep',
  );
});

test('restoring a mid-route bus seeds committed motion without an origin teleport', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    setDoors() {},
    setSpeed() {},
    setNextStop() {},
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(
    scene,
    makeModel,
    () => new THREE.Group(),
  );
  system.build({
    v: 1,
    routes: [{
      id: 'T',
      name: 'Test',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 2000, 0],
        stops: [{ id: 'a', s: 0 }, { id: 'b', s: 2000 }],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['T'] },
      b: { n: 'B', p: [2000, 3], r: ['T'] },
    },
  });
  const ride = system.restoreRide('T', 0, 0, 50);
  assert.ok(ride);
  const before = { ...ride.pos };
  assert.ok(before.x > 100, 'fixture restores well beyond the route origin');
  system.update(before.x, before.z, 0.016);
  const moved = Math.hypot(
    ride.pos.x - before.x,
    ride.pos.z - before.z,
  );
  assert.ok(moved <= 20 * 0.016 + 1e-6);

  const laneZ = ride.pos.z;
  const heldStartX = ride.pos.x;
  const stoppedCar = {
    key: 'car:stalled',
    x: ride.pos.x + 6.1 + 2.3 + 0.35,
    z: laneZ,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 0,
  };
  for (let frame = 0; frame < 100; frame++) {
    system.update(ride.pos.x, ride.pos.z, 0.1, [stoppedCar]);
  }
  assert.ok(
    Math.abs(ride.pos.z - laneZ) > 0.05,
    'sustained no-progress behind a stopped car enters a lateral escape',
  );
  assert.ok(
    ride.pos.x > heldStartX + 0.5,
    'the persistent escape clears enough lane width for route progress to resume',
  );
  assert.equal(
    trafficFootprintsOverlap({
      key: 'bus:test',
      x: ride.pos.x,
      z: ride.pos.z,
      fx: Math.cos(ride.pos.yaw),
      fz: -Math.sin(ride.pos.yaw),
      halfLength: 6.1,
      halfWidth: 1.3,
      speed: 0,
    }, stoppedCar, 0.08),
    false,
  );
  for (let frame = 0; frame < 300; frame++) {
    system.update(ride.pos.x, ride.pos.z, 0.1, [stoppedCar]);
  }
  assert.ok(
    ride.pos.x
      > stoppedCar.x + 6.1 + Math.hypot(
        stoppedCar.halfLength,
        stoppedCar.halfWidth,
      ) + 0.6,
    'the bus tail clears the remembered blocker within a bounded recovery',
  );
  assert.ok(
    Math.abs(ride.pos.z - laneZ) < 0.6,
    'the bus returns to its authored lane after completing the pass',
  );

  const departingCar = {
    ...stoppedCar,
    key: 'car:departing',
    x: ride.pos.x + 6.1 + 2.3 + 0.35,
  };
  for (let frame = 0; frame < 100; frame++) {
    system.update(ride.pos.x, ride.pos.z, 0.1, [departingCar]);
  }
  assert.ok(
    Math.abs(ride.pos.z - laneZ) > 0.05,
    'a second stopped blocker establishes a recovery pass',
  );
  departingCar.speed = 20;
  for (let frame = 0; frame < 200; frame++) {
    departingCar.x += departingCar.speed * 0.1;
    system.update(ride.pos.x, ride.pos.z, 0.1, [departingCar]);
  }
  assert.ok(
    Math.abs(ride.pos.z - laneZ) < 0.6,
    'a blocker that pulls safely ahead releases the bus back to lane',
  );

  ride.end();
  const stale = system.meshed.values().next().value;
  stale.finishing = true;
  system.worldTime = 1 - stale.dir.routePhase + stale.k * stale.dir.H;
  assert.equal(
    system.boardable(stale.model.group.position.x, stale.model.group.position.z),
    null,
    'a delayed finisher cannot advertise the next schedule generation',
  );
  assert.equal(
    system.board(stale.key),
    null,
    'a delayed finisher cannot be re-boarded after its timetable wraps',
  );
  stale.finishing = false;
  stale.init = false;
  stale.model.group.visible = false;
  system.worldTime = 1 - stale.dir.routePhase + stale.k * stale.dir.H;
  system.externalTrafficObstacles = [{
    key: 'car:occupied-berth',
    x: 0,
    z: 0,
    fx: 1,
    fz: 0,
    halfLength: 50,
    halfWidth: 50,
    speed: 0,
    immovable: true,
  }];
  assert.equal(
    system.boardable(0, 0),
    null,
    'a hidden, uninitialized bus is never advertised as boardable',
  );
  assert.equal(
    system.board(stale.key),
    null,
    'boarding cannot materialize a bus inside an occupied berth',
  );
  assert.equal(stale.init, false);
  assert.equal(stale.model.group.visible, false);
  system.dispose();
});

test('a sealed automated recovery retires once and suppresses its timetable slot', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    setDoors() {},
    setSpeed() {},
    setNextStop() {},
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(
    scene,
    makeModel,
    () => new THREE.Group(),
  );
  system.build({
    v: 1,
    routes: [{
      id: 'S',
      name: 'Sealed',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 2000, 0],
        stops: [{ id: 'a', s: 0 }, { id: 'b', s: 2000 }],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['S'] },
      b: { n: 'B', p: [2000, 3], r: ['S'] },
    },
  });
  const ride = system.restoreRide('S', 0, 0, 50);
  assert.ok(ride);
  const key = system.rideShare
    ? `0:${system.rideShare.dirIdx}:${system.rideShare.k}`
    : '';
  ride.end();
  system.update(ride.pos.x, ride.pos.z, 0.1);
  const laneZ = ride.pos.z;
  const stoppedCar = {
    key: 'car:sealed-leader',
    x: ride.pos.x + 6.1 + 2.3 + 0.35,
    z: laneZ,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 0.94,
    speed: 0,
  };
  for (let frame = 0; frame < 100; frame++) {
    system.update(ride.pos.x, ride.pos.z, 0.1, [stoppedCar]);
  }
  const trapped = system.meshed.get(key);
  assert.ok(trapped);

  const sealedWall = {
    key: 'parked:sealed-corridor',
    x: trapped.model.group.position.x + 8.5,
    z: laneZ - 2.2,
    fx: 1,
    fz: 0,
    halfLength: 2.3,
    halfWidth: 8,
    speed: 0,
    immovable: true,
  };
  for (let frame = 0; frame < 500; frame++) {
    system.update(
      trapped.model.group.position.x,
      trapped.model.group.position.z,
      0.1,
      [stoppedCar, sealedWall],
    );
  }
  assert.equal(
    system.meshed.has(key),
    false,
    'the automated loser cannot occupy a sealed junction indefinitely',
  );
  assert.ok(
    (system.suppressedUntil.get(key) ?? 0) > system.worldTime,
    'the retired timetable slot cannot immediately respawn',
  );
  system.dispose();
});

test('a delayed rider stays pinned and off-lane buses keep their doors closed', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    doorValue: 0,
    nextStop: null,
    setDoors(value) { this.doorValue = value; },
    setSpeed() {},
    setNextStop(value) { this.nextStop = value; },
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(
    scene,
    makeModel,
    () => new THREE.Group(),
  );
  system.build({
    v: 1,
    routes: [{
      id: 'R',
      name: 'Rider',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 2000, 0],
        stops: [{ id: 'a', s: 0 }, { id: 'b', s: 2000 }],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['R'] },
      b: { n: 'B', p: [2000, 3], r: ['R'] },
    },
  });
  const ride = system.restoreRide('R', 0, 0, 2);
  assert.ok(ride);
  const bus = ride.mb;
  bus.sepX = 2;
  bus.escapeSide = -1;
  bus.escapeBlockerKey = 'car:departed';
  bus.blockedFor = 4;
  system.update(ride.pos.x, ride.pos.z, 0.01);
  assert.equal(ride.model.doorValue, 0);
  assert.equal(ride.canExit, false);
  assert.equal(
    system.boardable(ride.pos.x, ride.pos.z),
    null,
    'a laterally displaced dwell cannot board from an adjacent lane',
  );

  bus.sepX = 0;
  bus.sepZ = 0;
  for (const other of [...system.meshed.values()]) {
    if (other !== bus) system.removeMeshed(other);
  }
  system.busTimer = Number.POSITIVE_INFINITY;
  system.worldTime = bus.runDeadline + 0.1;
  system.update(ride.pos.x, ride.pos.z, 0.1);
  assert.equal(bus.finishing, true);
  assert.equal(ride.active, true);
  assert.equal(
    ride.canExit,
    true,
    'returning to the missed origin berth reopens service before departure',
  );
  assert.equal(ride.atEnd, false);
  assert.ok(
    bus.rs < bus.dir.segSEnd[bus.dir.nSeg - 1] - 100,
    'fixture remains physically far from the terminal',
  );
  assert.equal(system.meshed.has(bus.key), true);
  assert.ok(system.rideShare.tau >= bus.dir.T - 2);
  for (let frame = 0; frame < 1200; frame++) {
    system.update(ride.pos.x, ride.pos.z, 0.1);
  }
  assert.ok(bus.rs >= bus.dir.segSEnd[bus.dir.nSeg - 1] - 2);
  assert.equal(ride.canExit, true);
  assert.equal(ride.model.doorValue, 1);
  const terminalKey = bus.key;
  ride.end();
  assert.equal(ride.active, false);
  system.update(bus.model.group.position.x, bus.model.group.position.z, 0.1);
  assert.equal(
    system.meshed.has(terminalKey),
    false,
    'unpinning releases the infinite ridden-terminal dwell',
  );
  system.dispose();
});

test('a rejected berth proposal cannot open doors or consume a carried dwell', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    doorValue: 0,
    nextStop: null,
    setDoors(value) { this.doorValue = value; },
    setSpeed() {},
    setNextStop(value) { this.nextStop = value; },
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(scene, makeModel, () => new THREE.Group());
  system.build({
    v: 1,
    routes: [{
      id: 'B',
      name: 'Berth',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 500, 0],
        stops: [
          { id: 'a', s: 0 },
          { id: 'b', s: 250 },
          { id: 'c', s: 500 },
        ],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['B'] },
      b: { n: 'B', p: [250, 3], r: ['B'] },
      c: { n: 'C', p: [500, 3], r: ['B'] },
    },
  });
  const ride = system.restoreRide('B', 0, 0, 2);
  assert.ok(ride);
  const bus = ride.mb;
  ride.end();
  for (const other of [...system.meshed.values()]) {
    if (other !== bus) system.removeMeshed(other);
  }
  system.busTimer = Number.POSITIVE_INFINITY;
  const berthS = bus.dir.parkS[1];
  bus.init = true;
  bus.rs = berthS - 1.9;
  bus.lastRS = bus.rs;
  bus.sfx = 1;
  bus.sfz = 0;
  bus.yaw = 0;
  bus.sepX = 0;
  bus.sepZ = 0;
  bus.nextPhysicalStopIdx = 1;
  bus.physicalDwellRemaining = -1;
  bus.physicalLat = 3;
  bus.model.group.position.set(bus.rs, 0, 3);
  bus.model.group.visible = true;
  bus.runDeadline = system.worldTime;
  const pedestrian = {
    key: 'ped:berth-edge',
    x: bus.rs + 7.1,
    z: 3,
    fx: 0,
    fz: 1,
    halfLength: 0.31,
    halfWidth: 0.31,
    speed: 0,
    priority: true,
  };
  system.update(bus.model.group.position.x, 3, 0.1, [pedestrian]);
  assert.equal(
    bus.physicalDwellRemaining,
    -1,
    'a rejected body motion rolls back the proposed dwell timer',
  );
  assert.equal(bus.serviceDwell, false);
  assert.equal(bus.serviceStopIdx, -1);
  assert.equal(bus.model.doorValue, 0);

  let servedIntermediate = false;
  let openFrames = 0;
  for (let frame = 0; frame < 250; frame++) {
    system.update(bus.model.group.position.x, 3, 0.1);
    if (bus.serviceStopIdx === 1) {
      servedIntermediate = true;
      if (bus.serviceDoorT > 0.6) openFrames++;
      assert.ok(
        Math.abs(bus.model.group.position.x + 4.1 - 250) < 2.1,
        'the physical front door serves the authored stop pole',
      );
    } else if (servedIntermediate) {
      break;
    }
  }
  assert.equal(servedIntermediate, true);
  assert.ok(
    openFrames >= 80,
    `the delayed stop retains a real dwell (observed ${openFrames} open frames)`,
  );
  system.dispose();
});

test('streaming just before a berth cannot mark that stop served by proximity', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    setDoors() {},
    setSpeed() {},
    setNextStop() {},
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(scene, makeModel, () => new THREE.Group());
  system.build({
    v: 1,
    routes: [{
      id: 'P',
      name: 'Proximity',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 500, 0],
        stops: [
          { id: 'a', s: 0 },
          { id: 'b', s: 250 },
          { id: 'c', s: 500 },
        ],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['P'] },
      b: { n: 'B', p: [250, 3], r: ['P'] },
      c: { n: 'C', p: [500, 3], r: ['P'] },
    },
  });
  const ride = system.restoreRide('P', 0, 0, 34.4556);
  assert.ok(ride);
  const bus = ride.mb;
  assert.equal(bus.nextPhysicalStopIdx, 1);
  assert.ok(bus.rs < bus.dir.parkS[1]);
  ride.end();
  for (const other of [...system.meshed.values()]) {
    if (other !== bus) system.removeMeshed(other);
  }
  system.busTimer = Number.POSITIVE_INFINITY;
  const wall = {
    key: 'parked:berth-hold',
    x: bus.model.group.position.x + 7.1,
    z: bus.model.group.position.z,
    fx: 1,
    fz: 0,
    halfLength: 0.31,
    halfWidth: 8,
    speed: 0,
    immovable: true,
  };
  for (let frame = 0; frame < 150; frame++) {
    system.update(bus.model.group.position.x, bus.model.group.position.z, 0.1, [wall]);
  }
  let served = false;
  for (let frame = 0; frame < 250; frame++) {
    system.update(bus.model.group.position.x, bus.model.group.position.z, 0.1);
    if (bus.serviceStopIdx === 1) served = true;
    if (served && bus.nextPhysicalStopIdx > 1) break;
  }
  assert.equal(
    served,
    true,
    'the delayed bus carries a full physical service at the nearly-reached stop',
  );
  system.dispose();
});

test('a delayed bus cannot expose a later timetable stop at an earlier berth', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    doorValue: 0,
    nextStop: null,
    setDoors(value) { this.doorValue = value; },
    setSpeed() {},
    setNextStop(value) { this.nextStop = value; },
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(scene, makeModel, () => new THREE.Group());
  system.build({
    v: 1,
    routes: [{
      id: 'D',
      name: 'Delayed',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 500, 0],
        stops: [
          { id: 'a', s: 0 },
          { id: 'b', s: 250 },
          { id: 'c', s: 500 },
        ],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['D'] },
      b: { n: 'B', p: [250, 3], r: ['D'] },
      c: { n: 'C', p: [500, 3], r: ['D'] },
    },
  });
  const ride = system.restoreRide('D', 0, 0, Number.POSITIVE_INFINITY);
  assert.ok(ride);
  const bus = ride.mb;
  for (const other of [...system.meshed.values()]) {
    if (other !== bus) system.removeMeshed(other);
  }
  system.busTimer = Number.POSITIVE_INFINITY;
  const berthS = bus.dir.parkS[1];
  bus.rs = berthS - 1.9;
  bus.lastRS = bus.rs;
  bus.sfx = 1;
  bus.sfz = 0;
  bus.yaw = 0;
  bus.lat = 3;
  bus.committedLat = 3;
  bus.sepX = 0;
  bus.sepZ = 0;
  bus.nextPhysicalStopIdx = 1;
  bus.physicalDwellRemaining = -1;
  bus.physicalLat = 3;
  bus.model.group.position.set(bus.rs, 0, 3);
  system.update(bus.model.group.position.x, 3, 0.1);
  assert.equal(bus.serviceDwell, false);
  assert.equal(bus.serviceStopIdx, -1);
  assert.equal(bus.model.doorValue, 0);
  assert.equal(ride.canExit, false);
  assert.equal(ride.atEnd, false);
  assert.equal(ride.hud.state, 'moving');
  assert.equal(ride.hud.thisStop, 'B');
  assert.equal(bus.model.nextStop, 'B');

  for (let frame = 0; frame < 30 && bus.serviceStopIdx < 0; frame++) {
    system.update(bus.model.group.position.x, 3, 0.1);
  }
  assert.equal(bus.serviceStopIdx, 1);
  assert.equal(ride.atEnd, false);
  ride.end();
  system.dispose();
});

test('an overdue automated bus serves every remaining stop before removal', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    setDoors() {},
    setSpeed() {},
    setNextStop() {},
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(scene, makeModel, () => new THREE.Group());
  system.build({
    v: 1,
    routes: [{
      id: 'F',
      name: 'Finisher',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 500, 0],
        stops: [
          { id: 'a', s: 0 },
          { id: 'b', s: 250 },
          { id: 'c', s: 500 },
        ],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['F'] },
      b: { n: 'B', p: [250, 3], r: ['F'] },
      c: { n: 'C', p: [500, 3], r: ['F'] },
    },
  });
  const ride = system.restoreRide('F', 0, 0, 2);
  assert.ok(ride);
  const bus = ride.mb;
  const key = bus.key;
  ride.end();
  for (const other of [...system.meshed.values()]) {
    if (other !== bus) system.removeMeshed(other);
  }
  system.busTimer = Number.POSITIVE_INFINITY;
  bus.runDeadline = system.worldTime;
  const served = new Set();
  for (let frame = 0; frame < 900 && system.meshed.has(key); frame++) {
    system.update(bus.model.group.position.x, bus.model.group.position.z, 0.1);
    if (bus.serviceStopIdx >= 0) served.add(bus.serviceStopIdx);
    if (bus.nextPhysicalStopIdx < bus.dir.nStops) {
      assert.equal(
        system.meshed.has(key),
        true,
        'a capped intermediate target cannot masquerade as the final terminal',
      );
    }
  }
  assert.equal(served.has(1), true, 'the overdue run serves its intermediate stop');
  assert.equal(served.has(2), true, 'the overdue run serves its terminal stop');
  assert.equal(system.meshed.has(key), false);
  system.dispose();
});

test('a rider boarding during terminal dwell keeps an exit after timetable expiry', () => {
  const scene = new THREE.Scene();
  const makeModel = () => ({
    group: new THREE.Group(),
    doorValue: 0,
    setDoors(value) { this.doorValue = value; },
    setSpeed() {},
    setNextStop() {},
    setStopRequested() {},
    dispose() {},
  });
  const system = new BusSystem(scene, makeModel, () => new THREE.Group());
  system.build({
    v: 1,
    routes: [{
      id: 'L',
      name: 'Late boarding',
      color: '#2266aa',
      sbs: false,
      dirs: [{
        dest: 'END',
        shape: [0, 0, 500, 0],
        stops: [{ id: 'a', s: 0 }, { id: 'b', s: 500 }],
      }],
    }],
    stops: {
      a: { n: 'A', p: [0, 3], r: ['L'] },
      b: { n: 'B', p: [500, 3], r: ['L'] },
    },
  });
  const ride = system.restoreRide('L', 0, 0, Number.POSITIVE_INFINITY);
  assert.ok(ride);
  const bus = ride.mb;
  for (const other of [...system.meshed.values()]) {
    if (other !== bus) system.removeMeshed(other);
  }
  system.busTimer = Number.POSITIVE_INFINITY;
  system.update(ride.pos.x, ride.pos.z, 0.1);
  assert.equal(ride.canExit, true);
  let previousZ = bus.model.group.position.z;
  let maxLateralStep = 0;
  for (let frame = 0; frame < 60; frame++) {
    system.update(ride.pos.x, ride.pos.z, 0.1);
    maxLateralStep = Math.max(
      maxLateralStep,
      Math.abs(bus.model.group.position.z - previousZ),
    );
    previousZ = bus.model.group.position.z;
  }
  assert.equal(bus.finishing, true);
  assert.equal(ride.active, true);
  assert.equal(ride.atEnd, true);
  assert.equal(ride.canExit, true);
  assert.equal(ride.model.doorValue, 1);
  assert.ok(
    maxLateralStep <= 0.81,
    `terminal deadline transition stays rate-bounded (${maxLateralStep}m)`,
  );
  const key = bus.key;
  ride.end();
  system.update(bus.model.group.position.x, bus.model.group.position.z, 0.1);
  assert.equal(system.meshed.has(key), false);
  system.dispose();
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
