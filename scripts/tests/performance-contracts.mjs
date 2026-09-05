import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BENCHMARK_PROFILES,
  evaluateCapture,
  serializeBenchmarkReport,
  summarizeSoak,
} from '../benchmarks/contracts.mjs';

function healthyReport(profileId, routeKind = 'street') {
  const profile = BENCHMARK_PROFILES[profileId];
  return {
    quality: profile.tier,
    mode: routeKind,
    samples: 600,
    frameMs: { p50: 12, p95: 15, p99: 18 },
    fps: { median: 83.3, onePercentLow: 55.5 },
    cpuMs: { p50: 3, p95: 5, p99: 6 },
    gpuMs: { availableSamples: 590, p50: 5, p95: 8, p99: 10 },
    drawCalls: { p50: 250, p95: 300, max: 320 },
    shadowCalls: { p50: 4, p95: 6, max: 8 },
    triangles: { p50: 500_000, p95: 700_000, max: 750_000 },
    streamingPressure: { p50: 0, p95: 0.1, max: 0.2 },
    jsHeapBytes: 128 * 1024 * 1024,
    sceneResources: {
      geometryBytes: 32 * 1024 * 1024,
      textureBytes: 64 * 1024 * 1024,
      totalBytes: 96 * 1024 * 1024,
    },
    streaming: {
      integration: { samples: 12, p50: 1, p95: 2, p99: 3, recentMax: 4 },
      errors: 0,
    },
  };
}

test('all four authored tiers have independent street and station guardrails', () => {
  assert.deepEqual(
    Object.keys(BENCHMARK_PROFILES),
    ['mobile-low', 'mobile-medium', 'desktop-high', 'desktop-ultra'],
  );
  for (const profile of Object.values(BENCHMARK_PROFILES)) {
    assert.ok(profile.budgets.street.drawCallsP95 > 0);
    assert.ok(profile.budgets.station.drawCallsP95 > 0);
    assert.ok(profile.budgets.gpuP95Ms > 0);
    assert.ok(profile.budgets.cpuP95Ms > 0);
  }
});

test('a healthy route passes and a regression identifies exact guardrails', () => {
  const capture = {
    routeId: 'times-square',
    routeKind: 'street',
    report: healthyReport('desktop-high'),
  };
  assert.deepEqual(evaluateCapture(capture, 'desktop-high').violations, []);

  capture.report.gpuMs.p95 = 18;
  capture.report.drawCalls.p95 = 901;
  capture.report.streaming.integration.p99 = 9;
  const result = evaluateCapture(capture, 'desktop-high');
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.violations.map((item) => item.metric),
    ['gpuMs.p95', 'drawCalls.p95', 'streaming.integration.p99'],
  );
});

test('moving train captures retain station guardrails and verify ride mode', () => {
  const capture = { routeId: 'subway-ride', routeKind: 'ride', report: healthyReport('mobile-low', 'ride') };
  assert.equal(evaluateCapture(capture, 'mobile-low').passed, true);
  capture.report.drawCalls.p95 = BENCHMARK_PROFILES['mobile-low'].budgets.station.drawCallsP95 + 1;
  assert.ok(evaluateCapture(capture, 'mobile-low').violations.some(v => v.metric === 'drawCalls.p95'));
  capture.report.mode = 'station';
  assert.ok(evaluateCapture(capture, 'mobile-low').violations.some(v => v.metric === 'mode'));
});

test('missing timer-query samples, heap, resources, and telemetry fail clearly', () => {
  const report = healthyReport('mobile-medium');
  report.gpuMs = { availableSamples: 0, p50: null, p95: null, p99: null };
  report.jsHeapBytes = null;
  delete report.sceneResources.textureBytes;
  delete report.streaming;
  const result = evaluateCapture({
    routeId: 'central-park',
    routeKind: 'street',
    report,
  }, 'mobile-medium');
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((item) => item.metric === 'gpuMs.p95'));
  assert.ok(result.violations.some((item) => item.metric === 'gpuMs.availableSamples'));
  assert.ok(result.violations.some((item) => item.metric === 'jsHeapBytes'));
  assert.ok(result.violations.some((item) => item.metric === 'sceneResources.textureBytes'));
  assert.ok(result.violations.some((item) => item.metric === 'streaming'));
});

test('soak comparison detects sustained drift and labels it as a proxy', () => {
  const captures = Array.from({ length: 9 }, (_, index) => {
    const report = healthyReport('mobile-medium');
    if (index >= 6) {
      report.frameMs.p50 = 15;
      report.gpuMs.p95 = 10;
      report.fps.onePercentLow = 42;
      report.jsHeapBytes += 80 * 1024 * 1024;
    }
    return { report };
  });
  const summary = summarizeSoak(captures, 5);
  assert.equal(summary.physicalDeviceValidated, false);
  assert.match(summary.thermalValidity, /not-a-physical-device/);
  assert.equal(summary.contract.passed, false);
  assert.ok(summary.contract.violations.some((item) => item.metric === 'soak.drift.frameP50Percent'));
  assert.ok(summary.contract.violations.some((item) => item.metric === 'soak.drift.heapBytes'));
  assert.throws(() => summarizeSoak(captures, 4.99), /5–10 minutes/);
});

test('report serialization is stable and rejects non-finite measurements', () => {
  const first = serializeBenchmarkReport({ z: 1, nested: { b: 2, a: 1 }, a: true });
  const second = serializeBenchmarkReport({ a: true, nested: { a: 1, b: 2 }, z: 1 });
  assert.equal(first, second);
  assert.ok(first.indexOf('"a"') < first.indexOf('"nested"'));
  assert.ok(first.endsWith('\n'));
  assert.throws(
    () => serializeBenchmarkReport({ gpuMs: Number.NaN }),
    /non-finite number/,
  );
});
