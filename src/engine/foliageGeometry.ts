import * as THREE from 'three';

interface CrownLobe { x: number; y: number; z: number; sx: number; sy: number; sz: number }
const random = (n: number) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

/** Opaque leaf sprays: geometric gaps and curved leaves replace solid crown
 * balloons. No alpha texture, blending, sorting, or per-leaf Object3D. */
export function buildFoliageGeometry(lobes: CrownLobe[], seed: number, sprays = 32): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], uv: number[] = [];
  const indices: number[] = [];
  const center = new THREE.Vector3(), tangent = new THREE.Vector3(), bitangent = new THREE.Vector3();
  const axis = new THREE.Vector3(), point = new THREE.Vector3();
  for (let l = 0; l < lobes.length; l++) {
    const lobe = lobes[l];
    // A shaded inner crown fills the branch volume. The sparse leaf sprays
    // supply the silhouette, keeping total geometry bounded on mobile.
    const core = new THREE.IcosahedronGeometry(1, 0);
    const corePosition = core.getAttribute('position'), coreNormal = core.getAttribute('normal');
    for (let v = 0; v < corePosition.count; v++) {
      const index = positions.length / 3;
      positions.push(lobe.x + corePosition.getX(v) * lobe.sx * .65,
        lobe.y + 3.15 + corePosition.getY(v) * lobe.sy * .65,
        lobe.z + corePosition.getZ(v) * lobe.sz * .65);
      normals.push(coreNormal.getX(v), coreNormal.getY(v), coreNormal.getZ(v));
      colors.push(.48, .48, .38); uv.push(.5, .5); indices.push(index);
    }
    core.dispose();
    for (let i = 0; i < sprays; i++) {
      const r = seed + l * 331 + i * 17;
      const y = 1 - 2 * (i + .5) / sprays;
      const azimuth = i * 2.399963229728653 + seed;
      const radius = Math.sqrt(1 - y * y);
      axis.set(Math.cos(azimuth) * radius, y, Math.sin(azimuth) * radius);
      const shell = .70 + random(r) * .34;
      center.set(lobe.x + axis.x * lobe.sx * shell, lobe.y + axis.y * lobe.sy * shell + 3.15, lobe.z + axis.z * lobe.sz * shell);
      tangent.set(-axis.z, 0, axis.x).normalize();
      bitangent.crossVectors(axis, tangent).normalize();
      // Each spray is four broad pointed leaves around a small shared stem.
      for (let leaf = 0; leaf < 4; leaf++) {
        const angle = leaf * Math.PI * .5 + random(r + 9) * 2;
        const len = (.24 + random(r + leaf + 1) * .19) * 1.25;
        const width = len * .42;
        const along = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
        const across = new THREE.Vector3().crossVectors(axis, along);
        const base = positions.length / 3;
        const tone = .64 + random(r + leaf + 8) * .36;
        for (const [u, v, lift] of [[0, 0, 0], [.42, -1, .05], [1, 0, 0], [.42, 1, .05], [.43, 0, .09]]) {
          point.copy(center).addScaledVector(along, u * len).addScaledVector(across, v * width).addScaledVector(axis, lift);
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
  return geometry;
}
