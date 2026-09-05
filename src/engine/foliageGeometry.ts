import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

interface CrownLobe { x: number; y: number; z: number; sx: number; sy: number; sz: number }
const random = (n: number) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

/** Opaque leaf sprays: geometric gaps and curved leaves replace solid crown
 * balloons. No alpha texture, blending, sorting, or per-leaf Object3D. */
export function buildFoliageGeometry(lobes: CrownLobe[], seed: number, sprays = 48): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], uv: number[] = [];
  const indices: number[] = [];
  const center = new THREE.Vector3(), tangent = new THREE.Vector3(), bitangent = new THREE.Vector3();
  const axis = new THREE.Vector3(), point = new THREE.Vector3();
  for (let l = 0; l < lobes.length; l++) {
    const lobe = lobes[l];
    for (let i = 0; i < sprays; i++) {
      const r = seed + l * 331 + i * 17;
      const y = 1 - 2 * (i + .5) / sprays;
      const azimuth = i * 2.399963229728653 + seed;
      const radius = Math.sqrt(1 - y * y);
      axis.set(Math.cos(azimuth) * radius, y, Math.sin(azimuth) * radius);
      const shell = .50 + random(r) * .50;
      center.set(lobe.x + axis.x * lobe.sx * shell, lobe.y + axis.y * lobe.sy * shell + 3.15, lobe.z + axis.z * lobe.sz * shell);
      tangent.set(-axis.z, 0, axis.x).normalize();
      bitangent.crossVectors(axis, tangent).normalize();
      // Six small folded leaves spread along each twig, with no visible solid core.
      for (let leaf = 0; leaf < 6; leaf++) {
        const angle = leaf * 2.39996 + random(r + 9) * 2;
        const len = .13 + random(r + leaf + 1) * .11;
        const width = len * .52;
        const along = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
        const across = new THREE.Vector3().crossVectors(axis, along);
        const base = positions.length / 3;
        const tone = .64 + random(r + leaf + 8) * .36;
        for (const [u, v, lift] of [[0, 0, 0], [.42, -1, .01], [1, 0, 0], [.42, 1, .01], [.43, 0, .025]]) {
          point.copy(center).addScaledVector(tangent, (leaf % 3 - 1) * .19).addScaledVector(bitangent, (Math.floor(leaf / 3) - .5) * .27).addScaledVector(along, u * len).addScaledVector(across, v * width).addScaledVector(axis, lift);
          positions.push(point.x, point.y, point.z);
          normals.push(axis.x, axis.y, axis.z);
          colors.push(tone, tone * (.95 + random(r + 5) * .05), tone * .83);
          uv.push(u, v * .5 + .5);
        }
        indices.push(base, base+1, base+4, base+1, base+2, base+4, base+2, base+3, base+4, base+3, base, base+4);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Tapered trunk and primary branches, shared by every instanced species. */
export function buildTreeTrunkGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (a:THREE.Vector3,b:THREE.Vector3,r0:number,r1:number) => {
    const direction = b.clone().sub(a);
    const geometry = new THREE.CylinderGeometry(r1,r0,direction.length(),8);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()));
    geometry.translate((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2); parts.push(geometry);
  };
  add(new THREE.Vector3(0,0,0),new THREE.Vector3(.025,3.3,-.04),.17,.045);
  for(let i=0;i<7;i++) {
    const angle=i*2.39996, start=new THREE.Vector3(.01,1.5+i*.16,0);
    const end=new THREE.Vector3(Math.cos(angle)*(1+i%2*.2),2.9+i*.12,Math.sin(angle)*.95);
    add(start,end,.065-i*.005,.012);
  }
  const geometry = mergeGeometries(parts,false)!; parts.forEach(g=>g.dispose()); return geometry;
}

/** Every LOD shares a vertex-colored material. Missing attributes default to
 * black in WebGL, so solid distant crowns must supply neutral vertex colors. */
export function withFoliageColors<T extends THREE.BufferGeometry>(geometry: T): T {
  if (!geometry.getAttribute('color')) {
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(geometry.getAttribute('position').count * 3).fill(1), 3));
  }
  return geometry;
}
