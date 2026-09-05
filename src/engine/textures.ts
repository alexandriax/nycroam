// Procedural surface library — every texture is generated on canvas at runtime
// (deterministic, self-contained, no assets). Each surface paints an albedo
// canvas plus a height field; normals come from a Sobel pass over the heights.
import * as THREE from 'three';
import { quality } from './quality';
import { canvas2d } from './canvas2d';

export interface Tex {
  map: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  metersPerRepeat: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function configure(t: THREE.CanvasTexture, srgb: boolean) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Asphalt, sidewalks and brick are all seen at grazing angles down a street,
  // which is exactly where anisotropy earns its keep -- and exactly where a low
  // tier cannot afford it. This was pinned at 8 for every device.
  t.anisotropy = quality().anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

function heightToNormal(h: Float32Array, size: number, strength: number): THREE.CanvasTexture {
  const { cv, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-dx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dy * inv * 0.5 + 0.5) * 255; // +Y up (OpenGL convention)
      d[i + 2] = inv * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return configure(new THREE.CanvasTexture(cv), false);
}

type Painter = (ctx: CanvasRenderingContext2D, rand: () => number, h: Float32Array, size: number) => void;

const cache = new Map<string, Tex | THREE.CanvasTexture>();

function surface(key: string, size: number, seed: number, mpr: number, normalStrength: number, paint: Painter): Tex {
  const hit = cache.get(key);
  if (hit) return hit as Tex;
  const { cv, ctx } = canvas2d(size, size);
  const h = new Float32Array(size * size);
  paint(ctx, mulberry32(seed), h, size);
  const tex: Tex = {
    map: configure(new THREE.CanvasTexture(cv), true),
    normal: heightToNormal(h, size, normalStrength),
    metersPerRepeat: mpr,
  };
  cache.set(key, tex);
  return tex;
}

/** Speckle helper: dots on canvas + bumps in the height field. */
function speckle(
  ctx: CanvasRenderingContext2D, rand: () => number, h: Float32Array, size: number,
  count: number, light: string, dark: string, bump: number,
) {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand() * size), y = Math.floor(rand() * size);
    const r = rand() < 0.85 ? 1 : 2;
    const up = rand() < 0.5;
    ctx.fillStyle = up ? light : dark;
    ctx.globalAlpha = 0.05 + rand() * 0.13;
    ctx.fillRect(x, y, r, r);
    h[y * size + x] += (up ? 1 : -1) * bump * rand();
  }
  ctx.globalAlpha = 1;
}

function hRect(h: Float32Array, size: number, x0: number, y0: number, w: number, hgt: number, v: number) {
  const x1 = Math.min(size, x0 + w), y1 = Math.min(size, y0 + hgt);
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) h[y * size + x] = v;
  }
}

// ---------------------------------------------------------------- surfaces --

export function makeAsphaltTexture(): Tex {
  return surface('asphalt', 512, 101, 4, 1.1, (ctx, rand, h, size) => {
    ctx.fillStyle = '#2b2d30';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, rand, h, size, 14000, '#5a5c60', '#17181a', 0.7);
    // faint patch seams + cracks
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = '#1a1b1d';
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1 + rand();
      ctx.beginPath();
      let x = rand() * size, y = rand() * size;
      ctx.moveTo(x, y);
      for (let s = 0; s < 5; s++) {
        x += (rand() - 0.5) * 200; y += (rand() - 0.3) * 150;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });
}

export function makeSidewalkTexture(): Tex {
  return surface('sidewalk', 512, 202, 3, 1.0, (ctx, rand, h, size) => {
    const flag = size / 2; // two 1.5m flags per 3m repeat
    for (let fy = 0; fy < 2; fy++) {
      for (let fx = 0; fx < 2; fx++) {
        const l = 176 + Math.floor(rand() * 14) - 7;
        ctx.fillStyle = `rgb(${l},${l - 2},${l - 8})`;
        ctx.fillRect(fx * flag, fy * flag, flag, flag);
      }
    }
    speckle(ctx, rand, h, size, 7000, '#d9d7ce', '#8e8c85', 0.3);
    // score joints
    ctx.strokeStyle = '#8f8d86';
    ctx.lineWidth = 4;
    for (const p of [0, flag, size]) {
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
      hRect(h, size, Math.round(p) - 2, 0, 4, size, -1.6);
      hRect(h, size, 0, Math.round(p) - 2, size, 4, -1.6);
    }
    // hairline cracks
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = '#7e7c76';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let x = rand() * size, y = rand() * size;
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) { x += (rand() - 0.5) * 90; y += (rand() - 0.5) * 90; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });
}

export function makeBrickTexture(tone: 'red' | 'brown' | 'tan' = 'red'): Tex {
  const bases = { red: [139, 74, 58], brown: [110, 74, 56], tan: [184, 154, 114] } as const;
  const seedByTone = { red: 303, brown: 313, tan: 323 };
  // 1.2m repeat: six ~200mm stretchers by eighteen ~67mm courses, matching
  // common NYC modular brick (including mortar) instead of oversized blocks.
  return surface(`brick-${tone}`, 512, seedByTone[tone], 1.2, 0.9, (ctx, rand, h, size) => {
    const [br, bg, bb] = bases[tone];
    ctx.fillStyle = '#c8c2b6'; // mortar
    ctx.fillRect(0, 0, size, size);
    const rows = 18, cols = 6;
    const bh = size / rows, bw = size / cols, gap = 4;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (bw / 2);
      for (let c = -1; c < cols + 1; c++) {
        const x = c * bw + off, y = r * bh;
        const j = (rand() - 0.5) * 34;
        const dk = rand() < 0.12 ? 0.72 : 1; // occasional dark header
        ctx.fillStyle = `rgb(${Math.round((br + j) * dk)},${Math.round((bg + j * 0.8) * dk)},${Math.round((bb + j * 0.6) * dk)})`;
        ctx.fillRect(x + gap / 2, y + gap / 2, bw - gap, bh - gap);
        hRect(h, size, Math.round(x + gap / 2), Math.round(y + gap / 2), Math.round(bw - gap), Math.round(bh - gap), 1.2 + rand() * 0.5);
      }
    }
    speckle(ctx, rand, h, size, 2600, '#e0d8cc', '#4a3a30', 0.25);
  });
}

export function makeRoofTexture(): Tex {
  return surface('roof', 512, 404, 4, 0.8, (ctx, rand, h, size) => {
    ctx.fillStyle = '#6a675f';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, rand, h, size, 16000, '#8d8a80', '#4d4b45', 0.5);
    // stains / patched areas
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = rand() < 0.5 ? '#57544d' : '#75726a';
      ctx.globalAlpha = 0.12 + rand() * 0.1;
      ctx.beginPath();
      ctx.ellipse(rand() * size, rand() * size, 30 + rand() * 90, 25 + rand() * 70, rand() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
}

export function makeTerrazzoTexture(): Tex {
  return surface('terrazzo', 512, 505, 2, 0.35, (ctx, rand, h, size) => {
    ctx.fillStyle = '#b9b5aa';
    ctx.fillRect(0, 0, size, size);
    const chips = ['#8d8a82', '#a39c8d', '#6e6a62', '#c9c4b8', '#3d3b36', '#b7a58c'];
    for (let i = 0; i < 5200; i++) {
      ctx.fillStyle = chips[Math.floor(rand() * chips.length)];
      ctx.globalAlpha = 0.5 + rand() * 0.5;
      const s = 1 + rand() * 2.4;
      ctx.fillRect(rand() * size, rand() * size, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#98948a';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, size, size);
    hRect(h, size, 0, 0, size, 3, -0.8);
    hRect(h, size, 0, 0, 3, size, -0.8);
  });
}

export function makeBarkTexture(): Tex {
  return surface('bark', 512, 606, 1.5, 1.2, (ctx, rand, h, size) => {
    ctx.fillStyle = '#5d4630';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 46; i++) {
      const w = 6 + rand() * 16;
      let x = rand() * size;
      const dark = rand() < 0.5;
      ctx.fillStyle = dark ? '#4a3826' : '#6f5539';
      ctx.globalAlpha = 0.5 + rand() * 0.4;
      for (let y = 0; y < size; y += 8) {
        x += (rand() - 0.5) * 5;
        ctx.fillRect(((x % size) + size) % size, y, w, 8);
        hRect(h, size, Math.round(((x % size) + size) % size), y, Math.round(w), 8, dark ? -1 : 1);
      }
    }
    ctx.globalAlpha = 1;
    speckle(ctx, rand, h, size, 2200, '#7d6142', '#33261a', 0.3);
  });
}

export function makeSubwayWallTexture(bandColor: string): Tex {
  return surface(`subwall-${bandColor}`, 512, 707, 7, 0.7, (ctx, rand, h, size) => {
    // white 2:1 tiles
    const tw = size / 12, th = tw / 2, grout = 2;
    ctx.fillStyle = '#cfcfc8';
    ctx.fillRect(0, 0, size, size);
    const bandTop = Math.round(size * 0.1), bandRows = 3;
    for (let r = 0; r < size / th; r++) {
      const off = (r % 2) * (tw / 2);
      const y = r * th;
      const inBand = y >= bandTop + th && r < bandTop / th + 1 + bandRows;
      for (let c = -1; c < 13; c++) {
        const x = c * tw + off;
        const l = 236 + Math.floor((rand() - 0.5) * 14);
        ctx.fillStyle = inBand ? bandColor : `rgb(${l},${l - 1},${l - 5})`;
        if (inBand && rand() < 0.35) {
          ctx.fillStyle = shade(bandColor, 0.88 + rand() * 0.2);
        }
        ctx.fillRect(x + grout / 2, y + grout / 2, tw - grout, th - grout);
        hRect(h, size, Math.round(x + grout / 2), Math.round(y + grout / 2), Math.round(tw - grout), Math.round(th - grout), 1);
      }
    }
    // black trim lines around the band
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, bandTop + th - 3, size, 3);
    ctx.fillRect(0, bandTop + th * (1 + bandRows), size, 3);
    // grime: floor-level gradient + drips
    const g = ctx.createLinearGradient(0, size * 0.82, 0, size);
    g.addColorStop(0, 'rgba(58,52,44,0)');
    g.addColorStop(1, 'rgba(58,52,44,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, size * 0.82, size, size * 0.18);
    for (let i = 0; i < 5; i++) {
      const x = rand() * size;
      const drip = ctx.createLinearGradient(0, bandTop, 0, bandTop + 60 + rand() * 120);
      drip.addColorStop(0, 'rgba(70,64,54,0.16)');
      drip.addColorStop(1, 'rgba(70,64,54,0)');
      ctx.fillStyle = drip;
      ctx.fillRect(x, bandTop, 3 + rand() * 4, 200);
    }
  });
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/** Mottled multiply-detail for grass/ground (averages ~0.75 so palettes survive). */
export function makeGrassDetailTexture(): THREE.CanvasTexture {
  const key = 'grassdetail';
  const hit = cache.get(key);
  if (hit) return hit as THREE.CanvasTexture;
  const size = 512;
  const { cv, ctx } = canvas2d(size, size);
  const rand = mulberry32(808);
  ctx.fillStyle = '#bcbeb4';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 480; i++) {
    const g = 168 + Math.floor((rand() - 0.5) * 44);
    ctx.fillStyle = `rgba(${g - 10},${g},${g - 22},0.10)`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, 12 + rand() * 60, 8 + rand() * 40, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 9000; i++) {
    const l = rand() < 0.5;
    ctx.fillStyle = l ? 'rgba(228,230,220,0.07)' : 'rgba(105,112,96,0.07)';
    ctx.fillRect(rand() * size, rand() * size, 1.5, 1.5);
  }
  const tex = configure(new THREE.CanvasTexture(cv), true);
  cache.set(key, tex);
  return tex;
}

export function makeCloudTexture(seed: number): THREE.CanvasTexture {
  const key = `cloud-${seed}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.CanvasTexture;
  const size = 256;
  const { cv, ctx } = canvas2d(size, size);
  const rand = mulberry32(900 + seed);
  const puffs = 9 + Math.floor(rand() * 6);
  for (let i = 0; i < puffs; i++) {
    const px = size * (0.25 + rand() * 0.5);
    const py = size * (0.35 + rand() * 0.3);
    const pr = size * (0.10 + rand() * 0.16);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
    const under = py > size * 0.52;
    const tone = under ? 224 : 255;
    grad.addColorStop(0, `rgba(${tone},${tone},${Math.min(255, tone + 2)},${0.5 + rand() * 0.3})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = configure(new THREE.CanvasTexture(cv), true);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, tex);
  return tex;
}
