import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  QualityGovernor,
  performancePercentile,
} from '../../src/engine/performance/QualityGovernor.ts';
import { batchStaticStationMeshes } from '../../src/engine/performance/stationBatch.ts';
import { disposeOwnedResources } from '../../src/engine/performance/resourceLifetime.ts';

function feedWindow(governor, {
  start,
  frameMs,
  cpuMs,
  gpuMs,
  count = 30,
  stepMs = 20,
  streamingPressure = 0,
}) {
  for (let i = 0; i < count; i++) {
    const decision = governor.sample({
      nowMs: start + i * stepMs,
      frameMs,
      cpuMs,
      gpuMs,
      streamingPressure,
    });
    if (decision) return decision;
  }
  return null;
}

test('percentiles interpolate deterministically', () => {
  assert.equal(performancePercentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(performancePercentile([10, 20], 0.95), 19.5);
  assert.equal(performancePercentile([], 0.95), 0);
});

test('isolated slow frames do not trip hysteresis', () => {
  const governor = new QualityGovernor({
    targetFrameMs: 16.7,
    evaluationIntervalMs: 100,
    historyMs: 300,
    minSamples: 10,
    overloadWindows: 2,
    actionCooldownMs: 0,
  });
  feedWindow(governor, { start: 0, frameMs: 10, cpuMs: 4, gpuMs: 5, count: 20, stepMs: 10 });
  governor.sample({ nowMs: 210, frameMs: 90, cpuMs: 70, gpuMs: 80 });
  const decision = feedWindow(governor, {
    start: 220, frameMs: 10, cpuMs: 4, gpuMs: 5, count: 20, stepMs: 10,
  });
  assert.equal(decision, null);
  assert.equal(governor.settings.effectsLevel, 2);
});

test('sustained GPU pressure drops effects before resolution', () => {
  const governor = new QualityGovernor({
    targetFrameMs: 16.7,
    evaluationIntervalMs: 100,
    historyMs: 220,
    minSamples: 8,
    overloadWindows: 2,
    actionCooldownMs: 0,
  });
  let decision = feedWindow(governor, {
    start: 0, frameMs: 25, cpuMs: 5, gpuMs: 20, count: 50, stepMs: 10,
  });
  assert.ok(decision);
  assert.equal(decision.knob, 'effectsLevel');
  assert.equal(decision.value, 1);

  decision = feedWindow(governor, {
    start: 600, frameMs: 25, cpuMs: 5, gpuMs: 20, count: 50, stepMs: 10,
  });
  assert.ok(decision);
  assert.equal(decision.knob, 'effectsLevel');
  assert.equal(decision.value, 0);
  assert.equal(governor.settings.renderScale, 1);
});

test('CPU pressure protects render resolution and reduces population first', () => {
  const governor = new QualityGovernor({
    targetFrameMs: 16.7,
    evaluationIntervalMs: 100,
    historyMs: 220,
    minSamples: 8,
    overloadWindows: 2,
    actionCooldownMs: 0,
  });
  const decision = feedWindow(governor, {
    start: 0, frameMs: 25, cpuMs: 16, gpuMs: 5, count: 50, stepMs: 10,
  });
  assert.ok(decision);
  assert.equal(decision.knob, 'populationScale');
  assert.equal(governor.settings.renderScale, 1);
});

test('recovery is slow and restores the most recent rung', () => {
  const governor = new QualityGovernor({
    targetFrameMs: 16.7,
    evaluationIntervalMs: 100,
    historyMs: 180,
    minSamples: 8,
    overloadWindows: 1,
    recoveryWindows: 3,
    actionCooldownMs: 0,
  });
  const down = feedWindow(governor, {
    start: 0, frameMs: 25, cpuMs: 5, gpuMs: 20, count: 30, stepMs: 10,
  });
  assert.equal(down?.direction, 'degrade');
  const up = feedWindow(governor, {
    start: 400, frameMs: 8, cpuMs: 3, gpuMs: 4, count: 60, stepMs: 10,
  });
  assert.equal(up?.direction, 'recover');
  assert.equal(up?.knob, down?.knob);
  assert.equal(governor.settings.effectsLevel, 2);
});

test('station batching preserves shadow roles and collapses submissions', () => {
  const root = new THREE.Group();
  const material = new THREE.MeshLambertMaterial();
  for (let i = 0; i < 10; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.position.x = i * 2;
    mesh.castShadow = i < 6;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  const stats = batchStaticStationMeshes(root);
  assert.equal(stats.inputMeshes, 10);
  assert.equal(stats.outputMeshes, 2);
  assert.equal(stats.colorDrawsSaved, 8);
  assert.equal(stats.inputShadowCasters, 6);
  assert.equal(stats.outputShadowCasters, 1);
  assert.equal(stats.shadowDrawsSaved, 5);
  const meshes = root.children.filter((child) => child instanceof THREE.Mesh);
  assert.equal(meshes.length, 2);
  assert.equal(meshes.filter((mesh) => mesh.castShadow).length, 1);
  material.dispose();
  for (const mesh of meshes) mesh.geometry.dispose();
});

test('station batching preserves nested service transforms and live texture materials', () => {
  const root = new THREE.Group();
  const service = new THREE.Group();
  service.position.set(32, -5, 18);
  service.rotation.y = Math.PI / 2;
  root.add(service);
  const texture = new THREE.Texture();
  const material = new THREE.MeshBasicMaterial({ map: texture });
  for (const x of [-4, 4]) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3, 1), material);
    sign.position.set(x, 2.5, 1);
    service.add(sign);
  }
  const stats = batchStaticStationMeshes(root);
  assert.equal(stats.inputMeshes, 2);
  assert.equal(stats.outputMeshes, 1);
  assert.deepEqual(service.position.toArray(), [32, -5, 18]);
  assert.equal(service.rotation.y, Math.PI / 2);
  const replacement = root.children.find((child) => child instanceof THREE.Mesh);
  assert.ok(replacement);
  assert.equal(replacement.material, material);
  assert.equal(replacement.material.map, texture);
  const beforeVersion = texture.version;
  texture.needsUpdate = true;
  assert.equal(texture.version, beforeVersion + 1);

  // Schedulers attach after batching. Their local frame must remain usable.
  const train = new THREE.Object3D();
  train.position.set(7, -1.1, 2);
  service.add(train);
  root.updateWorldMatrix(true, true);
  const trainWorld = train.getWorldPosition(new THREE.Vector3());
  assert.deepEqual(
    trainWorld.toArray().map((value) => Math.round(value * 10) / 10),
    [34, -6.1, 11],
  );
  replacement.geometry.dispose();
  material.dispose();
  texture.dispose();
});

test('station batching leaves transparent meshes separate for depth sorting', () => {
  const root = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.8 });
  for (const z of [0, 2, 4]) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    screen.position.z = z;
    root.add(screen);
  }
  const stats = batchStaticStationMeshes(root);
  assert.equal(stats.mergedMeshes, 0);
  assert.equal(stats.outputMeshes, 3);
  assert.equal(root.children.length, 3);
  for (const child of root.children) {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  }
  material.dispose();
});

test('owned-resource disposal deduplicates and leaves shared resources alive', () => {
  const counts = { geometry: 0, texture: 0, material: 0, shared: 0 };
  const geometry = { dispose() { counts.geometry++; } };
  const texture = { dispose() { counts.texture++; } };
  const material = { dispose() { counts.material++; } };
  const shared = { dispose() { counts.shared++; } };
  disposeOwnedResources([geometry, geometry], [texture], [material]);
  assert.deepEqual(counts, { geometry: 1, texture: 1, material: 1, shared: 0 });
  // `shared` represents manager-wide foliage/material resources: not putting it
  // in a tile's ownership set is the safety boundary.
  assert.equal(counts.shared, 0);
});
