const MIB = 1024 * 1024;

/**
 * Browser profiles are deliberately explicit. "Mobile" means Chromium device
 * emulation running the real mobile renderer (`?touch=1`); it is not presented
 * as physical-phone or thermal evidence anywhere in the report.
 */
export const BENCHMARK_PROFILES = Object.freeze({
  'mobile-low': Object.freeze({
    tier: 'low',
    platform: 'mobile-emulation',
    targetFps: 30,
    viewport: Object.freeze({ width: 390, height: 844, deviceScaleFactor: 2 }),
    userAgent: 'NYCRoamBenchmark/1.0 (Linux; Android 14; Mobile; Chromium emulation)',
    hasTouch: true,
    budgets: Object.freeze({
      frameP95Ms: 40,
      onePercentLowFps: 20,
      cpuP95Ms: 12,
      gpuP95Ms: 29,
      streamingIntegrationP99Ms: 12,
      streamingPressureP95: 0.85,
      heapBytes: 512 * MIB,
      street: Object.freeze({
        drawCallsP95: 450,
        shadowCallsP95: 8,
        trianglesP95: 1_200_000,
        residentBytes: 200 * MIB,
      }),
      station: Object.freeze({
        drawCallsP95: 400,
        shadowCallsP95: 8,
        trianglesP95: 1_500_000,
        residentBytes: 200 * MIB,
      }),
    }),
  }),
  'mobile-medium': Object.freeze({
    tier: 'medium',
    platform: 'mobile-emulation',
    targetFps: 45,
    viewport: Object.freeze({ width: 390, height: 844, deviceScaleFactor: 3 }),
    userAgent: 'NYCRoamBenchmark/1.0 (Linux; Android 14; Mobile; Chromium emulation)',
    hasTouch: true,
    budgets: Object.freeze({
      frameP95Ms: 30,
      onePercentLowFps: 30,
      cpuP95Ms: 12,
      gpuP95Ms: 20,
      streamingIntegrationP99Ms: 12,
      streamingPressureP95: 0.85,
      heapBytes: 512 * MIB,
      street: Object.freeze({
        drawCallsP95: 450,
        shadowCallsP95: 220,
        trianglesP95: 1_200_000,
        residentBytes: 200 * MIB,
      }),
      station: Object.freeze({
        drawCallsP95: 400,
        shadowCallsP95: 8,
        trianglesP95: 1_500_000,
        residentBytes: 200 * MIB,
      }),
    }),
  }),
  'desktop-high': Object.freeze({
    tier: 'high',
    platform: 'desktop-browser',
    targetFps: 60,
    viewport: Object.freeze({ width: 1440, height: 900, deviceScaleFactor: 1.5 }),
    userAgent: null,
    hasTouch: false,
    budgets: Object.freeze({
      frameP95Ms: 20,
      onePercentLowFps: 45,
      cpuP95Ms: 8,
      gpuP95Ms: 14,
      streamingIntegrationP99Ms: 8,
      streamingPressureP95: 0.75,
      heapBytes: 1536 * MIB,
      street: Object.freeze({
        drawCallsP95: 900,
        shadowCallsP95: 300,
        trianglesP95: 3_000_000,
        residentBytes: 500 * MIB,
      }),
      station: Object.freeze({
        drawCallsP95: 700,
        shadowCallsP95: 200,
        trianglesP95: 3_000_000,
        residentBytes: 500 * MIB,
      }),
    }),
  }),
  'desktop-ultra': Object.freeze({
    tier: 'ultra',
    platform: 'desktop-browser',
    targetFps: 60,
    viewport: Object.freeze({ width: 1920, height: 1080, deviceScaleFactor: 2 }),
    userAgent: null,
    hasTouch: false,
    budgets: Object.freeze({
      frameP95Ms: 20,
      onePercentLowFps: 45,
      cpuP95Ms: 8,
      gpuP95Ms: 14,
      streamingIntegrationP99Ms: 8,
      streamingPressureP95: 0.75,
      heapBytes: 1536 * MIB,
      street: Object.freeze({
        drawCallsP95: 1100,
        shadowCallsP95: 400,
        trianglesP95: 4_000_000,
        residentBytes: 650 * MIB,
      }),
      station: Object.freeze({
        drawCallsP95: 700,
        shadowCallsP95: 260,
        trianglesP95: 4_000_000,
        residentBytes: 650 * MIB,
      }),
    }),
  }),
});

export const REQUIRED_ROUTE_IDS = Object.freeze([
  'times-square',
  'central-park',
  'waterfront',
  'times-square-station',
  'subway-ride',
]);

export const SOAK_CONTRACT = Object.freeze({
  minMinutes: 5,
  maxMinutes: 10,
  maxFrameP50RegressionPercent: 15,
  maxGpuP95RegressionPercent: 15,
  maxOnePercentLowRegressionPercent: 15,
  maxHeapGrowthBytes: 64 * MIB,
});

const get = (object, path) => path.split('.').reduce(
  (value, key) => value == null ? undefined : value[key],
  object,
);

const display = (value) => typeof value === 'number'
  ? Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2)
  : String(value);

function violation(metric, actual, comparator, limit, note) {
  return {
    metric,
    actual: actual ?? null,
    comparator,
    limit,
    message: `${metric}: expected ${comparator} ${display(limit)}, received ${display(actual)}${note ? ` (${note})` : ''}`,
  };
}

function requireFinite(violations, report, path) {
  const actual = get(report, path);
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    violations.push(violation(path, actual, 'finite number', true));
    return null;
  }
  return actual;
}

function atMost(violations, report, path, limit, note) {
  const actual = requireFinite(violations, report, path);
  if (actual !== null && actual > limit) {
    violations.push(violation(path, actual, '<=', limit, note));
  }
}

function atLeast(violations, report, path, limit, note) {
  const actual = requireFinite(violations, report, path);
  if (actual !== null && actual < limit) {
    violations.push(violation(path, actual, '>=', limit, note));
  }
}

/**
 * Evaluate one route result against the plan's starting guardrails. The
 * evaluator is intentionally pure so it can run in Node tests and in CI report
 * post-processing without a browser.
 */
export function evaluateCapture(capture, profileId) {
  const profile = BENCHMARK_PROFILES[profileId];
  if (!profile) throw new Error(`Unknown benchmark profile: ${profileId}`);
  const report = capture.report;
  const routeKind = capture.routeKind;
  if (routeKind !== 'street' && routeKind !== 'station' && routeKind !== 'ride') {
    throw new Error(`Unknown route kind: ${routeKind}`);
  }

  const violations = [];
  if (report.quality !== profile.tier) {
    violations.push(violation('quality', report.quality, '===', profile.tier));
  }
  if (report.mode !== routeKind) {
    violations.push(violation('mode', report.mode, '===', routeKind));
  }

  atLeast(violations, report, 'samples', 240, 'capture is too short for stable percentiles');
  if (routeKind === 'station' || routeKind === 'ride') {
    atLeast(violations, report, 'durationSeconds', 30, 'retain the full arrival and passenger exchange');
  }
  atLeast(
    violations,
    report,
    'fps.median',
    profile.targetFps * 0.95,
    '5% tolerance accounts for display-scheduler quantization',
  );
  atMost(violations, report, 'frameMs.p95', profile.budgets.frameP95Ms);
  atLeast(violations, report, 'fps.onePercentLow', profile.budgets.onePercentLowFps);
  atMost(violations, report, 'cpuMs.p95', profile.budgets.cpuP95Ms);
  atMost(violations, report, 'gpuMs.p95', profile.budgets.gpuP95Ms);
  atLeast(violations, report, 'gpuMs.availableSamples', 30, 'timer-query results were not captured');
  atMost(
    violations,
    report,
    'streamingPressure.p95',
    profile.budgets.streamingPressureP95,
  );

  const sceneBudget = profile.budgets[routeKind === 'ride' ? 'station' : routeKind];
  atMost(violations, report, 'drawCalls.p95', sceneBudget.drawCallsP95);
  atMost(violations, report, 'shadowCalls.p95', sceneBudget.shadowCallsP95);
  atMost(violations, report, 'triangles.p95', sceneBudget.trianglesP95);
  atMost(violations, report, 'sceneResources.totalBytes', sceneBudget.residentBytes);
  atMost(violations, report, 'jsHeapBytes', profile.budgets.heapBytes);
  requireFinite(violations, report, 'sceneResources.geometryBytes');
  requireFinite(violations, report, 'sceneResources.textureBytes');

  const streaming = report.streaming;
  if (!streaming || typeof streaming !== 'object') {
    violations.push(violation('streaming', streaming, 'present', true));
  } else {
    atMost(violations, report, 'streaming.errors', 0);
    // Stations do not initiate tile integration. A street capture must prove
    // that upload/integration telemetry was exercised before its p99 is gated.
    if (routeKind === 'street') {
      atLeast(violations, report, 'streaming.integration.samples', 1);
      atMost(
        violations,
        report,
        'streaming.integration.p99',
        profile.budgets.streamingIntegrationP99Ms,
      );
    }
  }

  return {
    passed: violations.length === 0,
    profileId,
    routeId: capture.routeId,
    routeKind,
    violations,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const percentRegression = (first, last, lowerIsBetter) => {
  if (first === null || last === null || first === 0) return null;
  return lowerIsBetter
    ? ((last - first) / first) * 100
    : ((first - last) / first) * 100;
};

/**
 * Detect sustained drift in a 5–10 minute browser run. This is a load/thermal
 * proxy only: desktop emulation cannot validate a phone's skin temperature,
 * throttling policy, battery draw, or browser process-kill behavior.
 */
export function summarizeSoak(captures, durationMinutes) {
  if (!Number.isFinite(durationMinutes)
      || durationMinutes < SOAK_CONTRACT.minMinutes
      || durationMinutes > SOAK_CONTRACT.maxMinutes) {
    throw new Error(
      `Soak duration must be ${SOAK_CONTRACT.minMinutes}–${SOAK_CONTRACT.maxMinutes} minutes`,
    );
  }
  if (captures.length < 4) {
    throw new Error('Soak summary requires at least four route captures');
  }
  const windowSize = Math.max(1, Math.floor(captures.length / 3));
  const first = captures.slice(0, windowSize);
  const last = captures.slice(-windowSize);
  const metricMedian = (rows, path) => median(rows
    .map((row) => get(row.report, path))
    .filter((value) => typeof value === 'number' && Number.isFinite(value)));

  const firstFrameP50 = metricMedian(first, 'frameMs.p50');
  const lastFrameP50 = metricMedian(last, 'frameMs.p50');
  const firstGpuP95 = metricMedian(first, 'gpuMs.p95');
  const lastGpuP95 = metricMedian(last, 'gpuMs.p95');
  const firstOnePercentLow = metricMedian(first, 'fps.onePercentLow');
  const lastOnePercentLow = metricMedian(last, 'fps.onePercentLow');
  const firstHeap = metricMedian(first, 'jsHeapBytes');
  const lastHeap = metricMedian(last, 'jsHeapBytes');

  const summary = {
    measurementClass: 'desktop-browser-sustained-load-proxy',
    physicalDeviceValidated: false,
    thermalValidity: 'not-a-physical-device-thermal-measurement',
    requestedDurationMinutes: durationMinutes,
    captures: captures.length,
    comparisonWindowCaptures: windowSize,
    first: {
      frameMsP50: firstFrameP50,
      gpuMsP95: firstGpuP95,
      onePercentLowFps: firstOnePercentLow,
      jsHeapBytes: firstHeap,
    },
    last: {
      frameMsP50: lastFrameP50,
      gpuMsP95: lastGpuP95,
      onePercentLowFps: lastOnePercentLow,
      jsHeapBytes: lastHeap,
    },
    drift: {
      frameP50Percent: percentRegression(firstFrameP50, lastFrameP50, true),
      gpuP95Percent: percentRegression(firstGpuP95, lastGpuP95, true),
      onePercentLowPercent: percentRegression(firstOnePercentLow, lastOnePercentLow, false),
      heapBytes: firstHeap === null || lastHeap === null ? null : lastHeap - firstHeap,
    },
  };

  const violations = [];
  const checks = [
    ['soak.drift.frameP50Percent', summary.drift.frameP50Percent, SOAK_CONTRACT.maxFrameP50RegressionPercent],
    ['soak.drift.gpuP95Percent', summary.drift.gpuP95Percent, SOAK_CONTRACT.maxGpuP95RegressionPercent],
    ['soak.drift.onePercentLowPercent', summary.drift.onePercentLowPercent, SOAK_CONTRACT.maxOnePercentLowRegressionPercent],
    ['soak.drift.heapBytes', summary.drift.heapBytes, SOAK_CONTRACT.maxHeapGrowthBytes],
  ];
  for (const [metric, actual, limit] of checks) {
    if (actual === null || !Number.isFinite(actual)) {
      violations.push(violation(metric, actual, 'finite number', true));
    } else if (actual > limit) {
      violations.push(violation(metric, actual, '<=', limit));
    }
  }

  return {
    ...summary,
    contract: { passed: violations.length === 0, violations },
  };
}

function canonicalize(value, path = 'report') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(
      (key) => [key, canonicalize(value[key], `${path}.${key}`)],
    ));
  }
  throw new Error(`${path} contains unsupported value type ${typeof value}`);
}

/** Stable, strict JSON for diffable CI artifacts. */
export function serializeBenchmarkReport(report) {
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}
