import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as THREE from 'three';

// Node's native type stripping does not add TypeScript's bundler-style
// extension resolution. Keep the production imports untouched and supply the
// one missing resolution step only inside this test process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      if (specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      if (/^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  MATERIAL_ATLAS,
  MATERIAL_TIER_CONTRACTS,
  MaterialLibrary,
  hasKtx2Identifier,
  materialLibrary,
  validateMaterialManifest,
} = await import('../../src/engine/materialLibrary.ts');
const {
  makeFacadeMaterial,
  makeFlatMaterial,
  makeRoadMaterial,
  makeWalkMaterial,
  treeTrunkMaterial,
} = await import('../../src/engine/materials.ts');
const { manifestRegions } = await import('../materials/surface-library.mjs');

const materialDirectory = new URL('../../public/materials/', import.meta.url);
const manifest = validateMaterialManifest(JSON.parse(
  readFileSync(new URL('manifest.json', materialDirectory), 'utf8'),
));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const exactChannels = {
  color: {
    bytes: 410967,
    sha256: 'fa1a60ac011675f2b655b408d986f6189ffe7fbaffaa0a0af54aab61f1ed0f93',
    supercompression: 1, // KTX_SS_BASIS_LZ / ETC1S
  },
  normal: {
    bytes: 2752606,
    sha256: 'd2a836317b45f992271c989695a316abfeaab1818315150f1e88a21b0d50ec5f',
    supercompression: 2, // KTX_SS_ZSTANDARD / UASTC
  },
  orm: {
    bytes: 1057127,
    sha256: '50a3ca7e38517fc6404fd0fa9e7be2807e6ac92d5eb3875247a4b303f719fd41',
    supercompression: 2,
  },
};

test('shipping material assets are exact, real mipmapped KTX2 payloads', () => {
  for (const [channel, expected] of Object.entries(exactChannels)) {
    const metadata = manifest.channels[channel];
    const bytes = readFileSync(new URL(metadata.file, materialDirectory));
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(hasKtx2Identifier(bytes), true, `${channel} KTX2 identifier`);
    assert.equal(bytes.byteLength, expected.bytes, `${channel} exact byte size`);
    assert.equal(metadata.bytes, expected.bytes, `${channel} manifest byte size`);
    assert.equal(sha256(bytes), expected.sha256, `${channel} exact SHA-256`);
    assert.equal(metadata.sha256, expected.sha256, `${channel} manifest SHA-256`);
    assert.equal(header.getUint32(20, true), 2048, `${channel} width`);
    assert.equal(header.getUint32(24, true), 2048, `${channel} height`);
    assert.equal(header.getUint32(40, true), 12, `${channel} full mip chain`);
    assert.equal(
      header.getUint32(44, true),
      expected.supercompression,
      `${channel} supercompression scheme`,
    );
  }

  assert.deepEqual(manifest.atlas, {
    ...MATERIAL_ATLAS,
    regions: manifestRegions(),
  });
  assert.equal(manifest.encoder.project, 'BinomialLLC/basis_universal');
  assert.equal(manifest.encoder.version, 'v2_1_0');
  assert.equal(manifest.encoder.commit, '45d5f41015eecd9570d5a3f89ab9cc0037a25063');
  assert.equal(
    manifest.encoder.wasiSha256,
    'ab6e242096c8bf2bba351fa9a5b8e2d9e624669d76a823bbf181e559bea10ae7',
  );
  assert.deepEqual(manifest.transcoder, {
    'basis_transcoder.js': {
      bytes: 57529,
      sha256: '8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
    },
    'basis_transcoder.wasm': {
      bytes: 527333,
      sha256: '6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a',
    },
  });
});

test('material tier contracts stay within mobile and desktop residency budgets', () => {
  const fallbackAtlasBytes = manifest.residency.runtimeCanvasFallbackBytesPerAtlas;
  const compressedAtlasBytes = manifest.residency.blockCompressedUpperBytesPerAtlas;
  assert.equal(manifest.residency.runtimeCanvasFallbackAtlasSize, 1024);
  assert.equal(fallbackAtlasBytes, 5592405);
  assert.equal(compressedAtlasBytes, 5592405);

  const expected = {
    low: { channels: 1, normal: false, orm: false, pbr: false, budget: 6 },
    medium: { channels: 2, normal: true, orm: false, pbr: false, budget: 12 },
    high: { channels: 3, normal: true, orm: true, pbr: true, budget: 18 },
    ultra: { channels: 3, normal: true, orm: true, pbr: true, budget: 18 },
  };
  for (const [level, values] of Object.entries(expected)) {
    const contract = MATERIAL_TIER_CONTRACTS[level];
    assert.equal(contract.normalAtlas, values.normal, `${level} normal contract`);
    assert.equal(contract.ormAtlas, values.orm, `${level} ORM contract`);
    assert.equal(contract.pbrStreet, values.pbr, `${level} street BRDF contract`);
    assert.equal(contract.maxLibraryResidentBytes, values.budget * 1024 * 1024);
    assert.ok(values.channels * compressedAtlasBytes <= contract.maxLibraryResidentBytes);
    assert.ok(values.channels * fallbackAtlasBytes <= contract.maxLibraryResidentBytes);
    assert.equal('shadows' in contract, false, `${level} material cost is shadow-independent`);
  }
});

function fakeCompressedTexture() {
  // One backing store with three views is intentional: GPU residency counts all
  // mip uploads, while a CPU ArrayBuffer-dedup algorithm would under-report it.
  const backing = new ArrayBuffer(96);
  const mipmaps = [
    { data: new Uint8Array(backing, 0, 64), width: 8, height: 8 },
    { data: new Uint8Array(backing, 64, 24), width: 4, height: 4 },
    { data: new Uint8Array(backing, 88, 8), width: 2, height: 2 },
  ];
  return new THREE.CompressedTexture(
    mipmaps,
    8,
    8,
    THREE.RGBA_ASTC_4x4_Format,
  );
}

test('compressed load swaps shared uniforms in place, deduplicates residency, and disposes once', async () => {
  const texture = fakeCompressedTexture();
  let disposals = 0;
  texture.addEventListener('dispose', () => { disposals++; });
  const times = [100, 127.5];
  const library = new MaterialLibrary({
    now: () => times.shift() ?? 127.5,
    load: async () => ({
      textures: { color: texture, normal: texture, orm: texture },
      manifest,
      formats: { color: 'ASTC_4x4', normal: 'ASTC_4x4', orm: 'ASTC_4x4' },
      diskBytes: 4220700,
    }),
  });
  const sharedColorUniform = library.colorUniform;
  const loadingTexture = sharedColorUniform.value;

  await library.initialize({}, 'high');

  assert.equal(library.colorUniform, sharedColorUniform);
  assert.notEqual(sharedColorUniform.value, loadingTexture);
  assert.equal(sharedColorUniform.value, texture);
  assert.equal(library.normalUniform.value, texture);
  assert.equal(library.ormUniform.value, texture);
  assert.deepEqual(library.report(), {
    status: 'compressed',
    source: 'ktx2-basis',
    tier: 'high',
    atlas: MATERIAL_ATLAS,
    requestedChannels: ['color', 'normal', 'orm'],
    textures: 1,
    residentBytes: 96,
    budgetBytes: 18 * 1024 * 1024,
    diskBytes: 4220700,
    formats: { color: 'ASTC_4x4', normal: 'ASTC_4x4', orm: 'ASTC_4x4' },
    loadMs: 27.5,
    fallbackReason: null,
  });

  library.dispose();
  assert.equal(disposals, 1, 'one shared texture is disposed exactly once');
  assert.equal(library.report().source, 'disposed');
});

test('a transcode failure takes the deterministic canvas fallback path', async () => {
  const createCanvas = () => {
    const texture = new THREE.CanvasTexture({ width: 16, height: 16 });
    texture.generateMipmaps = true;
    return texture;
  };
  const textures = {
    color: createCanvas(),
    normal: createCanvas(),
    orm: createCanvas(),
  };
  const library = new MaterialLibrary({
    load: async () => { throw new Error('unsupported GPU texture format'); },
    fallback: () => textures,
  });

  await library.initialize({}, 'medium');
  const report = library.report();
  assert.equal(report.status, 'fallback');
  assert.equal(report.source, 'canvas-fallback');
  assert.equal(report.fallbackReason, 'unsupported GPU texture format');
  assert.deepEqual(report.requestedChannels, ['color', 'normal']);
  assert.deepEqual(report.formats, { color: 'CanvasTexture', normal: 'CanvasTexture' });
  assert.ok(library.colorUniform.value.isCanvasTexture);
  assert.ok(library.normalUniform.value.isCanvasTexture);
  library.dispose();
});

function compileMaterial(material, shaderName) {
  const source = THREE.ShaderLib[shaderName];
  const shader = {
    uniforms: {},
    vertexShader: source.vertexShader,
    fragmentShader: source.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  return shader;
}

test('shipping facade, road, walk, grass, and bark shaders consume the shared atlases', () => {
  const cases = [
    {
      material: makeFacadeMaterial(),
      shader: 'lambert',
      uniform: 'uNycSurfaceColor',
      sample: 'texture2D(uNycSurfaceColor',
      surface: 'semantic-facade-roof',
    },
    {
      material: makeRoadMaterial(),
      shader: 'standard',
      uniform: 'uNycMaterialColor',
      sample: 'texture2D(uNycMaterialColor',
      surface: 'asphalt-worn',
    },
    {
      material: makeWalkMaterial(),
      shader: 'standard',
      uniform: 'uNycMaterialColor',
      sample: 'texture2D(uNycMaterialColor',
      surface: 'concrete-aged',
    },
    {
      material: makeFlatMaterial(),
      shader: 'lambert',
      uniform: 'uNycGrassColor',
      sample: 'texture2D(uNycGrassColor',
      surface: 'grass-variants',
    },
    {
      material: treeTrunkMaterial(),
      shader: 'standard',
      uniform: 'uNycBarkColor',
      sample: 'texture2D(uNycBarkColor',
      surface: 'bark-brown',
    },
  ];

  for (const entry of cases) {
    assert.equal(entry.material.map, null, `${entry.surface} has no private RGBA texture`);
    assert.equal(entry.material.userData.nycMaterialSurface, entry.surface);
    const shader = compileMaterial(entry.material, entry.shader);
    assert.equal(shader.uniforms[entry.uniform], materialLibrary.colorUniform);
    assert.ok(shader.fragmentShader.includes(entry.sample), `${entry.surface} samples shared color`);
    assert.ok(shader.fragmentShader.includes('nycAtlasUv'), `${entry.surface} applies atlas gutters`);
    assert.ok(shader.fragmentShader.includes('nycMacroVariation'), `${entry.surface} breaks repetition`);
    entry.material.dispose();
  }
});
