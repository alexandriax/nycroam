import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
registerHooks({resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
}});
const { PassengerNavigation, canExchangePassengers } = await import('../../src/engine/subway/passengerNavigation.ts');
const { TransitPassengerBatch } = await import('../../src/engine/subway/transitPassengers.ts');
const { StationPassengers } = await import('../../src/engine/subway/StationPassengers.ts');

const platform = { minX: -70, maxX: 70, minZ: 1.58, maxZ: 7, y: 0, holes: [{ minX: 15, maxX: 21, minZ: 3, maxZ: 5.6 }] };
test('passenger paths keep shoulders off tracks and route around authored stair holes', () => {
  const nav = new PassengerNavigation(platform);
  assert.equal(nav.valid({ x: 0, z: 1.7 }), false);
  assert.equal(nav.valid({ x: 18, z: 4 }), false);
  const a = { x: 12, z: 4.1 }, b = { x: 25, z: 4.1 };
  assert.equal(nav.clear(a,b), false);
  const path = nav.path(a,b);
  assert.ok(path?.length > 1);
  let prev = a;
  for (const point of path) { assert.equal(nav.clear(prev,point), true); prev = point; }
  assert.equal(nav.path(a,{ x: 18, z: 4 }), null);
});

test('passenger doorway gate requires fully open doors and time to clear the path', () => {
  assert.equal(canExchangePassengers(false,20,2), false);
  assert.equal(canExchangePassengers(true,2,3), false);
  assert.equal(canExchangePassengers(true,5,3), true);
});

test('crowd animation packs fixed geometry and two reusable instance buffers', () => {
  const scene = new THREE.Group(), batch = new TransitPassengerBatch(scene,12,83);
  const body = batch.body.geometry, skin = batch.skin.geometry;
  const matrices = batch.body.instanceMatrix.array, pose = body.getAttribute('transitPose').array;
  for (let frame = 0; frame < 300; frame++) {
    for (let i = 0; i < 12; i++) batch.set(i,{ x:i, y:0, z:Math.sin(frame/100), yaw:0, seated:i%2===0, walk:i%2 });
    batch.update(frame/60); batch.commit(12);
  }
  assert.equal(batch.group.children.length,2);
  assert.equal(batch.body.geometry,body); assert.equal(batch.skin.geometry,skin);
  assert.equal(batch.body.instanceMatrix.array,matrices); assert.equal(body.getAttribute('transitPose').array,pose);
  assert.equal(batch.body.count,12); assert.ok(batch.body.boundingSphere.radius>5);
  batch.dispose(); batch.dispose(); assert.equal(scene.children.length,0);
});

function fakeTrain() {
  const group = new THREE.Group();
  group.position.set(-45,-1.1,0);
  return { group, acceptingPassengers:false, passengerBoardingRemaining:0,
    passengerLayout:{width:3,cars:Array.from({length:8},(_,i)=>({x:i*13,doors:[i*13-4,i*13,i*13+4],seatX:i*13+2}))} };
}
test('station commuters alight at central actual doors, board afterwards, and remain bounded through recycling', () => {
  const group = new THREE.Group(), crowd = new StationPassengers(group,[platform],'test-station',1);
  const train = fakeTrain(), live = {train,trackZ:0,platformSide:1,timeScale:1};
  crowd.update(.3,[live]);
  const capacity = crowd.people.length;
  assert.ok(crowd.people.some(p=>p.state==='onboard'));
  for(let i=0;i<10;i++) crowd.update(.1,[live]);
  assert.equal(crowd.people.some(p=>p.state==='boarding'||p.state==='alighting'),false);
  train.acceptingPassengers=true; train.passengerBoardingRemaining=12;
  crowd.update(.3,[live]);
  const leaving=crowd.people.filter(p=>p.state==='alighting');
  assert.ok(leaving.length>0); assert.ok(leaving.some(p=>Math.abs(p.x-4)<15));
  for(const p of leaving) {
    assert.equal(p.path[0].z,1.5);
    assert.ok(train.passengerLayout.cars.some(car=>car.doors.some(dx=>Math.abs(dx+train.group.position.x-p.path[0].x)<1e-8)));
  }
  // Put two waiting commuters beside those doors to exercise the inverse flow.
  const waiting=crowd.people.filter(p=>p.state==='waiting').slice(0,leaving.length);
  waiting.forEach((p,i)=>{p.x=leaving[i].x+.8;p.z=2.7;p.timer=10;});
  let sawBoarding=false;
  for(let i=0;i<90;i++){ train.passengerBoardingRemaining-=.1;crowd.update(.1,[live]);sawBoarding ||= crowd.people.some(p=>p.state==='boarding'); }
  assert.equal(sawBoarding,true);
  train.acceptingPassengers=false;train.passengerBoardingRemaining=0;
  crowd.update(.1,[live]);
  assert.equal(crowd.people.some(p=>p.state==='boarding'||p.state==='alighting'),false);
  for(let i=0;i<20;i++){crowd.update(.3,[]);crowd.update(.3,[{...live,train:fakeTrain()}]);}
  assert.equal(crowd.people.length,capacity); assert.equal(crowd.batch.group.children.length,2);
  crowd.dispose(); assert.equal(group.children.length,0);
});

const { RidePassengers } = await import('../../src/engine/subway/RidePassengers.ts');
test('ride seating uses distinct bench positions and replacement riders follow changing platform sides', () => {
  for (const bays of [[-4.158,0,4.158],[-6.188,-2.062,2.062,6.188]]) {
    const group = new THREE.Group(), crowd = new RidePassengers(group,bays.length===3?15.4:18.2,2.96,bays,91);
    const seats = crowd.riders.filter(p=>p.seated);
    assert.equal(new Set(seats.map(p=>`${p.x}/${p.z}`)).size,seats.length);
    crowd.update(4,{stationId:'A',platformSide:1,doorOpenAmt:1,state:'dwell',boardingRemaining:4});
    crowd.update(4,{stationId:'A',platformSide:1,doorOpenAmt:0,state:'travel',boardingRemaining:0});
    crowd.update(1,{stationId:'B',platformSide:-1,doorOpenAmt:0,state:'travel',boardingRemaining:0});
    const outsiders=crowd.riders.filter(p=>!p.seated&&Math.abs(p.z)>1.48);
    assert.ok(outsiders.every(p=>p.z<0));
    crowd.update(.2,{stationId:'B',platformSide:-1,doorOpenAmt:1,state:'dwell',boardingRemaining:8});
    assert.ok(crowd.riders.filter(p=>!p.seated&&Math.abs(p.z)>1.48).every(p=>p.z<0));
    crowd.dispose();
  }
});

test('mezzanine walkers share the platform batch but cannot exchange with trains on another floor', () => {
  const group=new THREE.Group();
  const mezz={minX:-30,maxX:30,minZ:.5,maxZ:6,y:5,holes:[{minX:10,maxX:16,minZ:1,maxZ:3}],boarding:false};
  const crowd=new StationPassengers(group,[platform,mezz],'concourse',1);
  assert.ok(crowd.people.some(p=>p.state==='waiting'&&p.platform===1&&p.y===5));
  const train=fakeTrain();train.acceptingPassengers=true;train.passengerBoardingRemaining=10;
  crowd.update(.3,[{train,trackZ:0,platformSide:1,timeScale:1}]);
  assert.ok(crowd.people.filter(p=>p.state==='alighting'||p.state==='boarding').every(p=>p.platform===0&&p.y===0));
  assert.equal(crowd.batch.group.children.length,2);
  crowd.dispose();
});

test('seated limb joints tag complete triangles, preserving connected authored segments',()=>{
  const group=new THREE.Group(),batch=new TransitPassengerBatch(group,1,1);
  const g=batch.body.geometry,joints=g.getAttribute('crowdJoint'),index=g.index;
  assert.ok(joints);
  for(let i=0;i<index.count;i+=3){
    const a=joints.getX(index.getX(i));
    assert.equal(joints.getX(index.getX(i+1)),a);assert.equal(joints.getX(index.getX(i+2)),a);
  }
  batch.set(0,{x:0,y:0,z:0,yaw:0,seated:true,driving:true});batch.commit(1);
  assert.equal(g.getAttribute('transitPose').itemSize,4);
  assert.equal(g.getAttribute('transitPose').getW(0),1);
  batch.dispose();
});
