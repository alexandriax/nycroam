// Low-poly station furniture builders. Every export returns a THREE.Group
// whose local origin sits at floor level (y=0), centered on the prop's
// footprint (unless noted), with +z as the "front" facing direction.
//
// Materials are shared at module scope. Geometries are always created fresh
// per builder call (shared only *within* a single call, e.g. across a row
// of identical pedestals) and never at module scope: callers dispose an
// entire prop group's geometries in one pass when it goes away (see
// StationWorld.dispose / EntranceManager's disposeGroup), so a geometry
// reused across independent calls could be destroyed while still in use
// elsewhere.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------
const STAINLESS = new THREE.MeshStandardMaterial({ color: '#b8bcc0', roughness: 0.4, metalness: 0.7 });
const BLACK_STEEL = new THREE.MeshLambertMaterial({ color: '#0a0a0a' });
const HUNTER_GREEN = new THREE.MeshLambertMaterial({ color: '#0f4536' });
const MAROON_BROWN = new THREE.MeshLambertMaterial({ color: '#4a2c25' });
const CONCRETE = new THREE.MeshLambertMaterial({ color: '#9aa0a3' });
const WOOD = new THREE.MeshLambertMaterial({ color: '#7a4f2a' });
const BOOTH_FRAME = new THREE.MeshLambertMaterial({ color: '#1e3d34' });
const BOOTH_GLASS = new THREE.MeshLambertMaterial({
  color: '#9fb4bd',
  emissive: '#303826',
  transparent: true,
  opacity: 0.85,
  side: THREE.DoubleSide,
});
const BOOTH_LIGHT = new THREE.MeshLambertMaterial({ color: '#3a2f1a', emissive: '#ffdca8', emissiveIntensity: 0.6 });
const MC_BLUE = new THREE.MeshLambertMaterial({ color: '#1c2f6e' });
const MC_SILVER = new THREE.MeshLambertMaterial({ color: '#d7d9db' });
const MC_SCREEN = new THREE.MeshLambertMaterial({ color: '#062830', emissive: '#7fd0ff', emissiveIntensity: 0.8 });
const MC_YELLOW = new THREE.MeshLambertMaterial({ color: '#f2c419' });

// ---------------------------------------------------------------------------
// Geometry helpers — a unit cylinder scaled per instance keeps a single
// BufferGeometry backing every cylindrical rod/disc created within one
// builder call (pass a fresh CylinderGeometry(1,1,1,N) in per call).
// ---------------------------------------------------------------------------
function cylMesh(geometry: THREE.CylinderGeometry, material: THREE.Material, radius: number, height: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(radius, height, radius);
  return mesh;
}

/** Position, orient and stretch a unit-length mesh (e.g. from cylMesh) between two points. */
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
// Turnstile row
// ---------------------------------------------------------------------------

/** `count` classic stainless turnstiles sharing pedestals, ~0.85m pitch each. */
export function buildTurnstileRow(count: number): THREE.Group {
  const group = new THREE.Group();
  const pitch = 0.85;
  const offsetX = (count * pitch) / 2;
  const pedestalCount = count + 1;

  const bodyGeo = new THREE.BoxGeometry(0.25, 1.0, 0.9);
  const topGeo = new THREE.BoxGeometry(0.27, 0.06, 0.92);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  for (let i = 0; i < pedestalCount; i++) {
    const x = i * pitch - offsetX;
    const body = new THREE.Mesh(bodyGeo, STAINLESS);
    body.position.set(x, 0.5, 0);
    group.add(body);
    const top = new THREE.Mesh(topGeo, BLACK_STEEL);
    top.position.set(x, 1.03, 0);
    group.add(top);
  }

  const hubY = 0.72;
  const armLen = 0.42;
  const tilt = THREE.MathUtils.degToRad(60);
  const armHoriz = Math.sin(tilt) * armLen;
  const armVert = Math.cos(tilt) * armLen;

  for (let i = 0; i < count; i++) {
    const cx = i * pitch + pitch / 2 - offsetX;
    const hub = new THREE.Vector3(cx, hubY, 0);
    const axle = cylMesh(unitCyl, STAINLESS, 0.03, 0.85);
    axle.position.set(cx, hubY, 0);
    group.add(axle);
    for (let a = 0; a < 3; a++) {
      const angle = (a * Math.PI * 2) / 3;
      const end = new THREE.Vector3(cx + Math.cos(angle) * armHoriz, hubY + armVert, Math.sin(angle) * armHoriz);
      const arm = cylMesh(unitCyl, STAINLESS, 0.018, 1);
      pointAt(arm, hub, end);
      group.add(arm);
    }
  }

  return group;
}

// ---------------------------------------------------------------------------
// Token/agent booth
// ---------------------------------------------------------------------------
const BOOTH_W = 2.2;
const BOOTH_H = 2.4;
const BOOTH_D = 1.6;
const BOOTH_BASE_H = 0.15;
const BOOTH_WALL_T = 0.08;
const BOOTH_FRAME_H = BOOTH_H - BOOTH_BASE_H - 0.25;

/** Token/agent booth: hunter-green frame, large glazed windows, stainless base. */
export function buildBooth(): THREE.Group {
  const group = new THREE.Group();

  const baseGeo = new THREE.BoxGeometry(BOOTH_W, BOOTH_BASE_H, BOOTH_D);
  const postGeo = new THREE.BoxGeometry(BOOTH_WALL_T, BOOTH_FRAME_H, BOOTH_WALL_T);
  const fbWinGeo = new THREE.PlaneGeometry(BOOTH_W - BOOTH_WALL_T * 2, BOOTH_FRAME_H - 0.1);
  const sideWinGeo = new THREE.PlaneGeometry(BOOTH_D - BOOTH_WALL_T * 2, BOOTH_FRAME_H - 0.1);
  const roofGeo = new THREE.BoxGeometry(BOOTH_W + 0.3, 0.1, BOOTH_D + 0.3);
  const lightGeo = new THREE.PlaneGeometry(BOOTH_W - 0.4, BOOTH_D - 0.4);

  const base = new THREE.Mesh(baseGeo, STAINLESS);
  base.position.y = BOOTH_BASE_H / 2;
  group.add(base);

  const corners: Array<[number, number]> = [
    [-BOOTH_W / 2 + BOOTH_WALL_T / 2, -BOOTH_D / 2 + BOOTH_WALL_T / 2],
    [BOOTH_W / 2 - BOOTH_WALL_T / 2, -BOOTH_D / 2 + BOOTH_WALL_T / 2],
    [-BOOTH_W / 2 + BOOTH_WALL_T / 2, BOOTH_D / 2 - BOOTH_WALL_T / 2],
    [BOOTH_W / 2 - BOOTH_WALL_T / 2, BOOTH_D / 2 - BOOTH_WALL_T / 2],
  ];
  for (const [cx, cz] of corners) {
    const post = new THREE.Mesh(postGeo, BOOTH_FRAME);
    post.position.set(cx, BOOTH_BASE_H + BOOTH_FRAME_H / 2, cz);
    group.add(post);
  }

  const winInset = 0.05;
  const frontWin = new THREE.Mesh(fbWinGeo, BOOTH_GLASS);
  frontWin.position.set(0, BOOTH_BASE_H + BOOTH_FRAME_H / 2, BOOTH_D / 2 - winInset);
  group.add(frontWin);

  const backWin = new THREE.Mesh(fbWinGeo, BOOTH_GLASS);
  backWin.rotation.y = Math.PI;
  backWin.position.set(0, BOOTH_BASE_H + BOOTH_FRAME_H / 2, -BOOTH_D / 2 + winInset);
  group.add(backWin);

  const leftWin = new THREE.Mesh(sideWinGeo, BOOTH_GLASS);
  leftWin.rotation.y = -Math.PI / 2;
  leftWin.position.set(-BOOTH_W / 2 + winInset, BOOTH_BASE_H + BOOTH_FRAME_H / 2, 0);
  group.add(leftWin);

  const rightWin = new THREE.Mesh(sideWinGeo, BOOTH_GLASS);
  rightWin.rotation.y = Math.PI / 2;
  rightWin.position.set(BOOTH_W / 2 - winInset, BOOTH_BASE_H + BOOTH_FRAME_H / 2, 0);
  group.add(rightWin);

  const roof = new THREE.Mesh(roofGeo, BOOTH_FRAME);
  roof.position.y = BOOTH_BASE_H + BOOTH_FRAME_H + 0.05;
  group.add(roof);

  const lightPanel = new THREE.Mesh(lightGeo, BOOTH_LIGHT);
  lightPanel.rotation.x = Math.PI / 2;
  lightPanel.position.y = BOOTH_BASE_H + BOOTH_FRAME_H - 0.05;
  group.add(lightPanel);

  return group;
}

// ---------------------------------------------------------------------------
// Bench
// ---------------------------------------------------------------------------
const BENCH_LENGTH = 2.4;
const BENCH_DEPTH = 0.45;
const BENCH_SEAT_Y = 0.45;
const BENCH_SLAT_COUNT = 5;
const BENCH_SLAT_GAP = 0.012;
const BENCH_SLAT_WIDTH = (BENCH_DEPTH - BENCH_SLAT_GAP * (BENCH_SLAT_COUNT - 1)) / BENCH_SLAT_COUNT;

/** Classic wood-slat bench, 2.4m long, with armrest dividers at the thirds. */
export function buildBench(): THREE.Group {
  const group = new THREE.Group();

  // legs stop BELOW the slats: a full-height leg pokes black steel through
  // the slat gaps and reads as holes in the wood from above
  const legH = BENCH_SEAT_Y - 0.03;
  const legGeo = new THREE.BoxGeometry(0.05, legH, BENCH_DEPTH - 0.06);
  const armGeo = new THREE.BoxGeometry(0.04, 0.04, BENCH_DEPTH);
  const armPostGeo = new THREE.BoxGeometry(0.04, 0.14, 0.04);
  const slatGeo = new THREE.BoxGeometry(BENCH_LENGTH, 0.03, BENCH_SLAT_WIDTH);
  const backGeo = new THREE.BoxGeometry(BENCH_LENGTH, 0.12, 0.03);

  const dividerXs = [-BENCH_LENGTH / 2, -BENCH_LENGTH / 6, BENCH_LENGTH / 6, BENCH_LENGTH / 2];
  for (const x of dividerXs) {
    const leg = new THREE.Mesh(legGeo, BLACK_STEEL);
    leg.position.set(x, legH / 2, 0);
    group.add(leg);
    // armrest: a slim rail over the seat on a short post, not a block on it
    const arm = new THREE.Mesh(armGeo, BLACK_STEEL);
    arm.position.set(x, BENCH_SEAT_Y + 0.19, 0);
    group.add(arm);
    const post = new THREE.Mesh(armPostGeo, BLACK_STEEL);
    post.position.set(x, BENCH_SEAT_Y + 0.1, BENCH_DEPTH / 2 - 0.06);
    group.add(post);
  }

  for (let i = 0; i < BENCH_SLAT_COUNT; i++) {
    const z = -BENCH_DEPTH / 2 + BENCH_SLAT_WIDTH / 2 + i * (BENCH_SLAT_WIDTH + BENCH_SLAT_GAP);
    const slat = new THREE.Mesh(slatGeo, WOOD);
    slat.position.set(0, BENCH_SEAT_Y, z);
    group.add(slat);
  }

  for (let i = 0; i < 2; i++) {
    const y = BENCH_SEAT_Y + 0.18 + i * 0.16;
    const back = new THREE.Mesh(backGeo, WOOD);
    back.position.set(0, y, -BENCH_DEPTH / 2 + 0.02);
    group.add(back);
  }

  return group;
}

// ---------------------------------------------------------------------------
// Trash can
// ---------------------------------------------------------------------------

/** Black steel mesh trash can with a rim. */
export function buildTrashCan(): THREE.Group {
  const group = new THREE.Group();
  const r = 0.28;
  const h = 0.85;
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1);

  const body = cylMesh(unitCyl, BLACK_STEEL, r, h);
  body.position.y = h / 2;
  group.add(body);

  const rim = cylMesh(unitCyl, BLACK_STEEL, r * 1.08, 0.05);
  rim.position.y = h;
  group.add(rim);

  return group;
}

// ---------------------------------------------------------------------------
// Rotogate (full-height exit turnstile)
// ---------------------------------------------------------------------------

/** Full-height maroon exit rotogate: 3/4 bar cage + 4-vane rotor + top plate. */
export function buildRotogate(): THREE.Group {
  const group = new THREE.Group();
  const radius = 0.55;
  const height = 2.2;
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  const barCount = 10;
  const arc = Math.PI * 1.5; // 3/4 circle
  const startAngle = -arc / 2;
  for (let i = 0; i <= barCount; i++) {
    const angle = startAngle + (arc * i) / barCount;
    const bar = cylMesh(unitCyl, MAROON_BROWN, 0.02, height);
    bar.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
    group.add(bar);
  }

  const topPlate = cylMesh(unitCyl, MAROON_BROWN, radius, 0.04);
  topPlate.position.y = height;
  group.add(topPlate);

  const axle = cylMesh(unitCyl, MAROON_BROWN, 0.04, height * 0.9);
  axle.position.y = height / 2;
  group.add(axle);

  const vaneHeights = [0.5, 1.1, 1.7];
  for (let v = 0; v < 4; v++) {
    const angle = (v * Math.PI) / 2;
    const end = new THREE.Vector3(Math.cos(angle) * radius * 0.9, 0, Math.sin(angle) * radius * 0.9);
    for (const vy of vaneHeights) {
      const start = new THREE.Vector3(0, vy, 0);
      const vane = cylMesh(unitCyl, MAROON_BROWN, 0.018, 1);
      pointAt(vane, start, new THREE.Vector3(end.x, vy, end.z));
      group.add(vane);
    }
  }

  return group;
}

// ---------------------------------------------------------------------------
// Railing
// ---------------------------------------------------------------------------

/** Hunter-green steel railing with posts every 1.2m, along +x, centered. */
export function buildRailing(length: number): THREE.Group {
  const group = new THREE.Group();
  const postSpacing = 1.2;
  const postCount = Math.max(2, Math.round(length / postSpacing) + 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  for (let i = 0; i < postCount; i++) {
    const x = -length / 2 + (i * length) / (postCount - 1);
    const post = cylMesh(unitCyl, HUNTER_GREEN, 0.03, 1.0);
    post.position.set(x, 0.5, 0);
    group.add(post);
  }

  const topRail = cylMesh(unitCyl, HUNTER_GREEN, 0.035, 1);
  pointAt(topRail, new THREE.Vector3(-length / 2, 1.0, 0), new THREE.Vector3(length / 2, 1.0, 0));
  group.add(topRail);

  const midRail = cylMesh(unitCyl, HUNTER_GREEN, 0.025, 1);
  pointAt(midRail, new THREE.Vector3(-length / 2, 0.55, 0), new THREE.Vector3(length / 2, 0.55, 0));
  group.add(midRail);

  return group;
}

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

/**
 * Solid concrete stair, origin at the bottom front edge, ascending toward -z.
 * Green handrails follow the slope on both sides.
 */
export function buildStairs(width: number, totalRise: number, totalRun: number): THREE.Group {
  const group = new THREE.Group();
  const stepCount = Math.max(1, Math.round(totalRise / 0.18));
  const stepRise = totalRise / stepCount;
  const stepRun = totalRun / stepCount;
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

  const stepGeo = new THREE.BoxGeometry(width, stepRise, stepRun);
  for (let i = 0; i < stepCount; i++) {
    const step = new THREE.Mesh(stepGeo, CONCRETE);
    step.position.set(0, stepRise * (i + 0.5), -stepRun * (i + 0.5));
    group.add(step);
  }

  const railHeight = 0.9;
  const sides = [-1, 1];
  for (const side of sides) {
    const x = (side * width) / 2;
    const bottom = new THREE.Vector3(x, railHeight, 0);
    const top = new THREE.Vector3(x, totalRise + railHeight, -totalRun);
    const rail = cylMesh(unitCyl, HUNTER_GREEN, 0.02, 1);
    pointAt(rail, bottom, top);
    group.add(rail);

    const postBottom = cylMesh(unitCyl, HUNTER_GREEN, 0.02, railHeight);
    postBottom.position.set(x, railHeight / 2, 0);
    group.add(postBottom);

    const postTop = cylMesh(unitCyl, HUNTER_GREEN, 0.02, railHeight);
    postTop.position.set(x, totalRise + railHeight / 2, -totalRun);
    group.add(postTop);
  }

  return group;
}

// ---------------------------------------------------------------------------
// Pillar
// ---------------------------------------------------------------------------
const pillarMaterialCache = new Map<string, THREE.MeshLambertMaterial>();

function pillarMaterial(color: string): THREE.MeshLambertMaterial {
  let mat = pillarMaterialCache.get(color);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color });
    pillarMaterialCache.set(color, mat);
  }
  return mat;
}

/** Riveted steel I-beam column: box shaft with wider cap/base plates. */
export function buildPillar(height: number, color: string): THREE.Group {
  const group = new THREE.Group();
  const mat = pillarMaterial(color);
  const shaftSize = 0.28;
  const plateSize = 0.4;
  const plateThickness = 0.06;
  const shaftHeight = Math.max(0.01, height - plateThickness * 2);

  const plateGeo = new THREE.BoxGeometry(plateSize, plateThickness, plateSize);
  const base = new THREE.Mesh(plateGeo, mat);
  base.position.y = plateThickness / 2;
  group.add(base);

  const shaft = new THREE.Mesh(new THREE.BoxGeometry(shaftSize, shaftHeight, shaftSize), mat);
  shaft.position.y = plateThickness + shaftHeight / 2;
  group.add(shaft);

  const cap = new THREE.Mesh(plateGeo, mat);
  cap.position.y = height - plateThickness / 2;
  group.add(cap);

  const rivetGeo = new THREE.BoxGeometry(0.03, 0.03, 0.03);
  const rivetOffsets: Array<[number, number]> = [
    [-shaftSize / 2, -shaftSize / 2],
    [shaftSize / 2, -shaftSize / 2],
    [-shaftSize / 2, shaftSize / 2],
    [shaftSize / 2, shaftSize / 2],
  ];
  const rivetRows = Math.max(2, Math.round(shaftHeight / 1.0));
  for (let r = 0; r < rivetRows; r++) {
    const y = plateThickness + (shaftHeight * (r + 0.5)) / rivetRows;
    for (const [rx, rz] of rivetOffsets) {
      const rivet = new THREE.Mesh(rivetGeo, mat);
      rivet.position.set(rx, y, rz);
      group.add(rivet);
    }
  }

  return group;
}

// ---------------------------------------------------------------------------
// MetroCard vending machine
// ---------------------------------------------------------------------------
const MC_W = 0.8;
const MC_H = 1.9;
const MC_D = 0.45;

/** MetroCard vending machine: dark blue body, silver panel, emissive screen. */
export function buildMetroCardMachine(): THREE.Group {
  const group = new THREE.Group();

  const bodyGeo = new THREE.BoxGeometry(MC_W, MC_H, MC_D);
  const panelGeo = new THREE.BoxGeometry(MC_W * 0.85, MC_H * 0.6, 0.02);
  const screenGeo = new THREE.BoxGeometry(MC_W * 0.45, MC_H * 0.22, 0.015);
  const keypadGeo = new THREE.BoxGeometry(MC_W * 0.5, MC_H * 0.08, 0.02);
  const slotGeo = new THREE.BoxGeometry(MC_W * 0.3, 0.03, 0.02);

  const body = new THREE.Mesh(bodyGeo, MC_BLUE);
  body.position.y = MC_H / 2;
  group.add(body);

  const panel = new THREE.Mesh(panelGeo, MC_SILVER);
  panel.position.set(0, MC_H * 0.55, MC_D / 2 + 0.011);
  group.add(panel);

  const screen = new THREE.Mesh(screenGeo, MC_SCREEN);
  screen.position.set(0, MC_H * 0.72, MC_D / 2 + 0.021);
  group.add(screen);

  const keypad = new THREE.Mesh(keypadGeo, MC_YELLOW);
  keypad.position.set(0, MC_H * 0.4, MC_D / 2 + 0.011);
  group.add(keypad);

  const slot = new THREE.Mesh(slotGeo, BLACK_STEEL);
  slot.position.set(0, MC_H * 0.28, MC_D / 2 + 0.011);
  group.add(slot);

  return group;
}
