import * as THREE from 'three';
import { treeLodForDistanceSq, type TreeLod } from './vegetationLod';

interface Source { mesh: THREE.InstancedMesh; matrices: Float32Array; colors: Float32Array | null }
function snapshot(mesh: THREE.InstancedMesh): Source {
  mesh.userData.dynamicVegetation = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return { mesh, matrices: mesh.instanceMatrix.array.slice() as Float32Array,
    colors: mesh.instanceColor?.array.slice() as Float32Array ?? null };
}

/** Compact the existing instance buffers by each tree's distance. No new
 * meshes/geometry allocations while walking; only changed selections upload. */
export class VegetationBatch {
  private readonly sources: Source[];
  private readonly near: (Source | null)[];
  private readonly trunks: Source;
  private readonly mid: Source;
  private readonly far: Source;
  private readonly sourceIndices: Uint32Array;
  private readonly lods: Uint8Array;
  private readonly trees: Float32Array;
  private readonly species: Uint8Array;
  constructor(
    trees: Float32Array,
    species: Uint8Array,
    trunks: THREE.InstancedMesh,
    near: (THREE.InstancedMesh | null)[],
    mid: THREE.InstancedMesh,
    far: THREE.InstancedMesh,
  ) {
    this.trees = trees; this.species = species;
    this.trunks = snapshot(trunks); this.mid = snapshot(mid); this.far = snapshot(far);
    this.near = near.map(mesh => mesh ? snapshot(mesh) : null);
    this.sources = [this.trunks, this.mid, this.far, ...this.near.filter((s): s is Source => !!s)];
    this.lods = new Uint8Array(species.length).fill(255);
    this.sourceIndices = new Uint32Array(species.length);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < species.length; i++) this.sourceIndices[i] = counts[species[i]]++;
  }
  update(x: number, y: number, z: number): void {
    let changed = false;
    for (let i = 0; i < this.species.length; i++) {
      const offset = i * 5;
      const dy = Math.max(0, Math.abs(y - (this.trees[offset + 1] + 3 * this.trees[offset + 3])) - 4);
      const distanceSq = (x - this.trees[offset]) ** 2 + (z - this.trees[offset + 2]) ** 2 + dy * dy;
      const previous = this.lods[i];
      const lod = treeLodForDistanceSq(distanceSq, previous < 3 ? previous as TreeLod : undefined);
      if (lod !== previous) { this.lods[i] = lod; changed = true; }
    }
    if (!changed) return;
    for (const { mesh } of this.sources) mesh.count = 0;
    const write = (source: Source, index: number) => {
      const target = source.mesh.count++;
      const matrices = source.mesh.instanceMatrix.array;
      for (let k = 0; k < 16; k++) matrices[target * 16 + k] = source.matrices[index * 16 + k];
      if (source.colors && source.mesh.instanceColor) {
        for (let k = 0; k < 3; k++) source.mesh.instanceColor.array[target * 3 + k] = source.colors[index * 3 + k];
      }
    };
    for (let i = 0; i < this.species.length; i++) {
      const lod = this.lods[i];
      if (lod < 2) write(this.trunks, i);
      if (lod === 0) write(this.near[this.species[i]]!, this.sourceIndices[i]);
      else write(lod === 1 ? this.mid : this.far, i);
    }
    for (const { mesh } of this.sources) {
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}
