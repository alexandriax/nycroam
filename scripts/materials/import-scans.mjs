#!/usr/bin/env node
// Offline runtime: this authoring command downloads only explicitly listed CC0
// maps, checks the provider checksum, then commits normalized source tiles.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { CONTENT_SIZE, encodePng } from './surface-library.mjs';
const output = new URL('../../assets/materials/scans/', import.meta.url);
const sources = [
  ['brick-red', 'red_brick_03'], ['brick-brown', 'brown_brick_02'],
  ['concrete-aged', 'concrete_floor_02'], ['asphalt-worn', 'asphalt_02'],
  ['limestone', 'sandstone_blocks_05'], ['roof-gravel', 'gravel_floor'],
];
const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const manifest = { license: 'CC0-1.0', licenseUrl: 'https://polyhaven.com/license', size: CONTENT_SIZE, sources: [] };
await mkdir(output, { recursive: true });
for (const [region, asset] of sources) {
  const response = await fetch(`https://api.polyhaven.com/files/${asset}`);
  if (!response.ok) throw new Error(`${asset}: ${response.status}`);
  const files = await response.json();
  const entry = { region, asset, page: `https://polyhaven.com/a/${asset}`, channels: {} };
  for (const [channel, key] of [['color', 'Diffuse'], ['normal', 'nor_gl'], ['orm', 'arm']]) {
    const source = files[key]['1k'].png;
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes, 'md5') !== source.md5) throw new Error(`Checksum mismatch: ${source.url}`);
    const input = PNG.sync.read(bytes);
    const png = new PNG({ width: CONTENT_SIZE, height: CONTENT_SIZE });
    // Area averaging avoids aliased mortar/aggregate; decode sRGB for albedo.
    for (let y = 0; y < CONTENT_SIZE; y++) for (let x = 0; x < CONTENT_SIZE; x++) {
      const sum = [0, 0, 0]; let weight = 0;
      const x0 = x * input.width / CONTENT_SIZE, x1 = (x + 1) * input.width / CONTENT_SIZE;
      const y0 = y * input.height / CONTENT_SIZE, y1 = (y + 1) * input.height / CONTENT_SIZE;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const w = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * (Math.min(sy + 1, y1) - Math.max(sy, y0));
        const i = (Math.min(input.height - 1, sy) * input.width + Math.min(input.width - 1, sx)) * 4;
        for (let c = 0; c < 3; c++) {
          const v = input.data[i + c] / 255;
          sum[c] += w * (channel === 'color' ? (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) : v);
        }
        weight += w;
      }
      let values = sum.map(v => v / weight);
      if (channel === 'normal') {
        const n = values.map(v => v * 2 - 1), length = Math.hypot(...n);
        values = n.map(v => v / length * .5 + .5);
      }
      const index = (y * CONTENT_SIZE + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = values[c];
        if (channel === 'color') v = v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055;
        // ARM from Poly Haven is AO / roughness / metallic, same as our ORM.
        png.data[index + c] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
      png.data[index + 3] = 255;
    }
    const encoded = encodePng(png), file = `${region}-${channel}.png`;
    await writeFile(new URL(file, output), encoded);
    entry.channels[channel] = { file, sha256: digest(encoded), sourceUrl: source.url, sourceSha256: digest(bytes) };
    console.log(`[scan] ${file} ${(encoded.length / 1024).toFixed(0)} KiB`);
  }
  manifest.sources.push(entry);
}
await writeFile(new URL('manifest.json', output), `${JSON.stringify(manifest, null, 2)}\n`);
