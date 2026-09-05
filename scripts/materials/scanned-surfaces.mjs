import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { SURFACES, CELL_SIZE, CELL_GUTTER, CONTENT_SIZE, ATLAS_GRID } from './surface-library.mjs';
const root = new URL('../../assets/materials/scans/', import.meta.url);

/** Replace selected cells without changing atlas dimensions, sampler count or
 * GPU residency. Wrapped gutters keep scans isolated through the mip chain. */
export async function applyScannedSurfaces(atlases) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  for (const source of manifest.sources) {
    const region = SURFACES.findIndex(surface => surface.id === source.region);
    if (region < 0) throw new Error(`Unknown scan region ${source.region}`);
    for (const [channel, metadata] of Object.entries(source.channels)) {
      const bytes = await readFile(new URL(metadata.file, root));
      if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error(`Scan checksum: ${metadata.file}`);
      const png = PNG.sync.read(bytes);
      if (png.width !== CONTENT_SIZE || png.height !== CONTENT_SIZE) throw new Error(`Scan dimensions: ${metadata.file}`);
      const atlas = atlases[channel];
      for (let y = 0; y < CELL_SIZE; y++) for (let x = 0; x < CELL_SIZE; x++) {
        const sx = (x - CELL_GUTTER + CONTENT_SIZE) % CONTENT_SIZE;
        const sy = (y - CELL_GUTTER + CONTENT_SIZE) % CONTENT_SIZE;
        const src = (sy * CONTENT_SIZE + sx) * 4;
        const dst = ((Math.floor(region / ATLAS_GRID) * CELL_SIZE + y) * atlas.width + (region % ATLAS_GRID) * CELL_SIZE + x) * 4;
        png.data.copy(atlas.data, dst, src, src + 4);
      }
    }
  }
  return manifest;
}
