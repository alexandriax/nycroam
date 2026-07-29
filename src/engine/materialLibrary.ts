import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { dataUrl } from './dataver';
import type { QualityLevel } from './quality';

export const MATERIAL_ATLAS = Object.freeze({
  width: 2048,
  height: 2048,
  grid: 4,
  cellSize: 512,
  gutter: 8,
  contentSize: 496,
});

export const SURFACE_REGION = Object.freeze({
  asphaltClean: 0,
  asphaltWorn: 1,
  concreteCool: 2,
  concreteAged: 3,
  brickRed: 4,
  brickBrown: 5,
  limestone: 6,
  paintedCastIron: 7,
  roofGravel: 8,
  roofTar: 9,
  grassLush: 10,
  grassDry: 11,
  barkGray: 12,
  barkBrown: 13,
  architecturalGlass: 14,
  neutralStone: 15,
});

export interface MaterialTierContract {
  compressedAlbedo: boolean;
  normalAtlas: boolean;
  ormAtlas: boolean;
  facadeNormals: boolean;
  pbrStreet: boolean;
  macroVariation: boolean;
  maxLibraryResidentBytes: number;
}

/**
 * Material complexity is independent of shadow policy. Medium no longer
 * receives/loses normals merely because its one street shadow is enabled.
 */
export const MATERIAL_TIER_CONTRACTS: Readonly<Record<QualityLevel, MaterialTierContract>> = Object.freeze({
  low: Object.freeze({
    compressedAlbedo: true,
    normalAtlas: false,
    ormAtlas: false,
    facadeNormals: false,
    pbrStreet: false,
    macroVariation: true,
    maxLibraryResidentBytes: 6 * 1024 * 1024,
  }),
  medium: Object.freeze({
    compressedAlbedo: true,
    normalAtlas: true,
    ormAtlas: false,
    facadeNormals: false,
    pbrStreet: false,
    macroVariation: true,
    maxLibraryResidentBytes: 12 * 1024 * 1024,
  }),
  high: Object.freeze({
    compressedAlbedo: true,
    normalAtlas: true,
    ormAtlas: true,
    facadeNormals: true,
    pbrStreet: true,
    macroVariation: true,
    maxLibraryResidentBytes: 18 * 1024 * 1024,
  }),
  ultra: Object.freeze({
    compressedAlbedo: true,
    normalAtlas: true,
    ormAtlas: true,
    facadeNormals: true,
    pbrStreet: true,
    macroVariation: true,
    maxLibraryResidentBytes: 18 * 1024 * 1024,
  }),
});

interface MaterialManifest {
  schemaVersion: number;
  atlas: {
    width: number;
    height: number;
    grid: number;
    cellSize: number;
    gutter: number;
    contentSize: number;
    regions: Record<string, { index: number; cell: number[]; metersPerRepeat: number }>;
  };
  channels: Record<string, {
    file: string;
    codec: string;
    colorSpace: string;
    sha256: string;
    bytes: number;
  }>;
  residency: {
    blockCompressedUpperBytesTotal: number;
  };
}

interface TextureSet {
  color: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
}

interface LoadedSet {
  textures: TextureSet;
  manifest: MaterialManifest;
  formats: Record<string, string>;
  diskBytes: number;
}

interface MaterialLibraryHooks {
  load?: (
    renderer: THREE.WebGLRenderer,
    level: QualityLevel,
    contract: MaterialTierContract,
  ) => Promise<LoadedSet>;
  fallback?: (level: QualityLevel, contract: MaterialTierContract) => TextureSet;
  now?: () => number;
}

export interface MaterialLibraryReport {
  status: 'idle' | 'loading' | 'compressed' | 'fallback' | 'disposed';
  source: 'neutral-loading' | 'ktx2-basis' | 'canvas-fallback' | 'disposed';
  tier: QualityLevel | null;
  atlas: typeof MATERIAL_ATLAS;
  requestedChannels: string[];
  textures: number;
  residentBytes: number;
  budgetBytes: number;
  diskBytes: number;
  formats: Record<string, string>;
  loadMs: number;
  fallbackReason: string | null;
}

const KTX2_MAGIC = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasKtx2Identifier(bytes: Uint8Array): boolean {
  if (bytes.byteLength < KTX2_MAGIC.byteLength) return false;
  return KTX2_MAGIC.every((value, index) => bytes[index] === value);
}

export function validateMaterialManifest(value: unknown): MaterialManifest {
  if (!value || typeof value !== 'object') throw new Error('material manifest is not an object');
  const manifest = value as MaterialManifest;
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported material manifest v${manifest.schemaVersion}`);
  const atlas = manifest.atlas;
  for (const [key, expected] of Object.entries(MATERIAL_ATLAS)) {
    if (atlas?.[key as keyof typeof atlas] !== expected) {
      throw new Error(`material atlas ${key} mismatch`);
    }
  }
  for (const id of ['color', 'normal', 'orm']) {
    const channel = manifest.channels?.[id];
    if (!channel || typeof channel.file !== 'string' || !channel.file.endsWith('.ktx2')) {
      throw new Error(`material channel ${id} is missing`);
    }
    if (!/^[a-f0-9]{64}$/.test(channel.sha256) || !Number.isSafeInteger(channel.bytes) || channel.bytes <= 0) {
      throw new Error(`material channel ${id} metadata is invalid`);
    }
  }
  const indices = Object.values(atlas.regions ?? {}).map((region) => region.index).sort((a, b) => a - b);
  if (indices.length !== 16 || indices.some((index, position) => index !== position)) {
    throw new Error('material atlas must contain exactly 16 unique regions');
  }
  return manifest;
}

function neutralTexture(rgba: [number, number, number, number], srgb: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function neutralSet(): TextureSet {
  return {
    color: neutralTexture([170, 170, 170, 255], true),
    normal: neutralTexture([128, 128, 255, 255], false),
    orm: neutralTexture([255, 230, 0, 255], false),
  };
}

function fallbackPixel(channel: keyof TextureSet, region: number, u: number, v: number): [number, number, number, number] {
  const bases = [
    [48, 50, 53], [58, 59, 59], [177, 176, 169], [158, 155, 145],
    [142, 73, 56], [105, 71, 53], [188, 176, 152], [84, 92, 92],
    [105, 102, 94], [54, 56, 56], [73, 101, 54], [113, 116, 67],
    [91, 76, 61], [101, 72, 46], [119, 145, 159], [151, 148, 139],
  ];
  const wave = Math.sin((u * 17.3 + v * 29.7 + region * 1.91) * Math.PI * 2);
  const grain = Math.sin((u * 97.1 - v * 83.9 + region * 7.3) * Math.PI * 2);
  if (channel === 'normal') {
    const nx = Math.max(-0.7, Math.min(0.7, wave * 0.13 + grain * 0.045));
    const ny = Math.max(-0.7, Math.min(0.7, grain * 0.11));
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    return [
      Math.round((nx * 0.5 + 0.5) * 255),
      Math.round((ny * 0.5 + 0.5) * 255),
      Math.round(nz * 255),
      255,
    ];
  }
  if (channel === 'orm') {
    const roughness = region === SURFACE_REGION.architecturalGlass ? 0.18
      : region === SURFACE_REGION.paintedCastIron ? 0.58
        : 0.86 + (region % 4) * 0.025;
    return [region === SURFACE_REGION.architecturalGlass ? 255 : 238, Math.round(roughness * 255), 0, 255];
  }
  const base = bases[region];
  const variation = wave * 8 + grain * 4;
  return [
    Math.max(0, Math.min(255, Math.round(base[0] + variation))),
    Math.max(0, Math.min(255, Math.round(base[1] + variation * 0.9))),
    Math.max(0, Math.min(255, Math.round(base[2] + variation * 0.75))),
    255,
  ];
}

function canvasFallback(channel: keyof TextureSet, size = 1024): THREE.CanvasTexture {
  if (typeof document === 'undefined') {
    throw new Error('CanvasTexture fallback requires a browser document');
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('2D canvas unavailable for material fallback');
  const image = context.createImageData(size, size);
  const cellSize = size / MATERIAL_ATLAS.grid;
  const gutter = Math.max(2, Math.round(CELL_GUTTER_FRACTION * size));
  const content = cellSize - gutter * 2;
  for (let y = 0; y < size; y++) {
    const cellY = Math.floor(y / cellSize);
    const localY = ((y - cellY * cellSize - gutter) % content + content) % content;
    for (let x = 0; x < size; x++) {
      const cellX = Math.floor(x / cellSize);
      const region = cellY * MATERIAL_ATLAS.grid + cellX;
      const localX = ((x - cellX * cellSize - gutter) % content + content) % content;
      const rgba = fallbackPixel(channel, region, localX / content, localY / content);
      const offset = (y * size + x) * 4;
      image.data.set(rgba, offset);
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = channel === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const CELL_GUTTER_FRACTION = MATERIAL_ATLAS.gutter / MATERIAL_ATLAS.width;

function fallbackSet(_level: QualityLevel, contract: MaterialTierContract): TextureSet {
  return {
    color: canvasFallback('color'),
    normal: contract.normalAtlas ? canvasFallback('normal') : neutralTexture([128, 128, 255, 255], false),
    orm: contract.ormAtlas ? canvasFallback('orm') : neutralTexture([255, 230, 0, 255], false),
  };
}

function textureBytes(texture: THREE.Texture): number {
  const mipmaps = (texture as THREE.CompressedTexture).mipmaps;
  if (Array.isArray(mipmaps) && mipmaps.length) {
    // GPU residency is one upload per mip view. Views can share a CPU backing
    // ArrayBuffer after KTX2 transcoding; deduping that buffer would omit every
    // mip after the first even though all mip levels are resident on the GPU.
    return mipmaps.reduce((sum, mip) => {
      const data = mip.data as ArrayBufferView | undefined;
      return sum + (data?.byteLength ?? 0);
    }, 0);
  }
  const image = texture.image as { width?: number; height?: number; data?: ArrayBufferView } | undefined;
  if (image?.data) return image.data.byteLength;
  if (image?.width && image?.height) {
    return Math.round(image.width * image.height * 4 * (texture.generateMipmaps ? 4 / 3 : 1));
  }
  return 0;
}

function uniqueTextureBytes(textures: TextureSet): { count: number; bytes: number } {
  const unique = new Set(Object.values(textures));
  return {
    count: unique.size,
    bytes: [...unique].reduce((sum, texture) => sum + textureBytes(texture), 0),
  };
}

function formatName(format: number): string {
  const names = new Map<number, string>([
    [THREE.RGBA_ASTC_4x4_Format, 'ASTC_4x4'],
    [THREE.RGBA_BPTC_Format, 'BC7'],
    [THREE.RGB_S3TC_DXT1_Format, 'BC1'],
    [THREE.RGBA_S3TC_DXT5_Format, 'BC3'],
    [THREE.RGB_ETC2_Format, 'ETC2_RGB'],
    [THREE.RGBA_ETC2_EAC_Format, 'ETC2_RGBA'],
    [THREE.RGB_ETC1_Format, 'ETC1_RGB'],
    [THREE.RGBAFormat, 'RGBA8'],
  ]);
  return names.get(format) ?? `format-${format}`;
}

async function defaultLoad(
  renderer: THREE.WebGLRenderer,
  level: QualityLevel,
  contract: MaterialTierContract,
): Promise<LoadedSet> {
  const response = await fetch(dataUrl('/materials/manifest.json'));
  if (!response.ok) throw new Error(`material manifest request failed (${response.status})`);
  const manifest = validateMaterialManifest(await response.json());
  const loader = new KTX2Loader()
    .setTranscoderPath('/materials/basis/')
    .setWorkerLimit(level === 'low' || level === 'medium' ? 1 : 2)
    .detectSupport(renderer);
  const requested = ['color', ...(contract.normalAtlas ? ['normal'] : []), ...(contract.ormAtlas ? ['orm'] : [])];
  const loaded = new Map<string, THREE.Texture>();
  try {
    await Promise.all(requested.map(async (channel) => {
      const meta = manifest.channels[channel];
      const texture = await loader.loadAsync(dataUrl(`/materials/${meta.file}`));
      texture.colorSpace = channel === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), level === 'low' ? 2 : level === 'medium' ? 4 : 8);
      texture.needsUpdate = true;
      loaded.set(channel, texture);
    }));
  } catch (error) {
    for (const texture of loaded.values()) texture.dispose();
    throw error;
  } finally {
    loader.dispose();
  }
  const color = loaded.get('color');
  if (!color) throw new Error('compressed material color atlas did not load');
  const normal = loaded.get('normal') ?? neutralTexture([128, 128, 255, 255], false);
  const orm = loaded.get('orm') ?? neutralTexture([255, 230, 0, 255], false);
  const textures = { color, normal, orm };
  return {
    textures,
    manifest,
    formats: Object.fromEntries([...loaded].map(([channel, texture]) => [
      channel,
      formatName(texture.format),
    ])),
    diskBytes: requested.reduce((sum, channel) => sum + manifest.channels[channel].bytes, 0),
  };
}

export class MaterialLibrary {
  readonly colorUniform: THREE.IUniform<THREE.Texture>;
  readonly normalUniform: THREE.IUniform<THREE.Texture>;
  readonly ormUniform: THREE.IUniform<THREE.Texture>;
  private textures: TextureSet;
  private status: MaterialLibraryReport['status'] = 'idle';
  private source: MaterialLibraryReport['source'] = 'neutral-loading';
  private level: QualityLevel | null = null;
  private contract: MaterialTierContract = MATERIAL_TIER_CONTRACTS.low;
  private promise: Promise<void> | null = null;
  private generation = 0;
  private diskBytes = 0;
  private formats: Record<string, string> = {};
  private loadMs = 0;
  private fallbackReason: string | null = null;
  private readonly hooks: MaterialLibraryHooks;

  constructor(hooks: MaterialLibraryHooks = {}) {
    this.hooks = hooks;
    this.textures = neutralSet();
    this.colorUniform = { value: this.textures.color };
    this.normalUniform = { value: this.textures.normal };
    this.ormUniform = { value: this.textures.orm };
  }

  initialize(renderer: THREE.WebGLRenderer, level: QualityLevel): Promise<void> {
    if (this.promise && this.level === level && this.status !== 'disposed') return this.promise;
    if (this.status === 'disposed') {
      this.textures = neutralSet();
      this.setTextures(this.textures);
    }
    this.level = level;
    this.contract = MATERIAL_TIER_CONTRACTS[level];
    this.status = 'loading';
    this.source = 'neutral-loading';
    this.fallbackReason = null;
    const generation = ++this.generation;
    const started = (this.hooks.now ?? performance.now.bind(performance))();
    const load = this.hooks.load ?? defaultLoad;
    this.promise = load(renderer, level, this.contract)
      .then((loaded) => {
        if (generation !== this.generation) {
          this.disposeSet(loaded.textures);
          return;
        }
        this.replaceTextures(loaded.textures);
        this.diskBytes = loaded.diskBytes;
        this.formats = loaded.formats;
        this.status = 'compressed';
        this.source = 'ktx2-basis';
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.fallbackReason = error instanceof Error ? error.message : String(error);
        const createFallback = this.hooks.fallback ?? fallbackSet;
        this.replaceTextures(createFallback(level, this.contract));
        this.diskBytes = 0;
        this.formats = { color: 'CanvasTexture', ...(this.contract.normalAtlas ? { normal: 'CanvasTexture' } : {}), ...(this.contract.ormAtlas ? { orm: 'CanvasTexture' } : {}) };
        this.status = 'fallback';
        this.source = 'canvas-fallback';
      })
      .finally(() => {
        if (generation === this.generation) {
          this.loadMs = (this.hooks.now ?? performance.now.bind(performance))() - started;
        }
      });
    return this.promise;
  }

  report(): MaterialLibraryReport {
    const residency = uniqueTextureBytes(this.textures);
    return {
      status: this.status,
      source: this.source,
      tier: this.level,
      atlas: MATERIAL_ATLAS,
      requestedChannels: [
        'color',
        ...(this.contract.normalAtlas ? ['normal'] : []),
        ...(this.contract.ormAtlas ? ['orm'] : []),
      ],
      textures: residency.count,
      residentBytes: residency.bytes,
      budgetBytes: this.contract.maxLibraryResidentBytes,
      diskBytes: this.diskBytes,
      formats: { ...this.formats },
      loadMs: this.loadMs,
      fallbackReason: this.fallbackReason,
    };
  }

  dispose(): void {
    this.generation++;
    this.promise = null;
    this.disposeSet(this.textures);
    this.status = 'disposed';
    this.source = 'disposed';
    this.diskBytes = 0;
    this.formats = {};
    this.colorUniform.value = this.normalUniform.value = this.ormUniform.value = null as unknown as THREE.Texture;
  }

  private replaceTextures(next: TextureSet): void {
    const previous = this.textures;
    this.textures = next;
    this.setTextures(next);
    this.disposeSet(previous, new Set(Object.values(next)));
  }

  private setTextures(textures: TextureSet): void {
    this.colorUniform.value = textures.color;
    this.normalUniform.value = textures.normal;
    this.ormUniform.value = textures.orm;
  }

  private disposeSet(textures: TextureSet, retained = new Set<THREE.Texture>()): void {
    for (const texture of new Set(Object.values(textures))) {
      if (!retained.has(texture)) texture.dispose();
    }
  }
}

export const materialLibrary = new MaterialLibrary();

/** GLSL helpers shared by all tile materials; 8px wrapped gutters stop bleed. */
export const MATERIAL_ATLAS_GLSL = `
vec2 nycAtlasUv(vec2 repeatUv, float region) {
  vec2 cell = vec2(mod(region, 4.0), floor(region / 4.0));
  vec2 inner = vec2(${(MATERIAL_ATLAS.gutter / MATERIAL_ATLAS.width).toFixed(10)})
    + fract(repeatUv) * ${(MATERIAL_ATLAS.contentSize / MATERIAL_ATLAS.width).toFixed(10)};
  return cell * 0.25 + inner;
}
float nycMacroVariation(vec2 worldPosition) {
  float broad = sin(worldPosition.x * 0.017 + worldPosition.y * 0.011);
  float cross = sin(worldPosition.x * -0.009 + worldPosition.y * 0.023 + 1.7);
  return clamp(0.965 + broad * 0.026 + cross * 0.018, 0.91, 1.03);
}`;
