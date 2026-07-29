import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import ts from 'typescript';
import {
  buildHeroLandmarkLod,
  disposeHeroLandmarkLodMaterials,
  HERO_LANDMARK_LOD_IDS,
  landmarkLodStats,
  LANDMARK_SHADOW_LAYER,
} from '../../src/engine/landmarks/landmarkLod.ts';
import { renderingTierContract } from '../../src/engine/quality.ts';
import {
  TEMPORAL_JITTER_8,
  temporalHistoryWeight,
} from '../../src/engine/rendering/TemporalAAPass.ts';

test('rendering contracts expose the deliberate per-tier cost ladder', () => {
  const low = renderingTierContract('low');
  const medium = renderingTierContract('medium');
  const high = renderingTierContract('high');
  const ultra = renderingTierContract('ultra');

  assert.equal(low.antialiasing, 'fxaa');
  assert.equal(low.grade, 'none');
  assert.equal(low.gtao, false);
  assert.equal(low.bloom, false);
  assert.equal(low.shadowStrategy, 'none');

  assert.equal(medium.antialiasing, 'smaa');
  assert.equal(medium.grade, 'minimal');
  assert.equal(medium.gtao, false);
  assert.equal(medium.materialDetail, 'near-pbr');

  assert.equal(high.antialiasing, 'smaa');
  assert.deepEqual(high.gtao, { scale: 0.5, samples: 8 });
  assert.equal(high.bloom.scale, 0.5);
  assert.equal(high.temporal, false);

  assert.equal(ultra.antialiasing, 'temporal');
  assert.deepEqual(ultra.gtao, { scale: 0.58, samples: 12 });
  assert.equal(ultra.temporal.jitterSamples, 8);
  assert.equal(ultra.fallbackAntialiasing, 'smaa');
  assert.equal(ultra.reflections, 'sky-probe');
});

test('temporal resolve uses centered jitter and rejects moving/depth-edge history', () => {
  assert.equal(TEMPORAL_JITTER_8.length, 8);
  assert.equal(new Set(TEMPORAL_JITTER_8.map((sample) => sample.join(','))).size, 8);
  const sum = TEMPORAL_JITTER_8.reduce(
    (acc, sample) => [acc[0] + sample[0], acc[1] + sample[1]],
    [0, 0],
  );
  assert.ok(Math.abs(sum[0]) < 1e-12);
  assert.ok(Math.abs(sum[1]) < 1e-12);

  const stable = temporalHistoryWeight(0, 0);
  const moving = temporalHistoryWeight(1, 0);
  const edge = temporalHistoryWeight(0, 1);
  const movingEdge = temporalHistoryWeight(1, 1);
  assert.equal(stable, 0.88);
  assert.ok(moving < stable * 0.2);
  assert.ok(edge < stable * 0.4);
  assert.ok(movingEdge < moving && movingEdge < edge);
});

test('the recognizable hero set is complete, bounded and backed by registry entries', () => {
  assert.ok(HERO_LANDMARK_LOD_IDS.size >= 15);
  assert.ok(HERO_LANDMARK_LOD_IDS.size <= 25);
  const registryUrl = new URL('../../src/engine/landmarks/registry.ts', import.meta.url);
  const registry = readFileSync(registryUrl, 'utf8');
  const source = ts.createSourceFile(
    registryUrl.pathname,
    registry,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let registryArray = null;
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (
        declaration.name.getText(source) === 'LANDMARKS_REG'
        && declaration.initializer
        && ts.isArrayLiteralExpression(declaration.initializer)
      ) registryArray = declaration.initializer;
    }
  });
  assert.ok(registryArray);
  const literalProperty = (object, name) => {
    const property = object.properties.find((candidate) => (
      ts.isPropertyAssignment(candidate)
      && (
        (ts.isIdentifier(candidate.name) && candidate.name.text === name)
        || (ts.isStringLiteral(candidate.name) && candidate.name.text === name)
      )
    ));
    return property && ts.isPropertyAssignment(property) ? property.initializer : null;
  };
  const entries = new Map();
  for (const element of registryArray.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const idNode = literalProperty(element, 'id');
    const setNode = literalProperty(element, 'set');
    if (!idNode || !setNode || !ts.isStringLiteral(idNode) || !ts.isStringLiteral(setNode)) continue;
    entries.set(idNode.text, {
      set: setNode.text,
      alias: literalProperty(element, 'aliasOf') !== null,
    });
  }

  for (const id of HERO_LANDMARK_LOD_IDS) {
    const entry = entries.get(id);
    assert.ok(entry, `missing registry entry ${id}`);
    assert.equal(entry.alias, false, `${id} must be a placed build, not an alias`);
    const setUrl = new URL(`../../src/engine/landmarks/sets/${entry.set}.ts`, import.meta.url);
    const setSourceText = readFileSync(setUrl, 'utf8');
    const setSource = ts.createSourceFile(
      setUrl.pathname,
      setSourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let buildersObject = null;
    setSource.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      for (const declaration of node.declarationList.declarations) {
        if (
          declaration.name.getText(setSource) === 'builders'
          && declaration.initializer
          && ts.isObjectLiteralExpression(declaration.initializer)
        ) buildersObject = declaration.initializer;
      }
    });
    assert.ok(buildersObject, `missing builders object for ${entry.set}`);
    const keys = new Set(buildersObject.properties.map((property) => {
      if (!('name' in property) || !property.name) return '';
      if (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) return property.name.text;
      return '';
    }));
    assert.ok(keys.has(id), `missing ${id} builder in ${entry.set}`);
  }
});

test('hero conversion creates three decreasing geometric levels and one shadow draw', async () => {
  const raw = new THREE.Group();
  raw.name = 'LOD test landmark';
  const stone = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });
  const glass = new THREE.MeshBasicMaterial({ color: 0x88bbdd });
  raw.add(new THREE.Mesh(new THREE.BoxGeometry(30, 100, 20), stone));
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(2, 9, 28, 20), stone);
  crown.position.y = 64;
  raw.add(crown);
  for (let i = 0; i < 200; i++) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.08), glass);
    pane.position.set((i % 20) - 10, 4 + Math.floor(i / 20), 10.05);
    raw.add(pane);
  }

  const converted = await buildHeroLandmarkLod(raw, 'high', true);
  const stats = landmarkLodStats(converted);
  assert.ok(stats);
  assert.ok(stats.highTriangles > stats.midTriangles);
  assert.ok(stats.midTriangles >= stats.farTriangles);
  assert.ok(stats.shadowTriangles > 0);
  assert.ok(stats.shadowTriangles < stats.highTriangles);
  assert.ok(stats.highGeometryBytes > 0);
  assert.ok(stats.lodOverheadGeometryBytes > 0);
  assert.equal(
    stats.residentGeometryBytes,
    stats.highGeometryBytes + stats.lodOverheadGeometryBytes,
  );
  assert.ok(stats.midDistance > 0);
  assert.ok(stats.farDistance > stats.midDistance);

  const lod = converted.children.find((child) => child instanceof THREE.LOD);
  assert.ok(lod instanceof THREE.LOD);
  assert.equal(lod.levels.length, 3);
  for (const level of lod.levels) {
    level.object.traverse((child) => {
      if (child instanceof THREE.Mesh) assert.equal(child.castShadow, false);
    });
  }
  const proxies = [];
  converted.traverse((child) => {
    if (child instanceof THREE.Mesh && child.userData.landmarkShadowProxy) proxies.push(child);
  });
  assert.equal(proxies.length, 1);
  assert.equal(proxies[0].castShadow, true);
  assert.equal(proxies[0].layers.isEnabled(LANDMARK_SHADOW_LAYER), true);
  assert.equal(stats.shadowTriangles, proxies[0].geometry.getIndex().count / 3);
  let proxyMaterialDisposeCount = 0;
  proxies[0].material.addEventListener('dispose', () => { proxyMaterialDisposeCount++; });
  disposeHeroLandmarkLodMaterials(converted);
  disposeHeroLandmarkLodMaterials(converted);
  assert.equal(proxyMaterialDisposeCount, 1);

  converted.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
  stone.dispose();
  glass.dispose();
});
