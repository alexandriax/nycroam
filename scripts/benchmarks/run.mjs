#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import {
  BENCHMARK_PROFILES,
  REQUIRED_ROUTE_IDS,
  evaluateCapture,
  serializeBenchmarkReport,
  summarizeSoak,
} from './contracts.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const NEXT_BIN = resolve(ROOT, 'node_modules/next/dist/bin/next');
const DEFAULT_PROFILES = ['mobile-medium', 'desktop-high'];
const DEFAULT_OUTPUT = resolve(ROOT, 'artifacts/benchmarks/performance-contract.json');
const ROUTE_TIMEOUT_MS = 120_000;

function usage() {
  return `
NYC Roam deterministic performance-contract runner

Usage:
  node scripts/benchmarks/run.mjs [options]

Options:
  --profiles <ids>      Comma-separated profiles (default: mobile-medium,desktop-high)
  --routes <ids>        Comma-separated golden routes (default: all five)
  --url <url>           Use an already-running production deployment
  --port <number>       Local next start port (default: available ephemeral port)
  --output <path>       JSON artifact path
  --soak-minutes <5-10> Repeat routes for a sustained-load/thermal-proxy capture
  --headed              Show Chromium
  --no-enforce          Record violations without returning a failing exit code
  --help                Show this help

Profiles: ${Object.keys(BENCHMARK_PROFILES).join(', ')}
Routes:   ${REQUIRED_ROUTE_IDS.join(', ')}

The local path requires a production build. Run "npm run build" first, or use
"npm run benchmark" to build and capture. Install the repo-matched browser with
"npm run benchmark:install-browser".
`.trim();
}

function parseList(value, option) {
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!result.length) throw new Error(`${option} requires at least one value`);
  return result;
}

function parseArgs(argv) {
  const options = {
    profiles: DEFAULT_PROFILES,
    routes: [...REQUIRED_ROUTE_IDS],
    url: null,
    port: null,
    output: DEFAULT_OUTPUT,
    soakMinutes: null,
    headed: false,
    enforce: true,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--profiles') options.profiles = parseList(next(), arg);
    else if (arg === '--routes') options.routes = parseList(next(), arg);
    else if (arg === '--url') options.url = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--output') options.output = resolve(ROOT, next());
    else if (arg === '--soak-minutes') options.soakMinutes = Number(next());
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--no-enforce') options.enforce = false;
    else if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  for (const id of options.profiles) {
    if (!BENCHMARK_PROFILES[id]) throw new Error(`Unknown benchmark profile: ${id}`);
  }
  for (const id of options.routes) {
    if (!REQUIRED_ROUTE_IDS.includes(id)) throw new Error(`Unknown golden route: ${id}`);
  }
  if (options.port !== null
      && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  if (options.soakMinutes !== null
      && (!Number.isFinite(options.soakMinutes)
        || options.soakMinutes < 5
        || options.soakMinutes > 10)) {
    throw new Error('--soak-minutes must be between 5 and 10');
  }
  return options;
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Production server exited with code ${child.exitCode}\n${logs()}`);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // Startup connection refusal is expected.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Production server did not become ready at ${url}\n${logs()}`);
}

async function startProductionServer(options) {
  if (options.url) {
    const url = new URL(options.url).toString();
    await waitForServer(url, null, () => '');
    return { url, child: null, owned: false, logs: () => '' };
  }
  if (!existsSync(resolve(ROOT, '.next/BUILD_ID'))) {
    throw new Error(
      'No production build found at .next/BUILD_ID. Run "npm run build" first.',
    );
  }
  const port = options.port ?? await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  let output = '';
  const child = spawn(process.execPath, [
    NEXT_BIN,
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  await waitForServer(url, child, () => output);
  return { url, child, owned: true, logs: () => output };
}

async function stopServer(server) {
  if (!server.owned || !server.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolveExit) => server.child.once('exit', () => resolveExit(true))),
    new Promise((resolveExit) => setTimeout(() => resolveExit(false), 3000)),
  ]);
  if (!exited && server.child.exitCode === null) server.child.kill('SIGKILL');
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function routeKind(routeId) {
  return routeId === 'subway-ride' ? 'ride' : routeId === 'times-square-station' ? 'station' : 'street';
}

async function launchBrowser(headed) {
  try {
    return await chromium.launch({
      headless: !headed,
      // Playwright's `chromium` channel opts into the full browser's modern
      // headless mode. The legacy headless shell commonly omits disjoint timer
      // queries, which would make a GPU contract invalid.
      channel: 'chromium',
      args: [
        '--mute-audio',
        '--enable-precise-memory-info',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to launch the repo-matched Chromium browser. `
      + `Run "npm run benchmark:install-browser" and retry.\n${message}`,
    );
  }
}

async function preparePage(browser, serverUrl, profileId) {
  const profile = BENCHMARK_PROFILES[profileId];
  const context = await browser.newContext({
    viewport: { width: profile.viewport.width, height: profile.viewport.height },
    deviceScaleFactor: profile.viewport.deviceScaleFactor,
    hasTouch: profile.hasTouch,
    isMobile: profile.hasTouch,
    userAgent: profile.userAgent ?? undefined,
    reducedMotion: 'reduce',
  });
  await context.addInitScript(({ tier }) => {
    try {
      localStorage.removeItem('nycroam');
      localStorage.removeItem('nycworld');
      localStorage.setItem('nycroam-quality', tier);
      // Set before World/AudioManager construction. Chromium is also launched
      // with --mute-audio, and the live manager is re-muted after readiness.
      localStorage.setItem('nycroam-muted', '1');
    } catch {
      // The script can first execute in an opaque about:blank document. It
      // executes again with the application origin before application code.
    }
  }, { tier: profile.tier });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  const url = new URL(serverUrl);
  if (profile.platform === 'mobile-emulation') url.searchParams.set('touch', '1');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    (requiredCount) => window.__nyc
      && typeof window.__nyc.runBenchmarkRoute === 'function'
      && window.__nyc.benchmarkRoutes().length >= requiredCount,
    REQUIRED_ROUTE_IDS.length,
    { timeout: 60_000 },
  );
  await page.evaluate(() => window.__nyc.audio.setMuted(true));
  await page.waitForTimeout(1000);

  const capabilities = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: typeof WebGL2RenderingContext !== 'undefined'
        && gl instanceof WebGL2RenderingContext,
      gpuTimerExtension: Boolean(gl?.getExtension('EXT_disjoint_timer_query_webgl2')),
      renderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      vendor: gl && debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      devicePixelRatio: devicePixelRatio,
      muted: window.__nyc.audio.isMuted,
      routes: window.__nyc.benchmarkRoutes(),
    };
  });
  if (!capabilities.webgl2) {
    await context.close();
    throw new Error(`${profileId}: WebGL2 is unavailable; performance capture cannot run`);
  }
  if (!capabilities.gpuTimerExtension) {
    await context.close();
    throw new Error(
      `${profileId}: EXT_disjoint_timer_query_webgl2 is unavailable. `
      + 'GPU time cannot be inferred from requestAnimationFrame, so the contract run is invalid.',
    );
  }
  if (!capabilities.muted) {
    await context.close();
    throw new Error(`${profileId}: in-game audio mute did not engage before testing`);
  }
  const missingRoutes = REQUIRED_ROUTE_IDS.filter((id) => !capabilities.routes.includes(id));
  if (missingRoutes.length) {
    await context.close();
    throw new Error(`${profileId}: runtime is missing golden routes: ${missingRoutes.join(', ')}`);
  }
  return { context, page, pageErrors, capabilities };
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureRoute(page, routeId, iteration) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { report, sceneCensus } = await page.evaluate(async (id) => {
    const report = await window.__nyc.runBenchmarkRoute(id);
    const scene = window.__nyc.activeRenderScene;
    const roots = [];
    const categories = new Map();
    const visit = (object, visible, totals) => {
      const active = visible && object.visible !== false;
      if (!active) return;
      if (object.isMesh) {
        const calls = Array.isArray(object.material)
          ? Math.max(1, object.geometry?.groups?.length || object.material.length)
          : 1;
        totals.calls += calls;
        totals.meshes++;
        if (object.castShadow) totals.shadowCalls += calls;
      }
      for (const child of object.children || []) visit(child, active, totals);
    };
    for (const root of scene?.children || []) {
      const totals = { calls: 0, meshes: 0, shadowCalls: 0 };
      visit(root, true, totals);
      const tile = (root.children || []).some(
        (child) => Number.isInteger(child.userData?.tileDetail),
      );
      const category = tile ? 'streamed tiles'
        : root.name || root.type || 'unnamed';
      const current = categories.get(category) || { calls: 0, meshes: 0, roots: 0, shadowCalls: 0 };
      current.calls += totals.calls;
      current.meshes += totals.meshes;
      current.roots++;
      current.shadowCalls += totals.shadowCalls;
      categories.set(category, current);
      if (totals.calls) roots.push({ category, ...totals });
    }
    return {
      report,
      sceneCensus: {
        categories: [...categories.entries()]
          .map(([category, totals]) => ({ category, ...totals }))
          .sort((a, b) => b.calls - a.calls)
          .slice(0, 40),
        roots: roots.sort((a, b) => b.calls - a.calls).slice(0, 40),
      },
    };
  }, routeId);
  return {
    routeId,
    routeKind: routeKind(routeId),
    iteration,
    startedAt,
    wallDurationSeconds: (performance.now() - started) / 1000,
    report,
    sceneCensus,
  };
}

async function captureProfile(browser, serverUrl, profileId, options) {
  const { context, page, pageErrors, capabilities } = await preparePage(
    browser,
    serverUrl,
    profileId,
  );
  const captures = [];
  const started = performance.now();
  const deadline = options.soakMinutes === null
    ? null
    : started + options.soakMinutes * 60_000;
  let iteration = 0;
  try {
    do {
      iteration++;
      for (const routeId of options.routes) {
        console.log(`[benchmark] ${profileId} route=${routeId} iteration=${iteration} (audio muted)`);
        captures.push(await withTimeout(
          captureRoute(page, routeId, iteration),
          ROUTE_TIMEOUT_MS,
          `${profileId}/${routeId}: route timed out`,
        ));
      }
    } while (deadline !== null && performance.now() < deadline);
  } finally {
    await context.close();
  }
  if (pageErrors.length) {
    throw new Error(
      `${profileId}: browser errors during capture:\n${pageErrors.slice(0, 10).join('\n')}`,
    );
  }

  const evaluations = captures.map((capture) => ({
    capture,
    evaluation: evaluateCapture(capture, profileId),
  }));
  const violations = evaluations.flatMap(({ capture, evaluation }) => (
    evaluation.violations.map((item) => ({
      ...item,
      routeId: evaluation.routeId,
      iteration: capture.iteration,
    }))
  ));
  const soak = options.soakMinutes === null
    ? null
    : summarizeSoak(captures, options.soakMinutes);
  if (soak) violations.push(...soak.contract.violations);
  return {
    profileId,
    tier: BENCHMARK_PROFILES[profileId].tier,
    platform: BENCHMARK_PROFILES[profileId].platform,
    capabilities,
    captures,
    soak,
    contract: { passed: violations.length === 0, violations },
  };
}

async function writeArtifact(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, serializeBenchmarkReport(report), 'utf8');
  await rename(temp, path);
}

function printSummary(report, output) {
  for (const profile of report.profiles) {
    console.log(`\n${profile.profileId}: ${profile.contract.passed ? 'PASS' : 'FAIL'}`);
    for (const capture of profile.captures) {
      const metrics = capture.report;
      console.log(
        `  ${capture.routeId} #${capture.iteration}: `
        + `${metrics.fps.median.toFixed(1)} fps median, `
        + `${metrics.fps.onePercentLow.toFixed(1)} fps 1% low, `
        + `CPU p95 ${metrics.cpuMs.p95.toFixed(2)} ms, `
        + `GPU p95 ${metrics.gpuMs.p95?.toFixed(2) ?? 'n/a'} ms, `
        + `${Math.round(metrics.drawCalls.p95)} draws, `
        + `${Math.round(metrics.triangles.p95).toLocaleString('en-US')} tris`,
      );
    }
    for (const issue of profile.contract.violations) {
      console.error(`  CONTRACT: ${issue.routeId ? `${issue.routeId}: ` : ''}${issue.message}`);
    }
  }
  console.log(`\nArtifact: ${output}`);
  console.log(
    'Physical-device limitation: mobile profiles are Chromium emulation. '
    + 'A 5–10 minute soak is a sustained-load proxy, not phone thermal, power, '
    + 'skin-temperature, throttling-policy, or tab-kill validation.',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let server;
  let browser;
  try {
    server = await startProductionServer(options);
    browser = await launchBrowser(options.headed);
    const profiles = [];
    for (const profileId of options.profiles) {
      profiles.push(await captureProfile(browser, server.url, profileId, options));
    }
    const violations = profiles.flatMap((profile) => profile.contract.violations.map(
      (item) => ({ ...item, profileId: profile.profileId }),
    ));
    const report = {
      schemaVersion: 1,
      benchmark: 'nyc-roam-golden-routes',
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      productionUrl: server.url,
      measurementClass: 'automated-production-chromium',
      physicalDeviceValidated: false,
      limitation: 'Mobile profiles are Chromium emulation; physical-phone thermal validation remains required.',
      nodeVersion: process.version,
      browserVersion: browser.version(),
      profiles,
      contract: { passed: violations.length === 0, violations },
    };
    await writeArtifact(options.output, report);
    printSummary(report, options.output);
    if (options.enforce && !report.contract.passed) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server) await stopServer(server);
  }
}

main().catch((error) => {
  console.error(`\n[benchmark] FATAL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
});
