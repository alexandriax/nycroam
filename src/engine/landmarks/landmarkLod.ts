import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { QualityLevel } from '../quality';
import { LANDMARK_SHADOW_LAYER } from './layers.js';

export { LANDMARK_SHADOW_LAYER } from './layers.js';

/**
 * These are the landmarks for which silhouette and recognition matter at
 * city-view distances. Their source remains the fitted procedural authored
 * model: converting it to a nominal glTF would discard live footprint fitting,
 * terrain placement, shared materials and exact OSM anchoring without making
 * the geometry intrinsically better.
 */
export const HERO_LANDMARK_LOD_IDS = new Set([
  'one-wtc',
  'oculus',
  'liberty-statue',
  'brooklyn-bridge',
  'washington-arch',
  'flatiron',
  'vessel',
  'edge-deck',
  'empire-state',
  'one-bryant',
  'times-square',
  'rockefeller-plaza',
  'top-of-the-rock',
  'st-patricks',
  'grand-central',
  'chrysler',
  'one-vanderbilt',
  'united-nations',
  'queensboro-bridge',
  'columbus-circle',
  'hearst-tower',
  'met-museum',
  'guggenheim',
  'gwb',
]);

export interface LandmarkLodStats {
  hero: true;
  highTriangles: number;
  midTriangles: number;
  farTriangles: number;
  shadowTriangles: number;
  highDraws: number;
  midDraws: number;
  farDraws: number;
  highGeometryBytes: number;
  midGeometryBytes: number;
  farGeometryBytes: number;
  shadowGeometryBytes: number;
  /** Extra resident geometry beyond the original close model. */
  lodOverheadGeometryBytes: number;
  /** Close + both reduced levels + shadow silhouette. */
  residentGeometryBytes: number;
  midDistance: number;
  farDistance: number;
}

interface PrimitiveMetric {
  mesh: THREE.Mesh;
  box: THREE.Box3;
  size: THREE.Vector3;
  center: THREE.Vector3;
  triangles: number;
  score: number;
  luminous: boolean;
  silhouette: boolean;
}

interface LodSelection {
  minFeature: number;
  targetRatio: number;
  maxMeshes: number;
  far: boolean;
}

const LEVEL_DISTANCE_SCALE: Record<QualityLevel, number> = {
  low: 0.55,
  medium: 0.74,
  high: 1,
  ultra: 1.22,
};

function trianglesOfGeometry(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return Math.floor((index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3);
}

function trianglesOfObject(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) total += trianglesOfGeometry(child.geometry);
  });
  return total;
}

function drawCount(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) total++;
  });
  return total;
}

function geometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.getIndex()?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += (attribute as THREE.BufferAttribute).array.byteLength;
  }
  return bytes;
}

function geometryBytesOfObject(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) total += geometryBytes(child.geometry);
  });
  return total;
}

/**
 * Landmark-local merger. This mirrors the shared kit merger's invariants but
 * intentionally keeps hero LOD construction independent from street-kit
 * modules so it stays usable in offline regression tests.
 */
function mergeVisualByMaterial(
  group: THREE.Group,
  receiveShadow: boolean,
): THREE.Group {
  group.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) return;
    const geometries = batches.get(child.material) ?? [];
    geometries.push(child.geometry.clone().applyMatrix4(child.matrixWorld));
    batches.set(child.material, geometries);
  });
  const out = new THREE.Group();
  out.name = group.name;
  for (const [material, geometries] of batches) {
    const allHaveUv = geometries.every((geometry) => geometry.getAttribute('uv'));
    for (const geometry of geometries) {
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') {
          geometry.deleteAttribute(name);
        }
      }
      if (!allHaveUv && geometry.getAttribute('uv')) geometry.deleteAttribute('uv');
      if (geometry.index === null) {
        geometry.setIndex([...Array(geometry.getAttribute('position').count).keys()]);
      }
    }
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = false;
    mesh.receiveShadow = receiveShadow;
    mesh.matrixAutoUpdate = false;
    out.add(mesh);
  }
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
  return out;
}

function isLuminous(material: THREE.Material | THREE.Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((candidate) => {
    if (candidate instanceof THREE.MeshBasicMaterial) return candidate.map !== null;
    if (
      candidate instanceof THREE.MeshStandardMaterial
      || candidate instanceof THREE.MeshPhongMaterial
      || candidate instanceof THREE.MeshLambertMaterial
    ) {
      return 'emissive' in candidate && candidate.emissive.getHex() !== 0;
    }
    return false;
  });
}

function primitiveMetrics(raw: THREE.Group): {
  metrics: PrimitiveMetric[];
  bounds: THREE.Box3;
  radius: number;
} {
  raw.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(raw);
  const extent = bounds.getSize(new THREE.Vector3());
  const edgeEpsilon = Math.max(0.08, Math.max(extent.x, extent.y, extent.z) * 0.003);
  const metrics: PrimitiveMetric[] = [];

  raw.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) return;
    const geometry = child.geometry;
    if (!geometry.getAttribute('position')) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone().applyMatrix4(child.matrixWorld);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
    const maxDim = dims[2];
    const volume = Math.max(0.001, size.x * size.y * size.z);
    const silhouette = (
      Math.abs(box.min.x - bounds.min.x) <= edgeEpsilon
      || Math.abs(box.max.x - bounds.max.x) <= edgeEpsilon
      || Math.abs(box.min.y - bounds.min.y) <= edgeEpsilon
      || Math.abs(box.max.y - bounds.max.y) <= edgeEpsilon
      || Math.abs(box.min.z - bounds.min.z) <= edgeEpsilon
      || Math.abs(box.max.z - bounds.max.z) <= edgeEpsilon
    );
    const luminous = isLuminous(child.material);
    // Screen-space value is dominated by feature span. Volume distinguishes a
    // real shaft/deck from a large but paper-thin window sheet; silhouette and
    // luminance preserve crowns, bridge cables and Times Square panels.
    const score = maxDim * maxDim
      + Math.cbrt(volume) * 7
      + (silhouette ? maxDim * 11 : 0)
      + (luminous ? maxDim * 16 + 80 : 0);
    metrics.push({
      mesh: child,
      box,
      size,
      center,
      triangles: trianglesOfGeometry(geometry),
      score,
      luminous,
      silhouette,
    });
  });

  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  return { metrics, bounds, radius: sphere.radius };
}

function selectPrimitives(
  metrics: PrimitiveMetric[],
  highTriangles: number,
  selection: LodSelection,
): PrimitiveMetric[] {
  const eligible = metrics.filter((metric) => {
    const dims = [metric.size.x, metric.size.y, metric.size.z].sort((a, b) => a - b);
    const maxDim = dims[2];
    const thicknessRatio = dims[0] / Math.max(0.001, maxDim);
    if (metric.luminous) return maxDim >= selection.minFeature * (selection.far ? 0.7 : 0.4);
    if (metric.silhouette && maxDim >= selection.minFeature * 0.55) return true;
    if (maxDim < selection.minFeature) return false;
    // Dense, paper-thin aggregate facade meshes are close-range relief rather
    // than massing. Keeping them would defeat LOD even though their AABB is big.
    if (metric.triangles > (selection.far ? 240 : 900) && thicknessRatio < 0.035) return false;
    return true;
  }).sort((a, b) => b.score - a.score);

  const fallback = metrics.slice().sort((a, b) => b.score - a.score);
  const source = eligible.length ? eligible : fallback;
  const budget = Math.max(24, Math.floor(highTriangles * selection.targetRatio));
  const picked: PrimitiveMetric[] = [];
  let triangles = 0;
  for (const metric of source) {
    if (picked.length >= selection.maxMeshes) break;
    // Always admit the first major mass. Thereafter respect the triangle
    // budget, with a small exception for a luminous or edge-defining feature.
    const beyondBudget = picked.length > 0 && triangles + metric.triangles > budget;
    if (beyondBudget && !(metric.luminous || (metric.silhouette && picked.length < 8))) continue;
    picked.push(metric);
    triangles += metric.triangles;
  }
  return picked;
}

function sourceGroupFrom(metrics: PrimitiveMetric[], name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const metric of metrics) {
    const mesh = new THREE.Mesh(
      metric.mesh.geometry.clone().applyMatrix4(metric.mesh.matrixWorld),
      metric.mesh.material,
    );
    mesh.castShadow = false;
    mesh.receiveShadow = metric.mesh.receiveShadow;
    group.add(mesh);
  }
  return group;
}

function makeShadowProxy(
  metrics: PrimitiveMetric[],
  bounds: THREE.Box3,
): THREE.Mesh {
  const candidates = metrics
    .filter((metric) => {
      const dims = [metric.size.x, metric.size.y, metric.size.z].sort((a, b) => a - b);
      const volume = metric.size.x * metric.size.y * metric.size.z;
      return dims[2] >= 3 && dims[0] >= 0.15 && (volume >= 1 || metric.silhouette);
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 36);

  const boxes = (candidates.length ? candidates : [{
    box: bounds,
    size: bounds.getSize(new THREE.Vector3()),
    center: bounds.getCenter(new THREE.Vector3()),
  }]).map((metric) => {
    const geometry = new THREE.BoxGeometry(
      Math.max(0.1, metric.size.x),
      Math.max(0.1, metric.size.y),
      Math.max(0.1, metric.size.z),
    );
    geometry.translate(metric.center.x, metric.center.y, metric.center.z);
    return geometry;
  });
  const geometry = mergeGeometries(boxes, false) ?? boxes[0];
  if (geometry !== boxes[0]) {
    for (const box of boxes) box.dispose();
  } else {
    for (let i = 1; i < boxes.length; i++) boxes[i].dispose();
  }
  geometry.computeBoundingSphere();
  // One tiny owned material per hero makes lifecycle explicit: the manager
  // disposes it when that hero streams out, independent of shared facade mats.
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: false,
    toneMapped: false,
  });
  material.name = 'NYCRoam.LandmarkShadowOnly';
  material.userData.landmarkShadowProxyOwned = true;
  const proxy = new THREE.Mesh(geometry, material);
  proxy.name = 'Landmark shadow proxy';
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.layers.set(LANDMARK_SHADOW_LAYER);
  proxy.matrixAutoUpdate = false;
  proxy.userData.landmarkShadowProxy = true;
  // It is absent from the main camera layer already; this also prevents UI
  // raycasts from ever finding an invisible shadow-only box.
  proxy.raycast = () => {};
  return proxy;
}

function applyVisualFlags(group: THREE.Group, receiveShadow: boolean): void {
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = false;
    child.receiveShadow = receiveShadow;
  });
}

/**
 * Convert one authored procedural hierarchy to close/mid/far render geometry.
 *
 * Collision must be derived from `raw` before calling this function because,
 * just like mergeByMaterial(), it consumes and disposes the source geometries.
 */
export async function buildHeroLandmarkLod(
  raw: THREE.Group,
  level: QualityLevel,
  receiveShadow: boolean,
  yieldBetween: (() => Promise<void>) | null = null,
): Promise<THREE.Group> {
  const { metrics, bounds, radius } = primitiveMetrics(raw);
  const highTriangles = metrics.reduce((sum, metric) => sum + metric.triangles, 0);
  const midMetrics = selectPrimitives(metrics, highTriangles, {
    minFeature: 0.9,
    targetRatio: 0.56,
    maxMeshes: 420,
    far: false,
  });
  const farMetrics = selectPrimitives(metrics, highTriangles, {
    minFeature: 3.2,
    targetRatio: 0.23,
    maxMeshes: 120,
    far: true,
  });

  // Clone reduced selections before the high merge consumes raw geometries.
  const midSource = sourceGroupFrom(midMetrics, `${raw.name} · mid source`);
  const farSource = sourceGroupFrom(farMetrics, `${raw.name} · far source`);
  const proxy = makeShadowProxy(metrics, bounds);

  // Three material merges can each be a few milliseconds on the densest hero.
  // LandmarkManager supplies its frame-yield hook so they never stack in one
  // animation frame; unit/offline callers omit it and stay synchronous-in-turn.
  if (yieldBetween) await yieldBetween();
  const high = mergeVisualByMaterial(raw, receiveShadow);
  if (yieldBetween) await yieldBetween();
  const mid = mergeVisualByMaterial(midSource, receiveShadow);
  if (yieldBetween) await yieldBetween();
  const far = mergeVisualByMaterial(farSource, receiveShadow);
  high.name = 'Hero landmark · close';
  mid.name = 'Hero landmark · mid';
  far.name = 'Hero landmark · silhouette';
  applyVisualFlags(high, receiveShadow);
  applyVisualFlags(mid, receiveShadow);
  applyVisualFlags(far, receiveShadow);

  const distanceScale = LEVEL_DISTANCE_SCALE[level];
  // Larger towers remain in each level farther away because their facade
  // details occupy real pixels at much greater range. Small civic monuments
  // switch early. Clamps bound both draw cost and memory-visible transitions.
  const midDistance = Math.round(
    THREE.MathUtils.clamp(Math.max(85, radius * 2.25), 85, 520) * distanceScale,
  );
  const farDistance = Math.round(
    THREE.MathUtils.clamp(Math.max(230, radius * 5.2), 230, 1250) * distanceScale,
  );

  const lod = new THREE.LOD();
  lod.name = 'Hero landmark geometric LOD';
  lod.autoUpdate = true;
  lod.addLevel(high, 0, 0.08);
  lod.addLevel(mid, midDistance, 0.1);
  lod.addLevel(far, Math.max(midDistance + 80, farDistance), 0.12);

  const out = new THREE.Group();
  out.name = raw.name;
  out.add(lod, proxy);
  const stats: LandmarkLodStats = {
    hero: true,
    highTriangles: trianglesOfObject(high),
    midTriangles: trianglesOfObject(mid),
    farTriangles: trianglesOfObject(far),
    shadowTriangles: trianglesOfGeometry(proxy.geometry),
    highDraws: drawCount(high),
    midDraws: drawCount(mid),
    farDraws: drawCount(far),
    highGeometryBytes: geometryBytesOfObject(high),
    midGeometryBytes: geometryBytesOfObject(mid),
    farGeometryBytes: geometryBytesOfObject(far),
    shadowGeometryBytes: geometryBytes(proxy.geometry),
    lodOverheadGeometryBytes: 0,
    residentGeometryBytes: 0,
    midDistance,
    farDistance: Math.max(midDistance + 80, farDistance),
  };
  stats.lodOverheadGeometryBytes = stats.midGeometryBytes
    + stats.farGeometryBytes
    + stats.shadowGeometryBytes;
  stats.residentGeometryBytes = stats.highGeometryBytes + stats.lodOverheadGeometryBytes;
  out.userData.landmarkLodStats = stats;
  return out;
}

export function landmarkLodStats(object: THREE.Object3D): LandmarkLodStats | null {
  const stats = object.userData.landmarkLodStats as LandmarkLodStats | undefined;
  return stats ? { ...stats } : null;
}

/** Dispose only per-hero materials; geometry remains owned by disposeGroup(). */
export function disposeHeroLandmarkLodMaterials(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (
        material.userData.landmarkShadowProxyOwned
        && !material.userData.landmarkShadowProxyDisposed
      ) {
        material.userData.landmarkShadowProxyDisposed = true;
        material.dispose();
      }
    }
  });
}
