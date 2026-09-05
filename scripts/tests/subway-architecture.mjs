import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';

// Node's built-in TypeScript stripping intentionally follows strict ESM
// resolution, while the application uses bundler-style extensionless imports.
// Keep the production imports idiomatic and resolve only this test's local TS
// graph the same way Next/TypeScript does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[a-z]+$/i.test(specifier)
      && context.parentURL?.includes('/src/engine/')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  createStationPortals,
  estimateStationSubmissions,
  optimizeStationArchitecture,
} = await import('../../src/engine/subway/stationArchitecture.ts');

const CELLS = [
  {
    id: 'platform',
    kind: 'platform',
    bounds: { minX: -20, maxX: 20, minZ: -6, maxZ: 6 },
    floorY: 0,
    minY: -2,
    maxY: 4.5,
  },
  {
    id: 'mezzanine',
    kind: 'mezzanine',
    bounds: { minX: -6, maxX: 6, minZ: -6, maxZ: 6 },
    floorY: 6,
    minY: 5.2,
    maxY: 10,
  },
  {
    id: 'corridor',
    kind: 'corridor',
    bounds: { minX: 6, maxX: 18, minZ: -3, maxZ: 3 },
    floorY: 6,
    minY: 5.2,
    maxY: 10,
  },
];

function disposeScene(scene, resources) {
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  for (const resource of new Set(resources)) resource.dispose();
  scene.clear();
}

test('station architecture instances repeated props, bakes AO and culls through portals', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const material = new THREE.MeshLambertMaterial({ color: 0x889988 });
  const resources = [material];
  const firstGeometry = new THREE.BoxGeometry(0.32, 3.4, 0.32);

  for (let i = 0; i < 16; i++) {
    const prop = new THREE.Group();
    prop.userData.stationProp = 'pillar';
    const geometry = i === 0 ? firstGeometry : new THREE.BoxGeometry(0.32, 3.4, 0.32);
    resources.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 1.7;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    prop.position.set(-16 + i * 2, 0, 0);
    prop.add(mesh);
    root.add(prop);
  }
  // Distinct mezzanine/corridor geometry makes hidden-cell savings measurable.
  for (const [x, y, z] of [[0, 6, 0], [10, 6, 0]]) {
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.2, 1.1), material);
      resources.push(mesh.geometry);
      mesh.position.set(x + (i % 3) * 1.4, y, z + Math.floor(i / 3) * 1.4);
      root.add(mesh);
    }
  }

  const portals = createStationPortals(CELLS, [{
    bounds: { minX: -1.2, maxX: 1.2, minZ: -1.2, maxZ: 1.2 },
    topY: 6,
    bottomY: 0,
  }]);
  const architecture = optimizeStationArchitecture(
    scene,
    root,
    CELLS,
    portals,
    (resource) => resources.push(resource),
    'high',
  );

  assert.equal(architecture.stats.cellCount, 3);
  assert.ok(architecture.stats.portalCount >= 2);
  assert.ok(architecture.stats.instancedSourceMeshes >= 16);
  assert.ok(architecture.stats.instancedDraws >= 1);
  assert.ok(firstGeometry.getAttribute('color'));
  assert.equal(firstGeometry.getAttribute('color').count, firstGeometry.getAttribute('position').count);
  assert.ok(architecture.stats.bakedVertices > 0);
  assert.ok(Number.isFinite(architecture.stats.buildMs));

  architecture.visibility.update(new THREE.Vector3(-19, 1.65, 0));
  assert.deepEqual(architecture.visibility.visibleCellIds, ['platform']);
  const platformOnly = estimateStationSubmissions(root);
  architecture.visibility.showAll();
  const allCells = estimateStationSubmissions(root);
  assert.ok(platformOnly.colorDraws < allCells.colorDraws);

  architecture.visibility.update(new THREE.Vector3(0, 2, 0));
  assert.deepEqual(
    new Set(architecture.visibility.visibleCellIds),
    new Set(['platform', 'mezzanine']),
  );
  assert.ok(architecture.stats.withinDesktopStaticBudget);
  assert.ok(architecture.stats.withinMobileStaticBudget);

  architecture.dispose();
  disposeScene(scene, resources);
});

test('mobile station policy removes shadow-map submissions and adds batched contacts', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  scene.add(light);
  const material = new THREE.MeshLambertMaterial();
  const resources = [material];
  for (let i = 0; i < 8; i++) {
    const prop = new THREE.Group();
    prop.userData.stationProp = 'bench';
    const geometry = new THREE.BoxGeometry(2.4, 0.45, 0.5);
    resources.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.225;
    mesh.castShadow = true;
    prop.position.set(-14 + i * 4, 0, 0);
    prop.add(mesh);
    root.add(prop);
  }
  const architecture = optimizeStationArchitecture(
    scene,
    root,
    [CELLS[0]],
    [],
    (resource) => resources.push(resource),
    'medium',
  );
  const estimate = architecture.profile(new THREE.Vector3(0, 1.65, 0));
  assert.equal(architecture.stats.shadowLights, 0);
  assert.equal(estimate.shadowDraws, 0);
  assert.equal(architecture.stats.contactShadowInstances, 8);
  assert.equal(architecture.stats.contactShadowDraws, 1);
  assert.ok(estimate.colorDraws < 400);

  architecture.dispose();
  disposeScene(scene, resources);
});

test('portal inference never connects crossing platform cells without an authored transfer', () => {
  const cells = [
    CELLS[0],
    {
      ...CELLS[0],
      id: 'other-platform',
      bounds: { minX: -4, maxX: 4, minZ: -20, maxZ: 20 },
    },
  ];
  assert.deepEqual(createStationPortals(cells), []);
});


test('station occlusion preserves custom surface shaders after cloning materials', () => {
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const material = new THREE.MeshStandardMaterial();
  const hook = shader => { shader.uniforms.surfaceScale = { value: 1.2 }; };
  material.onBeforeCompile = hook;
  material.customProgramCacheKey = () => 'physical-platform-detail';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(8,.3,3),material); root.add(mesh);
  const resources = [material,mesh.geometry];
  const architecture = optimizeStationArchitecture(scene,root,CELLS,[],r=>resources.push(r),'high');
  let found = false;
  root.traverse(o => { if(o instanceof THREE.Mesh) {
    found = true;
    assert.notEqual(o.material,material);
    assert.equal(o.material.onBeforeCompile,hook);
    assert.equal(o.material.customProgramCacheKey(),'physical-platform-detail');
    const shader = {uniforms:{}}; o.material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.surfaceScale.value,1.2);
    assert.equal(o.material.vertexColors,true);
  }});
  assert.ok(found); architecture.dispose(); resources.forEach(r=>r.dispose());
});
