#!/usr/bin/env node
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  ATLAS_GRID,
  ATLAS_SIZE,
  CELL_GUTTER,
  CELL_SIZE,
  CONTENT_SIZE,
  encodePng,
  generateSurfaceAtlases,
  manifestRegions,
} from './surface-library.mjs';
import {
  BASISU_COMMIT,
  BASISU_SHA256,
  BASISU_VERSION,
  fetchBasisuWasm,
  runBasisu,
  sha256,
} from './basisu-wasi.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT = resolve(ROOT, 'public/materials');
const TRANSCODER_SOURCE = resolve(ROOT, 'node_modules/three/examples/jsm/libs/basis');

const channels = [
  {
    id: 'color',
    source: 'color.png',
    output: 'nyc-surfaces-color.ktx2',
    codec: 'ETC1S',
    colorSpace: 'srgb',
    args: ['-etc1s', '-quality', '92', '-effort', '6', '-mipmap', '-mip_slow', '-mip_filter', 'kaiser', '-no_alpha'],
  },
  {
    id: 'normal',
    source: 'normal.png',
    output: 'nyc-surfaces-normal.ktx2',
    codec: 'UASTC-LDR-4x4-RDO',
    colorSpace: 'linear',
    args: ['-uastc', '-uastc_level', '3', '-uastc_rdo_l', '0.75', '-normal_map', '-mipmap', '-mip_renorm', '-mip_slow', '-no_alpha'],
  },
  {
    id: 'orm',
    source: 'orm.png',
    output: 'nyc-surfaces-orm.ktx2',
    codec: 'UASTC-LDR-4x4-RDO',
    colorSpace: 'linear',
    args: ['-uastc', '-uastc_level', '3', '-uastc_rdo_l', '0.8', '-linear', '-mipmap', '-mip_slow', '-no_alpha'],
  },
];

async function main() {
  const work = await mkdtemp(resolve(tmpdir(), 'nycroam-materials-'));
  try {
    const wasmPath = resolve(work, 'basisu_st.wasm');
    console.log(`[materials] generating ${ATLAS_SIZE}×${ATLAS_SIZE} deterministic source atlases`);
    const atlases = generateSurfaceAtlases();
    for (const channel of channels) {
      await writeFile(resolve(work, channel.source), encodePng(atlases[channel.id]));
    }

    console.log(`[materials] loading official Basis Universal ${BASISU_VERSION} WASI encoder`);
    const encoder = await fetchBasisuWasm(wasmPath);
    for (const channel of channels) {
      console.log(`[materials] ${channel.id}: ${channel.codec}`);
      await runBasisu(encoder, work, [
        '-file',
        `/work/${channel.source}`,
        '-ktx2',
        '-output_file',
        `/work/${channel.output}`,
        '-no_multithreading',
        '-quiet',
        ...channel.args,
      ]);
      await runBasisu(encoder, work, [
        '-validate',
        '-file',
        `/work/${channel.output}`,
        '-quiet',
      ]);
    }

    await mkdir(resolve(OUTPUT, 'basis'), { recursive: true });
    const channelManifest = {};
    for (const channel of channels) {
      const source = await readFile(resolve(work, channel.source));
      const output = await readFile(resolve(work, channel.output));
      await writeFile(resolve(OUTPUT, channel.output), output);
      channelManifest[channel.id] = {
        file: channel.output,
        codec: channel.codec,
        colorSpace: channel.colorSpace,
        sourceSha256: sha256(source),
        sha256: sha256(output),
        bytes: output.byteLength,
      };
    }
    const transcoderManifest = {};
    for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      const source = resolve(TRANSCODER_SOURCE, file);
      const bytes = await readFile(source);
      await copyFile(source, resolve(OUTPUT, 'basis', file));
      transcoderManifest[file] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
    }

    const mipFactor = 4 / 3;
    const rgba8SourceBytes = Math.round(ATLAS_SIZE * ATLAS_SIZE * 4 * mipFactor);
    const runtimeFallbackSize = 1024;
    const rgba8RuntimeFallbackBytes = Math.round(
      runtimeFallbackSize * runtimeFallbackSize * 4 * mipFactor,
    );
    const blockCompressedUpperBytes = Math.round(ATLAS_SIZE * ATLAS_SIZE * mipFactor);
    const manifest = {
      schemaVersion: 1,
      generator: 'scripts/materials/build-material-library.mjs',
      encoder: {
        project: 'BinomialLLC/basis_universal',
        version: BASISU_VERSION,
        commit: BASISU_COMMIT,
        wasiSha256: BASISU_SHA256,
      },
      atlas: {
        width: ATLAS_SIZE,
        height: ATLAS_SIZE,
        grid: ATLAS_GRID,
        cellSize: CELL_SIZE,
        gutter: CELL_GUTTER,
        contentSize: CONTENT_SIZE,
        regions: manifestRegions(),
      },
      channels: channelManifest,
      transcoder: transcoderManifest,
      residency: {
        rgba8SourceEquivalentBytesPerAtlas: rgba8SourceBytes,
        runtimeCanvasFallbackAtlasSize: runtimeFallbackSize,
        runtimeCanvasFallbackBytesPerAtlas: rgba8RuntimeFallbackBytes,
        blockCompressedUpperBytesPerAtlas: blockCompressedUpperBytes,
        blockCompressedUpperBytesTotal: blockCompressedUpperBytes * channels.length,
      },
    };
    await writeFile(
      resolve(OUTPUT, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    const diskBytes = Object.values(channelManifest).reduce((sum, item) => sum + item.bytes, 0);
    console.log(
      `[materials] wrote ${(diskBytes / 1024 / 1024).toFixed(2)} MiB KTX2; `
      + `GPU block-compressed upper bound ${(manifest.residency.blockCompressedUpperBytesTotal / 1024 / 1024).toFixed(2)} MiB`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[materials] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
