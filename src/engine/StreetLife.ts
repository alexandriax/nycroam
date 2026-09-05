import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { RoadPaths } from './tileTypes';
import { hash01 } from './palette';
import { heightAt } from './terrain';
import { quality } from './quality';

interface Placement { x: number; y: number; z: number; yaw: number; seed: number; travel: number; }

function colored(geo: THREE.BufferGeometry, color: string, part = 0): THREE.BufferGeometry {
  const c = new THREE.Color(color), count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3), parts = new Float32Array(count);
  for (let i = 0; i < count; i++) { colors.set([c.r, c.g, c.b], i * 3); parts[i] = part; }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  return geo;
}
function join(parts: THREE.BufferGeometry[]) {
  const normalized = parts.map(p => p.index ? p.toNonIndexed() : p);
  const geo = mergeGeometries(normalized, false)!;
  new Set([...parts, ...normalized]).forEach(p => p.dispose());
  return geo;
}
function personGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = (r: number, length: number, x: number, y: number, z: number, color: string, part = 0) => {
    const geo = new THREE.CapsuleGeometry(r, length, 3, 6);
    geo.translate(x,y,z); parts.push(colored(geo,color,part));
  };
  body(.17,.34,0,1.16,0,'#c5c1b9'); // jacket, tinted per instance
  body(.11,.1,0,1.62,0,'#cfaa89');
  body(.115,.045,0,1.71,-.025,'#322b27'); // hair
  for (const side of [-1,1]) {
    const leg = side < 0 ? 1 : 2, arm = side < 0 ? 3 : 4;
    body(.072,.56,side*.1,.48,0,'#353a43',leg);
    body(.058,.43,side*.235,1.06,0,'#bcb8b2',arm);
    body(.055,.035,side*.235,.77,0,'#cfaa89',arm);
    const shoe = new THREE.BoxGeometry(.14,.09,.27); shoe.translate(side*.1,.055,.055);
    parts.push(colored(shoe,'#282a2c',leg));
  }
  return join(parts);
}
function carGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number,h: number,d: number,x: number,y: number,z: number,color: string,part = 0,r = .06) => {
    const geo = Math.min(w,h,d)<.25 ? new THREE.BoxGeometry(w,h,d) : new RoundedBoxGeometry(w,h,d,1,r); geo.translate(x,y,z); parts.push(colored(geo,color,part));
  };
  box(1.82,.56,4.55,0,.64,0,'#ffffff',1,.15);
  box(1.52,.62,2.28,0,1.13,-.16,'#293b40',0,.17); // cabin glazing
  box(1.49,.09,1.5,0,1.48,-.24,'#ffffff',1,.04);
  box(1.8,.12,4.25,0,.39,0,'#303436');
  for (const side of [-1,1]) {
    box(.07,.58,.065,side*.77,1.14,-.17,'#22272a'); // B pillars
    box(.2,.13,.25,side*.96,1.12,.67,'#ffffff',1);
    for (const z of [-1.38,1.38]) {
      const wheel = new THREE.CylinderGeometry(.32,.32,.2,14); wheel.rotateZ(Math.PI/2); wheel.translate(side*.88,.34,z);
      parts.push(colored(wheel,'#202223'));
      const hub = new THREE.CylinderGeometry(.18,.18,.215,10); hub.rotateZ(Math.PI/2); hub.translate(side*.89,.34,z);
      parts.push(colored(hub,'#8c9194'));
    }
    box(.46,.12,.07,side*.58,.79,2.27,'#e7e8da');
    box(.45,.14,.07,side*.58,.78,-2.27,'#921e1a');
    box(.14,.055,1.38,side*.91,.95,-.15,'#a6a9a7');
  }
  box(.7,.18,.06,0,.51,2.285,'#262b2d');
  box(.3,.13,.06,0,.61,-2.29,'#eee8d4'); // NY plate proportions
  return join(parts);
}

/** Local ambient pedestrians and curbside cars, batched in two draws. Walking
 * paths are checked before admission; no navigation/allocations in the frame
 * loop. Parked vehicles avoid inventing one-way traffic from incomplete OSM. */
export class StreetLife {
  readonly group = new THREE.Group();
  private people: THREE.InstancedMesh;
  private cars: THREE.InstancedMesh;
  private timer = 0;
  private anchorX = Infinity;
  private anchorZ = Infinity;
  private time = { value: 0 };
  private viewer = { value: new THREE.Vector3() };
  private matrix = new THREE.Object3D();
  private capacity = quality().population;
  private density = 1;
  private pending: Generator<void, {walkers: Placement[]; cars: Placement[]}> | null = null;
  private pendingX = 0;
  private pendingZ = 0;
  private peopleCount = 0;
  private carCount = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'Local street life';
    const pmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .92 });
    pmat.onBeforeCompile = shader => {
      shader.uniforms.uLifeTime = this.time;
      shader.uniforms.uViewer = this.viewer;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aPart; attribute vec2 aWalk;
          uniform float uLifeTime; uniform vec3 uViewer;`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float nPhase = uLifeTime * 1.12 + aWalk.y;
          float nCycle = mod(nPhase, max(aWalk.x * 2.0, 0.01));
          float nDirection = nCycle < aWalk.x ? 1.0 : -1.0;
          if (aPart > .5) {
            float nSide = mod(aPart,2.0) < .5 ? -1.0 : 1.0;
            float na = sin(nPhase*6.0)*nSide*(aPart<2.5 ? .36 : -.28);
            objectNormal.yz = mat2(cos(na),sin(na),-sin(na),cos(na))*objectNormal.yz;
          }
          objectNormal.xz *= nDirection;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float phase = uLifeTime * 1.12 + aWalk.y;
          float cycle = mod(phase, max(aWalk.x * 2.0, 0.01));
          float direction = cycle < aWalk.x ? 1.0 : -1.0;
          float distanceAlong = aWalk.x - abs(cycle - aWalk.x);
          float gait = sin(phase * 6.0);
          if (aPart > 0.5) {
            float limbSide = mod(aPart, 2.0) < .5 ? -1.0 : 1.0;
            float pivot = aPart < 2.5 ? .85 : 1.38;
            float a = gait * limbSide * (aPart < 2.5 ? .36 : -.28);
            vec2 limb = vec2(transformed.y-pivot, transformed.z);
            transformed.y = cos(a)*limb.x - sin(a)*limb.y + pivot;
            transformed.z = sin(a)*limb.x + cos(a)*limb.y;
          }
          transformed.xz *= direction;
          transformed.z += distanceAlong;
          transformed.y += abs(gait)*.018;
          vec3 origin = (modelMatrix * instanceMatrix * vec4(0,0,0,1)).xyz;
          float visibleScale = 1.0 - smoothstep(135.0, 175.0, distance(origin.xz,uViewer.xz));
          transformed.y *= visibleScale;`);
    };
    const cmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .36, metalness: .28 });
    // Only painted panels inherit vehicle color; tires, lights and glass keep theirs.
    cmat.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;')
        .replace('#include <color_vertex>', `#include <color_vertex>
          #if defined(USE_INSTANCING_COLOR) && defined(USE_COLOR)
            vColor.xyz = color * mix(vec3(1.0), instanceColor, aPart);
          #endif`);
    };
    this.people = new THREE.InstancedMesh(personGeometry(), pmat, this.capacity);
    this.cars = new THREE.InstancedMesh(carGeometry(), cmat, Math.ceil(this.capacity / 3));
    this.people.geometry.setAttribute('aWalk', new THREE.InstancedBufferAttribute(new Float32Array(this.capacity*2),2));
    for (const mesh of [this.people,this.cars]) {
      mesh.setColorAt(0, new THREE.Color(0xffffff)); // compile the final instanced-color variant at startup
      mesh.count = 0; mesh.frustumCulled = false; // bounded local instances; shader motion exceeds base geometry
      mesh.receiveShadow = true;
      // No extra moving shadow pass for ambient actors.
      this.group.add(mesh);
    }
    this.cars.castShadow = quality().shadows;
    scene.add(this.group);
  }

  invalidate() { this.anchorX = Infinity; this.pending = null; this.timer = 2; }

  stats() { return { pedestrians: this.people.count, parkedCars: this.cars.count }; }

  setDensity(value: number) {
    this.density = Math.max(.35, Math.min(1,value));
    this.people.count = Math.floor(this.peopleCount*this.density);
    this.cars.count = Math.floor(this.carCount*this.density);
  }

  update(dt: number, x: number, y: number, z: number, paths: () => RoadPaths[], safe: (x: number,z: number,clearance: number) => boolean) {
    this.time.value += Math.min(.1,dt);
    this.viewer.value.set(x,y,z);
    this.group.visible = y < heightAt(x,z)+65;
    if (!this.group.visible) return;
    if (this.pending && Math.hypot(x-this.pendingX,z-this.pendingZ)>80) this.pending=null;
    if (this.pending) {
      const deadline=performance.now()+1.5;
      do {
        const next=this.pending.next();
        if (next.done) {
          const {walkers,cars}=next.value;
          this.anchorX=this.pendingX; this.anchorZ=this.pendingZ;
          this.peopleCount=this.place(this.people,walkers,true);
          this.carCount=this.place(this.cars,cars,false);
          this.setDensity(this.density);
          this.pending=null;
          break;
        }
      } while (performance.now()<deadline);
      return;
    }
    this.timer += dt;
    if (this.timer < 2) return;
    this.timer = 0;
    if (Math.hypot(x-this.anchorX,z-this.anchorZ) < 65 && this.peopleCount > 0) return;
    this.pendingX=x; this.pendingZ=z;
    this.pending=this.admit(x,z,paths(),safe);
  }

  private *admit(x: number,z: number,paths: RoadPaths[],safe: (x:number,z:number,clearance:number)=>boolean): Generator<void,{walkers:Placement[];cars:Placement[]}> {
    const walkers: Placement[] = [], cars: Placement[] = [];
    const seen = new Set<string>();
    for (const road of paths) for (let p = 0; p < road.width.length; p++) {
      if (road.streetLife?.[p] !== 1 || road.kind[p] !== 0 || road.width[p] < 8 || road.width[p] > 18) continue;
      for (let i = road.start[p]; i+1 < road.start[p+1]; i++) {
        const ax = road.pts[i*2], az = road.pts[i*2+1], bx = road.pts[i*2+2], bz = road.pts[i*2+3];
        const len = Math.hypot(bx-ax,bz-az);
        if (len < 24) continue;
        const dx = (bx-ax)/len, dz = (bz-az)/len;
        for (let dist = 12; dist < len-12; dist += 19) for (const side of [-1,1]) {
          yield;
          const cx = ax+dx*dist, cz = az+dz*dist;
          if (Math.hypot(cx-x,cz-z) > 145) continue;
          const seed = Math.round(cx)*31+Math.round(cz)*17+side*73;
          const key = `${Math.round(cx/5)},${Math.round(cz/5)},${side}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const offset = road.width[p]/2+1.35;
          const px = cx-dz*offset*side, pz = cz+dx*offset*side;
          const travel = Math.min(8,len-dist-10);
          const gy = heightAt(px,pz);
          // Check the whole stroll, including crossing streets and terrain.
          let valid = gy > -.2;
          for (let t = 0; t <= travel && valid; t += 2) {
            const sx = px+dx*t, sz = pz+dz*t;
            valid = safe(sx,sz,.42) && Math.abs(heightAt(sx,sz)-gy) < .18;
          }
          if (valid) walkers.push({x:px,y:gy+.13,z:pz,yaw:Math.atan2(dx,dz),seed,travel});
          const curb = road.width[p]/2-1.1;
          const vx = cx-dz*curb*side, vz = cz+dx*curb*side;
          if (hash01(seed+22) > .4 && safe(vx,vz,0) && Math.abs(heightAt(vx+dx*2,vz+dz*2)-heightAt(vx-dx*2,vz-dz*2)) < .2)
            cars.push({x:vx,y:heightAt(vx,vz)+.13,z:vz,yaw:Math.atan2(dx*side,dz*side),seed,travel:0});
        }
      }
    }
    const nearest = (a: Placement,b: Placement) => Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z);
    walkers.sort(nearest); cars.sort(nearest);
    return {walkers,cars};
  }

  private place(mesh: THREE.InstancedMesh, list: Placement[], people: boolean) {
    const count = Math.min(mesh.instanceMatrix.count,list.length);
    const palette = people ? ['#969ea9','#bb9f89','#667b88','#88817b','#b5aba2','#819282']
      : ['#efb629','#e8e6de','#383e42','#727a80','#d2d1c8','#293b50','#763f37'];
    const color = new THREE.Color(), walk = mesh.geometry.getAttribute('aWalk') as THREE.InstancedBufferAttribute;
    for (let i=0;i<count;i++) {
      const p=list[i], scale=people ? .94+hash01(p.seed+1)*.12 : .96+hash01(p.seed+1)*.07;
      this.matrix.position.set(p.x,p.y,p.z); this.matrix.rotation.set(0,p.yaw,0); this.matrix.scale.setScalar(scale); this.matrix.updateMatrix();
      mesh.setMatrixAt(i,this.matrix.matrix);
      mesh.setColorAt(i,color.set(palette[Math.floor(hash01(p.seed)*palette.length)]));
      if (people) walk.setXY(i,p.travel/scale,hash01(p.seed+7)*20);
    }
    mesh.instanceMatrix.needsUpdate=true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    if (walk) walk.needsUpdate=true;
    mesh.count=count;
    return count;
  }
  dispose() {
    this.pending=null;
    this.group.removeFromParent();
    for (const mesh of [this.people,this.cars]) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose(); }
  }
}
