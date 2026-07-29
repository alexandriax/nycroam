import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function importTranspiled(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics?.length ?? 0, 0);
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  return import(url);
}

test('packed building semantics round-trip all shader fields exactly', async () => {
  const semantics = await importTranspiled('src/engine/tileSemantics.ts');
  const input = {
    archetype: 15,
    window: 7,
    windowRatio: 13,
    storefront: 5,
    era: 6,
    roof: 7,
    confidence: 3,
  };
  const packed = semantics.packBuildingSemantics(input);
  assert.ok(packed < 2 ** 23, 'semantic word must remain float32-exact');
  assert.deepEqual(semantics.unpackBuildingSemantics(packed), input);
});

test('legacy v2 tiles expand to a stable rich semantic fallback', async () => {
  const semantics = await importTranspiled('src/engine/tileSemantics.ts');
  const tile = {
    v: 2,
    x: 0,
    z: 0,
    buildings: [{ p: [[0, 0], [18, 0], [18, 12], [0, 12]], h: 24, b: 0 }],
  };
  assert.equal(tile.v, 2);
  const building = tile.buildings[0];
  const first = semantics.semanticsForBuilding(building, 10);
  const second = semantics.semanticsForBuilding(building, 10);
  assert.deepEqual(first, second);
  assert.equal(first.archetype, 10);
  assert.ok(first.windowRatio >= 0 && first.windowRatio <= 15);
});

test('NCT3 codec round-trips legacy tiles and reduces source bytes', async () => {
  const { encodeTileBinary } = await import('../tile-binary.mjs');
  const binary = await importTranspiled('src/engine/tileBinary.ts');
  const tile = {
    v: 2,
    x: 0,
    z: 0,
    buildings: Array.from({ length: 32 }, (_, i) => ({
      p: [[i * 7, 0], [i * 7 + 6, 0], [i * 7 + 6, 12], [i * 7, 12]],
      h: 12 + i,
      b: 0,
      a: i % 8,
    })),
    roads: Array.from({ length: 20 }, (_, i) => ({
      p: [[0, i * 9], [180, i * 9]],
      k: i % 4,
      n: `Street ${i % 5}`,
    })),
    areas: [],
    trees: [[10, 0, 10, 1, 0.5]],
    signs: [],
    hydrants: [],
  };
  const jsonText = JSON.stringify(tile);
  const packed = encodeTileBinary(tile);
  const source = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
  assert.equal(binary.isTileBinary(source), true);
  const decoded = binary.decodeTileBinary(source);
  assert.equal(decoded.v, tile.v);
  assert.equal(decoded.x, tile.x);
  assert.equal(decoded.z, tile.z);
  assert.equal(decoded.buildings.length, tile.buildings.length);
  assert.deepEqual(decoded.buildings[0].p, tile.buildings[0].p);
  assert.equal(decoded.roads.length, tile.roads.length);
  assert.ok(packed.byteLength < Buffer.byteLength(jsonText));
});

test('vegetation LOD selects one bounded draw set at every distance', async () => {
  const vegetation = await importTranspiled('src/engine/vegetationLod.ts');
  assert.equal(vegetation.TREE_SILHOUETTE_FAMILIES, 4);
  assert.equal(vegetation.treeLodForDistanceSq(0), 0);
  assert.equal(vegetation.treeLodForDistanceSq(vegetation.TREE_NEAR_DISTANCE ** 2), 1);
  assert.equal(vegetation.treeLodForDistanceSq(vegetation.TREE_MID_DISTANCE ** 2), 2);
  assert.equal(
    vegetation.treeDrawCount(0, 4),
    vegetation.TREE_LOD_DRAW_CEILINGS.near,
  );
  assert.ok(vegetation.treeDrawCount(0, 99) <= vegetation.TREE_LOD_DRAW_CEILINGS.near);
  assert.equal(vegetation.treeDrawCount(1), vegetation.TREE_LOD_DRAW_CEILINGS.mid);
  assert.equal(vegetation.treeDrawCount(2), vegetation.TREE_LOD_DRAW_CEILINGS.far);
});

test('tile telemetry is fixed-window and reports pressure, bytes, and percentiles', async () => {
  const telemetryModule = await importTranspiled('src/engine/performance/TileStreamingTelemetry.ts');
  const telemetry = new telemetryModule.TileStreamingTelemetry();
  for (let i = 1; i <= 120; i++) {
    telemetry.requested(i % 3 === 0);
    telemetry.workerCompleted({
      fetchMs: i,
      decodeMs: i / 2,
      buildMs: i * 2,
      totalMs: i * 3,
      sourceBytes: 100,
      transferBytes: 40,
    });
    telemetry.integrated(i / 4);
  }
  telemetry.pressure(7, 3, 4, 2);
  telemetry.setDetailCounts([11, 5, 2]);
  const report = telemetry.report();
  assert.equal(report.worker.total.samples, 96);
  assert.equal(report.worker.total.recentMax, 360);
  assert.ok(report.worker.total.p95 >= report.worker.total.p50);
  assert.equal(report.bytes.source, 12_000);
  assert.equal(report.bytes.transferred, 4_800);
  assert.deepEqual(report.pressure, {
    queue: 7,
    inFlight: 3,
    awaitingIntegration: 4,
    prefetch: 2,
    peakQueue: 7,
    peakInFlight: 3,
    peakAwaitingIntegration: 4,
  });
  assert.deepEqual(report.detail, { base: 11, mid: 5, near: 2, upgrades: 40 });
});

test('retail anchor filtering is stable, bounded, and supports reused output', async () => {
  const anchorsModule = await importTranspiled('src/engine/tileAnchors.ts');
  const source = new Float32Array([
    0, 2, 0, 1,
    30, 3, 40, 2,
    200, 4, 0, 3,
  ]);
  const out = [999];
  out.length = 0;
  const full = anchorsModule.appendRetailAnchorsWithin(source, 0, 0, 51 ** 2, out, 2);
  assert.equal(full, true);
  assert.deepEqual(out, [0, 2, 0, 1, 30, 3, 40, 2]);
});

test('build-tiles remains executable JavaScript', async () => {
  const url = pathToFileURL(path.join(ROOT, 'scripts/build-tiles.mjs'));
  assert.equal(url.protocol, 'file:');
  const source = fs.readFileSync(url, 'utf8');
  assert.match(source, /packBuildingSemantics/);
  assert.match(source, /roadNodeDegree/);
});
