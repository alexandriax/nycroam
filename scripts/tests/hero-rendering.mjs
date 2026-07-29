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
import {
  HEARST_BIRD_MOUTH_CUT,
  HEARST_BIRD_MOUTH_BOUNDARIES,
  HEARST_DIAGONALS_PER_MODULE,
  HEARST_DIAGONAL_SEGMENT_COUNT,
  HEARST_DIAGRID_BEAM_COUNT,
  HEARST_DIAGRID_MODULES,
  HEARST_FACE_BAYS,
  HEARST_GRID_MODULE,
  HEARST_PERIMETER_NODE_COUNT,
  HEARST_RING_SEGMENT_COUNT,
  HEARST_SHARP_CORNER_CUT,
  HEARST_TOWER_DEPTH,
  HEARST_TOWER_WIDTH,
  hearstBoundaryIsBirdMouth,
  hearstBoundaryIsChamfered,
  hearstCurtainLevels,
  hearstDiagridSegments,
  hearstPerimeterRing,
  hearstProjectedDiagonalAngle,
  hearstRingPerimeter,
} from '../../src/engine/landmarks/hearstGeometry.ts';

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
  assert.deepEqual(high.gtao, { scale: 0.35, samples: 5 });
  assert.equal(high.bloom.scale, 0.25);
  assert.equal(high.temporal, false);

  assert.equal(ultra.antialiasing, 'temporal');
  assert.deepEqual(ultra.gtao, { scale: 0.35, samples: 8 });
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

test('Hearst curtain wall preserves four eight-storey mouths and a phased roof', () => {
  assert.equal(HEARST_DIAGRID_MODULES, 9);
  assert.deepEqual(HEARST_BIRD_MOUTH_BOUNDARIES, [1, 3, 5, 7]);
  assert.equal(HEARST_TOWER_WIDTH, HEARST_GRID_MODULE * 4);
  assert.equal(HEARST_TOWER_DEPTH, HEARST_GRID_MODULE * 3);
  assert.equal(HEARST_BIRD_MOUTH_CUT, HEARST_GRID_MODULE / 2);

  const y0 = 33.53, y1 = 182;
  const levels = hearstCurtainLevels(y0, y1);
  assert.equal(levels.length, HEARST_DIAGRID_MODULES + 1);
  const step = (y1 - y0) / HEARST_DIAGRID_MODULES;
  levels.forEach((level, boundary) => {
    assert.ok(Math.abs(level.y - (y0 + boundary * step)) < 1e-9);
    assert.equal(level.points.length, 8);
    assert.equal(new Set(level.points.map(([x, z]) => `${x}:${z}`)).size, 8);
  });

  assert.deepEqual(
    levels
      .map((_, boundary) => boundary)
      .filter(hearstBoundaryIsBirdMouth),
    [1, 3, 5, 7],
  );
  assert.deepEqual(
    levels
      .map((_, boundary) => boundary)
      .filter(hearstBoundaryIsChamfered),
    [1, 3, 5, 7, 9],
  );
  assert.equal(hearstBoundaryIsBirdMouth(9), false);

  const halfWidth = HEARST_TOWER_WIDTH / 2;
  assert.ok(Math.abs(
    levels[0].points[0][0] - (-halfWidth + HEARST_SHARP_CORNER_CUT),
  ) < 1e-9);
  assert.ok(Math.abs(
    levels[1].points[0][0] - (-halfWidth + HEARST_BIRD_MOUTH_CUT),
  ) < 1e-9);
  // The roof stays on the half-module phase so the final diagonals do not
  // stretch across a full corner and flatten to the wrong angle.
  assert.deepEqual(levels[9].points, levels[1].points);

  const triangleArea3d = (a, b, c) => {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    return ab.cross(ac).length() * 0.5;
  };
  const outwardDot = (a, b, c) => {
    const normal = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    const center = new THREE.Vector3()
      .copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const outward = new THREE.Vector3(
      center.x / (HEARST_TOWER_WIDTH / 2),
      0,
      center.z / (HEARST_TOWER_DEPTH / 2),
    ).normalize();
    return normal.dot(outward);
  };
  for (let level = 0; level + 1 < levels.length; level++) {
    for (let index = 0; index < 8; index++) {
      const next = (index + 1) % 8;
      const lower = levels[level], upper = levels[level + 1];
      const points = [
        new THREE.Vector3(...[lower.points[index][0], lower.y, lower.points[index][1]]),
        new THREE.Vector3(...[upper.points[index][0], upper.y, upper.points[index][1]]),
        new THREE.Vector3(...[upper.points[next][0], upper.y, upper.points[next][1]]),
        new THREE.Vector3(...[lower.points[next][0], lower.y, lower.points[next][1]]),
      ];
      assert.ok(triangleArea3d(points[0], points[1], points[2]) > 1e-4);
      assert.ok(triangleArea3d(points[0], points[2], points[3]) > 1e-4);
      assert.ok(outwardDot(points[0], points[1], points[2]) > 0);
      assert.ok(outwardDot(points[0], points[2], points[3]) > 0);
    }
  }
});

test('Hearst steel is one continuous 40-foot perimeter diagrid', () => {
  assert.deepEqual(HEARST_FACE_BAYS, [4, 4, 3, 3]);
  assert.equal(HEARST_PERIMETER_NODE_COUNT, 14);
  assert.equal(HEARST_DIAGONALS_PER_MODULE, 28);
  assert.equal(HEARST_DIAGONAL_SEGMENT_COUNT, 252);
  assert.equal(HEARST_RING_SEGMENT_COUNT, 140);
  assert.equal(HEARST_DIAGRID_BEAM_COUNT, 392);

  const fullPerimeter = (HEARST_TOWER_WIDTH + HEARST_TOWER_DEPTH) * 2;
  assert.ok(Math.abs(hearstRingPerimeter(0) - fullPerimeter) < 1e-9);
  const expectedMouthPerimeter = fullPerimeter
    - HEARST_BIRD_MOUTH_CUT * 8
    + Math.SQRT2 * HEARST_BIRD_MOUTH_CUT * 4;
  assert.ok(Math.abs(hearstRingPerimeter(1) - expectedMouthPerimeter) < 1e-9);

  for (let boundary = 0; boundary <= HEARST_DIAGRID_MODULES; boundary++) {
    const ring = hearstPerimeterRing(boundary);
    assert.equal(ring.length, HEARST_PERIMETER_NODE_COUNT);
    assert.equal(new Set(ring.map(({ point: [x, z] }) => `${x}:${z}`)).size, 14);
    const chamferEdges = ring.filter(({ point }, index) => {
      const next = ring[(index + 1) % ring.length].point;
      return Math.abs(point[0] - next[0]) > 1e-9
        && Math.abs(point[1] - next[1]) > 1e-9;
    });
    assert.equal(chamferEdges.length, hearstBoundaryIsChamfered(boundary) ? 4 : 0);
    for (let index = 0; index < ring.length; index++) {
      const point = ring[index].point;
      const next = ring[(index + 1) % ring.length].point;
      const length = Math.hypot(point[0] - next[0], point[1] - next[1]);
      assert.ok(
        Math.abs(length - HEARST_GRID_MODULE) < 1e-9
        || Math.abs(length - Math.SQRT2 * HEARST_BIRD_MOUTH_CUT) < 1e-9,
      );
    }
  }

  const y0 = 33.53, y1 = 182;
  const moduleH = (y1 - y0) / HEARST_DIAGRID_MODULES;
  assert.ok(hearstProjectedDiagonalAngle(moduleH) >= 68);
  assert.ok(hearstProjectedDiagonalAngle(moduleH) <= 72);
  const expectedLength = Math.hypot(moduleH, HEARST_GRID_MODULE / 2);
  const segments = hearstDiagridSegments();
  assert.equal(segments.length, HEARST_DIAGONAL_SEGMENT_COUNT);
  assert.equal(
    new Set(segments.map((segment) => (
      `${segment.module}:${segment.lowerIndex}>${segment.module + 1}:${segment.upperIndex}`
    ))).size,
    HEARST_DIAGONAL_SEGMENT_COUNT,
  );
  const degree = new Map();
  for (const segment of segments) {
    const planarRunX = Math.abs(segment.upper[0] - segment.lower[0]);
    const planarRunZ = Math.abs(segment.upper[1] - segment.lower[1]);
    assert.ok(
      (planarRunX < 1e-9 && planarRunZ > 0)
      || (planarRunZ < 1e-9 && planarRunX > 0),
      'every diagonal stays in exactly one facade plane',
    );
    assert.ok(Math.abs(Math.hypot(planarRunX, planarRunZ) - HEARST_GRID_MODULE / 2) < 1e-9);
    assert.ok(Math.abs(
      Math.hypot(planarRunX, moduleH, planarRunZ) - expectedLength,
    ) < 1e-9);
    for (const key of [
      `${segment.module}:${segment.lowerIndex}`,
      `${segment.module + 1}:${segment.upperIndex}`,
    ]) {
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  }

  for (let module = 0; module < HEARST_DIAGRID_MODULES; module++) {
    const tier = segments.filter((segment) => segment.module === module);
    assert.equal(tier.length, HEARST_DIAGONALS_PER_MODULE);
    assert.equal(tier.filter((segment) => segment.corner).length, 8);
  }
  for (let boundary = 0; boundary <= HEARST_DIAGRID_MODULES; boundary++) {
    for (let index = 0; index < HEARST_PERIMETER_NODE_COUNT; index++) {
      assert.equal(
        degree.get(`${boundary}:${index}`),
        boundary === 0 || boundary === HEARST_DIAGRID_MODULES ? 2 : 4,
      );
    }
  }
});

test('the recognizable hero set is complete, bounded and backed by registry entries', () => {
  assert.ok(HERO_LANDMARK_LOD_IDS.size >= 15);
  assert.ok(HERO_LANDMARK_LOD_IDS.size <= 25);
  assert.equal(HERO_LANDMARK_LOD_IDS.has('hearst-tower'), true);
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
