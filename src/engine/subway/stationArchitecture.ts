import * as THREE from 'three';
import { quality, type QualityLevel } from '../quality';
import {
  batchStaticStationMeshes,
  type StationBatchStats,
} from '../performance/stationBatch';

export interface StationCellBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface StationCellDefinition {
  id: string;
  kind: 'platform' | 'mezzanine' | 'corridor';
  bounds: StationCellBounds;
  floorY: number;
  minY: number;
  maxY: number;
}

export interface StationPortalDefinition {
  a: string;
  b: string;
  bounds: StationCellBounds;
  minY: number;
  maxY: number;
}

export interface StationVerticalPortal {
  bounds: StationCellBounds;
  topY: number;
  bottomY: number;
}

export interface StationSubmissionEstimate {
  colorDraws: number;
  shadowDraws: number;
  triangles: number;
}

export interface StationArchitectureStats {
  level: QualityLevel;
  buildMs: number;
  cellCount: number;
  portalCount: number;
  assignedMeshes: number;
  sharedMeshes: number;
  bakedGeometries: number;
  bakedVertices: number;
  instancedSourceMeshes: number;
  instancedDraws: number;
  instances: number;
  contactShadowInstances: number;
  contactShadowDraws: number;
  shadowLights: number;
  allCells: StationSubmissionEstimate;
  activeCell: StationSubmissionEstimate;
  mobileDrawTarget: number;
  desktopDrawTarget: number;
  withinMobileStaticBudget: boolean;
  withinDesktopStaticBudget: boolean;
}

export interface StationArchitectureResult {
  readonly batchStats: StationBatchStats;
  readonly stats: StationArchitectureStats;
  readonly visibility: StationVisibility;
  profile(cameraPosition?: THREE.Vector3): StationSubmissionEstimate;
  dispose(): void;
}

interface RuntimeProfileHook {
  dispose(): void;
}

type ResourceTracker = (
  resource: THREE.BufferGeometry | THREE.Material | THREE.Texture,
) => void;

interface PropAnchor {
  role: string;
  center: THREE.Vector3;
  size: THREE.Vector3;
  floorY: number;
}

interface CellRuntime {
  definition: StationCellDefinition;
  group: THREE.Group;
}

interface InstanceStats {
  sourceMeshes: number;
  draws: number;
  instances: number;
}

const EMPTY_BATCH_STATS: StationBatchStats = {
  inputMeshes: 0,
  outputMeshes: 0,
  mergedMeshes: 0,
  colorDrawsSaved: 0,
  inputShadowCasters: 0,
  outputShadowCasters: 0,
  shadowDrawsSaved: 0,
};

const SELECTED_SHADOW_ROLES: Record<QualityLevel, ReadonlySet<string>> = {
  low: new Set(),
  medium: new Set(),
  high: new Set(['pillar', 'turnstile', 'booth', 'rotogate']),
  ultra: new Set([
    'pillar', 'turnstile', 'booth', 'rotogate', 'bench', 'fare-barrier',
  ]),
};

const CONTACT_SHADOW_ROLES = new Set([
  'pillar', 'turnstile', 'booth', 'rotogate', 'bench', 'trash',
  'metrocard', 'fare-barrier',
]);

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function addBatchStats(into: StationBatchStats, next: StationBatchStats): void {
  into.inputMeshes += next.inputMeshes;
  into.outputMeshes += next.outputMeshes;
  into.mergedMeshes += next.mergedMeshes;
  into.colorDrawsSaved += next.colorDrawsSaved;
  into.inputShadowCasters += next.inputShadowCasters;
  into.outputShadowCasters += next.outputShadowCasters;
  into.shadowDrawsSaved += next.shadowDrawsSaved;
}

function propRole(object: THREE.Object3D): string | null {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    const role = cursor.userData.stationProp as string | undefined;
    if (role) return role;
    cursor = cursor.parent;
  }
  return null;
}

function collectPropAnchors(root: THREE.Object3D): PropAnchor[] {
  root.updateWorldMatrix(true, true);
  const anchors: PropAnchor[] = [];
  root.traverse((object) => {
    const role = object.userData.stationProp as string | undefined;
    if (!role || !CONTACT_SHADOW_ROLES.has(role)) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    anchors.push({ role, center, size, floorY: box.min.y });
  });
  return anchors;
}

function renderables(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh
      && !(object instanceof THREE.SkinnedMesh)
      && !object.userData.noStationOptimize
    ) {
      meshes.push(object);
    }
  });
  return meshes;
}

function staticShadowPolicy(meshes: THREE.Mesh[], level: QualityLevel): void {
  const allowed = SELECTED_SHADOW_ROLES[level];
  for (const mesh of meshes) {
    const role = propRole(mesh);
    if (role) mesh.userData.stationProp = role;
    if (!mesh.castShadow) continue;
    mesh.castShadow = role !== null && allowed.has(role);
  }
}

function enforceShadowLightLimit(scene: THREE.Scene, level: QualityLevel): number {
  const shadowLights: THREE.Light[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Light && object.castShadow) shadowLights.push(object);
  });
  const limit = level === 'low' || level === 'medium' ? 0 : 1;
  for (let i = limit; i < shadowLights.length; i++) shadowLights[i].castShadow = false;
  return Math.min(limit, shadowLights.length);
}

function bakeVertexOcclusion(
  meshes: THREE.Mesh[],
  track: ResourceTracker,
): { geometries: number; vertices: number } {
  const baked = new Set<THREE.BufferGeometry>();
  const materialClones = new Map<THREE.Material, THREE.Material>();
  let vertices = 0;

  for (const mesh of meshes) {
    if (
      mesh instanceof THREE.InstancedMesh
      || Array.isArray(mesh.material)
      || mesh.material instanceof THREE.MeshBasicMaterial
      || mesh.material.transparent
      || !mesh.geometry.getAttribute('position')
    ) continue;

    let material = materialClones.get(mesh.material);
    if (!material) {
      material = mesh.material.clone();
      // Material.clone() omits compile hooks: keep physical tile grain and
      // tactile domes when adding baked station occlusion.
      material.onBeforeCompile = mesh.material.onBeforeCompile;
      material.customProgramCacheKey = mesh.material.customProgramCacheKey;
      (material as THREE.Material & { vertexColors: boolean }).vertexColors = true;
      material.name = `${mesh.material.name || mesh.material.type}:station-vertex-ao`;
      materialClones.set(mesh.material, material);
      track(material);
    }
    mesh.material = material;

    const geometry = mesh.geometry;
    if (baked.has(geometry)) continue;
    baked.add(geometry);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const height = Math.max(0.05, box.max.y - box.min.y);
    const color = new Float32Array(position.count * 3);

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const ny = normal ? normal.getY(i) : 0;
      const low = 1 - THREE.MathUtils.clamp((y - box.min.y) / Math.max(0.3, height * 0.42), 0, 1);
      const underside = THREE.MathUtils.clamp(-ny, 0, 1);
      const wall = 1 - Math.abs(ny);
      const noise = Math.sin(x * 12.9898 + y * 37.719 + z * 78.233) * 43758.5453;
      const grain = noise - Math.floor(noise);
      const grime = 0.93 + grain * 0.07;
      const ao = THREE.MathUtils.clamp(
        (1 - low * 0.11 - underside * 0.14 - wall * 0.025) * grime,
        0.68,
        1,
      );
      // A slightly warmer floor bounce keeps the underground palette from
      // turning uniformly grey while the scalar still behaves as baked AO.
      color[i * 3] = ao;
      color[i * 3 + 1] = ao * (0.985 + (1 - Math.abs(ny)) * 0.01);
      color[i * 3 + 2] = ao * (0.96 + THREE.MathUtils.clamp(ny, 0, 1) * 0.025);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    vertices += position.count;
  }

  return { geometries: baked.size, vertices };
}

function distanceToRange(value: number, min: number, max: number): number {
  return value < min ? min - value : value > max ? value - max : 0;
}

function cellScore(cell: StationCellDefinition, point: THREE.Vector3): number {
  const dx = distanceToRange(point.x, cell.bounds.minX, cell.bounds.maxX);
  const dz = distanceToRange(point.z, cell.bounds.minZ, cell.bounds.maxZ);
  const dy = Math.abs(point.y - cell.floorY);
  return Math.hypot(dx, dz) + dy * 2.5;
}

function cellForPoint(
  cells: readonly StationCellDefinition[],
  point: THREE.Vector3,
  maxHorizontalGap = 2,
): StationCellDefinition | null {
  let best: StationCellDefinition | null = null;
  let bestScore = Infinity;
  for (const cell of cells) {
    const dx = distanceToRange(point.x, cell.bounds.minX, cell.bounds.maxX);
    const dz = distanceToRange(point.z, cell.bounds.minZ, cell.bounds.maxZ);
    if (dx > maxHorizontalGap || dz > maxHorizontalGap) continue;
    if (point.y < cell.minY - 1 || point.y > cell.maxY + 1) continue;
    const score = cellScore(cell, point);
    if (score < bestScore) {
      best = cell;
      bestScore = score;
    }
  }
  return best;
}

function movePreservingWorld(object: THREE.Object3D, parent: THREE.Object3D): void {
  object.updateWorldMatrix(true, false);
  parent.updateWorldMatrix(true, false);
  const matrix = parent.matrixWorld.clone().invert().multiply(object.matrixWorld);
  object.removeFromParent();
  parent.add(object);
  matrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
}

function partitionMeshes(
  root: THREE.Object3D,
  meshes: THREE.Mesh[],
  cells: CellRuntime[],
  overflow: THREE.Group,
): { assigned: number; shared: number } {
  root.updateWorldMatrix(true, true);
  const definitions = cells.map((cell) => cell.definition);
  let assigned = 0;
  let shared = 0;

  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const localBox = mesh.geometry.boundingBox;
    if (!localBox) {
      movePreservingWorld(mesh, overflow);
      shared++;
      continue;
    }
    const box = localBox.clone().applyMatrix4(mesh.matrixWorld);
    const center = box.getCenter(new THREE.Vector3());
    const cell = cellForPoint(definitions, center);
    const tall = cell ? box.max.y - box.min.y > (cell.maxY - cell.minY) * 1.25 : true;
    if (!cell || tall) {
      movePreservingWorld(mesh, overflow);
      shared++;
      continue;
    }
    const runtime = cells.find((candidate) => candidate.definition.id === cell.id)!;
    movePreservingWorld(mesh, runtime.group);
    assigned++;
  }
  return { assigned, shared };
}

function hashBytes(bytes: Uint8Array): number {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function geometryFingerprint(
  geometry: THREE.BufferGeometry,
  cache: Map<THREE.BufferGeometry, string>,
): string {
  const cached = cache.get(geometry);
  if (cached) return cached;
  const parts: string[] = [geometry.type, geometry.index ? 'i' : 'n'];
  for (const name of Object.keys(geometry.attributes).sort()) {
    const attribute = geometry.getAttribute(name);
    const bytes = new Uint8Array(
      attribute.array.buffer,
      attribute.array.byteOffset,
      attribute.array.byteLength,
    );
    parts.push(`${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}:${bytes.length}:${hashBytes(bytes)}`);
  }
  if (geometry.index) {
    const index = geometry.index;
    const bytes = new Uint8Array(index.array.buffer, index.array.byteOffset, index.array.byteLength);
    parts.push(`index:${bytes.length}:${hashBytes(bytes)}`);
  }
  parts.push(`groups:${JSON.stringify(geometry.groups)}`);
  const fingerprint = parts.join('|');
  cache.set(geometry, fingerprint);
  return fingerprint;
}

function instanceEligible(mesh: THREE.Mesh): boolean {
  return !(
    mesh instanceof THREE.InstancedMesh
    || mesh instanceof THREE.SkinnedMesh
    || Array.isArray(mesh.material)
    || mesh.material.transparent
    || mesh.morphTargetInfluences
    || Object.keys(mesh.geometry.morphAttributes).length > 0
    || mesh.userData.noStaticBatch
    || mesh.customDepthMaterial
    || mesh.customDistanceMaterial
  );
}

function instanceRepeatedMeshes(
  root: THREE.Group,
  threshold: number,
  retainedGeometries: Set<THREE.BufferGeometry>,
): InstanceStats {
  root.updateWorldMatrix(true, true);
  const rootInverse = root.matrixWorld.clone().invert();
  const geometryCache = new Map<THREE.BufferGeometry, string>();
  const batches = new Map<string, THREE.Mesh[]>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !instanceEligible(object)) return;
    const material = object.material as THREE.Material;
    const key = [
      material.uuid,
      geometryFingerprint(object.geometry, geometryCache),
      object.castShadow ? 1 : 0,
      object.receiveShadow ? 1 : 0,
      object.renderOrder,
      object.layers.mask,
    ].join('|');
    const batch = batches.get(key);
    if (batch) batch.push(object);
    else batches.set(key, [object]);
  });

  let sourceMeshes = 0;
  let draws = 0;
  let instances = 0;
  for (const batch of batches.values()) {
    if (batch.length < threshold) continue;
    const vertexCount = batch[0].geometry.getAttribute('position')?.count ?? 0;
    if ((batch.length - 1) * vertexCount < 96) continue;

    const first = batch[0];
    const instanced = new THREE.InstancedMesh(
      first.geometry,
      first.material as THREE.Material,
      batch.length,
    );
    retainedGeometries.add(first.geometry);
    instanced.name = `station-instance:${first.userData.stationProp || first.geometry.type}`;
    instanced.castShadow = first.castShadow;
    instanced.receiveShadow = first.receiveShadow;
    instanced.renderOrder = first.renderOrder;
    instanced.layers.mask = first.layers.mask;
    instanced.userData.stationProp = first.userData.stationProp;
    const matrix = new THREE.Matrix4();
    batch.forEach((mesh, index) => {
      matrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
      instanced.setMatrixAt(index, matrix);
      mesh.removeFromParent();
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingBox();
    instanced.computeBoundingSphere();
    root.add(instanced);
    sourceMeshes += batch.length;
    instances += batch.length;
    draws++;
  }
  return { sourceMeshes, draws, instances };
}

function addContactShadows(
  cells: CellRuntime[],
  overflow: THREE.Group,
  anchors: PropAnchor[],
  track: ResourceTracker,
): { instances: number; draws: number } {
  if (anchors.length === 0) return { instances: 0, draws: 0 };
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    uniforms: { opacity: { value: 0.24 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float opacity;
      void main() {
        vec2 d = (vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.05, dot(d, d)) * opacity;
        gl_FragColor = vec4(0.025, 0.02, 0.015, a);
      }`,
  });
  material.name = 'station-mobile-contact-shadow';
  track(geometry);
  track(material);

  const byCell = new Map<string, PropAnchor[]>();
  const definitions = cells.map((cell) => cell.definition);
  for (const anchor of anchors) {
    const cell = cellForPoint(definitions, anchor.center, 3);
    const id = cell?.id ?? '__shared__';
    const list = byCell.get(id);
    if (list) list.push(anchor);
    else byCell.set(id, [anchor]);
  }

  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const matrix = new THREE.Matrix4();
  let draws = 0;
  let instances = 0;
  for (const [id, list] of byCell) {
    const parent = id === '__shared__'
      ? overflow
      : cells.find((cell) => cell.definition.id === id)!.group;
    parent.updateWorldMatrix(true, false);
    const inverse = parent.matrixWorld.clone().invert();
    const shadow = new THREE.InstancedMesh(geometry, material, list.length);
    shadow.name = `station-contact-shadows:${id}`;
    shadow.renderOrder = 2;
    shadow.frustumCulled = true;
    list.forEach((anchor, index) => {
      const world = new THREE.Matrix4().compose(
        new THREE.Vector3(anchor.center.x, anchor.floorY + 0.012, anchor.center.z),
        quat,
        new THREE.Vector3(
          Math.max(0.42, anchor.size.x * 1.08),
          Math.max(0.42, anchor.size.z * 1.08),
          1,
        ),
      );
      matrix.multiplyMatrices(inverse, world);
      shadow.setMatrixAt(index, matrix);
    });
    shadow.instanceMatrix.needsUpdate = true;
    shadow.computeBoundingBox();
    shadow.computeBoundingSphere();
    parent.add(shadow);
    draws++;
    instances += list.length;
  }
  return { instances, draws };
}

function rectDistance(bounds: StationCellBounds, point: THREE.Vector3): number {
  return Math.hypot(
    distanceToRange(point.x, bounds.minX, bounds.maxX),
    distanceToRange(point.z, bounds.minZ, bounds.maxZ),
  );
}

export class StationVisibility {
  private readonly cells: CellRuntime[];
  private readonly portals: StationPortalDefinition[];
  private readonly revealDistance: number;
  private readonly scene: THREE.Scene;
  private readonly previousBeforeRender: THREE.Object3D['onBeforeRender'];
  private readonly renderHook: THREE.Object3D['onBeforeRender'];
  private readonly sentinel: THREE.Mesh;
  private activeId: string | null = null;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    cells: CellRuntime[],
    portals: StationPortalDefinition[],
    level: QualityLevel,
  ) {
    this.scene = scene;
    this.cells = cells;
    this.portals = portals;
    this.revealDistance = level === 'low' ? 7 : level === 'medium' ? 10 : 16;
    this.previousBeforeRender = scene.onBeforeRender;
    this.renderHook = (...args) => {
      this.previousBeforeRender.call(scene, ...args);
      const camera = args[2];
      if (camera instanceof THREE.Camera) {
        camera.getWorldPosition(_cameraWorld);
        this.update(_cameraWorld);
      }
    };
    const sentinelGeometry = new THREE.PlaneGeometry(0.001, 0.001);
    const sentinelMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
    });
    this.sentinel = new THREE.Mesh(sentinelGeometry, sentinelMaterial);
    this.sentinel.name = 'station-visibility-sentinel';
    this.sentinel.frustumCulled = false;
    this.sentinel.renderOrder = -100000;
    this.sentinel.onBeforeRender = this.renderHook;
    scene.add(this.sentinel);
  }

  update(cameraPosition: THREE.Vector3): void {
    if (this.cells.length === 0) return;
    const definitions = this.cells.map((cell) => cell.definition);
    let active = cellForPoint(definitions, cameraPosition, 4);
    if (!active) {
      active = definitions.reduce((best, cell) =>
        cellScore(cell, cameraPosition) < cellScore(best, cameraPosition) ? cell : best);
    }
    this.activeId = active.id;
    const visible = new Set<string>([active.id]);
    for (const portal of this.portals) {
      if (portal.a !== active.id && portal.b !== active.id) continue;
      if (
        cameraPosition.y < portal.minY - 2
        || cameraPosition.y > portal.maxY + 2
        || rectDistance(portal.bounds, cameraPosition) > this.revealDistance
      ) continue;
      visible.add(portal.a === active.id ? portal.b : portal.a);
    }
    for (const cell of this.cells) cell.group.visible = visible.has(cell.definition.id);
  }

  showAll(): void {
    for (const cell of this.cells) cell.group.visible = true;
  }

  get activeCellId(): string | null {
    return this.activeId;
  }

  get visibleCellIds(): string[] {
    return this.cells
      .filter((cell) => cell.group.visible)
      .map((cell) => cell.definition.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sentinel.removeFromParent();
    this.sentinel.geometry.dispose();
    (this.sentinel.material as THREE.Material).dispose();
  }
}

const _cameraWorld = new THREE.Vector3();

function portalBetweenSameLevel(
  a: StationCellDefinition,
  b: StationCellDefinition,
): StationCellBounds | null {
  if (a.kind === 'platform' && b.kind === 'platform') return null;
  const xOverlap = Math.min(a.bounds.maxX, b.bounds.maxX) - Math.max(a.bounds.minX, b.bounds.minX);
  const zOverlap = Math.min(a.bounds.maxZ, b.bounds.maxZ) - Math.max(a.bounds.minZ, b.bounds.minZ);
  const xGap = Math.max(0, Math.max(a.bounds.minX, b.bounds.minX) - Math.min(a.bounds.maxX, b.bounds.maxX));
  const zGap = Math.max(0, Math.max(a.bounds.minZ, b.bounds.minZ) - Math.min(a.bounds.maxZ, b.bounds.maxZ));
  if (xGap > 1.25 || zGap > 1.25) return null;
  if (xOverlap < 1.2 && zOverlap < 1.2) return null;

  const minX = xOverlap >= 1.2
    ? Math.max(a.bounds.minX, b.bounds.minX)
    : (Math.max(a.bounds.minX, b.bounds.minX) + Math.min(a.bounds.maxX, b.bounds.maxX)) / 2 - 0.7;
  const maxX = xOverlap >= 1.2
    ? Math.min(a.bounds.maxX, b.bounds.maxX)
    : minX + 1.4;
  const minZ = zOverlap >= 1.2
    ? Math.max(a.bounds.minZ, b.bounds.minZ)
    : (Math.max(a.bounds.minZ, b.bounds.minZ) + Math.min(a.bounds.maxZ, b.bounds.maxZ)) / 2 - 0.7;
  const maxZ = zOverlap >= 1.2
    ? Math.min(a.bounds.maxZ, b.bounds.maxZ)
    : minZ + 1.4;
  return { minX, maxX, minZ, maxZ };
}

/**
 * Build portals directly from authored cells and stair/escalator footprints.
 * Same-level platform-to-mezzanine and mezzanine-to-corridor openings are
 * inferred only where their real rectangles meet; platform boxes are never
 * connected merely because their AABBs cross.
 */
export function createStationPortals(
  cells: readonly StationCellDefinition[],
  vertical: readonly StationVerticalPortal[] = [],
): StationPortalDefinition[] {
  const portals: StationPortalDefinition[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      if (Math.abs(a.floorY - b.floorY) > 0.75) continue;
      const bounds = portalBetweenSameLevel(a, b);
      if (!bounds) continue;
      portals.push({
        a: a.id,
        b: b.id,
        bounds,
        minY: Math.min(a.floorY, b.floorY) - 0.5,
        maxY: Math.min(a.maxY, b.maxY),
      });
    }
  }

  for (const stair of vertical) {
    const center = new THREE.Vector3(
      (stair.bounds.minX + stair.bounds.maxX) / 2,
      0,
      (stair.bounds.minZ + stair.bounds.maxZ) / 2,
    );
    const atY = (y: number) => {
      center.y = y;
      return cells
        .filter((cell) =>
          distanceToRange(center.x, cell.bounds.minX, cell.bounds.maxX) < 2
          && distanceToRange(center.z, cell.bounds.minZ, cell.bounds.maxZ) < 2)
        .sort((a, b) => Math.abs(a.floorY - y) - Math.abs(b.floorY - y))[0];
    };
    const top = atY(stair.topY);
    const bottom = atY(stair.bottomY);
    if (!top || !bottom || top.id === bottom.id) continue;
    if (portals.some((portal) =>
      ((portal.a === top.id && portal.b === bottom.id)
        || (portal.a === bottom.id && portal.b === top.id))
      && portal.bounds.minX === stair.bounds.minX
      && portal.bounds.minZ === stair.bounds.minZ)) continue;
    portals.push({
      a: top.id,
      b: bottom.id,
      bounds: stair.bounds,
      minY: Math.min(stair.topY, stair.bottomY) - 0.5,
      maxY: Math.max(stair.topY, stair.bottomY) + 1,
    });
  }
  return portals;
}

function isEffectivelyVisible(object: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    if (!cursor.visible) return false;
    cursor = cursor.parent;
  }
  return true;
}

export function estimateStationSubmissions(root: THREE.Object3D): StationSubmissionEstimate {
  let colorDraws = 0;
  let shadowDraws = 0;
  let triangles = 0;
  root.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh)
      || !isEffectivelyVisible(object)
      || object.material.visible === false
    ) return;
    const geometry = object.geometry;
    const positionCount = geometry.getAttribute('position')?.count ?? 0;
    const elementCount = geometry.index?.count ?? positionCount;
    const groups = geometry.groups.length || 1;
    const materialDraws = Array.isArray(object.material)
      ? Math.min(groups, object.material.filter((material) => material.visible).length)
      : groups;
    colorDraws += materialDraws;
    if (object.castShadow) shadowDraws += materialDraws;
    const count = object instanceof THREE.InstancedMesh ? object.count : 1;
    triangles += Math.floor((elementCount / 3) * count);
  });
  return { colorDraws, shadowDraws, triangles };
}

function installRuntimeProfileHook(
  scene: THREE.Scene,
  stats: StationArchitectureStats,
  batchStats: StationBatchStats,
  visibility: StationVisibility,
): RuntimeProfileHook {
  const enabled = typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('profileSubway');
  if (!enabled) return { dispose() {} };
  let frames = 0;
  let peakCalls = 0;
  let peakTriangles = 0;
  const geometry = new THREE.PlaneGeometry(0.001, 0.001);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
  });
  const sentinel = new THREE.Mesh(geometry, material);
  sentinel.name = 'station-runtime-profile-sentinel';
  sentinel.frustumCulled = false;
  sentinel.renderOrder = 100000;
  const hook: THREE.Object3D['onAfterRender'] = (...args) => {
    const renderer = args[0];
    if (!(renderer instanceof THREE.WebGLRenderer)) return;
    frames++;
    peakCalls = Math.max(peakCalls, renderer.info.render.calls);
    peakTriangles = Math.max(peakTriangles, renderer.info.render.triangles);
    if (frames < 180) return;
    // Opt-in deterministic QA output for desktop automation and physical-phone
    // remote debugging. It captures renderer submissions, including live trains
    // and the active portal set, rather than only the constructor's static model.
    console.info('[SubwayArchitectureProfile]', JSON.stringify({
      level: stats.level,
      buildMs: Number(stats.buildMs.toFixed(2)),
      batchStats,
      architecture: {
        cells: stats.cellCount,
        portals: stats.portalCount,
        instancedSourceMeshes: stats.instancedSourceMeshes,
        instancedDraws: stats.instancedDraws,
        bakedGeometries: stats.bakedGeometries,
        bakedVertices: stats.bakedVertices,
        contactShadowDraws: stats.contactShadowDraws,
        staticActive: stats.activeCell,
      },
      runtime: {
        peakCalls,
        peakTriangles,
        visibleCells: visibility.visibleCellIds,
      },
    }));
    frames = 0;
    peakCalls = 0;
    peakTriangles = 0;
  };
  sentinel.onAfterRender = hook;
  scene.add(sentinel);
  console.info('[SubwayArchitectureBuild]', JSON.stringify({
    level: stats.level,
    buildMs: Number(stats.buildMs.toFixed(2)),
    batchStats,
    architecture: stats,
  }));
  return {
    dispose() {
      sentinel.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

export function optimizeStationArchitecture(
  scene: THREE.Scene,
  root: THREE.Group | THREE.Scene,
  cellDefinitions: readonly StationCellDefinition[],
  portals: readonly StationPortalDefinition[],
  track: ResourceTracker,
  level: QualityLevel = quality().level,
): StationArchitectureResult {
  const started = nowMs();
  const meshes = renderables(root);
  const anchors = collectPropAnchors(root);
  staticShadowPolicy(meshes, level);
  const shadowLights = enforceShadowLightLimit(scene, level);
  const baked = bakeVertexOcclusion(meshes, track);

  const cells: CellRuntime[] = cellDefinitions.map((definition) => {
    const group = new THREE.Group();
    group.name = `station-cell:${definition.id}`;
    group.userData.stationCell = definition.id;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    root.add(group);
    return { definition, group };
  });
  const overflow = new THREE.Group();
  overflow.name = 'station-cell:shared';
  overflow.userData.stationCell = 'shared';
  overflow.matrixAutoUpdate = false;
  overflow.updateMatrix();
  root.add(overflow);
  const partition = partitionMeshes(root, meshes, cells, overflow);

  const retainedGeometries = new Set<THREE.BufferGeometry>();
  const threshold = level === 'low' || level === 'medium' ? 6 : 4;
  const instanceStats: InstanceStats = { sourceMeshes: 0, draws: 0, instances: 0 };
  for (const group of [...cells.map((cell) => cell.group), overflow]) {
    const next = instanceRepeatedMeshes(group, threshold, retainedGeometries);
    instanceStats.sourceMeshes += next.sourceMeshes;
    instanceStats.draws += next.draws;
    instanceStats.instances += next.instances;
  }

  const contact = level === 'low' || level === 'medium'
    ? addContactShadows(cells, overflow, anchors, track)
    : { instances: 0, draws: 0 };

  const batchStats = { ...EMPTY_BATCH_STATS };
  for (const group of [...cells.map((cell) => cell.group), overflow]) {
    addBatchStats(batchStats, batchStaticStationMeshes(group, (geometry) => track(geometry)));
  }

  const visibility = new StationVisibility(scene, cells, [...portals], level);
  visibility.showAll();
  const allCells = estimateStationSubmissions(root);
  if (cells[0]) {
    const first = cells[0].definition;
    visibility.update(new THREE.Vector3(
      (first.bounds.minX + first.bounds.maxX) / 2,
      first.floorY + 1.65,
      (first.bounds.minZ + first.bounds.maxZ) / 2,
    ));
  }
  const activeCell = estimateStationSubmissions(root);
  const buildMs = nowMs() - started;
  const stats: StationArchitectureStats = {
    level,
    buildMs,
    cellCount: cells.length,
    portalCount: portals.length,
    assignedMeshes: partition.assigned,
    sharedMeshes: partition.shared,
    bakedGeometries: baked.geometries,
    bakedVertices: baked.vertices,
    instancedSourceMeshes: instanceStats.sourceMeshes,
    instancedDraws: instanceStats.draws,
    instances: instanceStats.instances,
    contactShadowInstances: contact.instances,
    contactShadowDraws: contact.draws,
    shadowLights,
    allCells,
    activeCell,
    mobileDrawTarget: 400,
    desktopDrawTarget: 700,
    withinMobileStaticBudget: activeCell.colorDraws < 400,
    withinDesktopStaticBudget: activeCell.colorDraws < 700,
  };
  const runtimeProfile = installRuntimeProfileHook(scene, stats, batchStats, visibility);

  return {
    batchStats,
    stats,
    visibility,
    profile(cameraPosition?: THREE.Vector3) {
      if (cameraPosition) visibility.update(cameraPosition);
      return estimateStationSubmissions(root);
    },
    dispose() {
      runtimeProfile.dispose();
      visibility.dispose();
    },
  };
}
