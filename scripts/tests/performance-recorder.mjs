import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import {
  PerformanceRecorder,
  estimateSceneResources,
  estimateShadowDrawCalls,
} from '../../src/engine/performance/PerformanceRecorder.ts';
import {
  GOLDEN_ROUTES,
  goldenRouteIds,
} from '../../src/engine/performance/goldenRoutes.ts';

function rendererWith({ calls, triangles }) {
  return {
    info: {
      render: { calls, triangles, points: 0, lines: 0 },
    },
  };
}

test('performance recorder reports frame, GPU, draw and one-percent-low percentiles', () => {
  const recorder = new PerformanceRecorder(100);
  recorder.reset('golden route');
  for (let i = 0; i < 100; i++) {
    recorder.sample(
      rendererWith({ calls: 300 + i, triangles: 500_000 + i * 1000 }),
      i === 99 ? 50 : 16,
      5 + i / 100,
      2 + i / 200,
      3 + i / 200,
      8 + i / 100,
      i / 200,
      24,
    );
  }
  const report = recorder.report();
  assert.equal(report.label, 'golden route');
  assert.equal(report.samples, 100);
  assert.ok(report.frameMs.p50 >= 16 && report.frameMs.p50 < 17);
  assert.ok(report.frameMs.p99 > 16 && report.frameMs.p99 < 50);
  assert.ok(report.fps.onePercentLow < report.fps.median);
  assert.equal(report.drawCalls.max, 399);
  assert.equal(report.shadowCalls.max, 24);
  assert.equal(report.gpuMs.availableSamples, 100);
  assert.ok(report.cpuBreakdown.update.p95 < report.cpuBreakdown.render.p95);
});

test('temporary benchmark capacity retains a complete 36 second arrival capture at 120 and 240Hz', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const hz of [120, 240]) {
    const recorder = new PerformanceRecorder();
    recorder.setCapacity(12_000);
    recorder.reset(`station at ${hz}Hz`);
    for (let i = 0; i < 36 * hz; i++) {
      now += 1000 / hz;
      recorder.sample(rendererWith({ calls: i === 9 * hz ? 1500 : 200, triangles: 500_000 }), 1000 / hz, 5, 2, 3, null, 0, 0);
    }
    const complete = recorder.report();
    assert.equal(complete.samples, 36 * hz);
    assert.ok(Math.abs(complete.durationSeconds - 36) < 1e-7);
    assert.equal(complete.drawCalls.max, 1500, 'the early arrival cannot fall out of the captured report');

    recorder.setCapacity(1200);
    const rolling = recorder.report();
    assert.equal(rolling.samples, 1200);
    assert.ok(Math.abs(rolling.durationSeconds - 1200 / hz) < 1e-7);
    assert.equal(rolling.drawCalls.max, 200, 'lowering capacity retains only the newest frames');
    now += 1000 / hz;
    recorder.sample(rendererWith({ calls: 210, triangles: 500_000 }), 1000 / hz, 5, 2, 3, null, 0, 0);
    assert.equal(recorder.report().samples, 1200, 'normal runtime recording remains bounded after the benchmark');
    assert.ok(Math.abs(recorder.report().durationSeconds - 1200 / hz) < 1e-7);
  }
});

test('capture capacity restores the constructor bound and rejects unbounded or invalid requests', () => {
  const recorder = new PerformanceRecorder(100);
  recorder.setCapacity(300);
  for (let i = 0; i < 200; i++) recorder.sample(rendererWith({ calls: 1, triangles: 1 }), 10, 1, 1, 0, null, 0, 0);
  assert.equal(recorder.report().samples, 200);
  recorder.setCapacity();
  assert.equal(recorder.report().samples, 100);
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 12_001]) assert.throws(() => recorder.setCapacity(capacity), RangeError);
  recorder.sample(rendererWith({ calls: 2, triangles: 1 }), 10, 1, 1, 0, null, 0, 0);
  assert.equal(recorder.report().samples, 100);
});

test('resource and shadow estimates deduplicate shared GPU resources', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const texture = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
  texture.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const first = new THREE.Mesh(geometry, material);
  const second = new THREE.Mesh(geometry, material);
  first.castShadow = true;
  second.castShadow = true;
  scene.add(first, second);

  const estimate = estimateSceneResources(scene);
  assert.equal(estimate.geometries, 1);
  assert.equal(estimate.materials, 1);
  assert.equal(estimate.textures, 1);
  assert.ok(estimate.geometryBytes > 0);
  assert.equal(estimate.textureBytes, 64);
  assert.equal(estimateShadowDrawCalls(scene), 0, 'dormant caster flags are not submissions');
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  scene.add(sun);
  assert.equal(estimateShadowDrawCalls(scene), 2);

  scene.visible = false;
  assert.equal(estimateShadowDrawCalls(scene), 0);
  geometry.dispose();
  texture.dispose();
  material.dispose();
});

test('golden routes cover dense street, park, waterfront, occupied station and moving train scenes', () => {
  assert.deepEqual(
    goldenRouteIds().sort(),
    ['central-park', 'subway-ride', 'times-square', 'times-square-station', 'waterfront'],
  );
  for (const route of Object.values(GOLDEN_ROUTES)) {
    if (route.kind === 'street') {
      assert.ok(route.points.length >= 4);
      for (const point of route.points) {
        assert.ok(point.lat > 40.69 && point.lat < 40.89);
        assert.ok(point.lon > -74.03 && point.lon < -73.90);
        assert.ok(point.seconds >= 3);
      }
    } else {
      assert.ok(route.seconds >= 30, 'transit capture includes an arrival and passenger exchange');
      const subway = JSON.parse(readFileSync(
        new URL('../../public/subway/subway.json', import.meta.url),
        'utf8',
      ));
      const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
      assert.ok(
        subway.stations.some((station) => (
          normalize(station.name).includes(normalize(route.stationSearch))
        )),
        `station route must resolve against subway.json: ${route.stationSearch}`,
      );
    }
  }
});

test('paused surface queues do not drive underground quality pressure and resume on the street', async () => {
  const { activeStreamingPressure } = await import('../../src/engine/performance/TileStreamingTelemetry.ts');
  for (const mode of ['station', 'ride']) assert.equal(activeStreamingPressure(mode, 33, 3), 0);
  for (const mode of ['street', 'bus']) {
    assert.equal(activeStreamingPressure(mode, 33, 3), 1);
    assert.equal(activeStreamingPressure(mode, 3, 3), 1 / 3);
    assert.equal(activeStreamingPressure(mode, 0, 3), 0);
  }
});
