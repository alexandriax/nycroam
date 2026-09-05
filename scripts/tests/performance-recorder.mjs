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
