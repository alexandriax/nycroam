import * as THREE from 'three';
import { dataUrl } from './dataver';
import { TILE_SIZE, tileKey } from './geo';
import { BLACK, SANS } from './fonts';

/**
 * Address-plaque layer. Small numbered plates mounted on the street-facing wall
 * of every numbered building (data baked by scripts/build-plaques.mjs into
 * /geo/plaques/{tx}_{tz}.json). Walk up to one and press `i` (or tap the mobile
 * info button) to open the info modal — World.nearestPlaque drives the prompt.
 *
 * Rendering mirrors the street-sign atlas (streetFurniture.buildSignsMesh): one
 * canvas atlas + one merged quad mesh per tile = a single draw call per tile.
 * Streaming mirrors TileManager: fetch the index once, load plaque tiles within
 * a small radius, build at most one per frame, dispose beyond the unload radius.
 */

// Baked record (matches build-plaques.mjs). Positions are tile-local decimetres.
interface RawPlaque {
  x: number; z: number; e: number; a: number; // pos dm + centre elev dm + facing degrees
  num?: string; st?: string; nm?: string; k?: string; lv?: number;
  wd?: string; wp?: string; web?: string; o?: string; lm?: 1;
}

/** Resolved plaque with world coords — what the info modal consumes. */
export interface PlaqueInfo {
  x: number; z: number; // world metres
  num?: string; st?: string; nm?: string; k?: string; lv?: number;
  wd?: string; wp?: string; web?: string; o?: string; lm?: boolean;
}

/** OldNYC deep link for a plaque's snapped marker key ("lat,lon"), or null. */
export function oldNycUrl(o?: string): string | null {
  return o ? `https://www.oldnyc.org/#g:${o}` : null;
}

interface PlaqueTileRecord {
  key: string;
  tx: number;
  tz: number;
  plaques: PlaqueInfo[]; // world-space, for nearest() lookups
  group: THREE.Group | null;
  geometry: THREE.BufferGeometry | null;
  texture: THREE.CanvasTexture | null;
  material: THREE.Material | null;
  state: 'queued' | 'loading' | 'ready' | 'empty';
}

const PLAQUE_W = 0.64;   // metres
const PLAQUE_H = 0.384;  // 5:3 plate
const CELL_W = 160, CELL_H = 96; // atlas cell (5:3), shrunk to keep the canvas <=2048

// Palette — ordinary plaques read as dark bronze; landmarks as a blue historic marker.
const ORD = { plate: '#23272d', border: '#b9975b', text: '#f2e8cf' };
const LMK_PLATE = '#15324f', LMK_BORDER = '#c9a24a', LMK_TEXT = '#ecd79b';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw one plaque plate into cell (cx,cy); return its UV sub-rect in the atlas. */
function drawPlaque(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, atlasW: number, atlasH: number, p: RawPlaque,
): { u0: number; v0: number; u1: number; v1: number } {
  const pad = 8;
  const x = cx + pad, y = cy + pad, w = CELL_W - pad * 2, h = CELL_H - pad * 2;
  const lm = p.lm === 1;
  const plate = lm ? LMK_PLATE : ORD.plate;
  const border = lm ? LMK_BORDER : ORD.border;
  const text = lm ? LMK_TEXT : ORD.text;

  ctx.save();
  // plate
  ctx.fillStyle = plate;
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();
  // beveled border
  ctx.strokeStyle = border;
  ctx.lineWidth = 5;
  roundRect(ctx, x + 4, y + 4, w - 8, h - 8, 7);
  ctx.stroke();

  // number (or landmark info glyph when there's no house number)
  const label = p.num ?? (lm ? 'i' : '');
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fs = 52;
  ctx.font = `${fs}px ${lm && !p.num ? SANS : BLACK}`;
  while (ctx.measureText(label).width > w - 26 && fs > 18) {
    fs -= 3;
    ctx.font = `${fs}px ${lm && !p.num ? SANS : BLACK}`;
  }
  ctx.fillText(label, x + w / 2, y + h / 2 + 2);

  // landmark badge: a small "i" dot in the corner so specials read at a glance
  if (lm && p.num) {
    ctx.fillStyle = LMK_BORDER;
    ctx.beginPath();
    ctx.arc(x + w - 15, y + 15, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = LMK_PLATE;
    ctx.font = `18px ${SANS}`;
    ctx.fillText('i', x + w - 15, y + 16);
  }
  ctx.restore();

  return {
    u0: (x - 2) / atlasW,
    v0: (y - 2) / atlasH,
    u1: (x + w + 2) / atlasW,
    v1: (y + h + 2) / atlasH,
  };
}

export class PlaqueManager {
  private scene: THREE.Scene;
  private known = new Set<string>();
  private records = new Map<string, PlaqueTileRecord>();
  private compile: ((g: THREE.Object3D) => Promise<void>) | null;
  loadRadius = 340;
  unloadRadius = 440;
  ready = false;

  constructor(scene: THREE.Scene, compile: ((g: THREE.Object3D) => Promise<void>) | null = null) {
    this.scene = scene;
    this.compile = compile;
  }

  async init(): Promise<boolean> {
    try {
      const res = await fetch(dataUrl('/geo/plaques/index.json'));
      if (!res.ok) return false;
      const idx = await res.json();
      for (const k of idx.tiles as string[]) this.known.add(k);
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  update(camX: number, camZ: number, dt: number) {
    if (!this.ready) return;
    const ctx = Math.floor(camX / TILE_SIZE), ctz = Math.floor(camZ / TILE_SIZE);
    const rTiles = Math.ceil(this.loadRadius / TILE_SIZE);

    // Load the nearest not-yet-loaded in-range tile — at most one build per frame
    // (each atlas draws dozens of text cells; batching a district froze frames).
    let nearest: { key: string; tx: number; tz: number; d: number } | null = null;
    for (let dx = -rTiles; dx <= rTiles; dx++) {
      for (let dz = -rTiles; dz <= rTiles; dz++) {
        const tx = ctx + dx, tz = ctz + dz;
        const key = tileKey(tx, tz);
        if (!this.known.has(key) || this.records.has(key)) continue;
        const cx = (tx + 0.5) * TILE_SIZE, cz = (tz + 0.5) * TILE_SIZE;
        const d = Math.hypot(cx - camX, cz - camZ);
        if (d > this.loadRadius) continue;
        if (!nearest || d < nearest.d) nearest = { key, tx, tz, d };
      }
    }
    if (nearest) {
      const rec: PlaqueTileRecord = {
        key: nearest.key, tx: nearest.tx, tz: nearest.tz, plaques: [],
        group: null, geometry: null, texture: null, material: null, state: 'loading',
      };
      this.records.set(nearest.key, rec);
      void this.load(rec);
    }

    // unload far tiles
    for (const [key, rec] of this.records) {
      const cx = (rec.tx + 0.5) * TILE_SIZE, cz = (rec.tz + 0.5) * TILE_SIZE;
      if (Math.hypot(cx - camX, cz - camZ) > this.unloadRadius) {
        this.dispose(rec);
        this.records.delete(key);
      }
    }
  }

  private async load(rec: PlaqueTileRecord) {
    let data: { plaques: RawPlaque[] };
    try {
      const res = await fetch(dataUrl(`/geo/plaques/${rec.key}.json`));
      if (!res.ok) { rec.state = 'empty'; return; }
      data = await res.json();
    } catch {
      rec.state = 'empty';
      return;
    }
    // The tile may have been unloaded while the fetch was in flight.
    if (this.records.get(rec.key) !== rec) return;
    const raw = data.plaques ?? [];
    if (!raw.length) { rec.state = 'empty'; return; }

    const ox = rec.tx * TILE_SIZE, oz = rec.tz * TILE_SIZE;
    for (const p of raw) {
      rec.plaques.push({
        x: ox + p.x / 10, z: oz + p.z / 10,
        num: p.num, st: p.st, nm: p.nm, k: p.k, lv: p.lv,
        wd: p.wd, wp: p.wp, web: p.web, o: p.o, lm: p.lm === 1,
      });
    }
    this.build(rec, raw, ox, oz);
  }

  private build(rec: PlaqueTileRecord, raw: RawPlaque[], ox: number, oz: number) {
    const n = raw.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    // shrink cells so neither atlas dimension exceeds 2048
    const cw = Math.min(CELL_W, Math.floor(2048 / cols));
    const ch = Math.min(CELL_H, Math.floor(2048 / rows));
    const atlasW = cols * cw, atlasH = rows * ch;
    const cv = document.createElement('canvas');
    cv.width = atlasW; cv.height = atlasH;
    const ctx = cv.getContext('2d')!;
    // scale the fixed-cell draw routine to the shrunk cell size
    const sx = cw / CELL_W, sy = ch / CELL_H;

    const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = raw[i];
      const col = i % cols, row = Math.floor(i / cols);
      ctx.save();
      ctx.translate(col * cw, row * ch);
      ctx.scale(sx, sy);
      const cell = drawPlaque(ctx, 0, 0, atlasW / sx, atlasH / sy, p);
      ctx.restore();

      const wx = ox + p.x / 10, wz = oz + p.z / 10, wy = p.e / 10;
      const ang = (p.a * Math.PI) / 180;
      const nx = Math.cos(ang), nz = Math.sin(ang);   // outward facing
      const tx = -nz, tz = nx;                         // wall tangent (horizontal)
      const hw = PLAQUE_W / 2, hh = PLAQUE_H / 2;
      const base = pos.length / 3;
      const corners: [number, number, number][] = [
        [wx - tx * hw, wy - hh, wz - tz * hw],
        [wx + tx * hw, wy - hh, wz + tz * hw],
        [wx + tx * hw, wy + hh, wz + tz * hw],
        [wx - tx * hw, wy + hh, wz - tz * hw],
      ];
      const uvs = [
        [cell.u0, 1 - cell.v1], [cell.u1, 1 - cell.v1], [cell.u1, 1 - cell.v0], [cell.u0, 1 - cell.v0],
      ];
      for (let c = 0; c < 4; c++) {
        pos.push(...corners[c]);
        uv.push(uvs[c][0], uvs[c][1]);
        nrm.push(nx, 0, nz);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const texture = new THREE.CanvasTexture(cv);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.minFilter = THREE.LinearFilter; // NPOT atlas — skip mipmaps
    texture.generateMipmaps = false;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({
      map: texture, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide,
      emissive: new THREE.Color(0x0c0c0e), // lift out of full shadow so numbers stay legible
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    const group = new THREE.Group();
    group.add(mesh);

    rec.geometry = geo;
    rec.texture = texture;
    rec.material = mat;
    rec.group = group;
    rec.state = 'ready';
    if (this.compile) {
      void this.compile(group).then(() => {
        if (this.records.get(rec.key) === rec) this.scene.add(group);
      });
    } else {
      this.scene.add(group);
    }
  }

  /** Nearest plaque within `dist` metres of (x,z), or null. */
  nearest(x: number, z: number, dist: number): { info: PlaqueInfo; d: number } | null {
    let best: PlaqueInfo | null = null;
    let bestD2 = dist * dist;
    for (const rec of this.records.values()) {
      for (const p of rec.plaques) {
        const dx = p.x - x, dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = p; }
      }
    }
    return best ? { info: best, d: Math.sqrt(bestD2) } : null;
  }

  private dispose(rec: PlaqueTileRecord) {
    if (rec.group) this.scene.remove(rec.group);
    rec.geometry?.dispose();
    rec.texture?.dispose();
    rec.material?.dispose();
    rec.group = null;
  }

  destroy() {
    for (const rec of this.records.values()) this.dispose(rec);
    this.records.clear();
  }
}
