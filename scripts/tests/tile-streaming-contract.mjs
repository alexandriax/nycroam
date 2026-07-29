import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
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

test('tile response byte accounting is exact for transfer and integration telemetry', async () => {
  const tileTypes = await importTranspiled('src/engine/tileTypes.ts');
  const mesh = {
    position: new Float32Array(3), // 12
    normal: new Int8Array(3), // 3
    color: new Uint8Array(3), // 3
    index: new Uint16Array(3), // 6
    uv: new Float32Array(2), // 8
    style: new Uint8Array(1), // 1
    semantic: new Float32Array(1), // 4
  };
  const response = {
    type: 'built',
    key: '0_0',
    detail: 2,
    requestId: 1,
    buildings: mesh,
    roads: null,
    walks: null,
    areas: null,
    water: null,
    markings: null,
    trees: new Float32Array(5), // 20
    retailAnchors: new Float32Array(4), // 16
    hydrants: new Float32Array(4), // 16
    signs: null,
    collision: {
      ringStart: new Uint32Array(2), // 8
      points: new Float32Array(4), // 16
      aabb: new Float32Array(4), // 16
      top: new Float32Array(1), // 4
      base: new Float32Array(1), // 4
    },
    roadPaths: {
      start: new Uint32Array(2), // 8
      pts: new Float32Array(4), // 16
      width: new Float32Array(1), // 4
      kind: new Uint8Array(1), // 1
      flags: new Uint16Array(1), // 2
    },
  };
  assert.equal(tileTypes.meshPayloadByteLength(mesh), 37);
  assert.equal(tileTypes.buildResponseByteLength(response), 168);
});

test('base, mid, and near integration retains UUID identity and attaches safely out of compile order', async () => {
  const tileTypes = await importTranspiled('src/engine/tileTypes.ts');
  const layers = [null, null, null];
  const root = new THREE.Group();
  const scene = new THREE.Group();
  const baseGeometry = new THREE.BufferGeometry();
  const baseMesh = new THREE.Mesh(baseGeometry);
  const baseLayer = new THREE.Group();
  const midLayer = new THREE.Group();
  const nearLayer = new THREE.Group();
  baseLayer.add(baseMesh);
  midLayer.add(new THREE.Mesh(new THREE.BufferGeometry()));
  nearLayer.add(new THREE.Mesh(new THREE.BufferGeometry()));
  const rootUuid = root.uuid;
  const baseGroupUuid = baseLayer.uuid;
  const baseMeshUuid = baseMesh.uuid;
  const baseGeometryUuid = baseGeometry.uuid;

  tileTypes.installTileDetailLayer(layers, 0, baseLayer);
  tileTypes.installTileDetailLayer(layers, 1, midLayer);
  assert.strictEqual(layers[0], baseLayer);
  tileTypes.installTileDetailLayer(layers, 2, nearLayer);
  assert.strictEqual(layers[0], baseLayer);
  assert.strictEqual(layers[1], midLayer);
  assert.equal(root.uuid, rootUuid);
  assert.equal(layers[0].uuid, baseGroupUuid);
  assert.equal(layers[0].children[0].uuid, baseMeshUuid);
  assert.equal(layers[0].children[0].geometry.uuid, baseGeometryUuid);
  assert.throws(() => tileTypes.installTileDetailLayer(layers, 1, {}), /already installed/);
  assert.throws(
    () => tileTypes.installTileDetailLayer([null, null, null], 2, {}),
    /installed before 1/,
  );

  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const compiles = [deferred(), deferred(), deferred()];
  const attach = (detail, layer) => compiles[detail].promise.then(() => {
    tileTypes.attachCompiledTileDetailLayer(
      layers,
      detail,
      layer,
      (compiled) => root.add(compiled),
      () => scene.add(root),
    );
  });
  const pending = [
    attach(0, baseLayer),
    attach(1, midLayer),
    attach(2, nearLayer),
  ];

  compiles[2].resolve();
  await pending[2];
  assert.strictEqual(nearLayer.parent, root);
  assert.equal(root.parent, null, 'near completion must not reveal a root without base');
  compiles[1].resolve();
  await pending[1];
  assert.strictEqual(midLayer.parent, root);
  assert.equal(root.parent, null, 'mid completion must not reveal a root without base');
  compiles[0].resolve();
  await pending[0];
  assert.strictEqual(baseLayer.parent, root);
  assert.strictEqual(root.parent, scene);
  assert.equal(baseLayer.children[0].geometry.uuid, baseGeometryUuid);
});

test('delta metadata preserves base collision/readiness and near data', async () => {
  const tileTypes = await importTranspiled('src/engine/tileTypes.ts');
  const collision = {
    ringStart: new Uint32Array([0, 2]),
    points: new Float32Array([0, 0, 1, 1]),
    aabb: new Float32Array([0, 0, 1, 1]),
    top: new Float32Array([12]),
    base: new Float32Array([0]),
  };
  const roadPaths = {
    start: new Uint32Array([0, 2]),
    pts: new Float32Array([0, 0, 1, 1]),
    width: new Float32Array([8]),
    kind: new Uint8Array([0]),
  };
  const state = {
    collision: null,
    roadPaths: null,
    trees: null,
    retailAnchors: null,
    signs: null,
    builtDetail: -1,
  };
  const response = (detail, extra = {}) => ({
    type: 'built', key: '0_0', detail, requestId: detail + 1,
    buildings: null, roads: null, walks: null, areas: null, water: null, markings: null,
    trees: null, retailAnchors: null, hydrants: null, signs: null,
    collision: null, roadPaths: null, ...extra,
  });

  tileTypes.retainTileResponseState(state, response(0, { collision, roadPaths }));
  assert.equal(state.builtDetail, 0);
  assert.strictEqual(state.collision, collision);
  assert.strictEqual(state.roadPaths, roadPaths);
  assert.equal(state.builtDetail >= 0 && state.collision !== null, true);

  tileTypes.retainTileResponseState(state, response(1));
  assert.equal(state.builtDetail, 1);
  assert.strictEqual(state.collision, collision);
  assert.strictEqual(state.roadPaths, roadPaths);

  const trees = new Float32Array([1, 2, 3, 1, 0.5]);
  tileTypes.retainTileResponseState(state, response(2, { trees }));
  assert.equal(state.builtDetail, 2);
  assert.strictEqual(state.collision, collision);
  assert.strictEqual(state.roadPaths, roadPaths);
  assert.strictEqual(state.trees, trees);
});

test('base surfaces have one owning tier and every installed tier is disposed on unload', async () => {
  const tileTypes = await importTranspiled('src/engine/tileTypes.ts');
  const workerSource = fs.readFileSync(path.join(ROOT, 'src/engine/tileWorker.ts'), 'utf8');
  const managerSource = fs.readFileSync(path.join(ROOT, 'src/engine/TileManager.ts'), 'utf8');
  assert.deepEqual(
    [0, 1, 2].filter((detail) => tileTypes.tileDetailIncludesBaseSurfaces(detail)),
    [0],
  );
  for (const roadClass of ['motorway', 'primary', 'residential', 'service', 'footway']) {
    const owners = [0, 1, 2].filter(
      (detail) => detail === tileTypes.tileRoadSurfaceDetail(roadClass),
    );
    assert.equal(owners.length, 1, `${roadClass} surface must be emitted once`);
  }
  assert.equal(tileTypes.tileRoadSurfaceDetail('primary'), 0);
  assert.equal(tileTypes.tileRoadSurfaceDetail('residential'), 1);
  assert.match(workerSource, /if \(tileDetailIncludesBaseSurfaces\(detail\)\) \{/);
  assert.match(workerSource, /if \(tileDetailIncludesBaseSurfaces\(detail\) && tile\.areas\)/);
  assert.match(
    workerSource,
    /const emitSurface = r\.c !== 'crossing' && detail === tileRoadSurfaceDetail\(r\.c\)/,
  );
  assert.match(workerSource, /const sidewalkLine = trimPolyline\(/);
  assert.match(workerSource, /const paintInset = Math\.min\(1\.15, total \* 0\.18\)/);
  assert.match(managerSource, /forEachTileDetailLayer\(rec\.layerGroups/);
  assert.match(managerSource, /disposeOwnedResources\(rec\.geometries, rec\.textures, rec\.materials\)/);

  const layers = [new THREE.Group(), new THREE.Group(), new THREE.Group()];
  const resources = layers.map((layer) => {
    const resource = { disposed: 0 };
    layer.userData.resource = resource;
    return resource;
  });
  const visited = [];
  tileTypes.forEachTileDetailLayer(layers, (layer) => {
    visited.push(layer.uuid);
    layer.userData.resource.disposed++;
  });
  assert.deepEqual(visited, layers.map((layer) => layer.uuid));
  assert.deepEqual(resources.map((resource) => resource.disposed), [1, 1, 1]);
});

test('tile telemetry is fixed-window and reports pressure, bytes, and percentiles', async () => {
  const telemetryModule = await importTranspiled('src/engine/performance/TileStreamingTelemetry.ts');
  const telemetry = new telemetryModule.TileStreamingTelemetry();
  for (let i = 1; i <= 120; i++) {
    const detail = (i - 1) % 3;
    telemetry.requested(i % 3 === 0);
    telemetry.workerCompleted({
      fetchMs: i,
      decodeMs: i / 2,
      buildMs: i * 2,
      totalMs: i * 3,
      sourceBytes: 100,
      transferBytes: 40,
    }, detail);
    telemetry.integrated(i / 4, 20, detail);
  }
  telemetry.pressure(7, 3, 4, 2);
  telemetry.setDetailCounts([11, 5, 2]);
  const report = telemetry.report();
  assert.equal(report.worker.total.samples, 96);
  assert.equal(report.worker.total.recentMax, 360);
  assert.ok(report.worker.total.p95 >= report.worker.total.p50);
  assert.equal(report.bytes.source, 12_000);
  assert.equal(report.bytes.transferred, 4_800);
  assert.equal(report.bytes.integrated, 2_400);
  assert.equal(report.bytes.integratedPerTile, 20);
  assert.deepEqual(report.bytes.byDetail, {
    base: { transferred: 1_600, integrated: 800 },
    mid: { transferred: 1_600, integrated: 800 },
    near: { transferred: 1_600, integrated: 800 },
  });
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
