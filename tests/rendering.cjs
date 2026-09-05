// Execute engine TypeScript without adding a test-runner dependency.
const ts = require('typescript');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  fileName: filename,
}).outputText, filename);
const THREE = require('three');
const { detectQuality, pixelBudgetRatio } = require('../src/engine/quality.ts');
const { StreetLife } = require('../src/engine/StreetLife.ts');
const { archWall, GRANITE } = require('../src/engine/landmarks/kit.ts');
const { buildingColor } = require('../src/engine/palette.ts');

test('touchscreen laptops retain desktop rendering; iPads and constrained devices are budgeted', () => {
  assert.equal(detectQuality({ userAgent:'Windows NT',maxTouchPoints:10,hardwareConcurrency:12 }).shadows,true);
  assert.equal(detectQuality({ userAgent:'Macintosh',maxTouchPoints:5,hardwareConcurrency:8 }).shadows,false);
  assert.equal(detectQuality({ userAgent:'Android',maxTouchPoints:5 }).shadows,false);
  assert.equal(detectQuality({ userAgent:'Linux',maxTouchPoints:0,deviceMemory:2 }).shadows,false);
});
test('pixel budget bounds ultrawide, 4K, retina and phone render targets', () => {
  for (const [w,h,dpr] of [[3840,2160,2],[7680,4320,2],[390,844,3],[1920,1080,1],[2560,1440,2]]) {
    const ratio = pixelBudgetRatio(w,h,dpr,2);
    assert.ok(w*h*ratio*ratio<=3200000.01);
    assert.ok(ratio<=dpr && ratio<=2 && ratio>0);
  }
});
test('named historic towers preserve masonry instead of acquiring curtain walls by height', () => {
  for (const name of ['Empire State Building','Chrysler Building','Woolworth Building']) assert.equal(buildingColor(82,300,name).glass,false);
  assert.equal(buildingColor(82,417,'One World Trade Center').glass,true);
});
test('street life builds finite, bounded geometry and releases owned resources', () => {
  const scene=new THREE.Scene(), life=new StreetLife(scene);
  assert.equal(life.group.children.length,2);
  let disposed=0;
  for (const mesh of life.group.children) {
    const p=mesh.geometry.getAttribute('position');
    assert.ok(p.count>100 && p.count<15000);
    assert.ok(Array.from(p.array).every(Number.isFinite));
    assert.ok(mesh.instanceMatrix.count<=72);
    mesh.geometry.addEventListener('dispose',()=>disposed++);
  }
  life.dispose();
  assert.equal(disposed,2);
  assert.equal(scene.children.length,0);
});
test('pedestrian admission rejects unsafe routes and does not spawn on blocked sidewalks', () => {
  const scene=new THREE.Scene(), life=new StreetLife(scene);
  const roads=[{start:new Uint32Array([0,2]),pts:new Float32Array([-60,0,60,0]),width:new Float32Array([10]),kind:new Uint8Array([0]),streetLife:new Uint8Array([1])}];
  for(let i=0;i<300;i++) life.update(.016,0,1.7,0,()=>roads,()=>false);
  assert.equal(life.group.children[0].count,0);
  assert.equal(life.group.children[1].count,0);
  life.dispose();
});
test('pointed arch remains passable and has a real opening with finite triangles', () => {
  const mesh=archWall(15,60,12,8,49,GRANITE,true);
  assert.equal(mesh.userData.passable,true);
  assert.ok(Array.from(mesh.geometry.getAttribute('position').array).every(Number.isFinite));
  const ray=new THREE.Raycaster(new THREE.Vector3(0,30,30),new THREE.Vector3(0,0,-1));
  mesh.updateMatrixWorld();
  assert.equal(ray.intersectObject(mesh).length,0);
  ray.set(new THREE.Vector3(6,30,30),new THREE.Vector3(0,0,-1));
  assert.ok(ray.intersectObject(mesh).length>0);
  mesh.geometry.dispose();
});
test('Empire State and Chrysler fitted crowns keep their real skyline heights', () => {
  const fits=require('../public/geo/landmarks-fit.json').fits;
  for (const [id,set,tip] of [['empire-state','midtown-south',443.2],['chrysler','midtown-east',319]]) {
    const {builders}=require(`../src/engine/landmarks/sets/${set}.ts`);
    const g=builders[id]({fit:fits[id],groundAt:()=>0,clearRoad:(x,z)=>[x,z]});
    const bounds=new THREE.Box3().setFromObject(g);
    assert.ok(Math.abs(bounds.max.y-tip)<1, `${id}: ${bounds.max.y}`);
    let triangles=0;
    g.traverse(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count??o.geometry.getAttribute('position').count)/3;o.geometry.dispose();}});
    assert.ok(triangles<20000, `${id}: ${triangles} triangles`);
  }
});

test('surface street admission populates bounded instances and recovers density', () => {
  const life=new StreetLife(new THREE.Scene());
  const roads=[{start:new Uint32Array([0,2]),pts:new Float32Array([-60,0,60,0]),width:new Float32Array([10]),kind:new Uint8Array([0]),streetLife:new Uint8Array([1])}];
  for(let i=0;i<300;i++) life.update(.016,0,1.7,0,()=>roads,()=>true);
  const full=life.stats(); assert.ok(full.pedestrians>0); assert.ok(full.parkedCars>0);
  life.setDensity(.4); assert.ok(life.stats().pedestrians<full.pedestrians);
  life.setDensity(1); assert.equal(life.stats().pedestrians,full.pedestrians);
  life.dispose();
});
test('plazas and bridge paths never admit curbside vehicles or pedestrians', () => {
  const life=new StreetLife(new THREE.Scene());
  const roads=[{start:new Uint32Array([0,2]),pts:new Float32Array([-60,0,60,0]),width:new Float32Array([10]),kind:new Uint8Array([0]),streetLife:new Uint8Array([0])}];
  for(let i=0;i<300;i++) life.update(.016,0,1.7,0,()=>roads,()=>true);
  assert.equal(life.stats().parkedCars,0); assert.equal(life.stats().pedestrians,0);
  life.dispose();
});
