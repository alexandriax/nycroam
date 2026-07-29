import { PNG } from 'pngjs';

export const ATLAS_SIZE = 2048;
export const ATLAS_GRID = 4;
export const CELL_SIZE = ATLAS_SIZE / ATLAS_GRID;
export const CELL_GUTTER = 8;
export const CONTENT_SIZE = CELL_SIZE - CELL_GUTTER * 2;

export const SURFACES = Object.freeze([
  { id: 'asphalt-clean', metersPerRepeat: 4, base: [48, 50, 53], roughness: 0.91, metallic: 0.01 },
  { id: 'asphalt-worn', metersPerRepeat: 4, base: [58, 59, 59], roughness: 0.88, metallic: 0.01 },
  { id: 'concrete-cool', metersPerRepeat: 3, base: [177, 176, 169], roughness: 0.94, metallic: 0 },
  { id: 'concrete-aged', metersPerRepeat: 3, base: [158, 155, 145], roughness: 0.92, metallic: 0 },
  { id: 'brick-red', metersPerRepeat: 1.2, base: [142, 73, 56], roughness: 0.91, metallic: 0 },
  { id: 'brick-brown', metersPerRepeat: 1.2, base: [105, 71, 53], roughness: 0.93, metallic: 0 },
  { id: 'limestone', metersPerRepeat: 2.4, base: [188, 176, 152], roughness: 0.84, metallic: 0 },
  { id: 'painted-cast-iron', metersPerRepeat: 2, base: [84, 92, 92], roughness: 0.55, metallic: 0.12 },
  { id: 'roof-gravel', metersPerRepeat: 4, base: [105, 102, 94], roughness: 0.9, metallic: 0 },
  { id: 'roof-tar', metersPerRepeat: 5, base: [54, 56, 56], roughness: 0.82, metallic: 0 },
  { id: 'grass-lush', metersPerRepeat: 5, base: [73, 101, 54], roughness: 0.95, metallic: 0 },
  { id: 'grass-dry', metersPerRepeat: 5, base: [113, 116, 67], roughness: 0.96, metallic: 0 },
  { id: 'bark-gray', metersPerRepeat: 1.5, base: [91, 76, 61], roughness: 0.96, metallic: 0 },
  { id: 'bark-brown', metersPerRepeat: 1.5, base: [101, 72, 46], roughness: 0.95, metallic: 0 },
  { id: 'architectural-glass', metersPerRepeat: 6, base: [119, 145, 159], roughness: 0.14, metallic: 0 },
  { id: 'neutral-stone', metersPerRepeat: 3, base: [151, 148, 139], roughness: 0.88, metallic: 0 },
]);

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const fract = (value) => value - Math.floor(value);
const smooth = (value) => value * value * (3 - 2 * value);

function hash2(x, y, seed) {
  let value = Math.imul((x | 0) ^ seed, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16) ^ (y | 0), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

function periodicNoise(x, y, cells, seed) {
  const gx = x * cells;
  const gy = y * cells;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = smooth(fract(gx));
  const ty = smooth(fract(gy));
  const at = (ix, iy) => hash2((ix + cells) % cells, (iy + cells) % cells, seed);
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function fbm(x, y, seed) {
  return periodicNoise(x, y, 4, seed) * 0.48
    + periodicNoise(x, y, 11, seed + 17) * 0.29
    + periodicNoise(x, y, 29, seed + 37) * 0.16
    + periodicNoise(x, y, 73, seed + 71) * 0.07;
}

function vary(base, amount, noise, tint = [1, 1, 1]) {
  const delta = (noise - 0.5) * amount;
  return base.map((channel, index) => Math.round(Math.max(
    0,
    Math.min(255, channel + delta * tint[index]),
  )));
}

function brickSample(surface, u, v, seed) {
  const rows = 18;
  const columns = 6;
  const row = Math.floor(v * rows);
  const shiftedU = fract(u + (row & 1 ? 0.5 / columns : 0));
  const column = Math.floor(shiftedU * columns);
  const localU = fract(shiftedU * columns);
  const localV = fract(v * rows);
  const mortar = Math.min(localU, 1 - localU) < 0.025 || Math.min(localV, 1 - localV) < 0.08;
  if (mortar) {
    const grit = periodicNoise(u, v, 47, seed + 89);
    return {
      color: vary([190, 184, 170], 18, grit),
      height: -0.78 + grit * 0.08,
      roughness: 0.97,
      ao: 0.72,
    };
  }
  const brick = hash2(column, row, seed);
  const fire = periodicNoise(u, v, 97, seed + 131);
  return {
    color: vary(surface.base, 42, brick * 0.65 + fire * 0.35, [1, 0.78, 0.58]),
    height: 0.28 + periodicNoise(u, v, 61, seed + 151) * 0.22,
    roughness: surface.roughness - brick * 0.035,
    ao: 0.92,
  };
}

function sampleSurface(surface, index, u, v) {
  const seed = 1013 + index * 977;
  const macro = fbm(u, v, seed);
  const grain = periodicNoise(u, v, 113, seed + 211);
  let color = vary(surface.base, 22, macro, [1, 0.92, 0.82]);
  let height = (grain - 0.5) * 0.22 + (macro - 0.5) * 0.12;
  let roughness = surface.roughness + (grain - 0.5) * 0.04;
  let ao = 0.96;

  if (surface.id.startsWith('asphalt')) {
    const aggregate = periodicNoise(u, v, 151, seed + 17);
    const tar = Math.abs(periodicNoise(u, v, 7, seed + 31) - 0.5);
    const crack = tar < (surface.id === 'asphalt-worn' ? 0.025 : 0.012);
    const patchX = Math.abs(fract(u * 2 + 0.17) - 0.5);
    const patchY = Math.abs(fract(v * 3 + 0.31) - 0.5);
    const patched = surface.id === 'asphalt-worn' && patchX < 0.28 && patchY < 0.32;
    if (patched) color = vary([45, 46, 47], 14, macro);
    if (crack) color = [24, 25, 26];
    height = (aggregate - 0.5) * 0.55 - (crack ? 0.72 : 0);
    roughness += patched ? -0.04 : 0;
    ao = crack ? 0.58 : 0.97;
  } else if (surface.id.startsWith('concrete')) {
    const joint = Math.min(
      Math.abs(fract(u * 2) - 0.5),
      Math.abs(fract(v * 2) - 0.5),
    ) < 0.012;
    const stain = periodicNoise(u, v, 5, seed + 43);
    color = vary(surface.base, surface.id.endsWith('aged') ? 34 : 20, macro * 0.65 + stain * 0.35);
    if (joint) color = vary([102, 101, 96], 12, grain);
    height = joint ? -0.9 : (grain - 0.5) * 0.22;
    roughness += stain * 0.025;
    ao = joint ? 0.63 : 0.96;
  } else if (surface.id.startsWith('brick')) {
    const brick = brickSample(surface, u, v, seed);
    ({ color, height, roughness, ao } = brick);
  } else if (surface.id === 'limestone' || surface.id === 'neutral-stone') {
    const rows = surface.id === 'limestone' ? 5 : 4;
    const columns = surface.id === 'limestone' ? 3 : 4;
    const row = Math.floor(v * rows);
    const localU = fract(u * columns + (row & 1 ? 0.5 : 0));
    const localV = fract(v * rows);
    const joint = Math.min(localU, 1 - localU, localV, 1 - localV) < 0.018;
    const pore = periodicNoise(u, v, 137, seed + 61);
    color = vary(surface.base, 24, macro * 0.72 + pore * 0.28, [1, 0.94, 0.82]);
    if (joint) color = vary([111, 105, 92], 10, grain);
    height = joint ? -0.65 : (pore - 0.5) * 0.18;
    ao = joint ? 0.7 : 0.97;
  } else if (surface.id === 'painted-cast-iron') {
    const frame = Math.min(
      Math.abs(fract(u * 3) - 0.5),
      Math.abs(fract(v * 5) - 0.5),
    ) < 0.07;
    const chip = grain > 0.985;
    color = frame ? vary([61, 67, 68], 12, macro) : color;
    if (chip) color = [78, 60, 44];
    height = frame ? 0.55 : chip ? -0.3 : (grain - 0.5) * 0.08;
    roughness = chip ? 0.72 : surface.roughness;
    ao = frame ? 0.9 : 0.97;
  } else if (surface.id === 'roof-gravel') {
    const stone = periodicNoise(u, v, 181, seed + 79);
    const stain = periodicNoise(u, v, 9, seed + 97);
    color = vary(surface.base, 42, stone * 0.72 + stain * 0.28);
    height = (stone - 0.5) * 0.72;
    roughness += stone * 0.035;
  } else if (surface.id === 'roof-tar') {
    const seam = Math.min(Math.abs(fract(u * 4) - 0.5), Math.abs(fract(v * 4) - 0.5)) < 0.018;
    const pond = periodicNoise(u, v, 5, seed + 107);
    color = vary(surface.base, 24, macro * 0.65 + pond * 0.35);
    if (seam) color = [35, 37, 38];
    height = seam ? 0.4 : (grain - 0.5) * 0.12;
    roughness -= pond > 0.78 ? 0.12 : 0;
    ao = seam ? 0.88 : 0.97;
  } else if (surface.id.startsWith('grass')) {
    const blade = Math.sin((u * 173 + v * 29) * Math.PI * 2) * 0.5 + 0.5;
    const patch = periodicNoise(u, v, 7, seed + 127);
    color = vary(surface.base, 48, patch * 0.72 + blade * 0.28, [0.72, 1, 0.46]);
    height = (grain - 0.5) * 0.25 + (blade - 0.5) * 0.28;
    roughness = surface.roughness;
  } else if (surface.id.startsWith('bark')) {
    const ridges = Math.sin((u * 21 + periodicNoise(u, v, 5, seed + 149) * 2.7) * Math.PI * 2);
    const fissure = ridges < -0.86 || periodicNoise(u, v, 31, seed + 173) < 0.055;
    color = vary(surface.base, 38, macro * 0.55 + (ridges * 0.5 + 0.5) * 0.45, [1, 0.75, 0.5]);
    if (fissure) color = vary([48, 38, 29], 12, grain);
    height = fissure ? -0.72 : ridges * 0.38;
    ao = fissure ? 0.57 : 0.94;
  } else if (surface.id === 'architectural-glass') {
    const streak = periodicNoise(u, v, 13, seed + 191);
    const speck = periodicNoise(u, v, 149, seed + 223);
    color = vary(surface.base, 22, macro * 0.8 + streak * 0.2, [0.55, 0.85, 1]);
    height = (speck - 0.5) * 0.025;
    roughness = surface.roughness + streak * 0.045;
    ao = 1;
  }

  return {
    color,
    height,
    roughness: clamp01(roughness),
    ao: clamp01(ao),
    metallic: clamp01(surface.metallic),
  };
}

const pixelIndex = (x, y) => (y * ATLAS_SIZE + x) * 4;
const contentIndex = (x, y) => y * CONTENT_SIZE + x;

function writePixel(png, x, y, rgba) {
  const index = pixelIndex(x, y);
  png.data[index] = rgba[0];
  png.data[index + 1] = rgba[1];
  png.data[index + 2] = rgba[2];
  png.data[index + 3] = rgba[3] ?? 255;
}

function wrapContent(value) {
  return ((value % CONTENT_SIZE) + CONTENT_SIZE) % CONTENT_SIZE;
}

/**
 * Build three same-layout atlases. Every region has wrapped gutters and its
 * normal is derived independently, so neither compression blocks nor mipmaps
 * can pull a neighboring material into the visible region.
 */
export function generateSurfaceAtlases() {
  const color = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE, colorType: 6 });
  const normal = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE, colorType: 6 });
  const orm = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE, colorType: 6 });

  for (let surfaceIndex = 0; surfaceIndex < SURFACES.length; surfaceIndex++) {
    const surface = SURFACES[surfaceIndex];
    const pixelCount = CONTENT_SIZE * CONTENT_SIZE;
    const albedo = new Uint8Array(pixelCount * 3);
    const heights = new Float32Array(pixelCount);
    const roughness = new Uint8Array(pixelCount);
    const occlusion = new Uint8Array(pixelCount);
    for (let y = 0; y < CONTENT_SIZE; y++) {
      const v = y / CONTENT_SIZE;
      for (let x = 0; x < CONTENT_SIZE; x++) {
        const u = x / CONTENT_SIZE;
        const sample = sampleSurface(surface, surfaceIndex, u, v);
        const index = contentIndex(x, y);
        albedo[index * 3] = sample.color[0];
        albedo[index * 3 + 1] = sample.color[1];
        albedo[index * 3 + 2] = sample.color[2];
        heights[index] = sample.height;
        roughness[index] = Math.round(sample.roughness * 255);
        occlusion[index] = Math.round(sample.ao * 255);
      }
    }

    const cellX = (surfaceIndex % ATLAS_GRID) * CELL_SIZE;
    const cellY = Math.floor(surfaceIndex / ATLAS_GRID) * CELL_SIZE;
    const strength = surface.id.startsWith('grass') ? 1.3
      : surface.id.startsWith('bark') ? 2.2
        : surface.id.startsWith('brick') ? 1.8
          : 1.45;
    for (let cellPixelY = 0; cellPixelY < CELL_SIZE; cellPixelY++) {
      const sourceY = wrapContent(cellPixelY - CELL_GUTTER);
      for (let cellPixelX = 0; cellPixelX < CELL_SIZE; cellPixelX++) {
        const sourceX = wrapContent(cellPixelX - CELL_GUTTER);
        const sourceIndex = contentIndex(sourceX, sourceY);
        const left = heights[contentIndex(wrapContent(sourceX - 1), sourceY)];
        const right = heights[contentIndex(wrapContent(sourceX + 1), sourceY)];
        const down = heights[contentIndex(sourceX, wrapContent(sourceY - 1))];
        const up = heights[contentIndex(sourceX, wrapContent(sourceY + 1))];
        const dx = (right - left) * strength;
        const dy = (up - down) * strength;
        const inverse = 1 / Math.hypot(dx, dy, 1);
        const targetX = cellX + cellPixelX;
        const targetY = cellY + cellPixelY;
        writePixel(color, targetX, targetY, [
          albedo[sourceIndex * 3],
          albedo[sourceIndex * 3 + 1],
          albedo[sourceIndex * 3 + 2],
          255,
        ]);
        writePixel(normal, targetX, targetY, [
          Math.round((-dx * inverse * 0.5 + 0.5) * 255),
          Math.round((dy * inverse * 0.5 + 0.5) * 255),
          Math.round(inverse * 255),
          255,
        ]);
        writePixel(orm, targetX, targetY, [
          occlusion[sourceIndex],
          roughness[sourceIndex],
          Math.round(surface.metallic * 255),
          255,
        ]);
      }
    }
  }
  return { color, normal, orm };
}

export function encodePng(png) {
  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    bitDepth: 8,
    deflateLevel: 9,
    deflateStrategy: 3,
  });
}

export function manifestRegions() {
  return Object.fromEntries(SURFACES.map((surface, index) => [
    surface.id,
    {
      index,
      cell: [index % ATLAS_GRID, Math.floor(index / ATLAS_GRID)],
      metersPerRepeat: surface.metersPerRepeat,
    },
  ]));
}
