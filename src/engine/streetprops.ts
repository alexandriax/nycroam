// Street-level subway entrance kit and misc sidewalk furniture: the classic
// NYC sidewalk stairhead with railings, globe lamp and route sign, plus a
// cobra-head street light and a traffic signal.
//
// Note on the import path below: streetprops.ts lives at src/engine/streetprops.ts
// and subway/types.ts lives at src/engine/subway/types.ts, both under src/engine/,
// so the correct relative specifier is './subway/types' (a sibling subfolder),
// not '../subway/types' — using '../subway/types' does not resolve from this
// file's actual location and would fail to compile.
//
// Materials are shared at module scope; geometries are always created fresh
// per builder call (shared only *within* one call). Callers (see
// EntranceManager's disposeGroup) dispose every mesh's geometry in one pass
// when a placed kit goes out of range, and several kits can be alive at
// once, so a geometry shared across independent calls could be destroyed
// while another still-visible kit depends on it.
import * as THREE from 'three';
import { routeColor, bulletTextColor } from './subway/types';
import { BLACK } from './fonts';

// ---------------------------------------------------------------------------
// Geometry helpers (duplicated from props.ts's pattern since this file may
// only import from 'three' and the subway types module). Pass in a fresh
// CylinderGeometry(1,1,1,N) created per builder call.
// ---------------------------------------------------------------------------
function cylMesh(geometry: THREE.CylinderGeometry, material: THREE.Material, radius: number, height: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(radius, height, radius);
  return mesh;
}

function pointAt(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  if (len > 1e-6) {
    dir.multiplyScalar(1 / len);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }
  mesh.scale.y = len;
}

// ---------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------
const HUNTER_GREEN = new THREE.MeshLambertMaterial({ color: '#0f4536' });
const DARK_STEEL = new THREE.MeshLambertMaterial({ color: '#0a0a0a' });
const CONCRETE = new THREE.MeshLambertMaterial({ color: '#9aa0a3' });
const PIT_DARK = new THREE.MeshLambertMaterial({ color: '#0a0c0e' });
const STEP_MATERIALS = [
  new THREE.MeshLambertMaterial({ color: '#9aa0a3' }),
  new THREE.MeshLambertMaterial({ color: '#55585a' }),
  new THREE.MeshLambertMaterial({ color: '#1c1d1e' }),
];
// The iconic 24-hour-entrance green globe: bright enough to spot down a block.
const GLOBE_MATERIAL = new THREE.MeshLambertMaterial({
  color: '#2fae5c',
  emissive: '#37e874',
  emissiveIntensity: 1.5,
});
const KIOSK_GLASS = new THREE.MeshLambertMaterial({
  color: '#9fb4bd',
  emissive: '#26302c',
  transparent: true,
  opacity: 0.6,
  side: THREE.DoubleSide,
});
const BRONZE = new THREE.MeshLambertMaterial({ color: '#4a3728' });
const LUMINAIRE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#2a2a2a' });
const WARM_UNDERGLOW = new THREE.MeshLambertMaterial({
  color: '#fff0c0',
  emissive: '#ffdd88',
  emissiveIntensity: 0.8,
  side: THREE.DoubleSide,
});
const SIGNAL_POLE_MATERIAL = new THREE.MeshLambertMaterial({ color: '#5c5a2e' });
const SIGNAL_HEAD_MATERIAL = new THREE.MeshLambertMaterial({ color: '#1a1a1a' });
const RED_OFF = new THREE.MeshLambertMaterial({ color: '#4a1010' });
const AMBER_OFF = new THREE.MeshLambertMaterial({ color: '#4a3a10' });
const GREEN_LIT = new THREE.MeshLambertMaterial({ color: '#1aff3c', emissive: '#1aff3c', emissiveIntensity: 1.1 });

// ---------------------------------------------------------------------------
// Fixed dimensions (plain numbers — safe to share, nothing to dispose)
// ---------------------------------------------------------------------------
const PIT_W = 1.6;
const PIT_L = 3.4;
const PIT_DEPTH = 2.6;
const WALL_T = 0.1;

const STEP_COUNT = 14;
const STEP_RISE = PIT_DEPTH / STEP_COUNT;
const STEP_RUN = PIT_L / STEP_COUNT;

const CURB_H = 0.08;
const CURB_W = 0.15;

const KIOSK_W = 2.0;
const KIOSK_H = 2.4;
const KIOSK_D = 2.0;

// ---------------------------------------------------------------------------
// Tiny local route-bullet drawing (duplicated from signage.ts's drawBullet
// to avoid cross-importing it — see the import-path note above).
// ---------------------------------------------------------------------------
function drawBullet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, route: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = routeColor(route);
  ctx.fill();
  ctx.fillStyle = bulletTextColor(route);
  ctx.font = `${Math.round(r * 1.2)}px ${BLACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(route, x, y + r * 0.05);
}

/** Sign panel width in meters — grows with the route count so 4+ bullets fit. */
export function entranceSignWidth(routeCount: number): number {
  return routeCount <= 3 ? 2.0 : 2.0 + 0.3 * (routeCount - 3);
}

function makeEntranceSignTexture(routes: string[]): THREE.CanvasTexture {
  // canvas width tracks the panel width so bullets stay circular
  const w = Math.round(512 * entranceSignWidth(routes.length));
  const h = 215;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#ffffff';
  ctx.font = `96px ${BLACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('SUBWAY', 30, h / 2);

  const r = 72;
  let bx = w - 34 - r;
  for (let i = routes.length - 1; i >= 0; i--) {
    drawBullet(ctx, bx, h / 2, r, routes[i]);
    bx -= r * 2 + 18;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/** One straight railing edge (posts + top/mid rails), centered along local +x. */
function buildRailEdge(unitCyl: THREE.CylinderGeometry, length: number, baseY: number): THREE.Group {
  const edge = new THREE.Group();
  const postSpacing = 1.0;
  const postCount = Math.max(2, Math.round(length / postSpacing) + 1);
  for (let i = 0; i < postCount; i++) {
    const x = -length / 2 + (i * length) / (postCount - 1);
    const post = cylMesh(unitCyl, HUNTER_GREEN, 0.025, 1.0);
    post.position.set(x, baseY + 0.5, 0);
    edge.add(post);
  }
  const topRail = cylMesh(unitCyl, HUNTER_GREEN, 0.032, 1);
  pointAt(topRail, new THREE.Vector3(-length / 2, baseY + 1.0, 0), new THREE.Vector3(length / 2, baseY + 1.0, 0));
  edge.add(topRail);
  const midRail = cylMesh(unitCyl, HUNTER_GREEN, 0.022, 1);
  pointAt(midRail, new THREE.Vector3(-length / 2, baseY + 0.55, 0), new THREE.Vector3(length / 2, baseY + 0.55, 0));
  edge.add(midRail);
  return edge;
}

/**
 * Classic NYC sidewalk subway stair entrance. Origin sits at sidewalk level,
 * centered on the 1.6m-wide opening; the stairwell descends toward +z while
 * the near (-z) side stays open to the sidewalk.
 */
export function buildEntranceKit(routes: string[], kind: string, name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name || 'Subway Entrance';
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  if (kind === 'elevator') {
    const postH = KIOSK_H - 0.2;
    const baseGeo = new THREE.BoxGeometry(KIOSK_W, 0.1, KIOSK_D);
    const postGeo = new THREE.BoxGeometry(0.1, postH, 0.1);
    const roofGeo = new THREE.BoxGeometry(KIOSK_W + 0.15, 0.1, KIOSK_D + 0.15);
    const fbGlassGeo = new THREE.PlaneGeometry(KIOSK_W - 0.2, KIOSK_H - 0.3);
    const sideGlassGeo = new THREE.PlaneGeometry(KIOSK_D - 0.2, KIOSK_H - 0.3);

    const base = new THREE.Mesh(baseGeo, HUNTER_GREEN);
    base.position.set(0, 0.05, KIOSK_D / 2);
    group.add(base);

    const corners: Array<[number, number]> = [
      [-KIOSK_W / 2 + 0.05, 0.05],
      [KIOSK_W / 2 - 0.05, 0.05],
      [-KIOSK_W / 2 + 0.05, KIOSK_D - 0.05],
      [KIOSK_W / 2 - 0.05, KIOSK_D - 0.05],
    ];
    for (const [cx, cz] of corners) {
      const post = new THREE.Mesh(postGeo, HUNTER_GREEN);
      post.position.set(cx, 0.1 + postH / 2, cz);
      group.add(post);
    }

    const frontGlass = new THREE.Mesh(fbGlassGeo, KIOSK_GLASS);
    frontGlass.position.set(0, 0.1 + postH / 2, 0.05);
    group.add(frontGlass);
    const backGlass = new THREE.Mesh(fbGlassGeo, KIOSK_GLASS);
    backGlass.position.set(0, 0.1 + postH / 2, KIOSK_D - 0.05);
    group.add(backGlass);
    const leftGlass = new THREE.Mesh(sideGlassGeo, KIOSK_GLASS);
    leftGlass.rotation.y = Math.PI / 2;
    leftGlass.position.set(-KIOSK_W / 2 + 0.05, 0.1 + postH / 2, KIOSK_D / 2);
    group.add(leftGlass);
    const rightGlass = new THREE.Mesh(sideGlassGeo, KIOSK_GLASS);
    rightGlass.rotation.y = Math.PI / 2;
    rightGlass.position.set(KIOSK_W / 2 - 0.05, 0.1 + postH / 2, KIOSK_D / 2);
    group.add(rightGlass);

    const roof = new THREE.Mesh(roofGeo, HUNTER_GREEN);
    roof.position.set(0, 0.15 + postH, KIOSK_D / 2);
    group.add(roof);
  } else {
    const floorGeo = new THREE.BoxGeometry(PIT_W, WALL_T, PIT_L);
    const backWallGeo = new THREE.BoxGeometry(PIT_W, PIT_DEPTH, WALL_T);
    const sideWallGeo = new THREE.BoxGeometry(WALL_T, PIT_DEPTH, PIT_L);
    const stepGeo = new THREE.BoxGeometry(PIT_W - 0.05, STEP_RISE, STEP_RUN);
    const curbBackGeo = new THREE.BoxGeometry(PIT_W + CURB_W * 2, CURB_H, CURB_W);
    const curbSideGeo = new THREE.BoxGeometry(CURB_W, CURB_H, PIT_L + CURB_W);

    const floor = new THREE.Mesh(floorGeo, PIT_DARK);
    floor.position.set(0, -PIT_DEPTH - WALL_T / 2, PIT_L / 2);
    group.add(floor);

    const backWall = new THREE.Mesh(backWallGeo, PIT_DARK);
    backWall.position.set(0, -PIT_DEPTH / 2, PIT_L + WALL_T / 2);
    group.add(backWall);

    const leftWall = new THREE.Mesh(sideWallGeo, PIT_DARK);
    leftWall.position.set(-PIT_W / 2 - WALL_T / 2, -PIT_DEPTH / 2, PIT_L / 2);
    group.add(leftWall);
    const rightWall = new THREE.Mesh(sideWallGeo, PIT_DARK);
    rightWall.position.set(PIT_W / 2 + WALL_T / 2, -PIT_DEPTH / 2, PIT_L / 2);
    group.add(rightWall);

    for (let i = 0; i < STEP_COUNT; i++) {
      const matIndex = i < 5 ? 0 : i < 10 ? 1 : 2;
      const step = new THREE.Mesh(stepGeo, STEP_MATERIALS[matIndex]);
      step.position.set(0, -STEP_RISE * (i + 0.5), STEP_RUN * (i + 0.5));
      group.add(step);
    }

    const curbBack = new THREE.Mesh(curbBackGeo, CONCRETE);
    curbBack.position.set(0, CURB_H / 2, PIT_L + CURB_W / 2);
    group.add(curbBack);
    const curbLeft = new THREE.Mesh(curbSideGeo, CONCRETE);
    curbLeft.position.set(-PIT_W / 2 - CURB_W / 2, CURB_H / 2, PIT_L / 2 + CURB_W / 2);
    group.add(curbLeft);
    const curbRight = new THREE.Mesh(curbSideGeo, CONCRETE);
    curbRight.position.set(PIT_W / 2 + CURB_W / 2, CURB_H / 2, PIT_L / 2 + CURB_W / 2);
    group.add(curbRight);

    const backEdge = buildRailEdge(unitCyl, PIT_W + CURB_W * 2, CURB_H);
    backEdge.position.set(0, 0, PIT_L + CURB_W / 2);
    group.add(backEdge);

    const leftEdge = buildRailEdge(unitCyl, PIT_L + CURB_W, CURB_H);
    leftEdge.rotation.y = Math.PI / 2;
    leftEdge.position.set(-PIT_W / 2 - CURB_W / 2, 0, PIT_L / 2 + CURB_W / 2);
    group.add(leftEdge);

    const rightEdge = buildRailEdge(unitCyl, PIT_L + CURB_W, CURB_H);
    rightEdge.rotation.y = Math.PI / 2;
    rightEdge.position.set(PIT_W / 2 + CURB_W / 2, 0, PIT_L / 2 + CURB_W / 2);
    group.add(rightEdge);
  }

  // Cast-iron pole with the classic green globe lamp at a front corner.
  const poleX = -(PIT_W / 2 + 0.25);
  const poleZ = -0.35;
  const pole = cylMesh(unitCyl, HUNTER_GREEN, 0.045, 3.4);
  pole.position.set(poleX, 1.7, poleZ);
  group.add(pole);
  const finial = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.1, 8), HUNTER_GREEN);
  finial.position.set(poleX, 3.45, poleZ);
  group.add(finial);
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), GLOBE_MATERIAL);
  globe.position.set(poleX, 3.72, poleZ);
  group.add(globe);

  // Black route sign mounted across two short posts above the entrance front.
  const signZ = -0.3;
  const signCenterY = 2.3;
  const postH = signCenterY - 0.21;
  const postX = entranceSignWidth(routes.length) / 2 - 0.12;
  const postLeft = cylMesh(unitCyl, DARK_STEEL, 0.025, postH);
  postLeft.position.set(-postX, postH / 2, signZ);
  group.add(postLeft);
  const postRight = cylMesh(unitCyl, DARK_STEEL, 0.025, postH);
  postRight.position.set(postX, postH / 2, signZ);
  group.add(postRight);

  const signTexture = makeEntranceSignTexture(routes);
  const signW = entranceSignWidth(routes.length);
  // two front-facing panels back-to-back: the text reads correctly (not
  // mirrored) from either approach direction. Unlit material: a lit panel
  // under the 2.7x warm sun + ACES tonemapping clips red and turns the
  // orange B/D/F/M bullets visibly red.
  const signMaterial = new THREE.MeshBasicMaterial({
    map: signTexture,
    color: '#ffffff',
  });
  const signPanel = new THREE.Mesh(new THREE.PlaneGeometry(signW, 0.42), signMaterial);
  signPanel.position.set(0, signCenterY, signZ + 0.012);
  group.add(signPanel);
  const signBack = new THREE.Mesh(new THREE.PlaneGeometry(signW, 0.42), signMaterial);
  signBack.position.set(0, signCenterY, signZ - 0.012);
  signBack.rotation.y = Math.PI;
  group.add(signBack);

  return group;
}

/** NYC "cobra head" street light: tapered bronze pole with a curved arm. */
export function buildStreetLamp(): THREE.Group {
  const group = new THREE.Group();
  const poleH = 7.3;
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, poleH, 8), BRONZE);
  pole.position.y = poleH / 2;
  group.add(pole);

  const armStart = new THREE.Vector3(0, poleH, 0);
  const armMid = new THREE.Vector3(0.9, poleH + 0.05, 0);
  const armEnd = new THREE.Vector3(2.4, poleH - 0.25, 0);

  const seg1 = cylMesh(unitCyl, BRONZE, 0.045, 1);
  pointAt(seg1, armStart, armMid);
  group.add(seg1);

  const seg2 = cylMesh(unitCyl, BRONZE, 0.04, 1);
  pointAt(seg2, armMid, armEnd);
  group.add(seg2);

  const luminaire = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.35), LUMINAIRE_MATERIAL);
  luminaire.position.set(armEnd.x + 0.1, armEnd.y - 0.05, 0);
  group.add(luminaire);

  const underside = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.28), WARM_UNDERGLOW);
  underside.rotation.x = Math.PI / 2;
  underside.position.set(armEnd.x + 0.1, armEnd.y - 0.16, 0);
  group.add(underside);

  return group;
}

/** Dark yellow-olive traffic signal pole with a 3-light head (green lit). */
export function buildTrafficSignal(): THREE.Group {
  const group = new THREE.Group();
  const poleH = 4.2;
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  const pole = cylMesh(unitCyl, SIGNAL_POLE_MATERIAL, 0.05, poleH);
  pole.position.y = poleH / 2;
  group.add(pole);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.75, 0.28), SIGNAL_HEAD_MATERIAL);
  head.position.set(0.2, poleH - 0.1, 0);
  group.add(head);

  const lightGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.03, 8);
  const lightYs = [poleH + 0.12, poleH - 0.1, poleH - 0.32];
  const lightMats = [RED_OFF, AMBER_OFF, GREEN_LIT];
  for (let i = 0; i < 3; i++) {
    const light = new THREE.Mesh(lightGeo, lightMats[i]);
    light.rotation.x = Math.PI / 2;
    light.position.set(0.2, lightYs[i], 0.16);
    group.add(light);
  }

  return group;
}
