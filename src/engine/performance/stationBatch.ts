import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface StationBatchStats {
  inputMeshes: number;
  outputMeshes: number;
  mergedMeshes: number;
  colorDrawsSaved: number;
  inputShadowCasters: number;
  outputShadowCasters: number;
  shadowDrawsSaved: number;
}

interface Batch {
  meshes: THREE.Mesh[];
  material: THREE.Material;
}

function attributeSignature(geometry: THREE.BufferGeometry): string {
  const attrs = Object.keys(geometry.attributes).sort().map((name) => {
    const attr = geometry.getAttribute(name);
    return `${name}:${attr.itemSize}:${attr.normalized ? 1 : 0}`;
  }).join(',');
  return `${geometry.index ? 'i' : 'n'}|${attrs}`;
}

function eligible(mesh: THREE.Mesh): boolean {
  if (
    mesh instanceof THREE.InstancedMesh
    || mesh instanceof THREE.SkinnedMesh
    || Array.isArray(mesh.material)
    || mesh.material.transparent
    || mesh.morphTargetInfluences
    || Object.keys(mesh.geometry.morphAttributes).length > 0
    || mesh.userData.noStaticBatch
    || mesh.customDepthMaterial
    || mesh.customDistanceMaterial
  ) return false;
  const range = mesh.geometry.drawRange;
  const available = mesh.geometry.index?.count
    ?? mesh.geometry.getAttribute('position')?.count
    ?? 0;
  return range.start === 0 && (range.count === Infinity || range.count >= available);
}

/**
 * Collapse a built station's immutable meshes by material and shadow role.
 *
 * Transparent props remain separate for correct sorting. Dynamic trains are
 * attached after station construction and are therefore outside `root`.
 */
export function batchStaticStationMeshes(
  root: THREE.Object3D,
  trackGeometry?: (geometry: THREE.BufferGeometry) => void,
): StationBatchStats {
  root.updateWorldMatrix(true, true);
  const rootInverse = root.matrixWorld.clone().invert();
  const batches = new Map<string, Batch>();
  const allMeshes: THREE.Mesh[] = [];
  const sourceReferenceCounts = new Map<THREE.BufferGeometry, number>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    allMeshes.push(object);
    sourceReferenceCounts.set(
      object.geometry,
      (sourceReferenceCounts.get(object.geometry) ?? 0) + 1,
    );
    if (!eligible(object)) return;
    const material = object.material as THREE.Material;
    const key = [
      material.uuid,
      attributeSignature(object.geometry),
      object.castShadow ? 1 : 0,
      object.receiveShadow ? 1 : 0,
      object.renderOrder,
      object.layers.mask,
    ].join('|');
    const batch = batches.get(key);
    if (batch) batch.meshes.push(object);
    else batches.set(key, { meshes: [object], material });
  });

  let mergedMeshes = 0;
  let outputBatches = 0;
  let mergedShadowInputs = 0;
  let outputShadowBatches = 0;
  for (const batch of batches.values()) {
    if (batch.meshes.length < 2) continue;
    const transformed: THREE.BufferGeometry[] = [];
    for (const mesh of batch.meshes) {
      const toRoot = rootInverse.clone().multiply(mesh.matrixWorld);
      transformed.push(mesh.geometry.clone().applyMatrix4(toRoot));
    }
    const merged = mergeGeometries(transformed, false);
    for (const geometry of transformed) geometry.dispose();
    if (!merged) continue;

    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const first = batch.meshes[0];
    const replacement = new THREE.Mesh(merged, batch.material);
    replacement.name = `station-batch:${batch.material.name || batch.material.type}`;
    replacement.castShadow = first.castShadow;
    replacement.receiveShadow = first.receiveShadow;
    replacement.renderOrder = first.renderOrder;
    replacement.layers.mask = first.layers.mask;
    replacement.matrixAutoUpdate = false;
    replacement.updateMatrix();
    root.add(replacement);
    trackGeometry?.(merged);

    for (const mesh of batch.meshes) {
      mesh.parent?.remove(mesh);
      const remaining = (sourceReferenceCounts.get(mesh.geometry) ?? 1) - 1;
      sourceReferenceCounts.set(mesh.geometry, remaining);
      if (remaining === 0) mesh.geometry.dispose();
    }
    mergedMeshes += batch.meshes.length;
    outputBatches++;
    if (first.castShadow) {
      mergedShadowInputs += batch.meshes.length;
      outputShadowBatches++;
    }
  }

  const outputMeshes = allMeshes.length - mergedMeshes + outputBatches;
  const inputShadowCasters = allMeshes.filter((mesh) => mesh.castShadow).length;
  const outputShadowCasters = inputShadowCasters - mergedShadowInputs + outputShadowBatches;
  return {
    inputMeshes: allMeshes.length,
    outputMeshes,
    mergedMeshes,
    colorDrawsSaved: allMeshes.length - outputMeshes,
    inputShadowCasters,
    outputShadowCasters,
    shadowDrawsSaved: inputShadowCasters - outputShadowCasters,
  };
}
