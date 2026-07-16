// Curbside MTA bus stop kit: dark steel pole topped by the blue BUS STOP flag
// (canvas texture: bus glyph + stacked route chips), a Guide-A-Ride box, and an
// optional shelter. Origin at ground under the POLE, sign facing +z, the kit
// extending along local -x (BusSystem orients +x along the street).
//
// Conventions (see streetprops.ts / EntranceManager.ts):
// - materials shared at module scope; geometries fresh per call, collapsed by
//   mergeByMaterial (which clones + disposes the sources).
// - sign textures/materials are CACHED module-level by content key and shared
//   across kits, so their meshes are marked userData.shared with module-shared
//   geometry: the caller's disposeGroup skips them entirely and only frees the
//   per-kit merged geometries. Never dispose the cache.
// - NO transparent panes: the shelter "glass" is opaque smoked gray.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeByMaterial } from '../EntranceManager';
import { hash01 } from '../palette';
import { BLACK, SANS } from '../fonts';
import type { BusRouteBadge, BusStopKitFactory } from './types';

// ---- shared materials -------------------------------------------------------
const DARK_STEEL = new THREE.MeshLambertMaterial({ color: '#26282b' });
// opaque smoked-glass look for the shelter panels (never transparent — see the
// repo-wide rule about transparent panes mis-sorting against the street).
const SMOKED = new THREE.MeshLambertMaterial({ color: '#232a33', emissive: '#0a0d11' });
const TRIM_WHITE = new THREE.MeshLambertMaterial({ color: '#e6e8ea' });
const STEEL_LIGHT = new THREE.MeshLambertMaterial({ color: '#969ca1' });

// ---- shared sign geometry (module-level, userData.shared meshes) ------------
// Two unit planes back-to-back (the rear one rotated, so text reads correctly
// from -z too). Scaled per mesh; never disposed.
function makeDualPlane(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(1, 1).translate(0, 0, 0.005);
  const b = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI).translate(0, 0, -0.005);
  const merged = mergeGeometries([a, b], false)!;
  a.dispose();
  b.dispose();
  return merged;
}
const DUAL_PLANE_GEO = makeDualPlane();
const FRONT_PLANE_GEO = new THREE.PlaneGeometry(1, 1);

// ---- canvas helpers ----------------------------------------------------------
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, startPx: number, family: string): number {
  let size = startPx;
  ctx.font = `${size}px ${family}`;
  while (ctx.measureText(text).width > maxW && size > 10) {
    size -= 2;
    ctx.font = `${size}px ${family}`;
  }
  return size;
}

function drawFlag(ctx: CanvasRenderingContext2D, w: number, h: number, routes: BusRouteBadge[]): void {
  // OPAQUE dark backing frame (a floating transparent-cornered plane would
  // depth-write alpha-0 pixels and punch holes against the street)
  ctx.fillStyle = '#1b1d1f';
  ctx.fillRect(0, 0, w, h);
  // deep blue MTA field
  rr(ctx, 8, 8, w - 16, 292, 18);
  ctx.fillStyle = '#0039a6';
  ctx.fill();
  // white side-view bus glyph (windows/hubs punched back in field blue)
  const bx = 46, by = 44, bw = w - 92, bh = 74;
  rr(ctx, bx, by, bw, bh, 14);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.fillStyle = '#0039a6';
  for (let i = 0; i < 4; i++) {
    rr(ctx, bx + 10 + i * 38, by + 10, 30, 26, 4);
    ctx.fill();
  }
  for (const cx of [bx + 28, bx + bw - 28]) {
    ctx.beginPath();
    ctx.arc(cx, by + bh + 4, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, by + bh + 4, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0039a6';
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `52px ${BLACK}`;
  ctx.fillText('BUS', w / 2, 200);
  ctx.fillText('STOP', w / 2, 258);
  // white plate stacking up to 6 route chips (rounded rects, MTA bus style)
  rr(ctx, 8, 312, w - 16, h - 322, 14);
  ctx.fillStyle = '#f2f4f6';
  ctx.fill();
  const chips = routes.slice(0, 6);
  const pitch = 38;
  for (let i = 0; i < chips.length; i++) {
    const y = 322 + i * pitch;
    rr(ctx, 22, y, w - 44, 32, 8);
    ctx.fillStyle = chips[i].color;
    ctx.fill();
    if (chips[i].sbs) {
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#00a6ce';
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    const size = fitFont(ctx, chips[i].id, w - 68, 24, BLACK);
    ctx.font = `${size}px ${BLACK}`;
    ctx.fillText(chips[i].id, w / 2, y + 17);
  }
}

function drawGuide(ctx: CanvasRenderingContext2D, w: number, h: number, routes: BusRouteBadge[]): void {
  rr(ctx, 0, 0, w, h, 10);
  ctx.fillStyle = '#f4f5f7';
  ctx.fill();
  ctx.fillStyle = '#101214';
  ctx.fillRect(0, 0, w, 44);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `22px ${BLACK}`;
  ctx.fillText('GUIDE-A-RIDE', w / 2, 24);
  const rows = routes.slice(0, 6);
  for (let i = 0; i < rows.length; i++) {
    const y = 60 + i * 42;
    rr(ctx, 14, y, 62, 30, 6);
    ctx.fillStyle = rows[i].color;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    const size = fitFont(ctx, rows[i].id, 54, 18, BLACK);
    ctx.font = `${size}px ${BLACK}`;
    ctx.fillText(rows[i].id, 45, y + 16);
    ctx.fillStyle = '#3c4044';
    ctx.textAlign = 'left';
    ctx.font = `bold 15px ${SANS}`;
    ctx.fillText('route & schedule', 86, y + 16);
    ctx.textAlign = 'center';
  }
}

// ---- texture/material cache (shared across kits; never disposed) -------------
interface StopSignMats { flag: THREE.MeshBasicMaterial; guide: THREE.MeshBasicMaterial; }
const signCache = new Map<string, StopSignMats>();

function bake(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, transparent: boolean): THREE.MeshBasicMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // MeshBasic: unlit, so the warm-sun tonemap never shifts the chip colors
  // (same reasoning as the streetprops entrance sign).
  return new THREE.MeshBasicMaterial({ map: tex, color: '#ffffff', transparent });
}

function signMats(routes: BusRouteBadge[], shelter: boolean): StopSignMats {
  const key = routes.map((r) => `${r.id}:${r.color}:${r.sbs ? 1 : 0}`).sort().join(',') + `|s${shelter ? 1 : 0}`;
  let m = signCache.get(key);
  if (!m) {
    m = {
      flag: bake(256, 560, (ctx) => drawFlag(ctx, 256, 560, routes), false),
      guide: bake(224, 320, (ctx) => drawGuide(ctx, 224, 320, routes), false),
    };
    signCache.set(key, m);
  }
  return m;
}

// ---- kit builder --------------------------------------------------------------
function boxAt(g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
}

export const buildBusStop: BusStopKitFactory = (routes: BusRouteBadge[], seed: number, shelter: boolean): THREE.Group => {
  const kit = new THREE.Group();
  kit.name = 'Bus Stop';
  const poleH = 3.2 + hash01(seed * 17 + 3) * 0.12;

  // pole + base
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, poleH, 8), DARK_STEEL);
  pole.position.y = poleH / 2;
  kit.add(pole);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.06, 8), DARK_STEEL);
  base.position.y = 0.03;
  kit.add(base);

  // Guide-A-Ride box on the pole (~1.5 m, seed-jittered)
  const guideY = 1.46 + hash01(seed * 29 + 11) * 0.1;
  boxAt(kit, DARK_STEEL, 0.44, 0.6, 0.1, 0, guideY, 0.06);

  if (shelter) {
    // ~4.3 x 1.5 m shelter offset along -x: steel frame, OPAQUE smoked panels,
    // flat roof with white edge trim, steel bench. All merged (<= 8 draws).
    const cx = -2.9 - hash01(seed * 7 + 1) * 0.25;
    for (const px of [cx - 2.02, cx + 2.02]) {
      for (const pz of [-0.68, 0.88]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.34, 6), DARK_STEEL);
        post.position.set(px, 1.17, pz);
        kit.add(post);
      }
    }
    boxAt(kit, DARK_STEEL, 4.5, 0.08, 1.7, cx, 2.36, 0.1); // roof slab
    boxAt(kit, TRIM_WHITE, 4.62, 0.07, 0.09, cx, 2.41, 0.955); // roof trim, street edge
    boxAt(kit, TRIM_WHITE, 4.62, 0.07, 0.09, cx, 2.41, -0.755); // roof trim, back edge
    boxAt(kit, TRIM_WHITE, 0.09, 0.07, 1.62, cx - 2.265, 2.41, 0.1);
    boxAt(kit, TRIM_WHITE, 0.09, 0.07, 1.62, cx + 2.265, 2.41, 0.1);
    boxAt(kit, SMOKED, 3.94, 2.0, 0.05, cx, 1.25, -0.66); // back panel
    boxAt(kit, SMOKED, 0.05, 2.0, 1.3, cx - 2.0, 1.25, 0.0); // far side panel
    boxAt(kit, SMOKED, 0.05, 2.0, 1.3, cx + 2.0, 1.25, 0.0); // near side panel
    boxAt(kit, STEEL_LIGHT, 3.3, 0.07, 0.42, cx, 0.56, -0.34); // bench slab
    boxAt(kit, DARK_STEEL, 0.08, 0.52, 0.36, cx - 1.4, 0.26, -0.34);
    boxAt(kit, DARK_STEEL, 0.08, 0.52, 0.36, cx + 1.4, 0.26, -0.34);
  }

  const out = mergeByMaterial(kit);
  out.name = kit.name;

  // Cached-texture signs, added AFTER the merge with shared geometry and
  // userData.shared so disposeGroup leaves both the geometry and the cached
  // canvas material alone.
  const mats = signMats(routes, shelter);
  const flag = new THREE.Mesh(DUAL_PLANE_GEO, mats.flag);
  flag.scale.set(0.56, 1.225, 1);
  flag.position.set(0, poleH - 0.55, 0.05);
  flag.rotation.y = (hash01(seed * 41 + 5) - 0.5) * 0.05;
  flag.userData.shared = true;
  out.add(flag);
  const guide = new THREE.Mesh(FRONT_PLANE_GEO, mats.guide);
  guide.scale.set(0.34, 0.485, 1);
  guide.position.set(0, guideY, 0.117);
  guide.userData.shared = true;
  out.add(guide);

  return out;
};
