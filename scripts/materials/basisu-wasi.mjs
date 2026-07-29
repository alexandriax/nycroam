import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

export const BASISU_COMMIT = '45d5f41015eecd9570d5a3f89ab9cc0037a25063';
export const BASISU_VERSION = 'v2_1_0';
export const BASISU_SHA256 = 'ab6e242096c8bf2bba351fa9a5b8e2d9e624669d76a823bbf181e559bea10ae7';
export const BASISU_URL = `https://raw.githubusercontent.com/BinomialLLC/basis_universal/${BASISU_COMMIT}/bin/basisu_st.wasm`;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Download the pinned official single-thread WASI encoder and verify it. */
export async function fetchBasisuWasm(destination) {
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch {
    const response = await fetch(BASISU_URL);
    if (!response.ok) {
      throw new Error(`basisu download failed (${response.status}) from ${BASISU_URL}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, bytes);
  }
  const actual = sha256(bytes);
  if (actual !== BASISU_SHA256) {
    throw new Error(`basisu SHA-256 mismatch: expected ${BASISU_SHA256}, received ${actual}`);
  }
  return WebAssembly.compile(bytes);
}

/** Execute one deterministic encoder/validator invocation inside Node WASI. */
export async function runBasisu(module, workDirectory, args) {
  const wasi = new WASI({
    version: 'preview1',
    args: ['basisu', ...args],
    env: {},
    preopens: { '/work': workDirectory },
  });
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(instance);
  if (exitCode !== 0) {
    throw new Error(`basisu exited with code ${exitCode}: ${args.join(' ')}`);
  }
}

export { sha256 };
