// Generates the site icons from assets/mascot.png.
//
//   node scripts/make-icons.mjs
//
// The source art is 1024x1024 with a lot of empty margin — the character only
// covers ~44% of the width, which turns to mush at a 16px favicon. So: crop to
// the opaque subject (the soft glow halo is excluded from the bounding box but
// still sampled), square it up, then downscale by area-averaging on
// premultiplied alpha. Premultiplying matters — averaging straight RGBA pulls
// the transparent pixels' colour into the edges and leaves a dark fringe.
//
// Outputs:
//   app/favicon.ico   16/32/48 (PNG-in-ICO) — crisp small sizes, hand-filtered
//   app/icon.png      512 transparent, for high-DPI and PWA
//   app/apple-icon.png 180 on an opaque tile (iOS composites transparency badly)
//   assets/mascot-512.png  README asset
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'mascot.png');
const APP = path.join(ROOT, 'app');
const IOS_BG = [11, 14, 18]; // #0b0e12, matches themeColor

const src = PNG.sync.read(fs.readFileSync(SRC));

/** Bounding box of solidly-opaque pixels (ignores the soft glow). */
function contentBox(img, alphaMin = 200) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Square crop centred on the box, clamped to the source. */
function squareCrop(img, box, marginFrac = 0.04) {
  const bw = box.maxX - box.minX + 1;
  const bh = box.maxY - box.minY + 1;
  let side = Math.round(Math.max(bw, bh) * (1 + marginFrac * 2));
  side = Math.min(side, img.width, img.height);
  const cx = Math.round((box.minX + box.maxX) / 2);
  const cy = Math.round((box.minY + box.maxY) / 2);
  let x0 = Math.round(cx - side / 2);
  let y0 = Math.round(cy - side / 2);
  x0 = Math.max(0, Math.min(x0, img.width - side));
  y0 = Math.max(0, Math.min(y0, img.height - side));
  const out = new PNG({ width: side, height: side });
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const s = ((y + y0) * img.width + (x + x0)) * 4;
      const d = (y * side + x) * 4;
      out.data[d] = img.data[s];
      out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2];
      out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

/** Area-average downscale on premultiplied alpha (box filter over source rects). */
function resize(img, size) {
  const out = new PNG({ width: size, height: size });
  const scale = img.width / size;
  for (let y = 0; y < size; y++) {
    const sy0 = y * scale, sy1 = (y + 1) * scale;
    const iy0 = Math.floor(sy0), iy1 = Math.min(img.height, Math.ceil(sy1));
    for (let x = 0; x < size; x++) {
      const sx0 = x * scale, sx1 = (x + 1) * scale;
      const ix0 = Math.floor(sx0), ix1 = Math.min(img.width, Math.ceil(sx1));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          const w = wx * wy;
          if (w <= 0) continue;
          const i = (sy * img.width + sx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al * w;
          g += img.data[i + 1] * al * w;
          b += img.data[i + 2] * al * w;
          a += img.data[i + 3] * w;
          wsum += w;
        }
      }
      const d = (y * size + x) * 4;
      const alpha = a / wsum;
      const un = alpha > 0 ? 255 / alpha : 0; // un-premultiply
      out.data[d] = Math.round(Math.min(255, (r / wsum) * un));
      out.data[d + 1] = Math.round(Math.min(255, (g / wsum) * un));
      out.data[d + 2] = Math.round(Math.min(255, (b / wsum) * un));
      out.data[d + 3] = Math.round(alpha);
    }
  }
  return out;
}

/** Composite over an opaque colour (iOS home-screen tiles want no alpha). */
function flatten(img, [br, bg, bb]) {
  const out = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    out.data[i] = Math.round(img.data[i] * a + br * (1 - a));
    out.data[i + 1] = Math.round(img.data[i + 1] * a + bg * (1 - a));
    out.data[i + 2] = Math.round(img.data[i + 2] * a + bb * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

/** Pack PNGs into an .ico (PNG-in-ICO; understood by every current browser). */
function buildIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngBuffers.forEach((buf, i) => {
    const s = sizes[i];
    const o = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, o);       // width (0 means 256)
    dir.writeUInt8(s >= 256 ? 0 : s, o + 1);   // height
    dir.writeUInt8(0, o + 2);                  // palette
    dir.writeUInt8(0, o + 3);                  // reserved
    dir.writeUInt16LE(1, o + 4);               // colour planes
    dir.writeUInt16LE(32, o + 6);              // bits per pixel
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngBuffers]);
}

const box = contentBox(src);
const cropped = squareCrop(src, box);
console.log(`source ${src.width}x${src.height}`);
console.log(`subject bbox x ${box.minX}..${box.maxX}, y ${box.minY}..${box.maxY} -> square crop ${cropped.width}px`);

const icoSizes = [16, 32, 48];
const icoPngs = icoSizes.map((s) => PNG.sync.write(resize(cropped, s)));
fs.writeFileSync(path.join(APP, 'favicon.ico'), buildIco(icoPngs, icoSizes));
console.log(`app/favicon.ico     ${icoSizes.join('/')} px`);

const icon512 = resize(cropped, 512);
fs.writeFileSync(path.join(APP, 'icon.png'), PNG.sync.write(icon512));
console.log('app/icon.png        512px transparent');

fs.writeFileSync(path.join(APP, 'apple-icon.png'), PNG.sync.write(flatten(resize(cropped, 180), IOS_BG)));
console.log('app/apple-icon.png  180px on #0b0e12');

fs.writeFileSync(path.join(ROOT, 'assets', 'mascot-512.png'), PNG.sync.write(icon512));
console.log('assets/mascot-512.png  512px (README)');
