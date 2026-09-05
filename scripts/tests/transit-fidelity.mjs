import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
registerHooks({resolve(specifier,context,next){
  try{return next(specifier,context);}catch(error){
    if(error.code==='ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`,context);
    throw error;
  }
}});
const {TrainTimeline,arrivalReadout,TRAIN_CYCLE_SECONDS,SPAWN_TO_BOARDING}=await import('../../src/engine/subway/trainTiming.ts');
const {carDims,wallSegments,trainDoorFrame,TRAIN_FLOOR_ABOVE_RAIL}=await import('../../src/engine/subway/trainGeometry.ts');
const {busSidePanel}=await import('../../src/engine/bus/geometry.ts');
const {VegetationBatch}=await import('../../src/engine/VegetationBatch.ts');
// Geometry/scheduler tests need sign-canvas allocation, not rasterized fonts.
const context=new Proxy({measureText:s=>({width:s.length*10}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),createLinearGradient:()=>({addColorStop(){}})}, {get:(o,k)=>k in o ? o[k] : ()=>{},set:(o,k,v)=>(o[k]=v,true)});
globalThis.document={createElement:()=>({getContext:()=>context,width:0,height:0})};
const {Train}=await import('../../src/engine/subway/train.ts');
const {TrainScheduler}=await import('../../src/engine/subway/scheduler.ts');

test('service minutes count gameplay seconds; Now requires a ready doorway',()=>{
  assert.deepEqual(arrivalReadout(5.01),{big:'6',unit:'MIN'});
  assert.deepEqual(arrivalReadout(.1),{big:'1',unit:'MIN'});
  assert.deepEqual(arrivalReadout(0),{big:'Now',unit:''});
  assert.equal(arrivalReadout(Infinity).big,'–');
  const clock=new TrainTimeline(); clock.update(SPAWN_TO_BOARDING-.01);
  assert.equal(clock.acceptingPassengers,false); assert.ok(clock.secondsToDoors>0);
  clock.update(.01); assert.equal(clock.acceptingPassengers,true); assert.equal(clock.secondsToDoors,0);
  clock.update(12); assert.equal(clock.acceptingPassengers,false); assert.equal(clock.secondsToDoors,Infinity);
});

test('train timeline preserves elapsed time across multiple phases and frame partitions',()=>{
  const fine=new TrainTimeline(),coarse=new TrainTimeline();
  for(let i=0;i<6000;i++)fine.update(1/60);
  coarse.update(100);
  assert.equal(fine.phase,coarse.phase); assert.ok(Math.abs(fine.elapsed-coarse.elapsed)<1e-6);
  coarse.update(-2); coarse.update(NaN); assert.equal(coarse.elapsed,100%TRAIN_CYCLE_SECONDS-19);
});

function scheduler(){
  const original=Math.random; Math.random=()=>.25;
  try{return new TrainScheduler(new THREE.Group(),{division:'IND',routes:['A','C'],name:'Canal St'},
    {trackZs:[-2.2],trackDirs:[1],platformSides:[1],portal:150,half:100,railY:-1.1},null,30);
  }finally{Math.random=original;}
}
test('all three forecast rows match actual boarding over route rotation, dwell and recycle',()=>{
  const system=scheduler(), predicted=system.arrivals().map(a=>({...a}));
  let time=0, previous=false, arrivals=[];
  for(let frame=0;frame<6600;frame++){
    system.update(1/60);time+=1/60;
    const boarding=system.boardable(0,-2.2);
    if(boarding&&!previous)arrivals.push({time,route:boarding.route});
    previous=!!boarding;
    const rows=system.arrivals();
    if(boarding) {
      assert.equal(rows[0].seconds,0);
      assert.ok(rows[1].seconds>0);
      assert.ok(Math.abs(time+rows[1].seconds-(predicted[0].seconds+arrivals.length*30))<.02);
    }
  }
  assert.ok(arrivals.length>=3);
  predicted.forEach((row,i)=>{assert.ok(Math.abs(row.seconds-arrivals[i].time)<.02); assert.equal(row.routes[0],arrivals[i].route);});
  system.dispose();
});

test('scheduler carries spawn overshoot and reseeded dwell into the next exact forecast',()=>{
  const fine=scheduler(),coarse=scheduler();
  for(let i=0;i<6000;i++)fine.update(1/60);
  for(let i=0;i<20;i++)coarse.update(5);
  fine.arrivals().forEach((a,i)=>assert.ok(Math.abs(a.seconds-coarse.arrivals()[i].seconds)<1e-5));
  coarse.seedDwell('C',1);assert.equal(coarse.boardable(0,-2.2).route,'C');
  const next=coarse.arrivals()[1];coarse.update(next.seconds);
  assert.equal(coarse.boardable(0,-2.2).route,next.routes[0]);
  fine.dispose();coarse.dispose();
});

test('car layouts match division door count and cover shell length without stray gaps',()=>{
  for(const [division,count] of [['IRT',3],['IND',4]]){
    const dimensions=carDims(division), segments=wallSegments(dimensions);
    assert.equal(dimensions.doors.length,count);
    assert.ok(Math.abs(segments.reduce((n,s)=>n+s.w,0)+count*1.3-dimensions.length)<1e-6);
    assert.ok(segments.every(s=>s.w>0));
  }
  assert.equal(TRAIN_FLOOR_ABOVE_RAIL-1.1,0,'underground and elevated platform offsets share this datum');
  const frame=trainDoorFrame();frame.computeBoundingBox();
  assert.ok(Math.abs(frame.boundingBox.min.y)<1e-6);
  assert.ok(Math.abs(frame.boundingBox.max.x-.325)<1e-6);
  frame.dispose();
});

test('station doors have complete frames, stay aligned with platform, and stop uploading when still',()=>{
  const train=new Train({division:'IND',routes:['A'],carCount:1,platformSide:1});
  const frame=train.group.getObjectByName('train-door-frame-instances');
  assert.equal(frame.count,16);
  const matrix=new THREE.Matrix4();frame.getMatrixAt(0,matrix);
  assert.ok(Math.abs(matrix.elements[13]-1.1)<1e-6);
  train.forceDwell(8); const before=frame.instanceMatrix.version;
  train.update(.1);assert.equal(frame.instanceMatrix.version,before);
  assert.equal(train.acceptingPassengers,true);
  assert.ok(train.group.children.length<40,'train keeps material batching');
  train.dispose();
});

test('bus panels physically clear the wheel and retain material between axles',()=>{
  const geometry=busSidePanel(-6,6,.62,1.06,.06);
  const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometry,material);mesh.updateMatrixWorld();
  const ray=new THREE.Raycaster(new THREE.Vector3(3.2,.8,2),new THREE.Vector3(0,0,-1));
  assert.equal(ray.intersectObject(mesh).length,0);
  ray.ray.origin.x=0;assert.ok(ray.intersectObject(mesh).length>0);
  geometry.dispose();material.dispose();
});

test('tree distance is per instance across tile boundaries, with stable buffers and hysteresis',()=>{
  const geometry=new THREE.BoxGeometry(),material=new THREE.MeshLambertMaterial();
  const mesh=()=>new THREE.InstancedMesh(geometry,material,2);
  const trunk=mesh(),near=mesh(),mid=mesh(),far=mesh();
  for(const target of [trunk,near,mid,far])for(let i=0;i<2;i++){
    target.setMatrixAt(i,new THREE.Matrix4().makeTranslation(i?500:258,0,0));
    target.setColorAt(i,new THREE.Color(i?0xff0000:0x00ff00));
  }
  const batch=new VegetationBatch(new Float32Array([258,0,0,1,.5,500,0,0,1,.5]),new Uint8Array([0,0]),trunk,[near,null,null,null],mid,far);
  batch.update(256,1.7,0);assert.equal(near.count,1);assert.equal(mid.count,1);assert.equal(trunk.count,2);
  const version=near.instanceMatrix.version;batch.update(257,1.7,0);assert.equal(near.instanceMatrix.version,version);
  batch.update(332,1.7,0);assert.equal(near.count,1,'74m retains near during hysteresis');
  batch.update(340,1.7,0);assert.equal(near.count,0);
  batch.update(490,1.7,0);assert.equal(near.count,1);
  const matrix=new THREE.Matrix4();near.getMatrixAt(0,matrix);assert.equal(matrix.elements[12],500);
  const color=new THREE.Color();near.getColorAt(0,color);assert.equal(color.getHex(),0xff0000);
  [trunk,near,mid,far].forEach(m=>m.dispose());geometry.dispose();material.dispose();
});


test('ride cabin batches fittings and moves complete paired door frames without gaps',async()=>{
  const {RideWorld}=await import('../../src/engine/subway/RideWorld.ts');
  const stations=new Map([['a',{name:'Canal St',division:'IND',layout:{bandColor:'#ad431f'}}]]);
  const ride=new RideWorld('A',1,'a',{routes:{A:{stops:['a'],t:[],color:'#0039a6'}}},stations,null);
  assert.equal(ride.doorPanels.length,16);
  for(const {mesh,home,side,dir} of ride.doorPanels){
    assert.equal(mesh.position.x,home);
    let draws=0;mesh.traverse(o=>{if(o instanceof THREE.Mesh)draws++;});
    assert.equal(draws,3,'steel, glazing and rubber seal form three batches per moving leaf');
    const steel=mesh.children[0].children.find(m=>m.material.type==='MeshStandardMaterial'&&!m.material.transparent);
    steel.geometry.computeBoundingBox();
    assert.ok(Math.abs(steel.geometry.boundingBox.max.x-.325)<1e-5);
  }
  const staticCabin=ride.scene.children.find(o=>o instanceof THREE.Group && o.children.some(m=>m.material?.type==='MeshStandardMaterial') && o.position.length()===0);
  assert.ok(staticCabin);
  assert.ok(staticCabin.children.length<20,'static cabin fittings share materials');
  ride.dispose();
});


test('distant crowns supply neutral vertex colors to the shared foliage shader',async()=>{
  const {withFoliageColors}=await import('../../src/engine/foliageGeometry.ts');
  for(const geometry of [new THREE.IcosahedronGeometry(1.45,1),new THREE.OctahedronGeometry(1.35,0)]) {
    const tinted=withFoliageColors(geometry);
    assert.equal(tinted.getAttribute('color').count,geometry.getAttribute('position').count);
    assert.ok(tinted.getAttribute('color').array.every(value=>value===1));
    const colors=tinted.getAttribute('color');colors.setX(0,.4);
    assert.equal(withFoliageColors(tinted).getAttribute('color'),colors);
    geometry.dispose();
  }
});
