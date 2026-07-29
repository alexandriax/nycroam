// MTA New York City Bus vehicle (New Flyer Xcelsior XD40-style), built with the
// subway-train conventions (see subway/train.ts):
// - windows are real OPENINGS between opaque wall segments (NO transparent
//   glass anywhere: transparent panes mis-sort against the street and glitch
//   black). The rider sees the streets through the openings; passers-by see
//   the lit interior.
// - canvas-texture signage; STATIC sign textures are cached module-level by
//   content key and shared across instances (never disposed); the dynamic
//   interior next-stop LED is per-instance and disposed with the bus.
// - module-level shared materials; after building, everything static is
//   collapsed with mergeByMaterial. Only the 4 door leaves, the 2 axle
//   spinners and the interior LED plane stay dynamic (~24 draws per bus).
//
// Local frame: +x forward, +y up, doors on +z (curb side). Group origin at
// GROUND level under the bus center. BusSystem clamps the rider inside
// BUS.interior at BUS.floorY, so the walkable box stays clear of geometry:
// seats/wells flank it (|z| >= 0.95, x <= -5.25 deck, x >= 3.3 cab) and the
// only things inside it are floor-level standee strips (<= 9 mm tall), the
// stanchion poles pinned exactly at the z = +-0.95 boundary, and ceiling rails
// above floorY + 2.0.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeByMaterial } from '../EntranceManager';
import { BLACK, LED, SANS } from '../fonts';
import { BUS, type BusModelLike, type BusModelOpts } from './types';
import { canvas2d } from '../canvas2d';

// ---------------------------------------------------------------------------
// Layout constants (absolute y from ground; x/z in the bus local frame)
// ---------------------------------------------------------------------------
const L = BUS.length; // 12.2
const HALF_W = BUS.width / 2; // 1.3
const FLOOR_Y = BUS.floorY; // 0.38
const BODY_X = L / 2 - 0.04; // side walls span +-6.06; bumpers reach ~+-6.13
const WALL_T = 0.06;
const WALL_Z = HALF_W - WALL_T / 2; // side-wall center plane (outer skin at 1.30)

// horizontal paint bands, bottom -> top (stacked boxes: no coplanar overlays)
const SKIRT_B = 0.4;
const SKIRT_T = 0.62;
const WHITE_T = 1.06; // lower white panel top
const BELT_T = 1.3; // royal-blue beltline stripe top
const SILL = 1.42; // black sill band 1.30..1.42; window OPENING starts here
const HEAD = 2.42; // window opening ends (also the door top)
const HEAD_T = 2.54; // black head band
const CANT_T = 2.96; // upper white band top (roof line)

// doors (curb side +z). Openings: ~1.3 m front / 1.5 m rear.
const DOOR_B = 0.36;
const FRONT_DOOR_W = 1.3;
const REAR_DOOR_W = 1.5;
const FRONT_BAY_A = BUS.doorX.front - FRONT_DOOR_W / 2; // 3.45
const FRONT_BAY_B = BUS.doorX.front + FRONT_DOOR_W / 2; // 4.75
const REAR_BAY_A = BUS.doorX.rear - REAR_DOOR_W / 2; // -1.90
const REAR_BAY_B = BUS.doorX.rear + REAR_DOOR_W / 2; // -0.40
const FRONT_LEAF_W = 0.66; // 2 leaves overlap the 1.30 opening by 1 cm each side
const REAR_LEAF_W = 0.76;
const FRONT_SLIDE = 0.7; // > 0.65 so leaves fully clear the opening at t=1
const REAR_SLIDE = 0.8; // > 0.75 likewise
const DOOR_OUT = 0.06; // outward (+z) glide while sliding
const LEAF_Z = HALF_W + 0.04; // closed-leaf center plane, proud of the skin
const LEAF_T = 0.045;

// wheels
const AXLE_F = 3.2; // front axle (arch trim stops at the front door bay)
const AXLE_R = -3.6;
const TIRE_R = 0.48;
const TIRE_W = 0.3;
const WHEEL_Z = 1.04; // tucked inside the skirt

const CEIL_Y = 2.555; // interior ceiling panel center (clear of floorY + 2.0)

// ---------------------------------------------------------------------------
// Shared materials (module scope; every BusModel reuses these). Interior mats
// carry a small emissive floor so the cabin never renders pitch black.
// ---------------------------------------------------------------------------
const WHITE = new THREE.MeshLambertMaterial({ color: '#e9ebed', emissive: '#232425' });
const BLUE = new THREE.MeshLambertMaterial({ color: '#1740a6', emissive: '#060f28' });
const BAND = new THREE.MeshLambertMaterial({ color: '#101214', emissive: '#050606' });
const SKIRT = new THREE.MeshLambertMaterial({ color: '#26292c', emissive: '#0e0f10' });
const ROOF = new THREE.MeshLambertMaterial({ color: '#cdd1d4' });
const SEAT = new THREE.MeshLambertMaterial({ color: '#1c4f9c', emissive: '#16336b' });
// lit interior lining: the hull shadows all direct sun, so cabin surfaces need
// a real emissive floor to read as a lit bus (same trick as the train interior)
const PANEL = new THREE.MeshLambertMaterial({ color: '#c6cacd', emissive: '#585b5e' });
const CEIL_MAT = new THREE.MeshLambertMaterial({ color: '#eef0f2', emissive: '#55575a' });
const LIGHT_WARM = new THREE.MeshBasicMaterial({ color: '#fff2d6' }); // ceiling strips + headlights
const STANDEE = new THREE.MeshLambertMaterial({ color: '#e3c235', emissive: '#55480f' });
const POLE = new THREE.MeshStandardMaterial({ color: '#d9b842', metalness: 0.55, roughness: 0.38 });
const TAIL_RED = new THREE.MeshLambertMaterial({ color: '#3a0d0d', emissive: '#ff2222', emissiveIntensity: 1.0 });
const AMBER = new THREE.MeshLambertMaterial({ color: '#4a2c08', emissive: '#ffa22e', emissiveIntensity: 1.0 });
const TIRE_MAT = new THREE.MeshLambertMaterial({ color: '#17181a' });
const HUB_MAT = new THREE.MeshLambertMaterial({ color: '#9aa0a5' });
const DOOR_MAT = new THREE.MeshLambertMaterial({ color: '#d9dcdf', emissive: '#1d1e1f' });
const TEAL = new THREE.MeshLambertMaterial({ color: '#00a6ce' }); // SBS accent

// merged-hull buckets that cast/receive shadows
const SHADOW_MATS = new Set<THREE.Material>([WHITE, BLUE, BAND, SKIRT, ROOF]);

let farTemplate: THREE.Group | null = null;
/**
 * Five-draw XD40 silhouette for buses seen down the avenue. At 130m the real
 * doors, cabin poles, lamps and individual wheels are sub-pixel, but the white
 * body, blue belt, dark glazing, roof and paired wheel masses remain legible.
 */
function farBusTemplate(): THREE.Group {
  if (farTemplate) return farTemplate;
  const source = new THREE.Group();
  const add = (
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    source.add(mesh);
  };
  add(WHITE, L, 2.5, BUS.width, 0, 1.6, 0);
  add(BLUE, L + 0.03, 0.24, BUS.width + 0.035, 0, 1.18, 0);
  add(BAND, L - 0.65, 0.82, BUS.width + 0.045, 0.05, 2.02, 0);
  add(ROOF, L - 0.3, 0.18, BUS.width - 0.18, -0.05, 2.93, 0);
  for (const x of [AXLE_F, AXLE_R]) add(TIRE_MAT, 0.92, 0.76, BUS.width + 0.08, x, 0.48, 0);
  farTemplate = mergeByMaterial(source, { receiveShadow: true });
  farTemplate.name = 'Bus distance silhouette';
  farTemplate.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = false;
      child.userData.shared = true;
    }
  });
  return farTemplate;
}

// ---------------------------------------------------------------------------
// Shared geometries for the dynamic parts (module cache; NEVER disposed —
// these are kept out of mergeByMaterial, which disposes its sources)
// ---------------------------------------------------------------------------
const leafGeoCache = new Map<number, THREE.BufferGeometry>();

/** One door leaf: framed panel with its own window OPENING (1.10..2.30). */
function leafGeometry(w: number): THREE.BufferGeometry {
  let g = leafGeoCache.get(w);
  if (!g) {
    const parts = [
      new THREE.BoxGeometry(w, 1.1 - DOOR_B, LEAF_T).translate(0, (DOOR_B + 1.1) / 2, 0), // lower panel
      new THREE.BoxGeometry(w, HEAD - 2.3, LEAF_T).translate(0, (2.3 + HEAD) / 2, 0), // header
      new THREE.BoxGeometry(0.07, 1.2, LEAF_T).translate(-(w / 2 - 0.035), 1.7, 0), // stiles frame
      new THREE.BoxGeometry(0.07, 1.2, LEAF_T).translate(w / 2 - 0.035, 1.7, 0), //   the window
    ];
    g = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();
    leafGeoCache.set(w, g);
  }
  return g;
}

let axleGeoShared: THREE.BufferGeometry | null = null;

/** Both tires + both hubs of one axle in a single 2-group geometry. */
function axleGeometry(): THREE.BufferGeometry {
  if (!axleGeoShared) {
    const tires: THREE.BufferGeometry[] = [];
    const hubs: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      tires.push(new THREE.CylinderGeometry(TIRE_R, TIRE_R, TIRE_W, 12).rotateX(Math.PI / 2).translate(0, 0, s * WHEEL_Z));
      hubs.push(new THREE.CylinderGeometry(0.2, 0.2, TIRE_W + 0.05, 8).rotateX(Math.PI / 2).translate(0, 0, s * WHEEL_Z));
    }
    const t = mergeGeometries(tires, false)!;
    const h = mergeGeometries(hubs, false)!;
    for (const x of [...tires, ...hubs]) x.dispose();
    axleGeoShared = mergeGeometries([t, h], true)!; // group 0 = tires, 1 = hubs
    t.dispose();
    h.dispose();
  }
  return axleGeoShared;
}

// ---------------------------------------------------------------------------
// Canvas helpers + cached STATIC sign materials (shared across instances)
// ---------------------------------------------------------------------------
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

/** The raw feed route id sometimes carries its own "-SBS"/"+SBS" suffix
 * (e.g. "M14A-SBS"), which would otherwise force the big amber glyph to
 * shrink for a status the teal side stripe + chip already show. Strip it
 * for DISPLAY only — callers still cache/key on the untouched route id. */
function routeLabel(route: string): string {
  return route.replace(/[+-]SBS$/i, '');
}

function charSum(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i);
  return n;
}

const signMatCache = new Map<string, THREE.Material>();

// Merged static hull (exterior + interior + route/dest signs) keyed by its full
// visual content. Every field the build reads — route, dest, sbs — is in the key,
// and the builders are pure (no randomness), so all buses on a route+direction
// share ONE merged geometry. New instances clone it (meshes share the cached
// geometry + materials), turning a ~8 ms rebuild-and-merge into a cheap clone.
// Templates are never disposed (bounded to route×dest×sbs), same as the shared
// door/axle geometries above.
const hullCache = new Map<string, THREE.Group>();

function cachedCanvasMat(
  key: string,
  w: number,
  h: number,
  opts: { lit?: boolean; transparent?: boolean },
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.Material {
  let m = signMatCache.get(key);
  if (!m) {
    const { cv: canvas, ctx } = canvas2d(w, h);
    draw(ctx);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = opts.lit
      ? new THREE.MeshLambertMaterial({ map: tex, color: '#ffffff', transparent: !!opts.transparent })
      : new THREE.MeshBasicMaterial({ map: tex, color: '#ffffff', transparent: !!opts.transparent });
    signMatCache.set(key, m);
  }
  return m;
}

/** Front destination: amber-on-black LED, ROUTE dominant with a smaller
 * `{dest}` alongside (+ teal SBS chip). Canvas/plate are taller than a stock
 * letterbox headsign so the route glyph reads big on approach; `dest` keeps
 * the SAME pixel size as the old strip, so relative to the bigger route it
 * now reads as clearly secondary (like a real bus headsign). */
function frontDestMat(route: string, dest: string, sbs: boolean): THREE.Material {
  return cachedCanvasMat(`F|${route}|${dest}|${sbs ? 1 : 0}`, 768, 200, {}, (ctx) => {
    ctx.fillStyle = '#060708';
    ctx.fillRect(0, 0, 768, 200);
    const amber = '#ffb531';
    const label = routeLabel(route);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = amber;
    ctx.shadowColor = amber;
    ctx.shadowBlur = 10;
    const rSize = fitFont(ctx, label, 420, 176, LED);
    ctx.font = `${rSize}px ${LED}`;
    ctx.fillText(label, 28, 104);
    let x = 28 + ctx.measureText(label).width + 28;
    if (sbs) {
      ctx.shadowBlur = 0;
      rr(ctx, x, 64, 124, 72, 12);
      ctx.fillStyle = '#00a6ce';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.font = `36px ${BLACK}`;
      ctx.fillText('+SBS', x + 62, 102);
      ctx.textAlign = 'left';
      x += 150;
      ctx.fillStyle = amber;
      ctx.shadowBlur = 10;
    }
    if (dest) {
      const dSize = fitFont(ctx, dest, 768 - x - 22, 56, LED);
      ctx.font = `${dSize}px ${LED}`;
      ctx.fillText(dest, x, 104);
    }
    ctx.shadowBlur = 0;
  });
}

/** Side/rear amber route plate: big route on top, tiny dest below. The rear
 * plate reuses this texture with a UV crop onto the route region. Wider than
 * tall (vs. the old near-square plate) so a 3-4 char route can run near its
 * full font size without the width cap shrinking it back down. */
function routePlateMat(route: string, dest: string): THREE.Material {
  return cachedCanvasMat(`P|${route}|${dest}`, 380, 200, {}, (ctx) => {
    ctx.fillStyle = '#060708';
    ctx.fillRect(0, 0, 380, 200);
    const amber = '#ffb531';
    const label = routeLabel(route);
    ctx.fillStyle = amber;
    ctx.shadowColor = amber;
    ctx.shadowBlur = 8;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rSize = fitFont(ctx, label, 356, 140, LED);
    ctx.font = `${rSize}px ${LED}`;
    ctx.fillText(label, 190, 84);
    if (dest) {
      const dSize = fitFont(ctx, dest, 360, 26, LED);
      ctx.font = `${dSize}px ${LED}`;
      ctx.fillText(dest, 190, 172);
    }
    ctx.shadowBlur = 0;
  });
}

/** Blue "MTA New York City Bus" side text strip (+ teal SBS, fleet number). */
function sideStripMat(route: string, sbs: boolean): THREE.Material {
  return cachedCanvasMat(`S|${route}|${sbs ? 1 : 0}`, 1280, 96, { lit: true, transparent: true }, (ctx) => {
    ctx.clearRect(0, 0, 1280, 96);
    ctx.beginPath();
    ctx.arc(46, 48, 40, 0, Math.PI * 2);
    ctx.fillStyle = '#1740a6';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `26px ${BLACK}`;
    ctx.fillText('MTA', 46, 50);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#1740a6';
    const main = 'New York City Bus';
    const mSize = fitFont(ctx, main, sbs ? 520 : 880, 54, SANS);
    ctx.font = `bold ${mSize}px ${SANS}`;
    ctx.fillText(main, 100, 52);
    let x = 100 + ctx.measureText(main).width + 34;
    if (sbs) {
      ctx.fillStyle = '#00a6ce';
      const tSize = fitFont(ctx, '+ SELECT BUS SERVICE', 1080 - x, 40, BLACK);
      ctx.font = `${tSize}px ${BLACK}`;
      ctx.fillText('+ SELECT BUS SERVICE', x, 52);
      x += ctx.measureText('+ SELECT BUS SERVICE').width;
    }
    const fleet = 3800 + ((charSum(route) * 31) % 1100);
    ctx.fillStyle = '#43474c';
    ctx.textAlign = 'right';
    ctx.font = `bold 40px ${SANS}`;
    ctx.fillText(`#${fleet}`, 1256, 52);
  });
}

/** Rear engine grille (route-independent; one shared texture). */
function grilleMat(): THREE.Material {
  return cachedCanvasMat('G', 256, 224, { lit: true }, (ctx) => {
    ctx.fillStyle = '#17191b';
    ctx.fillRect(0, 0, 256, 224);
    ctx.fillStyle = '#2c2f33';
    for (let y = 10; y < 214; y += 14) ctx.fillRect(10, y, 236, 5);
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(18, 148, 96, 62);
    ctx.fillRect(142, 148, 96, 62);
  });
}

// ---------------------------------------------------------------------------
// Small builder helpers (fresh geometry per call: mergeByMaterial disposes it)
// ---------------------------------------------------------------------------
function addBox(g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

function addCyl(g: THREE.Group, mat: THREE.Material, r: number, len: number, x: number, y: number, z: number, seg = 6, alongX = false): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r, r, len, seg);
  if (alongX) geo.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

/** One horizontal paint band of a side-wall segment. */
function addBandBox(g: THREE.Group, mat: THREE.Material, a: number, b: number, y0: number, y1: number, z: number): void {
  addBox(g, mat, b - a, y1 - y0, WALL_T, (a + b) / 2, (y0 + y1) / 2, z);
}

// ---------------------------------------------------------------------------
// Exterior
// ---------------------------------------------------------------------------
function buildExterior(g: THREE.Group, sbs: boolean): void {
  // Side walls. Curb side (+z) is segmented around the two door bays; the
  // street side (-z) is one continuous run. Each segment is a stack of band
  // boxes with the SILL..HEAD row left as a real OPENING, framed by dark edge
  // posts and mullions (train-style window band).
  const sides: { s: 1 | -1; segs: [number, number][] }[] = [
    { s: 1, segs: [[-BODY_X, REAR_BAY_A], [REAR_BAY_B, FRONT_BAY_A], [FRONT_BAY_B, BODY_X]] },
    { s: -1, segs: [[-BODY_X, BODY_X]] },
  ];
  for (const { s, segs } of sides) {
    const z = s * WALL_Z;
    for (const [a, b] of segs) {
      addBandBox(g, SKIRT, a, b, SKIRT_B, SKIRT_T, z);
      addBandBox(g, WHITE, a, b, SKIRT_T, WHITE_T, z);
      addBandBox(g, BLUE, a, b, WHITE_T, BELT_T, z);
      addBandBox(g, BAND, a, b, BELT_T, SILL, z);
      // window band: edge posts + mullions (the gaps between are OPENINGS)
      const w = b - a;
      const midY = (SILL + HEAD) / 2;
      addBox(g, BAND, 0.07, HEAD - SILL, WALL_T + 0.02, a + 0.035, midY, z);
      addBox(g, BAND, 0.07, HEAD - SILL, WALL_T + 0.02, b - 0.035, midY, z);
      const panes = Math.max(1, Math.round(w / 1.5));
      for (let k = 1; k < panes; k++) {
        addBox(g, BAND, 0.06, HEAD - SILL, WALL_T + 0.02, a + (w * k) / panes, midY, z);
      }
    }
    // continuous header above the windows/doors
    addBandBox(g, BAND, -BODY_X, BODY_X, HEAD, HEAD_T, z);
    addBandBox(g, WHITE, -BODY_X, BODY_X, HEAD_T, CANT_T, z);
    // wheel-arch trim, proud of the skin (front arch stops at the door bay;
    // the open front-door leaf glides OUTSIDE it, like the real thing)
    for (const [aa, ab] of [[2.58, 3.44], [-4.22, -2.98]] as [number, number][]) {
      addBox(g, BAND, ab - aa, 1.04 - SKIRT_B, 0.012, (aa + ab) / 2, (SKIRT_B + 1.04) / 2, s * (HALF_W + 0.006));
    }
    if (sbs) addBox(g, TEAL, 3.6, BELT_T - WHITE_T, 0.012, 1.5, (WHITE_T + BELT_T) / 2, s * (HALF_W + 0.006));
  }

  // Front face (x ~ +6.03): huge windshield OPENING between thin pillars,
  // black destination-sign box above, headlights/signals on the lower mask.
  addBox(g, SKIRT, 0.08, SKIRT_T - SKIRT_B, 2.56, 6.03, (SKIRT_B + SKIRT_T) / 2, 0);
  addBox(g, WHITE, 0.08, 1.15 - SKIRT_T, 2.56, 6.03, (SKIRT_T + 1.15) / 2, 0); // lower mask
  addBox(g, BAND, 0.08, 2.88 - 2.35, 2.56, 6.03, (2.35 + 2.88) / 2, 0); // dest-sign box (enlarged for a bigger route glyph)
  addBox(g, WHITE, 0.08, CANT_T - 2.88, 2.56, 6.03, (2.88 + CANT_T) / 2, 0); // cap
  for (const pz of [-1.23, 1.23]) addBox(g, BAND, 0.08, 2.35 - 1.15, 0.1, 6.03, 1.75, pz); // A-pillars
  addBox(g, BAND, 0.08, 2.35 - 1.15, 0.06, 6.03, 1.75, 0); // 2-piece windshield mullion
  addBox(g, SKIRT, 0.1, 0.34, 2.62, 6.08, 0.45, 0); // bumper
  for (const lz of [-0.82, 0.82]) addBox(g, LIGHT_WARM, 0.07, 0.16, 0.34, 6.085, 0.86, lz); // headlights
  for (const lz of [-1.09, 1.09]) addBox(g, AMBER, 0.07, 0.16, 0.13, 6.085, 0.86, lz); // turn signals
  const wiper = addBox(g, BAND, 0.025, 0.8, 0.03, 6.09, 1.45, -0.35);
  wiper.rotation.x = 0.55;
  for (const s of [-1, 1] as const) {
    // side mirrors on thin arms
    const arm = addBox(g, BAND, 0.05, 0.05, 0.42, 6.0, 2.18, s * 1.36);
    arm.rotation.x = s * -0.25;
    addBox(g, BAND, 0.16, 0.32, 0.06, 6.0, 2.0, s * 1.56);
  }

  // Rear face: engine grille band, taillights, no window.
  addBox(g, WHITE, 0.08, CANT_T - 1.95, 2.56, -6.03, (1.95 + CANT_T) / 2, 0);
  addBox(g, SKIRT, 0.08, 1.95 - 0.72, 2.56, -6.03, (0.72 + 1.95) / 2, 0);
  addBox(g, SKIRT, 0.08, 0.72 - SKIRT_B, 2.56, -6.03, (SKIRT_B + 0.72) / 2, 0);
  addBox(g, SKIRT, 0.1, 0.34, 2.62, -6.08, 0.45, 0); // rear bumper
  for (const lz of [-1.06, 1.06]) {
    addBox(g, TAIL_RED, 0.07, 0.55, 0.14, -6.09, 1.05, lz);
    addBox(g, AMBER, 0.07, 0.14, 0.14, -6.09, 0.66, lz);
  }

  // Roof: pale gray slab + low full-length HVAC hump (top ~3.14 < 3.15).
  addBox(g, ROOF, L - 0.06, 0.1, 2.52, 0, 2.99, 0);
  addBox(g, ROOF, 10.4, 0.1, 1.6, 0, 3.09, 0);

  // dark underbody closes the view through the doorways at ground level
  addBox(g, SKIRT, 11.2, 0.22, 2.0, 0, 0.25, 0);
}

// ---------------------------------------------------------------------------
// Interior (visible through the openings AND inhabited by the rider)
// ---------------------------------------------------------------------------
function addTransverseSeat(g: THREE.Group, cx: number, s: 1 | -1): void {
  addBox(g, SKIRT, 0.3, 0.36, 0.22, cx, 0.56, s * 1.09); // pedestal
  addBox(g, SEAT, 0.42, 0.08, 0.28, cx, 0.78, s * 1.095); // cushion
  addBox(g, SEAT, 0.07, 0.5, 0.28, cx - 0.175, 1.07, s * 1.095); // backrest (faces +x)
}

function addLongBench(g: THREE.Group, a: number, b: number, s: 1 | -1): void {
  addBox(g, SEAT, b - a, 0.08, 0.28, (a + b) / 2, 1.04, s * 1.1); // cushion on the wheel box
  addBox(g, SEAT, b - a, 0.46, 0.06, (a + b) / 2, 1.33, s * 1.21); // back against the wall
}

function buildInterior(g: THREE.Group): void {
  // floor at BUS.floorY + raised rear deck (one step, +0.25) behind the walk box
  addBox(g, SKIRT, L - 0.26, 0.08, 2.44, 0, FLOOR_Y - 0.04, 0);
  addBox(g, SKIRT, 0.81, 0.25, 2.44, -5.655, FLOOR_Y + 0.125, 0); // deck: x -6.06..-5.25
  // yellow standee lines at both door bays (floor-level marking, <= 9 mm)
  addBox(g, STANDEE, FRONT_DOOR_W, 0.008, 0.07, BUS.doorX.front, FLOOR_Y + 0.007, 0.58);
  addBox(g, STANDEE, REAR_DOOR_W, 0.008, 0.07, BUS.doorX.rear, FLOOR_Y + 0.007, 0.58);

  // ceiling: off-white panels + TWO full-length warm light strips
  addBox(g, CEIL_MAT, 11.9, 0.05, 2.4, 0, CEIL_Y, 0);
  for (const s of [-1, 1]) addBox(g, LIGHT_WARM, 10.2, 0.025, 0.11, -0.3, 2.515, s * 0.42);

  // wheel-well boxes (flank the walk box at z >= 0.95)
  for (const s of [-1, 1]) {
    addBox(g, SKIRT, 0.86, 0.62, 0.31, 3.01, 0.69, s * 1.105); // front, x 2.58..3.44
    addBox(g, SKIRT, 1.24, 0.62, 0.31, AXLE_R, 0.69, s * 1.105); // rear, x -4.22..-2.98
  }

  // seats: longitudinal benches over the wheel wells, forward-facing rows
  // (narrow flank singles), and the rear-facing 5-seat bench on the deck
  addLongBench(g, 2.6, 3.42, 1);
  addLongBench(g, 2.6, 3.28, -1); // trimmed at the cab partition
  addLongBench(g, -4.2, -2.98, 1);
  addLongBench(g, -4.2, -2.98, -1);
  for (const cx of [2.05, 1.3, 0.55, -0.2, -0.95, -1.7, -2.45]) addTransverseSeat(g, cx, -1);
  for (const cx of [2.05, 1.3, 0.55, -2.45]) addTransverseSeat(g, cx, 1); // curb side skips the door bays
  for (const s of [-1, 1] as const) addTransverseSeat(g, -4.72, s);
  addBox(g, SKIRT, 0.44, 0.35, 2.1, -5.8, 0.805, 0); // rear bench base on the deck
  for (const zk of [-0.88, -0.44, 0, 0.44, 0.88]) {
    addBox(g, SEAT, 0.42, 0.08, 0.4, -5.79, 1.02, zk);
    addBox(g, SEAT, 0.08, 0.6, 0.4, -5.96, 1.42, zk);
  }

  // stanchions: warm-yellow poles at the aisle boundary (z = +-0.95 exactly),
  // two full-length ceiling handrails (above floorY + 2.0), door grab bars
  for (const s of [-1, 1]) {
    for (const px of [2.42, 0.92, -0.58, -2.08, -3.58]) addCyl(g, POLE, 0.021, 2.14, px, FLOOR_Y + 1.07, s * 0.95);
    addCyl(g, POLE, 0.02, 8.5, -0.85, 2.43, s * 0.58, 6, true);
  }
  for (const bx of [3.55, 4.65]) addCyl(g, POLE, 0.018, 1.5, bx, 1.5, 1.1);
  for (const bx of [-1.83, -0.47]) addCyl(g, POLE, 0.018, 1.5, bx, 1.5, 1.1);
  addCyl(g, POLE, 0.018, FRONT_DOOR_W - 0.2, BUS.doorX.front, 2.28, 1.1, 6, true);
  addCyl(g, POLE, 0.018, REAR_DOOR_W - 0.2, BUS.doorX.rear, 2.28, 1.1, 6, true);

  // driver cab (x > interior.maxX = 3.3). The walk box (BUS.interior.maxX in
  // World) already stops the rider here, so the divider is only a low modesty
  // panel — you see over it to the driver and the front destination sign.
  addBox(g, PANEL, 0.05, 0.98, 1.44, 3.34, 0.87, -0.52); // low cab divider
  // slim grab pole up the curb-side edge of the divider (was the full panel)
  addCyl(g, POLE, 0.02, 1.94, 3.34, 1.35, 0.16);
  addBox(g, SKIRT, 0.5, 0.42, 2.1, 5.7, 1.01, 0); // dash (visible through the windshield)
  addBox(g, BAND, 0.2, 0.1, 0.5, 5.43, 1.27, -0.55); // instrument binnacle
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6).rotateZ(0.5), BAND);
  col.position.set(5.3, 1.16, -0.55);
  g.add(col);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.022, 6, 14).rotateY(Math.PI / 2).rotateZ(-0.5), BAND);
  wheel.position.set(5.14, 1.33, -0.55);
  g.add(wheel);
  addBox(g, SKIRT, 0.16, 0.34, 0.16, 4.78, 0.55, -0.58); // driver seat pedestal
  addBox(g, SEAT, 0.44, 0.09, 0.44, 4.78, 0.765, -0.58);
  addBox(g, SEAT, 0.1, 0.62, 0.44, 4.56, 1.16, -0.58);
  addCyl(g, BAND, 0.13, 0.94, 4.45, 0.85, 0.72, 8); // farebox just inside the front door
  addBox(g, ROOF, 0.24, 0.16, 0.2, 4.45, 1.4, 0.72);

  addBox(g, BAND, 0.05, 0.26, 1.56, 3.66, 2.26, 0); // interior LED sign backing
}

// ---------------------------------------------------------------------------
// Static cached signage (planes merge into the hull; materials are cached)
// ---------------------------------------------------------------------------
function addStaticSigns(g: THREE.Group, opts: BusModelOpts): void {
  const { route, dest, sbs } = opts;
  // front destination sign in the black box above the windshield (spans
  // y 2.35..2.88, 0.53 m tall) — the plate nearly fills that box so the
  // route glyph is big
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), frontDestMat(route, dest, sbs));
  front.rotation.y = Math.PI / 2;
  front.position.set(6.08, 2.615, 0);
  g.add(front);
  // side route plates beside the front door on BOTH sides, floating in the
  // first window opening on a black backing (readable from either sidewalk
  // when buses queue at a stop; mirrored the same way as the text strip
  // below). Both planes share the one cached `plate` material, so
  // mergeByMaterial still collapses them into a single draw call. Sized to
  // the window opening (clear x 4.82..5.99, clear y 1.42..2.42 — no mullion
  // in this segment, see `panes` in buildExterior).
  const plate = routePlateMat(route, dest);
  for (const s of [-1, 1] as const) {
    addBox(g, BAND, 0.8, 0.44, 0.03, 5.35, 1.95, s * 1.275);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(0.76, 0.4), plate);
    side.position.set(5.35, 1.95, s * 1.296);
    if (s === -1) side.rotation.y = Math.PI;
    g.add(side);
  }
  // rear plate: same cached texture, UVs cropped to the route region (top
  // 75% of the plate texture, above the dest line)
  const rearGeo = new THREE.PlaneGeometry(0.61, 0.24);
  const uv = rearGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 0.25 + uv.getY(i) * 0.75);
  uv.needsUpdate = true;
  addBox(g, BAND, 0.04, 0.32, 0.68, -6.09, 2.45, 0.45);
  const rear = new THREE.Mesh(rearGeo, plate);
  rear.rotation.y = -Math.PI / 2;
  rear.position.set(-6.115, 2.45, 0.45);
  g.add(rear);
  // "MTA New York City Bus" text strip on both sides (mirrored like the
  // subway sign-back so it reads correctly from either sidewalk)
  const strip = sideStripMat(route, sbs);
  for (const s of [-1, 1] as const) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 0.218), strip);
    m.position.set(1.09, 0.84, s * (HALF_W + 0.004));
    if (s === -1) m.rotation.y = Math.PI;
    g.add(m);
  }
  // rear engine grille texture band
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.16), grilleMat());
  grille.rotation.y = -Math.PI / 2;
  grille.position.set(-6.085, 1.33, 0);
  g.add(grille);
}

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------
export class BusModel implements BusModelLike {
  readonly group: THREE.Group;

  private readonly hull = new THREE.Group(); // merged statics + doors + LED (bobs subtly)
  private readonly farHull: THREE.Group;
  private readonly mergedMeshes: THREE.Mesh[] = [];
  private readonly leaves: { mesh: THREE.Mesh; x0: number; sign: number; slide: number }[] = [];
  private readonly axles: THREE.Mesh[] = [];
  private ledGeo: THREE.PlaneGeometry | null = null;
  private ledCtx: CanvasRenderingContext2D | null = null;
  private ledTexture: THREE.CanvasTexture | null = null;
  private ledMaterial: THREE.MeshBasicMaterial | null = null;

  private ledRaw: string | null = null; // last text from setNextStop
  private ledShown = ''; // last string actually drawn (redraw throttle)
  private stopReq = false;
  private stopReqShown = false;
  private doorT = 0;
  private bobPhase = 0;
  private distanceLod = true;
  private detailed = false;
  private disposed = false;
  private idleBuild = 0;
  private readonly opts: BusModelOpts;

  constructor(opts: BusModelOpts, env?: THREE.Texture | null) {
    this.opts = opts;
    if (env && !POLE.envMap) {
      POLE.envMap = env; // steel bits pick up the shared street env map
      POLE.needsUpdate = true;
    }
    this.group = new THREE.Group();
    this.group.name = `Bus ${opts.route}`;
    this.hull.name = `Bus ${opts.route} near detail`;
    this.hull.visible = false;
    this.group.add(this.hull);
    this.farHull = farBusTemplate().clone(true);
    this.farHull.visible = true;
    this.group.add(this.farHull);

    // Most buses first materialize 100–250m down an avenue. Build only their
    // five-draw silhouette in the animation frame, then prepare the full
    // walkable XD40 during browser idle time. This removes route/destination
    // canvas work and geometry merging from the traversal tail without
    // sacrificing any geometry where a player can resolve or board the bus.
    if (typeof requestIdleCallback === 'function') {
      this.idleBuild = requestIdleCallback(() => {
        this.idleBuild = 0;
        if (!this.disposed) this.ensureDetailed();
      }, { timeout: 500 });
    } else {
      this.idleBuild = window.setTimeout(() => {
        this.idleBuild = 0;
        if (!this.disposed) this.ensureDetailed();
      }, 0);
    }
  }

  private ensureDetailed(): void {
    if (this.detailed || this.disposed) return;
    this.detailed = true;
    const opts = this.opts;
    const hullKey = `${opts.route}|${opts.dest}|${opts.sbs ? 1 : 0}`;
    let template = hullCache.get(hullKey);
    if (!template) {
      const build = new THREE.Group();
      buildExterior(build, opts.sbs);
      buildInterior(build);
      addStaticSigns(build, opts);
      template = mergeByMaterial(build);
      hullCache.set(hullKey, template);
    }
    // clone shares the cached geometry + materials — dispose() must not free them
    const merged = template.clone();
    const meshes = merged.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    this.mergedMeshes.push(...meshes);
    for (const m of meshes) {
      if (SHADOW_MATS.has(m.material as THREE.Material)) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    }
    this.hull.add(merged);

    // door leaves (kept out of the merge; slide apart in x and out in +z)
    const doors = [
      { cx: BUS.doorX.front, w: FRONT_LEAF_W, slide: FRONT_SLIDE },
      { cx: BUS.doorX.rear, w: REAR_LEAF_W, slide: REAR_SLIDE },
    ];
    for (const d of doors) {
      for (const sign of [-1, 1] as const) {
        const mesh = new THREE.Mesh(leafGeometry(d.w), DOOR_MAT);
        const x0 = d.cx + sign * (d.w / 2);
        mesh.position.set(x0, 0, LEAF_Z);
        this.hull.add(mesh);
        this.leaves.push({ mesh, x0, sign, slide: d.slide });
      }
    }

    // axle spinners: one 2-material mesh each (tires + hubs), spun in setSpeed
    for (const ax of [AXLE_F, AXLE_R]) {
      const mesh = new THREE.Mesh(axleGeometry(), [TIRE_MAT, HUB_MAT]);
      mesh.position.set(ax, TIRE_R, 0);
      this.axles.push(mesh);
      this.group.add(mesh);
    }

    // interior next-stop LED (per-instance dynamic canvas)
    const { cv: canvas, ctx } = canvas2d(768, 96);
    this.ledCtx = ctx;
    this.ledTexture = new THREE.CanvasTexture(canvas);
    this.ledTexture.colorSpace = THREE.SRGBColorSpace;
    this.ledMaterial = new THREE.MeshBasicMaterial({ map: this.ledTexture, color: '#ffffff' });
    this.ledGeo = new THREE.PlaneGeometry(1.5, 0.1875);
    const led = new THREE.Mesh(this.ledGeo, this.ledMaterial);
    led.rotation.y = -Math.PI / 2; // faces the passengers (-x)
    led.position.set(3.628, 2.26, 0);
    this.hull.add(led);
    this.ledShown = '\u0000'; // force the latest queued state onto the new canvas
    this.paintLed('', false);
    // Door state may already have advanced while this bus was a distance
    // silhouette. Apply it directly: setDoors() quite correctly skips work
    // when the scalar has not changed, but these leaves are brand new.
    for (const leaf of this.leaves) {
      leaf.mesh.position.x = leaf.x0 + leaf.sign * leaf.slide * this.doorT;
      leaf.mesh.position.z = LEAF_Z + DOOR_OUT * this.doorT;
    }
    this.renderLed();
    this.hull.visible = !this.distanceLod;
  }

  /** 0 closed .. 1 open (linear, like the train doors). */
  setDoors(t: number): void {
    const tt = Math.min(1, Math.max(0, t));
    if (tt !== this.doorT) {
      this.doorT = tt;
      for (const l of this.leaves) {
        l.mesh.position.x = l.x0 + l.sign * l.slide * tt;
        l.mesh.position.z = LEAF_Z + DOOR_OUT * tt;
      }
    }
    this.renderLed(); // dwelling flips the sign to the plain stop name
  }

  /** Wheel spin + a subtle body bob. Forward (+x) roll is negative rotation.z:
   * rotating +z by a positive angle sends the tire TOP toward -x, so the spin
   * is subtracted to make the top move toward +x. */
  setSpeed(v: number, dt: number): void {
    const spin = (v * dt) / TIRE_R;
    for (const a of this.axles) a.rotation.z -= spin;
    this.bobPhase += v * dt * 0.55;
    const amp = Math.min(1, v / 6) * 0.006;
    this.hull.position.y = Math.sin(this.bobPhase) * amp;
    this.hull.rotation.x = Math.sin(this.bobPhase * 0.7) * amp * 0.3;
  }

  /** Interior LED text: "NEXT STOP: {text}" while moving, the plain text while
   * dwelling (doors open), blank when null. Redraws only on change. */
  setNextStop(text: string | null): void {
    this.ledRaw = text;
    this.renderLed();
  }

  setStopRequested(on: boolean): void {
    this.stopReq = on;
    this.renderLed();
  }

  setViewerDistanceSq(distanceSq: number, forceFull = false): void {
    // Wide hysteresis prevents a bus circling a stop from toggling as it
    // crosses the threshold. The interaction/ride path always forces full.
    const threshold = this.distanceLod ? 82 : 102;
    const far = !forceFull && distanceSq > threshold * threshold;
    if (!far) this.ensureDetailed();
    if (far === this.distanceLod) return;
    this.distanceLod = far;
    this.hull.visible = !far;
    for (const axle of this.axles) axle.visible = !far;
    this.farHull.visible = far;
  }

  private renderLed(): void {
    const raw = this.ledRaw;
    const shown = raw === null || raw === '' ? '' : this.doorT > 0.5 ? raw : `NEXT STOP: ${raw}`;
    if (shown === this.ledShown && this.stopReq === this.stopReqShown) return;
    this.ledShown = shown;
    this.stopReqShown = this.stopReq;
    this.paintLed(shown, this.stopReq);
  }

  private paintLed(shown: string, req: boolean): void {
    const ctx = this.ledCtx;
    if (!ctx || !this.ledTexture) return;
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, 768, 96);
    const red = '#ff2d3a';
    ctx.textBaseline = 'middle';
    if (shown) {
      ctx.fillStyle = red;
      ctx.shadowColor = red;
      ctx.shadowBlur = 7;
      ctx.textAlign = 'left';
      const size = fitFont(ctx, shown, 528, 52, LED);
      ctx.font = `${size}px ${LED}`;
      ctx.fillText(shown, 18, 52);
      ctx.shadowBlur = 0;
    }
    if (req) {
      ctx.strokeStyle = red;
      ctx.lineWidth = 3;
      rr(ctx, 566, 12, 188, 72, 10);
      ctx.stroke();
      ctx.fillStyle = red;
      ctx.shadowColor = red;
      ctx.shadowBlur = 6;
      ctx.textAlign = 'center';
      ctx.font = `26px ${LED}`;
      ctx.fillText('STOP', 660, 34);
      ctx.fillText('REQUESTED', 660, 64);
      ctx.shadowBlur = 0;
    }
    this.ledTexture.needsUpdate = true;
  }

  /** Frees this instance's GPU resources. Shared module materials, the cached
   * sign textures and the shared leaf/axle geometries are left intact
   * (bikes.ts documents the same pattern). */
  dispose(): void {
    this.disposed = true;
    if (this.idleBuild) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.idleBuild);
      else clearTimeout(this.idleBuild);
      this.idleBuild = 0;
    }
    this.group.removeFromParent();
    // the merged hull geometry + materials are shared from hullCache (this bus is
    // a clone) — freeing them would break every other bus on the route. Only the
    // per-instance LED is ours to dispose.
    this.ledGeo?.dispose();
    this.ledTexture?.dispose();
    this.ledMaterial?.dispose();
  }
}
