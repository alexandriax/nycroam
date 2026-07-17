// CanvasTexture factories for NYC subway signage: black-and-white direction
// signs, serif mosaic name tablets, and glossy tile wall bands.
// All canvases are client-side (document.createElement('canvas')) and are
// meant to be consumed as THREE.Texture maps by props.ts / train.ts / streetprops.ts.
import * as THREE from 'three';
import { routeColor, bulletTextColor } from './types';
import { BLACK, SERIF } from '../fonts';

function createCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

function finalizeTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const bigint = parseInt(full, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function jitterColor(rgb: [number, number, number], amount: number): string {
  const f = 1 + (Math.random() * 2 - 1) * amount;
  const r = Math.min(255, Math.max(0, Math.round(rgb[0] * f)));
  const g = Math.min(255, Math.max(0, Math.round(rgb[1] * f)));
  const b = Math.min(255, Math.max(0, Math.round(rgb[2] * f)));
  return `rgb(${r}, ${g}, ${b})`;
}

// `weight` is a CSS font prefix ('bold ' for synthetic-bold faces; '' for
// Archivo Black, whose face is already heavy — layering synthetic bold on it
// only fuzzes the glyph edges at texture scale).
function fitFontSize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, family: string, startPx: number, weight = 'bold '): number {
  let size = startPx;
  ctx.font = `${weight}${size}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && size > 12) {
    size -= 2;
    ctx.font = `${weight}${size}px ${family}`;
  }
  return size;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGroutGrid(ctx: CanvasRenderingContext2D, w: number, h: number, cell: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += cell) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += cell) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}

function drawArrowTriangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, dir: 'left' | 'right'): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  if (dir === 'right') {
    ctx.moveTo(cx - size * 0.5, cy - size);
    ctx.lineTo(cx - size * 0.5, cy + size);
    ctx.lineTo(cx + size * 0.65, cy);
  } else {
    ctx.moveTo(cx + size * 0.5, cy - size);
    ctx.lineTo(cx + size * 0.5, cy + size);
    ctx.lineTo(cx - size * 0.65, cy);
  }
  ctx.closePath();
  ctx.fill();
}

function drawUpArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx + size * 0.6, cy + size * 0.5);
  ctx.lineTo(cx - size * 0.6, cy + size * 0.5);
  ctx.closePath();
  ctx.fill();
}

/** Filled route bullet: colored disc + centered bold route glyph. */
export function drawBullet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, route: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = routeColor(route);
  ctx.fill();
  ctx.fillStyle = bulletTextColor(route);
  ctx.font = `${Math.round(r * 1.2)}px ${BLACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(route, x, y + r * 0.05);
  ctx.restore();
}

/**
 * Tileable glossy white wall texture with a colored frieze band near the
 * top, bordered by thin black trim lines — the classic IND/IRT tile wall.
 */
export function makeWallTexture(bandColor: string): THREE.Texture {
  const size = 512;
  const { canvas, ctx } = createCanvas(size, size);

  const tileW = 30;
  const tileH = 15;
  const grout = 2;
  const pitchW = tileW + grout;
  const pitchH = tileH + grout;
  const borderH = 4;

  const bandTopBorderY = Math.round(size * 0.2);
  const bandColorStartY = bandTopBorderY + borderH;
  const bandColorEndY = bandColorStartY + 3 * pitchH;
  const bandBottomBorderY = bandColorEndY;

  ctx.fillStyle = '#cfcfc8';
  ctx.fillRect(0, 0, size, size);

  const whiteRgb = hexToRgb('#f5f5f2');
  const bandRgb = hexToRgb(bandColor);

  for (let ty = 0; ty < size; ty += pitchH) {
    const inBand = ty >= bandColorStartY && ty < bandColorEndY;
    const rowRgb = inBand ? bandRgb : whiteRgb;
    for (let tx = 0; tx < size; tx += pitchW) {
      ctx.fillStyle = jitterColor(rowRgb, 0.03);
      ctx.fillRect(tx, ty, tileW, tileH);
    }
  }

  ctx.fillStyle = '#111111';
  ctx.fillRect(0, bandTopBorderY, size, borderH);
  ctx.fillRect(0, bandBottomBorderY, size, borderH);

  const texture = finalizeTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Black-tile station-name mosaic plaque with an ornamental colored border. */
export function makeNameMosaicTexture(name: string, bandColor: string): { texture: THREE.Texture; aspect: number } {
  const w = 1024;
  const h = 320;
  const { canvas, ctx } = createCanvas(w, h);

  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, w, h);

  const borderPx = 40; // ~2 mosaic tiles
  const [br, bg, bb] = hexToRgb(bandColor);
  ctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
  ctx.fillRect(0, 0, w, borderPx);
  ctx.fillRect(0, h - borderPx, w, borderPx);
  ctx.fillRect(0, 0, borderPx, h);
  ctx.fillRect(w - borderPx, 0, borderPx, h);

  const lighten = (c: number): number => Math.min(255, Math.round(c + (255 - c) * 0.35));
  ctx.strokeStyle = `rgb(${lighten(br)}, ${lighten(bg)}, ${lighten(bb)})`;
  ctx.lineWidth = 3;
  ctx.strokeRect(borderPx - 10, borderPx - 10, w - (borderPx - 10) * 2, h - (borderPx - 10) * 2);

  drawGroutGrid(ctx, w, h, 20, 'rgba(0,0,0,0.35)');

  const text = name.toUpperCase();
  const maxWidth = w - borderPx * 2 - 60;
  const size = fitFontSize(ctx, text, maxWidth, SERIF, 120);
  ctx.font = `bold ${size}px ${SERIF}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const texture = finalizeTexture(canvas);
  return { texture, aspect: w / h };
}

function drawDownArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy + size);
  ctx.lineTo(cx + size * 0.6, cy - size * 0.5);
  ctx.lineTo(cx - size * 0.6, cy - size * 0.5);
  ctx.closePath();
  ctx.fill();
}

export type SignArrow = 'left' | 'right' | 'up' | 'down' | 'none';

/** Black hanging direction sign: route bullets, text, optional arrow
 *  (left/right for corridor turns, up = straight ahead, down = stairs down).
 *  `scale` < 1 bakes a proportionally smaller canvas (complexes hang dozens of
 *  signs — full-size canvases would burn tens of MB of texture memory). */
export function makeHangingSignTexture(opts: { routes: string[]; text: string; arrow?: SignArrow; scale?: number }): { texture: THREE.Texture; aspect: number } {
  // bullet-only signs (junction pointers) get a compact panel — a full-width
  // canvas would render as a long empty black bar
  const w = opts.text ? 2048 : Math.max(700, 320 + opts.routes.length * 190);
  const h = 256;
  const { canvas, ctx } = createCanvas(Math.round(w * (opts.scale ?? 1)), Math.round(h * (opts.scale ?? 1)));
  if (opts.scale && opts.scale !== 1) ctx.scale(opts.scale, opts.scale);

  const margin = 8;
  roundRectPath(ctx, margin, margin, w - margin * 2, h - margin * 2, 28);
  ctx.fillStyle = '#000000';
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(margin + 28, h - margin - 2);
  ctx.lineTo(w - margin - 28, h - margin - 2);
  ctx.stroke();

  let x = 44;
  const cy = h / 2 - 8;
  const bulletR = 76;
  // a left arrow LEADS the sign (MTA convention); all other arrows trail
  if (opts.arrow === 'left') {
    drawArrowTriangle(ctx, x + 50, cy, 40, 'left');
    x += 130;
  }
  for (const route of opts.routes) {
    drawBullet(ctx, x + bulletR, cy, bulletR, route);
    x += bulletR * 2 + 22;
  }
  x += 24;

  ctx.fillStyle = '#ffffff';
  ctx.font = `82px ${BLACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.text, x, cy);

  if (opts.arrow === 'right') drawArrowTriangle(ctx, w - 110, cy, 40, 'right');
  else if (opts.arrow === 'up') drawUpArrow(ctx, w - 110, cy, 40);
  else if (opts.arrow === 'down') drawDownArrow(ctx, w - 110, cy, 40);

  const texture = finalizeTexture(canvas);
  return { texture, aspect: w / h };
}

/** Small black column-mounted station-name plate. */
export function makeColumnSignTexture(name: string): { texture: THREE.Texture; aspect: number } {
  const w = 512;
  const h = 128;
  const { canvas, ctx } = createCanvas(w, h);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, w - 12, h - 12);

  const text = name.toUpperCase();
  const size = fitFontSize(ctx, text, w - 48, BLACK, 52, '');
  ctx.font = `${size}px ${BLACK}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 2);

  const texture = finalizeTexture(canvas);
  return { texture, aspect: w / h };
}

/** Black EXIT sign, optionally with an upward directional arrow. */
export function makeExitSignTexture(withArrow: boolean): { texture: THREE.Texture; aspect: number } {
  const w = 512;
  const h = 160;
  const { canvas, ctx } = createCanvas(w, h);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.strokeRect(5, 5, w - 10, h - 10);

  ctx.fillStyle = '#ffffff';
  ctx.font = `76px ${BLACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tx = withArrow ? w / 2 + 40 : w / 2;
  ctx.fillText('EXIT', tx, h / 2 + 4);

  if (withArrow) {
    drawUpArrow(ctx, 66, h / 2, 34);
  }

  const texture = finalizeTexture(canvas);
  return { texture, aspect: w / h };
}
