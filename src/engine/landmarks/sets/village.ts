import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRICK_RED, BRONZE, WHITE_LM,
  WATER_LM, GREEN_PATINA, STEEL_LM, GLASS_LM,
  box, cyl, strut, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Greenwich Village / Chelsea / Hudson Yards set. Every builder returns a group
 * whose origin sits at ground level at the registry position; the manager
 * rotates/positions/merges it. +z is the front face.
 */

// local tones (kept module-scope so the merger sees one instance per material)
const GRASS = new THREE.MeshLambertMaterial({ color: '#6d8f3a' });
const GRAVEL = new THREE.MeshLambertMaterial({ color: '#9a958a' });
const NYL_GLASS = new THREE.MeshStandardMaterial({
  color: '#263a3e', metalness: 0.38, roughness: 0.23,
  emissive: '#152528', emissiveIntensity: 0.28, envMapIntensity: 0.7,
});
const NYL_GOLD = new THREE.MeshStandardMaterial({
  color: '#d7ad2f', metalness: 0.84, roughness: 0.27,
  emissive: '#493000', emissiveIntensity: 0.17,
});
const NYL_GOLD_SHADE = new THREE.MeshStandardMaterial({
  color: '#b8891c', metalness: 0.88, roughness: 0.32,
  emissive: '#503300', emissiveIntensity: 0.22,
});
const FLAT_STONE = new THREE.MeshLambertMaterial({ color: '#d5cbb7' });
const FLAT_TERRA = new THREE.MeshLambertMaterial({ color: '#c6b99f' });
const FLAT_TERRA_LIGHT = new THREE.MeshLambertMaterial({ color: '#ded4c1' });
const FLAT_GLASS = new THREE.MeshStandardMaterial({ color: '#26383a', metalness: 0.28, roughness: 0.2 });
const FLAT_BRONZE = new THREE.MeshStandardMaterial({ color: '#594630', metalness: 0.72, roughness: 0.36 });
const MET_STONE = new THREE.MeshLambertMaterial({ color: '#d8d3c5' });
const MET_GLASS = new THREE.MeshStandardMaterial({ color: '#21343b', metalness: 0.36, roughness: 0.25 });
const MET_ROOF = new THREE.MeshStandardMaterial({ color: '#aaa99f', metalness: 0.32, roughness: 0.48 });
const MET_ROOF_SHADE = new THREE.MeshStandardMaterial({ color: '#85867f', metalness: 0.36, roughness: 0.5 });
const MET_GOLD = new THREE.MeshStandardMaterial({ color: '#c99f32', metalness: 0.84, roughness: 0.3 });
const MET_LANTERN = new THREE.MeshBasicMaterial({ color: '#ffd27a' });

// 30 Hudson Yards palette. Its dark blue curtain wall needs enough reflected
// sky to stay crystalline, but a low emissive floor keeps shaded/mobile faces
// from becoming a black monolith when the environment map is reduced.
const HY_STEEL = new THREE.MeshStandardMaterial({
  color: '#c5d0d4', metalness: 0.5, roughness: 0.23,
  emissive: '#45555d', emissiveIntensity: 0.28,
});
const HY_DARK_STEEL = new THREE.MeshStandardMaterial({
  color: '#38484e', metalness: 0.38, roughness: 0.34,
  emissive: '#1b3038', emissiveIntensity: 0.46,
});
const HY_EDGE_UNDERSIDE = new THREE.MeshStandardMaterial({
  color: '#9ba9ad', metalness: 0.58, roughness: 0.28,
  emissive: '#35464d', emissiveIntensity: 0.3,
  side: THREE.DoubleSide,
});
const HY_EDGE_GLASS = new THREE.MeshStandardMaterial({
  color: '#bedce4', metalness: 0.12, roughness: 0.08,
  emissive: '#527d89', emissiveIntensity: 0.5,
  transparent: true, opacity: 0.62, depthWrite: false,
  side: THREE.DoubleSide,
});
const HY_CROWN_GLASS = new THREE.MeshStandardMaterial({
  color: '#416d79', metalness: 0.08, roughness: 0.3,
  emissive: '#264c58', emissiveIntensity: 0.48, envMapIntensity: 0.45,
  transparent: true, opacity: 0.78, depthWrite: false,
  side: THREE.DoubleSide,
});
const HY_LOBBY = new THREE.MeshStandardMaterial({
  color: '#99b7bd', metalness: 0.14, roughness: 0.12,
  emissive: '#9f7148', emissiveIntensity: 0.58,
  transparent: true, opacity: 0.82,
});
const HY_DOOR = new THREE.MeshStandardMaterial({
  color: '#233c43', metalness: 0.3, roughness: 0.16,
  emissive: '#183740', emissiveIntensity: 0.68,
});
const HY_GLOW = new THREE.MeshBasicMaterial({ color: '#e9f2f4' });
const HY_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

function hyDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

type HyPoint = readonly [number, number];
type HyLevel = { y: number; points: readonly HyPoint[] };

/**
 * One continuously faceted curtain-wall volume. Physical-scale UVs repeat a
 * six-bay/eight-floor atlas across clean facade strips, so the 100-story tower
 * retains mullions, spandrels and interior variation at close range without
 * thousands of window meshes or draw calls.
 */
function hyEnvelope(levels: readonly HyLevel[], mat: THREE.Material, cap = true): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const BAY_ATLAS = 1.52 * 6;
  const FLOOR_ATLAS = 3.65 * 8;
  const point = (p: HyPoint, y: number) => new THREE.Vector3(p[0], y, p[1]);
  const addQuad = (
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    u0: number, u1: number, v0: number, v1: number,
  ) => {
    const n = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z);
    uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);
    indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };

  for (let band = 0; band < levels.length - 1; band++) {
    const lower = levels[band], upper = levels[band + 1];
    if (lower.points.length !== upper.points.length) continue;
    let along = 0;
    for (let side = 0; side < lower.points.length; side++) {
      const next = (side + 1) % lower.points.length;
      const l0 = point(lower.points[side], lower.y);
      const l1 = point(lower.points[next], lower.y);
      const u0 = point(upper.points[side], upper.y);
      const u1 = point(upper.points[next], upper.y);
      const span = Math.max(l0.distanceTo(l1), u0.distanceTo(u1));
      addQuad(
        l0, u0, u1, l1,
        along / BAY_ATLAS, (along + span) / BAY_ATLAS,
        lower.y / FLOOR_ATLAS, upper.y / FLOOR_ATLAS,
      );
      along += span;
    }
  }

  if (cap) {
    const top = levels[levels.length - 1];
    const center = new THREE.Vector3(
      top.points.reduce((sum, p) => sum + p[0], 0) / top.points.length,
      top.y,
      top.points.reduce((sum, p) => sum + p[1], 0) / top.points.length,
    );
    for (let i = 0; i < top.points.length; i++) {
      const next = (i + 1) % top.points.length;
      const n = positions.length / 3;
      for (const p of [center, point(top.points[next], top.y), point(top.points[i], top.y)]) {
        positions.push(p.x, p.y, p.z);
      }
      uvs.push(0.5, 0.5, 1, 1, 0, 1);
      indices.push(n, n + 1, n + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return hyDetail(new THREE.Mesh(geo, mat));
}

/** Flat x/z polygon used for Edge's transparent glass-floor window. */
function hyHorizontalPanel(points: readonly HyPoint[], y: number, mat: THREE.Material): THREE.Mesh {
  const positions = points.flatMap(([x, z]) => [x, y, z]);
  const indices: number[] = [];
  for (let i = 1; i < points.length - 1; i++) indices.push(0, i + 1, i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return hyDetail(new THREE.Mesh(geo, mat));
}

/** One transparent wall leaning the official 6.6° out from Edge's centroid. */
function hyEdgeWall(
  a: HyPoint,
  b: HyPoint,
  center: HyPoint,
  y: number,
  h: number,
): { panel: THREE.Mesh; bottomA: THREE.Vector3; bottomB: THREE.Vector3; topA: THREE.Vector3; topB: THREE.Vector3 } {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.max(0.001, Math.hypot(dx, dz));
  let nx = dz / len, nz = -dx / len;
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
  if (nx * (mx - center[0]) + nz * (mz - center[1]) < 0) {
    nx = -nx; nz = -nz;
  }
  const lean = Math.tan(THREE.MathUtils.degToRad(6.6)) * h;
  const bottomA = new THREE.Vector3(a[0], y, a[1]);
  const bottomB = new THREE.Vector3(b[0], y, b[1]);
  const topA = new THREE.Vector3(a[0] + nx * lean, y + h, a[1] + nz * lean);
  const topB = new THREE.Vector3(b[0] + nx * lean, y + h, b[1] + nz * lean);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    ...bottomA.toArray(), ...topA.toArray(), ...topB.toArray(), ...bottomB.toArray(),
  ], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 1, 0], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return {
    panel: hyDetail(new THREE.Mesh(geo, HY_EDGE_GLASS)),
    bottomA, bottomB, topA, topB,
  };
}

/** Transparent triangular crown plane facing local +/-z. */
function hyCrownPanel(points: readonly (readonly [number, number])[], z: number): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    points.flatMap(([x, y]) => [x, y, z]),
    3,
  ));
  geo.setIndex([0, 1, 2]);
  geo.computeVertexNormals();
  return hyDetail(new THREE.Mesh(geo, HY_CROWN_GLASS));
}

/** Park bench (matches the Central Park style). */
function bench(mat: THREE.Material = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.06, 0.5, mat, 0, 0.45, 0));
  g.add(box(1.8, 0.5, 0.06, mat, 0, 0.7, -0.25));
  g.add(box(0.08, 0.45, 0.5, mat, -0.8, 0.22, 0));
  g.add(box(0.08, 0.45, 0.5, mat, 0.8, 0.22, 0));
  return g;
}

/** A vertical wall/bar of `height` running along the edge from (ax,az) to (bx,bz). */
function edgeBar(ax: number, az: number, bx: number, bz: number, y: number, thick: number, height: number, mat: THREE.Material): THREE.Mesh {
  const dx = bx - ax, dz = bz - az;
  const m = box(Math.hypot(dx, dz), height, thick, mat, (ax + bx) / 2, y, (az + bz) / 2);
  m.rotation.y = Math.atan2(-dz, dx);
  return m;
}

/** Stand a 2D x/z outline up into a solid vertical prism with exact collision. */
function polygonPrism(
  outline: readonly (readonly [number, number])[],
  height: number,
  mat: THREE.Material,
  y = 0,
  scaleX = 1,
  scaleZ = 1,
): THREE.Mesh {
  const shape = new THREE.Shape();
  for (let i = 0; i < outline.length; i++) {
    const [x, z] = outline[i];
    const sx = x * scaleX;
    // ExtrudeGeometry uses shape XY + depth Z. A -90° X rotation maps shape
    // Y to world -Z and extrusion depth to +Y, hence the sign flip here.
    const sy = -z * scaleZ;
    if (i === 0) shape.moveTo(sx, sy); else shape.lineTo(sx, sy);
  }
  shape.closePath();
  const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1,
  }), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

/** Classic NYC rooftop water tower: steel legs, wood-tone tank, conical cap. */
function waterTower(): THREE.Group {
  const t = new THREE.Group();
  const legH = 4;
  for (const [lx, lz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]] as const) {
    t.add(cyl(0.09, 0.09, legH, STEEL_LM, lx, legH / 2, lz, 6));
  }
  t.add(strut(new THREE.Vector3(-1.3, 0.3, -1.3), new THREE.Vector3(1.3, legH - 0.3, -1.3), 0.04, STEEL_LM, 6));
  t.add(strut(new THREE.Vector3(1.3, 0.3, 1.3), new THREE.Vector3(-1.3, legH - 0.3, 1.3), 0.04, STEEL_LM, 6));
  t.add(cyl(1.7, 1.8, 4.2, DARKSTONE, 0, legH + 2.1, 0, 12)); // tank
  for (const hy of [legH + 0.7, legH + 2.1, legH + 3.5]) t.add(cyl(1.82, 1.82, 0.12, STEEL_LM, 0, hy, 0, 12)); // hoops
  t.add(cyl(0.05, 1.85, 1.5, DARKSTONE, 0, legH + 4.95, 0, 12)); // conical cap
  return t;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Washington Square Arch: marble triumphal arch, pier statues, fountain plaza
  'washington-arch': () => {
    const g = new THREE.Group();
    const W = 14, H = 23, D = 5, aW = 9, aH = 14;
    g.add(archWall(W, H, D, aW, aH, MARBLE)); // arch mass with the 9m archway
    g.add(box(W + 0.8, 1.8, D + 0.8, MARBLE, 0, H - 3.0, 0)); // frieze band
    g.add(box(W + 1.6, 1.0, D + 1.6, MARBLE, 0, H - 0.5, 0)); // cornice cap
    for (const sx of [-1, 1]) {
      g.add(box(1.2, H - 4, 0.5, MARBLE, sx * 6.4, (H - 4) / 2, D / 2 + 0.25)); // pilaster
      g.add(box(1.6, 0.6, 0.8, MARBLE, sx * 6.4, H - 4.2, D / 2 + 0.3)); // pilaster capital
      g.add(box(1.4, 3.6, 0.35, DARKSTONE, sx * 5.0, 11.7, D / 2 + 0.1)); // sculpture niche recess
      g.add(box(1.8, 0.6, 1.0, MARBLE, sx * 5.0, 9.5, D / 2 + 0.4)); // statue bracket
      const fig = figure(2.8, MARBLE);
      fig.position.set(sx * 5.0, 9.8, D / 2 + 0.55);
      g.add(fig); // pier figure (Washington at War / at Peace)
    }
    // Washington Square Fountain: the real basin sits ~55 m down the 5th Ave
    // axis (local +z), centred over the park's baked water polygon — NOT right
    // at the arch. A wide granite basin with a raised centre and a jet, so it
    // reads as a fountain instead of a flat disc.
    const fx = -4, fz = 55;
    const water = (r: number, y: number) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(r, 32), WATER_LM);
      m.rotation.x = -Math.PI / 2; m.position.set(fx, y, fz); return m;
    };
    const ring = (prof: [number, number][]) => { const m = lathe(prof, GRANITE, 40); m.position.set(fx, 0, fz); return m; };
    const R = 10.6; // outer basin radius (matches the baked ~11 m water polygon)
    g.add(ring([[R, 0], [R + 0.35, 0.6], [R - 0.2, 0.65], [R - 0.9, 0.45], [R - 0.9, 0]])); // outer curb rim
    g.add(water(R - 0.8, 0.4));      // main pool
    g.add(ring([[4.2, 0.4], [4.4, 0.8], [3.7, 0.85], [3.7, 0.4]])); // inner tier wall
    g.add(water(3.6, 0.6));          // upper basin pool
    g.add(cyl(1.1, 1.5, 1.3, GRANITE, fx, 0.4, fz, 20)); // centre pedestal
    g.add(ring([[1.9, 1.65], [2.2, 1.9], [1.7, 2.0], [1.7, 1.7]])); // top bowl rim
    g.add(water(1.6, 1.9));          // top bowl
    g.add(cyl(0.1, 0.16, 4.4, WHITE_LM, fx, 1.9, fz, 8));  // central jet plume (white = spray)
    g.add(cyl(0.6, 0.03, 1.1, WHITE_LM, fx, 5.7, fz, 12)); // spray crown fanning out
    return g;
  },

  // Stonewall: brick tavern front + Christopher Park with the white Liberation statues
  stonewall: () => {
    const g = new THREE.Group();
    const FW = 13, FH = 8;
    g.add(box(FW, FH, 9, BRICK_RED, 0, FH / 2, 0)); // 2-story tavern block
    g.add(box(FW + 0.6, 0.7, 9.6, LIMESTONE, 0, FH + 0.25, 0)); // cornice
    for (let i = 0; i < 4; i++) {
      const wx = -4.8 + i * 3.2;
      const frame = archWall(2.8, 3.8, 0.4, 1.6, 2.9, BRICK_RED); // ground-floor arched opening
      frame.position.set(wx, 0.15, 4.55);
      g.add(frame);
      g.add(box(1.9, 3.0, 0.15, DARKSTONE, wx, 1.7, 4.42)); // dark glazing
      g.add(box(1.5, 2.0, 0.12, DARKSTONE, wx, 5.6, 4.55)); // upper window
      g.add(box(1.8, 0.25, 0.3, LIMESTONE, wx, 6.75, 4.6)); // lintel
    }
    // Christopher Park opposite (+z)
    const park = new THREE.Group();
    for (let x = -6; x <= 6; x += 1.2) park.add(cyl(0.04, 0.04, 1.1, DARKSTONE, x, 0.55, -6, 6)); // fence run
    park.add(box(12.4, 0.08, 0.08, DARKSTONE, 0, 1.05, -6));
    for (let z = -6; z <= 0.01; z += 1.2) park.add(cyl(0.04, 0.04, 1.1, DARKSTONE, -6, 0.55, z, 6)); // fence corner return
    park.add(box(0.08, 0.08, 6.4, DARKSTONE, -6, 1.05, -3));
    for (const [fx, fz] of [[-1.4, -1.5], [-0.3, -1.2]] as const) { // standing pair
      const s = figure(1.8, WHITE_LM);
      s.position.set(fx, 0, fz);
      park.add(s);
    }
    const seatBench = bench(WHITE_LM);
    seatBench.position.set(2.5, 0, 0);
    park.add(seatBench);
    for (const fx of [2.0, 3.0]) { // seated pair on the bench
      const s = figure(1.3, WHITE_LM);
      s.position.set(fx, 0.55, 0);
      park.add(s);
    }
    for (const [bx, bz] of [[-3, 3], [3, 4]] as const) {
      const b = bench();
      b.position.set(bx, 0, bz);
      park.add(b);
    }
    park.position.set(0, 0, 12);
    g.add(park);
    return g;
  },

  // Flatiron Building: a full replacement for the two overlapping generic OSM
  // extrusions. Its 0.1m-precision outline below comes from the baked building
  // footprint, transformed into the registry's measured local frame: the broad
  // 22nd Street base is local -z and the rounded six-foot prow points north.
  flatiron: () => {
    const g = new THREE.Group();
    const outline = [
      [-12.8, -32.1], [-10.2, -31.7], [10.7, -27.1], [12.9, -24.7],
      [13.1, -23.7], [12.9, -22.8], [7.7, 0.9], [4.9, 24.1],
      [3.9, 25.9], [2.0, 26.7], [-0.2, 26.8], [-2.6, 26.7],
      [-3.9, 25.9], [-4.9, 24.1], [-10.0, -2.7], [-15.1, -29.5],
      [-14.6, -31.0], [-13.4, -32.0],
    ] as const;
    const height = 86.9; // official 285ft architectural height

    // The National Historic Landmark description explicitly divides the skin
    // into a five-floor limestone base, twelve-floor terra-cotta shaft, and a
    // four-floor capital. Separate solids preserve that columnar reading while
    // retaining one exact triangular collision envelope at every level.
    g.add(polygonPrism(outline, 21.0, FLAT_STONE));
    g.add(polygonPrism(outline, 48.7, FLAT_TERRA, 21.0));
    g.add(polygonPrism(outline, height - 69.7 - 2.0, FLAT_TERRA_LIGHT, 69.7));
    for (const [y, h, sx, sz] of [
      [8.4, 0.75, 1.025, 1.012],
      [20.7, 1.15, 1.035, 1.018],
      [69.2, 1.15, 1.035, 1.018],
      [84.6, 1.45, 1.055, 1.026],
    ] as const) {
      g.add(polygonPrism(outline, h, FLAT_STONE, y, sx, sz));
    }

    // Window panes are hand-packed into one mesh: roughly 800 individually
    // placed openings, but a single draw and no four-figure Object3D traversal.
    // The three long façade axes follow the real wedge rather than projecting a
    // rectangular texture across its prow.
    const pos: number[] = [], norm: number[] = [], idx: number[] = [];
    const addQuad = (
      cx: number, cy: number, cz: number,
      tx: number, tz: number, nx: number, nz: number,
      w: number, h: number,
    ) => {
      const base = pos.length / 3;
      const vx = tx * w / 2, vz = tz * w / 2, vy = h / 2;
      pos.push(
        cx - vx, cy - vy, cz - vz,
        cx - vx, cy + vy, cz - vz,
        cx + vx, cy + vy, cz + vz,
        cx + vx, cy - vy, cz + vz,
      );
      for (let i = 0; i < 4; i++) norm.push(nx, 0, nz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    type Face = { a: readonly [number, number]; b: readonly [number, number]; bays: number };
    const faces: Face[] = [
      { a: [12.9, -22.8], b: [3.9, 25.9], bays: 14 },   // Broadway
      { a: [-3.9, 25.9], b: [-15.1, -29.5], bays: 15 }, // Fifth Avenue
      { a: [-14.6, -31.0], b: [12.5, -25.6], bays: 8 }, // East 22nd Street
      { a: [0.95, 26.85], b: [-0.95, 26.85], bays: 1 }, // six-foot rounded prow
    ];
    const frame = (face: Face) => {
      const dx = face.b[0] - face.a[0], dz = face.b[1] - face.a[1];
      const len = Math.hypot(dx, dz);
      const tx = dx / len, tz = dz / len;
      return { tx, tz, nx: tz, nz: -tx, len };
    };
    const paneRow = (face: Face, y: number, h: number, widthScale = 0.58, out = 0.65) => {
      const { tx, tz, nx, nz, len } = frame(face);
      const pitch = len / (face.bays + 1);
      const w = Math.min(h * 0.78, pitch * widthScale);
      for (let i = 0; i < face.bays; i++) {
        const t = (i + 1) / (face.bays + 1);
        addQuad(
          face.a[0] + (face.b[0] - face.a[0]) * t + nx * out,
          y,
          face.a[1] + (face.b[1] - face.a[1]) * t + nz * out,
          tx, tz, nx, nz, w, h,
        );
      }
    };
    for (const face of faces) {
      paneRow(face, 3.25, 4.8, 0.78); // tall storefront/display windows
      for (const y of [8.1, 12.2, 16.2, 20.0]) paneRow(face, y, 2.45);
      for (let floor = 0; floor < 12; floor++) paneRow(face, 23.9 + floor * 3.72, 2.35);
      paneRow(face, 72.3, 2.45);
      paneRow(face, 77.8, 5.6, 0.48); // paired-story arcade proportions
      paneRow(face, 83.2, 1.65, 0.5); // small square top-story openings
    }

    // Three rows of eight-story projecting oriels interrupt each long face,
    // one of the façade's defining details in the NHL description.
    for (const face of faces.slice(0, 2)) {
      const { tx, tz, nx, nz } = frame(face);
      const rot = Math.atan2(-tz, tx);
      for (const t of [0.25, 0.5, 0.75]) {
        const cx = face.a[0] + (face.b[0] - face.a[0]) * t;
        const cz = face.a[1] + (face.b[1] - face.a[1]) * t;
        const bay = box(3.35, 30.5, 0.72, FLAT_TERRA_LIGHT, cx + nx * 0.42, 38.0, cz + nz * 0.42);
        bay.rotation.y = rot;
        g.add(bay);
        for (let floor = 0; floor < 8; floor++) {
          addQuad(cx + nx * 0.83, 25.0 + floor * 3.65, cz + nz * 0.83,
            tx, tz, nx, nz, 2.15, 2.25);
        }
      }
    }

    // Matching double-height arched-entry compositions at the center of the
    // Broadway and Fifth Avenue elevations: recessed dark glazing, engaged
    // columns, and a full stone entablature.
    for (const face of faces.slice(0, 2)) {
      const { tx, tz, nx, nz } = frame(face);
      const cx = (face.a[0] + face.b[0]) / 2;
      const cz = (face.a[1] + face.b[1]) / 2;
      addQuad(cx + nx * 0.88, 5.2, cz + nz * 0.88, tx, tz, nx, nz, 4.5, 8.4);
      const rot = Math.atan2(-tz, tx);
      for (const side of [-1, 1]) {
        const col = box(0.58, 8.6, 0.72, FLAT_STONE,
          cx + tx * side * 2.45 + nx * 0.76, 4.55,
          cz + tz * side * 2.45 + nz * 0.76);
        col.rotation.y = rot;
        g.add(col);
      }
      const ent = box(6.0, 0.85, 0.95, FLAT_STONE, cx + nx * 0.72, 9.15, cz + nz * 0.72);
      ent.rotation.y = rot;
      g.add(ent);
    }

    const windowGeo = new THREE.BufferGeometry();
    windowGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    windowGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    windowGeo.setIndex(idx);
    const windows = new THREE.Mesh(windowGeo, FLAT_GLASS);
    windows.userData.noCollision = true;
    g.add(windows);

    // Roof dentils and the continuous stone balustrade complete the heavy
    // capital without a texture: many tiny pieces merge into the stone draw.
    for (const face of faces) {
      const { tx, tz, nx, nz, len } = frame(face);
      const rot = Math.atan2(-tz, tx);
      const dentils = Math.max(2, Math.floor(len / 2.1));
      for (let i = 0; i <= dentils; i++) {
        const t = i / dentils;
        const cx = face.a[0] + (face.b[0] - face.a[0]) * t;
        const cz = face.a[1] + (face.b[1] - face.a[1]) * t;
        const d = box(0.82, 0.55, 0.72, FLAT_STONE, cx + nx * 0.72, 84.25, cz + nz * 0.72);
        d.rotation.y = rot; g.add(d);
      }
      g.add(edgeBar(face.a[0], face.a[1], face.b[0], face.b[1], 86.62, 0.5, 0.32, FLAT_STONE));
      const posts = Math.max(2, Math.floor(len / 4.2));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const cx = face.a[0] + (face.b[0] - face.a[0]) * t;
        const cz = face.a[1] + (face.b[1] - face.a[1]) * t;
        g.add(box(0.42, 1.45, 0.42, FLAT_STONE, cx, 85.93, cz));
      }
    }

    // Dark metal rails at the lower-storefront datum add close-up relief and
    // echo the historic display-window framing without expensive transparency.
    for (const face of faces) {
      g.add(edgeBar(face.a[0], face.a[1], face.b[0], face.b[1], 5.7, 0.18, 0.18, FLAT_BRONZE));
    }
    return g;
  },

  // New York Life Building: rebuild the generic OSM upper massing with the
  // real 115m setback, limestone tower, four corner turrets and six-story
  // gilded octagonal crown. The tile pipeline clears only the replaced parts.
  'new-york-life': (ctx) => {
    const g = new THREE.Group();
    const setbackY = ctx.fit?.keptH ?? 115;
    const roofY = ctx.fit?.roofH ?? 188;
    const shaftTop = Math.min(148, roofY - 36);
    const shaftW = 33, shaftD = 35;

    // Limestone upper tower. All 236 recessed panes are authored directly into
    // one quad mesh. This preserves the close-up Gothic bay rhythm without
    // allocating/traversing hundreds of temporary BoxGeometry objects whenever
    // the landmark streams in (and without turning the façade into collision).
    g.add(box(shaftW, shaftTop - setbackY, shaftD, LIMESTONE, 0, (setbackY + shaftTop) / 2, 0));
    g.add(box(shaftW + 2.2, 1.2, shaftD + 2.2, LIMESTONE, 0, setbackY + 0.6, 0));
    g.add(box(shaftW + 1.6, 1.5, shaftD + 1.6, LIMESTONE, 0, shaftTop - 0.75, 0));

    const panePos: number[] = [], paneNorm: number[] = [], paneIdx: number[] = [];
    const addPane = (
      cx: number, cy: number, cz: number,
      tx: number, tz: number, nx: number, nz: number,
      w: number, h: number,
    ) => {
      const base = panePos.length / 3;
      const vx = tx * w / 2, vz = tz * w / 2, vy = h / 2;
      panePos.push(
        cx - vx, cy - vy, cz - vz,
        cx - vx, cy + vy, cz - vz,
        cx + vx, cy + vy, cz + vz,
        cx + vx, cy - vy, cz + vz,
      );
      for (let i = 0; i < 4; i++) paneNorm.push(nx, 0, nz);
      paneIdx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const floorCount = 8;
    for (let floor = 0; floor < floorCount; floor++) {
      const y = setbackY + 3.0 + floor * ((shaftTop - setbackY - 5.2) / (floorCount - 1));
      for (let bay = -3; bay <= 3; bay++) {
        const u = bay * 4.05;
        addPane(u, y, shaftD / 2 + 0.015, 1, 0, 0, 1, 2.65, 2.25);
        addPane(-u, y, -shaftD / 2 - 0.015, -1, 0, 0, -1, 2.65, 2.25);
        addPane(shaftW / 2 + 0.015, y, -u, 0, -1, 1, 0, 2.65, 2.25);
        addPane(-shaftW / 2 - 0.015, y, u, 0, 1, -1, 0, 2.65, 2.25);
      }
    }
    // Strong vertical piers and a final row of tall arched-window proportions.
    for (const x of [-15.2, 15.2]) for (const z of [-15.8, 15.8]) {
      const pier = box(1.2, shaftTop - setbackY + 1.0, 1.2, LIMESTONE, x, (setbackY + shaftTop) / 2, z);
      pier.userData.noCollision = true;
      g.add(pier);
    }
    for (const u of [-8, 0, 8]) {
      addPane(u, shaftTop - 3.4, shaftD / 2 + 0.02, 1, 0, 0, 1, 4.3, 4.7);
      addPane(-u, shaftTop - 3.4, -shaftD / 2 - 0.02, -1, 0, 0, -1, 4.3, 4.7);
      addPane(shaftW / 2 + 0.02, shaftTop - 3.4, -u, 0, -1, 1, 0, 4.3, 4.7);
      addPane(-shaftW / 2 - 0.02, shaftTop - 3.4, u, 0, 1, -1, 0, 4.3, 4.7);
    }
    const paneGeo = new THREE.BufferGeometry();
    paneGeo.setAttribute('position', new THREE.Float32BufferAttribute(panePos, 3));
    paneGeo.setAttribute('normal', new THREE.Float32BufferAttribute(paneNorm, 3));
    paneGeo.setIndex(paneIdx);
    const panes = new THREE.Mesh(paneGeo, NYL_GLASS);
    panes.userData.noCollision = true;
    g.add(panes);

    // Four real corner turrets occupy measured OSM centers on the shaft roof.
    for (const x of [-12.6, 12.6]) for (const z of [-13.4, 13.4]) {
      g.add(cyl(1.75, 1.9, 3.0, LIMESTONE, x, shaftTop - 1.5, z, 8));
      g.add(cyl(0.08, 1.8, 4.5, NYL_GOLD, x, shaftTop + 2.25, z, 8));
      g.add(cyl(0.08, 0.18, 1.4, NYL_GOLD, x, shaftTop + 5.2, z, 6));
    }
    // Open parapet between the turrets, deliberately segmented at the corners.
    for (const z of [-shaftD / 2, shaftD / 2]) {
      g.add(box(20, 1.1, 0.45, LIMESTONE, 0, shaftTop + 0.55, z));
    }
    for (const x of [-shaftW / 2, shaftW / 2]) {
      g.add(box(0.45, 1.1, 21, LIMESTONE, x, shaftTop + 0.55, 0));
    }

    // The official crown is an octagonal pyramid. Eight separately shaded
    // facets plus low-profile ribs suggest the gold-dipped ceramic tile work
    // without a texture or transparency cost at skyline distance.
    const crownBase = shaftTop;
    const lanternBase = Math.max(crownBase + 28, roofY - 7);
    const half = Math.min(ctx.fit?.topW ?? 24, ctx.fit?.topD ?? 24) / 2;
    const clip = half * 0.42;
    const rim = [
      new THREE.Vector3(-clip, crownBase, -half), new THREE.Vector3(clip, crownBase, -half),
      new THREE.Vector3(half, crownBase, -clip), new THREE.Vector3(half, crownBase, clip),
      new THREE.Vector3(clip, crownBase, half), new THREE.Vector3(-clip, crownBase, half),
      new THREE.Vector3(-half, crownBase, clip), new THREE.Vector3(-half, crownBase, -clip),
    ];
    const apex = new THREE.Vector3(0, lanternBase, 0);
    for (let i = 0; i < rim.length; i++) {
      const a = rim[i], b = rim[(i + 1) % rim.length];
      const geo = new THREE.BufferGeometry().setFromPoints([b, a, apex]);
      geo.setIndex([0, 1, 2]);
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, i % 2 ? NYL_GOLD_SHADE : NYL_GOLD));
      g.add(strut(a, apex, 0.07, NYL_GOLD_SHADE, 5));
    }
    for (const t of [0.27, 0.52, 0.76]) {
      const ring = rim.map((p) => p.clone().lerp(apex, t));
      for (let i = 0; i < ring.length; i++) {
        g.add(strut(ring[i], ring[(i + 1) % ring.length], 0.055, NYL_GOLD_SHADE, 5));
      }
    }
    // The 18-ton lantern and spire finish at the measured 187.5m roof height.
    g.add(cyl(1.2, 1.55, 2.2, NYL_GOLD, 0, lanternBase + 1.1, 0, 8));
    g.add(cyl(0.32, 0.75, 2.0, NYL_GOLD_SHADE, 0, lanternBase + 3.2, 0, 8));
    g.add(cyl(0.03, 0.3, Math.max(1, roofY - lanternBase - 4.2), NYL_GOLD, 0, (lanternBase + roofY + 4.2) / 2, 0, 6));
    return g;
  },

  // Metropolitan Life Insurance Company Tower: the generic source contained
  // the correct stacked silhouette but rendered every part as an unadorned
  // prism. Rebuild the 1909 Venetian-campanile landmark at its measured host
  // center, using the documented 213.4m architectural height.
  'met-life-tower': (ctx) => {
    const g = new THREE.Group();
    // The National Historic Landmark survey gives an 85x75ft (25.9x22.9m)
    // lot. The tile fit independently measures 26x22m; use that real plan
    // instead of the old 33x32m box that made the campanile read squat.
    const W = ctx.fit?.w ?? 25.9, D = ctx.fit?.d ?? 22.9;
    const baseTop = 20.7;  // five-storey, 68ft base
    const shaftTop = 132.3; // +366ft simple shaft through the 28th storey
    const loggiaBase = 138.0, loggiaTop = 160.5, plinthBase = 162.0;
    const roofBase = 178;
    const pyramidTop = 197;
    const totalH = 213.4;

    // Subtle entasis and stepped cornices preserve the tower's base/shaft/
    // capital proportions after its simplified 1960s limestone recladding.
    g.add(box(W, 50, D, MET_STONE, 0, 25, 0));
    g.add(box(W - 0.35, 50, D - 0.35, MET_STONE, 0, 75, 0));
    g.add(box(W - 0.7, shaftTop - 100, D - 0.7, MET_STONE, 0, (100 + shaftTop) / 2, 0));
    for (const [y, grow, h] of [
      [8, 1.0, 0.8], [baseTop, 1.15, 0.95], [50, 0.7, 0.65],
      [100, 0.6, 0.65], [shaftTop, 2.0, 1.8],
    ] as const) {
      g.add(box(W + grow, h, D + grow, MET_STONE, 0, y, 0));
    }

    // Every regular window lives in one hand-packed quad mesh and therefore one
    // final draw. Nine bays echo the survey's three sets of triple windows.
    const pos: number[] = [], norm: number[] = [], idx: number[] = [];
    const clockY = 120.0;
    const clockSize = 8.08; // documented 26.5ft dial, not the old 10.2m disc
    const bayPitch = (Math.min(W, D) - 3.0) / 8;
    const addQuad = (
      cx: number, cy: number, cz: number,
      hx: number, hz: number, nx: number, nz: number,
      w: number, h: number,
    ) => {
      const base = pos.length / 3;
      const vx = hx * w / 2, vz = hz * w / 2, vy = h / 2;
      pos.push(
        cx - vx, cy - vy, cz - vz,
        cx + vx, cy - vy, cz + vz,
        cx + vx, cy + vy, cz + vz,
        cx - vx, cy + vy, cz - vz,
      );
      for (let i = 0; i < 4; i++) norm.push(nx, 0, nz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let y = 9.5; y < shaftTop - 1.5; y += 3.75) {
      const faceW = y < 50 ? W : y < 100 ? W - 0.35 : W - 0.7;
      const faceD = y < 50 ? D : y < 100 ? D - 0.35 : D - 0.7;
      for (let bay = -4; bay <= 4; bay++) {
        const u = bay * bayPitch;
        if (Math.abs(u) < clockSize / 2 + 0.7 && Math.abs(y - clockY) < clockSize / 2 + 0.55) continue;
        addQuad(u, y, faceD / 2 + 0.025, 1, 0, 0, 1, 1.35, 2.15);
        addQuad(u, y, -faceD / 2 - 0.025, -1, 0, 0, -1, 1.35, 2.15);
        addQuad(faceW / 2 + 0.025, y, u, 0, -1, 1, 0, 1.35, 2.15);
        addQuad(-faceW / 2 - 0.025, y, u, 0, 1, -1, 0, 1.35, 2.15);
      }
    }
    // Two restrained window rows articulate the recessed four-storey plinth
    // below the roof. Keep them in the shaft's packed façade draw: the real
    // crown has five small openings per face here, not a blank limestone box.
    const plinthW = W - 2.0, plinthD = D - 2.0;
    const plinthPitch = (Math.min(plinthW, plinthD) - 4.0) / 4;
    for (const y of [166.4, 172.2]) {
      for (let bay = -2; bay <= 2; bay++) {
        const u = bay * plinthPitch;
        addQuad(u, y, plinthD / 2 + 0.025, 1, 0, 0, 1, 1.25, 1.9);
        addQuad(-u, y, -plinthD / 2 - 0.025, -1, 0, 0, -1, 1.25, 1.9);
        addQuad(plinthW / 2 + 0.025, y, -u, 0, -1, 1, 0, 1.25, 1.9);
        addQuad(-plinthW / 2 - 0.025, y, u, 0, 1, -1, 0, 1.25, 1.9);
      }
    }
    const windowGeo = new THREE.BufferGeometry();
    windowGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    windowGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    windowGeo.setIndex(idx);
    g.add(new THREE.Mesh(windowGeo, MET_GLASS));

    // Four working-time clock faces. They bake the visitor's local time when
    // the landmark streams in, so the icon behaves like a clock rather than a
    // decorative random dial; all four faces share the same 256px texture.
    const now = new Date();
    const mins = now.getMinutes() + now.getSeconds() / 60;
    const hours = (now.getHours() % 12) + mins / 60;
    const clockTex = canvasTexture((c, w, h) => {
      const cx = w / 2, cy = h / 2, r = w * 0.43;
      c.clearRect(0, 0, w, h);
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fillStyle = '#e8e1cb'; c.fill();
      c.lineWidth = 11; c.strokeStyle = '#315b70'; c.stroke();
      c.save(); c.translate(cx, cy);
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        const inner = r - (i % 5 === 0 ? 15 : 8);
        c.beginPath();
        c.moveTo(Math.sin(a) * inner, -Math.cos(a) * inner);
        c.lineTo(Math.sin(a) * (r - 3), -Math.cos(a) * (r - 3));
        c.lineWidth = i % 5 === 0 ? 4 : 2;
        c.strokeStyle = '#263238'; c.stroke();
      }
      const numerals = ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
      c.fillStyle = '#263238'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = 'bold 22px Georgia, serif';
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.fillText(numerals[i], Math.sin(a) * (r - 29), -Math.cos(a) * (r - 29));
      }
      const hand = (turn: number, len: number, width: number) => {
        const a = turn * Math.PI * 2;
        c.beginPath(); c.moveTo(0, 0);
        c.lineTo(Math.sin(a) * len, -Math.cos(a) * len);
        c.lineCap = 'round'; c.lineWidth = width; c.strokeStyle = '#171b1d'; c.stroke();
      };
      hand(hours / 12, r * 0.52, 7);
      hand(mins / 60, r * 0.72, 5);
      c.beginPath(); c.arc(0, 0, 7, 0, Math.PI * 2); c.fillStyle = '#9d7333'; c.fill();
      c.restore();
    });
    const clockMat = new THREE.MeshBasicMaterial({ map: clockTex, transparent: true, alphaTest: 0.04 });
    const addFace = (mesh: THREE.Mesh, x: number, z: number, ry: number) => {
      mesh.position.set(x, clockY, z); mesh.rotation.y = ry; g.add(mesh);
    };
    const clockW = W - 0.7, clockD = D - 0.7;
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), 0, clockD / 2 + 0.09, 0);
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), 0, -clockD / 2 - 0.09, Math.PI);
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), clockW / 2 + 0.09, 0, Math.PI / 2);
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), -clockW / 2 - 0.09, 0, -Math.PI / 2);
    for (const [x, z, ry] of [
      [0, clockD / 2 + 0.04, 0], [0, -clockD / 2 - 0.04, Math.PI],
      [clockW / 2 + 0.04, 0, Math.PI / 2], [-clockW / 2 - 0.04, 0, -Math.PI / 2],
    ] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(clockSize / 2, 0.31, 8, 32), MET_STONE);
      ring.position.set(x, clockY, z); ring.rotation.y = ry; g.add(ring);
    }

    // Two balcony storeys, five-storey arcaded loggia and recessed four-storey
    // plinth follow the landmark survey's vertical sequence. The previous
    // shaft ran 19m too high and compressed this defining campanile capital.
    g.add(box(W + 3.2, 2.2, D + 3.2, MET_STONE, 0, shaftTop + 1.1, 0));
    g.add(box(W + 3.6, 0.9, D + 3.6, MET_STONE, 0, loggiaBase - 0.45, 0));
    g.add(box(W + 1.2, loggiaTop - loggiaBase, D + 1.2, MET_STONE, 0, (loggiaBase + loggiaTop) / 2, 0));
    const archPanel = (w: number, h: number) => {
      const s = new THREE.Shape();
      const r = w / 2, spring = h / 2 - r;
      s.moveTo(-r, -h / 2); s.lineTo(r, -h / 2); s.lineTo(r, spring);
      s.absarc(0, spring, r, 0, Math.PI, false); s.lineTo(-r, -h / 2); s.closePath();
      return new THREE.ShapeGeometry(s, 8);
    };
    const capitalPitch = (Math.min(W, D) - 4.4) / 4;
    for (let bay = -2; bay <= 2; bay++) {
      const u = bay * capitalPitch;
      const panels = [
        { x: u, z: D / 2 + 0.72, ry: 0 },
        { x: -u, z: -D / 2 - 0.72, ry: Math.PI },
        { x: W / 2 + 0.72, z: -u, ry: Math.PI / 2 },
        { x: -W / 2 - 0.72, z: u, ry: -Math.PI / 2 },
      ];
      for (const p of panels) {
        const panel = new THREE.Mesh(archPanel(2.8, 12.2), MET_GLASS);
        panel.position.set(p.x, (loggiaBase + loggiaTop) / 2 + 0.2, p.z);
        panel.rotation.y = p.ry;
        g.add(panel);
      }
    }
    for (const z of [-D / 2 - 1.0, D / 2 + 1.0]) {
      g.add(box(W + 2.0, 0.7, 0.55, MET_STONE, 0, loggiaTop + 0.35, z));
      for (let x = -W / 2; x <= W / 2; x += 1.8) {
        g.add(box(0.28, 1.8, 0.28, MET_STONE, x, loggiaTop + 1.25, z));
      }
    }
    for (const x of [-W / 2 - 1.0, W / 2 + 1.0]) {
      g.add(box(0.55, 0.7, D + 2.0, MET_STONE, x, loggiaTop + 0.35, 0));
      for (let z = -D / 2; z <= D / 2; z += 1.8) {
        g.add(box(0.28, 1.8, 0.28, MET_STONE, x, loggiaTop + 1.25, z));
      }
    }
    g.add(box(plinthW, roofBase - plinthBase, plinthD, MET_STONE, 0, (plinthBase + roofBase) / 2, 0));
    g.add(box(W, 1.2, D, MET_STONE, 0, roofBase - 0.6, 0));

    // Four steep roof facets, seam ribs and oculi. Normal-aware triangle winding
    // keeps every face visible with standard one-sided materials.
    const rhw = plinthW / 2, rhd = plinthD / 2;
    const corners = [
      new THREE.Vector3(-rhw, roofBase, -rhd), new THREE.Vector3(rhw, roofBase, -rhd),
      new THREE.Vector3(rhw, roofBase, rhd), new THREE.Vector3(-rhw, roofBase, rhd),
    ];
    const roofApex = new THREE.Vector3(0, pyramidTop, 0);
    for (let i = 0; i < 4; i++) {
      let a = corners[i], b = corners[(i + 1) % 4];
      let normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(roofApex, a)).normalize();
      const outward = a.clone().add(b).multiplyScalar(0.5).setY(0);
      if (normal.dot(outward) < 0) {
        const tmp = a; a = b; b = tmp;
        normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(roofApex, a)).normalize();
      }
      const geo = new THREE.BufferGeometry().setFromPoints([a, b, roofApex]);
      geo.setIndex([0, 1, 2]); geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, i % 2 ? MET_ROOF_SHADE : MET_ROOF));
      g.add(strut(a, roofApex, 0.11, MET_GOLD, 6));
      const edgeMid = a.clone().add(b).multiplyScalar(0.5);
      for (const [t, r] of [[0.28, 0.9], [0.5, 0.72], [0.7, 0.55]] as const) {
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 14), MET_GLASS);
        disc.position.copy(edgeMid).lerp(roofApex, t).addScaledVector(normal, 0.04);
        disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        g.add(disc);
      }
    }

    // Gilded cupola and the illuminated "light that never fails" lantern.
    g.add(cyl(3.3, 3.8, 1.0, MET_GOLD, 0, pyramidTop + 0.5, 0, 8));
    g.add(cyl(2.4, 2.4, 6.2, MET_GLASS, 0, pyramidTop + 4.0, 0, 8));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.add(cyl(0.14, 0.18, 6.4, MET_GOLD, Math.cos(a) * 2.45, pyramidTop + 4.0, Math.sin(a) * 2.45, 6));
    }
    g.add(cyl(3.0, 2.8, 0.8, MET_GOLD, 0, pyramidTop + 7.4, 0, 8));
    g.add(cyl(0.45, 2.7, 2.8, MET_GOLD, 0, pyramidTop + 9.2, 0, 8));
    g.add(cyl(1.05, 1.05, 2.2, MET_LANTERN, 0, pyramidTop + 11.7, 0, 8));
    g.add(cyl(0.05, 1.0, 1.7, MET_GOLD, 0, pyramidTop + 13.65, 0, 8));
    g.add(cyl(0.035, 0.16, Math.max(0.4, totalH - pyramidTop - 14.5), MET_GOLD, 0, (totalH + pyramidTop + 14.5) / 2, 0, 6));
    return g;
  },

  // Union Square: equestrian George Washington on a granite plinth, planters, plaza steps
  'union-square': () => {
    const g = new THREE.Group();
    g.add(box(3.6, 0.5, 3.2, GRANITE, 0, 0.25, 0)); // base course
    g.add(box(3.0, 4.0, 2.6, GRANITE, 0, 2.0, 0)); // tall plinth
    g.add(box(3.4, 0.5, 3.0, GRANITE, 0, 4.0, 0)); // cap
    const eq = new THREE.Group();
    const bodyY = 2.0;
    eq.add(box(1.1, 1.5, 3.0, BRONZE, 0, bodyY, 0)); // horse body (length along z)
    const neck = box(0.85, 1.5, 0.8, BRONZE, 0, bodyY + 0.85, 1.4); neck.rotation.x = 0.55; eq.add(neck);
    const head = box(0.5, 0.55, 1.1, BRONZE, 0, bodyY + 1.6, 1.95); head.rotation.x = -0.25; eq.add(head);
    for (const lz of [-1.1, 1.05]) for (const lx of [-0.42, 0.42]) eq.add(cyl(0.13, 0.16, 2.0, BRONZE, lx, 1.0, lz, 6));
    eq.add(cyl(0.1, 0.2, 1.2, BRONZE, 0, bodyY - 0.1, -1.7, 6)); // tail
    const rider = figure(1.8, BRONZE); rider.position.set(0, bodyY + 0.7, -0.1); eq.add(rider);
    eq.position.set(0, 4.25, 0); // facing +z on the plinth
    g.add(eq);
    for (const px of [-7, 7]) { // low fountain planters
      const planter = lathe([[1.8, 0], [1.9, 0.6], [1.6, 0.65]], GRANITE, 12);
      planter.position.set(px, 0, 4);
      g.add(planter);
      const w = new THREE.Mesh(new THREE.CircleGeometry(1.55, 12), WATER_LM);
      w.rotation.x = -Math.PI / 2; w.position.set(px, 0.5, 4);
      g.add(w);
    }
    for (let i = 0; i < 3; i++) g.add(box(22, 0.4, 1.4, GRANITE, 0, 0.2 + i * 0.4, -9 + i * 1.4)); // south plaza steps
    return g;
  },

  // Madison Square Park: the Farragut monument (bronze figure on an exedra) + fountain
  'madison-sq-park': () => {
    const g = new THREE.Group();
    const R = 5, N = 8;
    for (let i = 0; i <= N; i++) { // curved granite exedra bench, opening toward +z
      const a = -0.95 + (i / N) * 1.9;
      const sA = Math.sin(a), cA = Math.cos(a);
      const seat = box(1.5, 0.5, 0.9, GRANITE, sA * R, 0.5, -cA * R); seat.rotation.y = -a; g.add(seat);
      const back = box(1.5, 1.3, 0.35, GRANITE, sA * (R + 0.5), 1.35, -cA * (R + 0.5)); back.rotation.y = -a; g.add(back);
    }
    g.add(box(1.8, 1.0, 1.2, GRANITE, 0, 0.5, -2)); // admiral pedestal in the hollow
    const adm = figure(2.8, BRONZE); adm.position.set(0, 1.0, -2); g.add(adm);
    const basin = lathe([[3.2, 0], [3.35, 0.5], [3.0, 0.55]], GRANITE, 16); // park fountain
    basin.position.set(0, 0, 9); g.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(2.9, 16), WATER_LM);
    water.rotation.x = -Math.PI / 2; water.position.set(0, 0.42, 9); g.add(water);
    g.add(cyl(0.09, 0.14, 2.6, WATER_LM, 0, 1.3, 9, 6)); // center jet
    return g;
  },

  // High Line: 30m of elevated steel viaduct with a planted deck and the peel-up bench
  'high-line': () => {
    const g = new THREE.Group();
    const deckY = 8, len = 30, hw = 3.5;
    for (const z of [-15, -5, 5, 15]) { // riveted columns in pairs every 10m
      for (const x of [-hw, hw]) {
        g.add(box(0.5, deckY, 0.5, STEEL_LM, x, deckY / 2, z));
        g.add(box(0.9, 0.3, 0.9, STEEL_LM, x, 0.15, z)); // base plate
        g.add(box(0.7, 0.5, 0.7, STEEL_LM, x, deckY - 0.4, z)); // riveted head plate
      }
      g.add(box(2 * hw, 0.5, 0.35, STEEL_LM, 0, deckY - 1.2, z)); // cross beam
    }
    for (const x of [-hw, hw]) g.add(box(0.45, 1.5, len, STEEL_LM, x, deckY - 0.75, 0)); // deep side girders
    g.add(box(2 * hw, 0.35, len, STEEL_LM, 0, deckY - 1.6, 0)); // underdeck plate
    g.add(box(2 * hw + 0.4, 0.3, len, GRAVEL, 0, deckY + 0.15, 0)); // gravel-tone deck slab
    const strips = [[-2.4, 1.4, GRASS], [-0.2, 1.0, GREEN_PATINA], [2.2, 1.2, GRASS]] as const;
    for (const [gx, gw, mat] of strips) { // planted strips of grasses
      for (let z = -13.5; z <= 13.5; z += 1.5) g.add(box(gw, 0.6, 1.0, mat, gx, deckY + 0.6, z));
    }
    g.add(box(1.2, 0.16, 4.0, DARKSTONE, 2.4, deckY + 0.55, -3)); // peel-up bench seat
    const peel = box(1.2, 0.16, 2.4, DARKSTONE, 2.4, deckY + 0.95, -6.4); peel.rotation.x = -0.5; g.add(peel); // ...that peels up
    for (const x of [-hw - 0.1, hw + 0.1]) { // railings
      for (let z = -14; z <= 14; z += 3.5) g.add(cyl(0.04, 0.04, 1.1, STEEL_LM, x, deckY + 0.85, z, 6));
      g.add(box(0.06, 0.06, len, STEEL_LM, x, deckY + 1.35, 0));
    }
    return g;
  },

  // Whitney: Renzo Piano terraced white volumes stepping back with an exterior stair zigzag
  whitney: () => {
    const g = new THREE.Group();
    const floors = [
      { w: 42, h: 13, d: 44, y: 6.5, z: 2 },
      { w: 38, h: 11, d: 36, y: 18.5, z: -3 },
      { w: 33, h: 10, d: 28, y: 29.0, z: -9 },
      { w: 26, h: 9, d: 22, y: 38.5, z: -15 },
    ];
    for (const f of floors) {
      g.add(box(f.w, f.h, f.d, WHITE_LM, 0, f.y, f.z)); // terraced volume (steps back toward -z)
      for (const wy of [f.y - f.h * 0.25, f.y + f.h * 0.2]) g.add(box(f.w * 0.82, f.h * 0.22, 0.3, DARKSTONE, 0, wy, f.z + f.d / 2 + 0.02)); // ribbon windows
      g.add(box(0.3, f.h * 0.22, f.d * 0.7, DARKSTONE, -f.w / 2 - 0.02, f.y, f.z)); // side ribbon
    }
    const stairX = floors[0].w / 2 + 1.2;
    let y0 = 3;
    for (let i = 0; i < 6; i++) { // zigzag escape stair on the +x face
      const fromZ = i % 2 === 0 ? -5.5 : 5.5, toZ = i % 2 === 0 ? 5.5 : -5.5;
      const run = toZ - fromZ, rise = 5.5;
      const flight = box(1.8, 0.22, Math.hypot(run, rise), STEEL_LM, stairX, y0 + rise / 2, (fromZ + toZ) / 2);
      flight.rotation.x = -Math.sign(run) * Math.atan2(rise, Math.abs(run));
      g.add(flight);
      g.add(box(2.2, 0.25, 2.4, STEEL_LM, stairX, y0 + rise, toZ)); // landing
      y0 += rise;
    }
    return g;
  },

  // Chelsea Market: brick factory corner with an arched ground floor and a rooftop water tower
  'chelsea-market': () => {
    const g = new THREE.Group();
    const FH = 20;
    g.add(box(34, 14, 14, BRICK_RED, 0, 13, 0)); // main wing upper floors (y6..20)
    g.add(box(14, FH, 22, BRICK_RED, -10, FH / 2, -11)); // return wing forms the corner
    g.add(box(35, 0.8, 15, DARKSTONE, 0, FH + 0.3, 0)); // main cornice
    g.add(box(15, 0.8, 23, DARKSTONE, -10, FH + 0.3, -11)); // return cornice
    for (let fx = -14; fx <= 14; fx += 4) for (const wy of [9, 13, 17]) g.add(box(2.2, 2.4, 0.2, DARKSTONE, fx, wy, 7.02)); // window grid
    for (let i = 0; i < 3; i++) { // row of 3 ground-floor arches
      const ax = -11 + i * 11;
      const panel = archWall(11, 6, 14, 5, 5.2, BRICK_RED);
      panel.position.set(ax, 0, 0);
      g.add(panel);
      g.add(box(4.6, 5, 0.3, DARKSTONE, ax, 2.6, 5)); // recessed storefront
    }
    const wt = waterTower();
    wt.position.set(9, FH, 3);
    g.add(wt);
    return g;
  },

  // Little Island: Heatherwick's tulip pots rising from the river under a rolling green deck
  'little-island': () => {
    const g = new THREE.Group();
    const baseY = -2;
    const cols = [
      [-9, -6, 8], [-3, -8, 11], [4, -7, 13], [10, -3, 15],
      [-11, 0, 7], [-4, -1, 12], [3, 1, 16], [9, 4, 14],
      [-8, 6, 9], [-1, 7, 13], [6, 8, 11], [11, 8, 8],
    ] as const;
    for (const [cx, cz, H] of cols) { // concrete tulip: thin stem flaring to a faceted cup
      const tulip = lathe([[0.9, 0], [0.5, H * 0.55], [0.55, H * 0.8], [1.7, H * 0.97], [2.0, H]], GRANITE, 6);
      tulip.position.set(cx, baseY, cz);
      g.add(tulip);
    }
    const plates = [
      { x: -5, z: -5, y: 11.5, rx: 0.16, rz: -0.12, w: 16, d: 14 },
      { x: 7, z: -3, y: 13.5, rx: -0.12, rz: 0.14, w: 14, d: 14 },
      { x: 0, z: 6, y: 10.5, rx: 0.20, rz: 0.04, w: 16, d: 13 },
      { x: -8, z: 4, y: 8.5, rx: 0.14, rz: -0.18, w: 12, d: 12 },
      { x: 8, z: 7, y: 10.0, rx: 0.10, rz: 0.16, w: 11, d: 12 },
    ];
    for (const p of plates) { // rolling green deck of large angled plates
      const plate = box(p.w, 0.5, p.d, p.z < 0 ? GREEN_PATINA : GRASS, p.x, baseY + p.y, p.z);
      plate.rotation.x = p.rx; plate.rotation.z = p.rz;
      g.add(plate);
    }
    const ramp = new THREE.Group(); // stair/bridge ramp toward the +z shore
    ramp.add(box(4.5, 0.4, 16, DARKSTONE, 0, 0, 0));
    for (const rx of [-2.1, 2.1]) ramp.add(box(0.12, 1.0, 16, STEEL_LM, rx, 0.7, 0));
    ramp.position.set(0, baseY + 7, 16);
    ramp.rotation.x = 0.32;
    g.add(ramp);
    return g;
  },

  // The Vessel: copper honeycomb basket — 8 levels of diamond lattice flaring 8m to 24m
  vessel: () => {
    const g = new THREE.Group();
    const levels = 8, topY = 45, N = 12;
    const rAt = (t: number) => 8 + 16 * t;
    const rings: THREE.Vector3[][] = [];
    for (let l = 0; l <= levels; l++) {
      const t = l / levels, rr = rAt(t), yy = topY * t, off = (l % 2) * (Math.PI / N);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + off;
        pts.push(new THREE.Vector3(Math.cos(a) * rr, yy, Math.sin(a) * rr));
      }
      rings.push(pts);
    }
    for (let l = 0; l < levels; l++) { // angled struts forming diamond openings (~192 struts)
      const lo = rings[l], hi = rings[l + 1];
      for (let i = 0; i < N; i++) {
        g.add(strut(lo[i], hi[i], 0.16, BRONZE, 6));
        g.add(strut(lo[i], hi[(i - 1 + N) % N], 0.16, BRONZE, 6));
      }
    }
    for (let l = 0; l <= levels; l++) { // interior landing ring at each level
      const t = l / levels;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rAt(t), 0.18, 6, N), BRONZE);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = topY * t;
      g.add(ring);
    }
    return g;
  },

  // 30 Hudson Yards + Edge: full replacement for eleven overlapping generic
  // source prisms. The data pipeline supplies the surveyed 117x58m site and
  // 395m steel-crown height; this lean build recreates KPF's city-facing
  // crystalline shift, 100-story curtain wall, open triangular crown, City
  // Climb and the exact 1,100ft cantilevered Edge deck as one coherent object.
  'edge-deck': (ctx) => {
    const g = new THREE.Group();
    const siteW = ctx.fit?.w ?? 117;
    const siteD = ctx.fit?.d ?? 58;
    const tipY = ctx.fit?.roofH ?? 395;
    const sx = siteW / 117;
    const sz = siteD / 58;
    const P = (x: number, z: number): HyPoint => [x * sx, z * sz];
    const scaled = (points: readonly HyPoint[]) => points.map(([x, z]) => P(x, z));

    // Six facade bays by eight floors: dark blue low-e glass, pale mullions,
    // broad horizontal spandrels and deterministic warm interior variation.
    const curtain = canvasTexture((c, w, h) => {
      const cols = 6, rows = 8;
      const cw = w / cols, ch = h / rows;
      c.fillStyle = '#315867';
      c.fillRect(0, 0, w, h);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * cw, y = row * ch;
          const tone = (row * 13 + col * 7 + row * col * 3) % 9;
          const grad = c.createLinearGradient(x, y, x + cw, y);
          grad.addColorStop(0, tone < 3 ? '#294e5d' : '#365f6e');
          grad.addColorStop(0.48, tone % 4 === 0 ? '#89aeb9' : '#5e8794');
          grad.addColorStop(1, tone === 7 ? '#244653' : '#315b69');
          c.fillStyle = grad;
          c.fillRect(x, y, cw, ch);
          c.fillStyle = 'rgba(213,229,232,.24)';
          c.fillRect(x + cw * 0.58, y + 2, 2, ch - 8);
          if ((row * 5 + col * 11) % 13 < 2) {
            c.fillStyle = 'rgba(239,189,122,.3)';
            c.fillRect(x + 3, y + 3, cw - 6, ch * 0.48);
          }
          c.fillStyle = 'rgba(193,211,216,.92)';
          c.fillRect(x, y, 2, ch);
          c.fillStyle = '#263942';
          c.fillRect(x, y + ch - 6, cw, 6);
          c.fillStyle = 'rgba(158,189,196,.58)';
          c.fillRect(x, y + ch - 6, cw, 1);
        }
      }
    }, 192, 256);
    curtain.wrapS = curtain.wrapT = THREE.RepeatWrapping;
    curtain.anisotropy = 4;
    const towerGlass = new THREE.MeshStandardMaterial({
      map: curtain, color: '#94b7c0', metalness: 0.24, roughness: 0.18,
      emissive: '#315965', emissiveIntensity: 0.52, envMapIntensity: 1.15,
    });
    const towerGlassShade = new THREE.MeshStandardMaterial({
      map: curtain, color: '#739ba8', metalness: 0.26, roughness: 0.21,
      emissive: '#284d59', emissiveIntensity: 0.54, envMapIntensity: 1.08,
    });

    // Measured source plans: the rail-platform podium spreads west while the
    // office shaft rises from the eastern half, then shifts toward the city as
    // it climbs. Six shared vertices keep every fold sharp and flicker-free.
    const podiumPlan = scaled([
      [-58.5, -29], [-15.3, -29], [-15.8, 4.6], [-26.5, 4.7],
      [-36.7, 13], [-52, 12.2], [-53.8, -12.4], [-48.5, -15.4],
    ]);
    const podiumTop = scaled([
      [-53.5, -28], [-14.5, -28], [-15.5, 5.5], [-25.5, 5.5],
      [-35.5, 13], [-49.5, 12], [-51.5, -12], [-47, -15],
    ]);
    g.add(hyEnvelope([
      { y: 0, points: podiumPlan },
      { y: 70, points: podiumPlan },
      { y: 130, points: podiumTop },
    ], towerGlassShade));

    const main0 = scaled([
      [-16, -29], [51.7, -29], [51.7, -16.7],
      [55, -14], [53, 20], [-16, 20],
    ]);
    const main130 = scaled([
      [-16, -29], [51.7, -29], [51.7, -16.7],
      [55, -14], [53, 20], [-16, 20],
    ]);
    const main250 = scaled([
      [-12, -27], [53, -27], [53, -16],
      [57, -13], [55, 23], [-12, 23],
    ]);
    const main310 = scaled([
      [-9, -24], [54, -24], [54, -16],
      [58, -13], [56, 26], [-9, 26],
    ]);
    // Above the 310m office roof, the mapped skillion volumes fold around
    // Edge rather than continuing as one full rectangular prism. This
    // concave reveal is what lets the real deck project 80ft into open air.
    const upper310 = scaled([
      [-9, -24], [54, -24], [54, -16], [58, -13],
      [56, 26], [21, 26], [20, -15], [-9, -16],
    ]);
    const main335 = scaled([
      [-8, -21], [55, -21], [55, -16], [58, -13],
      [57, 27], [21, 27], [20, -15], [-8, -16],
    ]);
    const main370 = scaled([
      [-6, -17], [57, -17], [57, -14], [58, -13],
      [58, 28], [22, 28], [21, -14], [-6, -14],
    ]);
    const shaftLevels: HyLevel[] = [
      { y: 0, points: main0 },
      { y: 130, points: main130 },
      { y: 250, points: main250 },
      { y: 310, points: main310 },
    ];
    const upperLevels: HyLevel[] = [
      { y: 310, points: upper310 },
      { y: 335, points: main335 },
      { y: 370, points: main370 },
    ];
    g.add(hyEnvelope(shaftLevels, towerGlass));
    g.add(hyEnvelope(upperLevels, towerGlass, false));

    // Stainless corner folds and major mechanical datums stay visible at
    // skyline distance while the texture supplies all sub-floor detail.
    for (const levels of [shaftLevels, upperLevels]) {
      for (let level = 0; level < levels.length - 1; level++) {
        const a = levels[level], b = levels[level + 1];
        for (let i = 0; i < a.points.length; i++) {
          g.add(hyDetail(strut(
            new THREE.Vector3(a.points[i][0], a.y, a.points[i][1]),
            new THREE.Vector3(b.points[i][0], b.y, b.points[i][1]),
            0.17, HY_STEEL, 5,
          )));
        }
      }
    }
    for (const level of [...shaftLevels.slice(1), ...upperLevels.slice(1)]) {
      for (let i = 0; i < level.points.length; i++) {
        const next = (i + 1) % level.points.length;
        g.add(hyDetail(strut(
          new THREE.Vector3(level.points[i][0], level.y, level.points[i][1]),
          new THREE.Vector3(level.points[next][0], level.y, level.points[next][1]),
          0.15, HY_STEEL, 5,
        )));
      }
    }
    // 1,296ft sloping crown. KPF's city elevation rises to one west apex and
    // falls to the opposite shoulder; the old model inverted this into a
    // horizontal scaffold. Translucent front/back wedges, floor datum rails,
    // and the bright sloping perimeter preserve the glass-clad triangular
    // silhouette without rebuilding OSM's three opaque 395m roof slabs.
    const crownLeft = -6 * sx, crownRight = 58 * sx;
    const frontZ = 28.2 * sz, backZ = -17.2 * sz;
    const crownTri = [
      [crownLeft, 370] as const,
      [crownLeft, tipY] as const,
      [crownRight, 370] as const,
    ];
    g.add(hyCrownPanel(crownTri, frontZ - 0.2));
    g.add(hyCrownPanel(crownTri, backZ + 0.2));
    const frontA = new THREE.Vector3(crownLeft, 370, frontZ);
    const frontB = new THREE.Vector3(crownLeft, tipY, frontZ);
    const frontC = new THREE.Vector3(crownRight, 370, frontZ);
    const backA = new THREE.Vector3(crownLeft, 370, backZ);
    const backB = new THREE.Vector3(crownLeft, tipY, backZ);
    const backC = new THREE.Vector3(crownRight, 370, backZ);
    for (const [a, b] of [
      [frontA, frontB], [frontB, frontC], [frontC, frontA],
      [backA, backB], [backB, backC], [backC, backA],
      [frontA, backA], [frontB, backB], [frontC, backC],
    ] as [THREE.Vector3, THREE.Vector3][]) {
      g.add(hyDetail(strut(a, b, 0.52, HY_STEEL, 7)));
    }
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      const y = THREE.MathUtils.lerp(370, tipY, t);
      const x = THREE.MathUtils.lerp(crownRight, crownLeft, t);
      const left = new THREE.Vector3(crownLeft, y, frontZ);
      const right = new THREE.Vector3(x, y, frontZ);
      const leftBack = new THREE.Vector3(crownLeft, y, backZ);
      const rightBack = new THREE.Vector3(x, y, backZ);
      g.add(hyDetail(strut(left, right, 0.16, HY_STEEL, 5)));
      g.add(hyDetail(strut(leftBack, rightBack, 0.16, HY_STEEL, 5)));
      g.add(hyDetail(strut(left, rightBack, 0.1, HY_DARK_STEEL, 5)));
      g.add(hyDetail(strut(right, leftBack, 0.1, HY_DARK_STEEL, 5)));
    }
    // The diagonal silver reveal around City Climb remains legible from the
    // High Line without turning the crown into a dense lattice.
    const revealA = new THREE.Vector3(crownLeft + 2 * sx, 391, frontZ + 0.12);
    const revealB = new THREE.Vector3(crownLeft + 11 * sx, 373, frontZ + 0.12);
    const revealC = new THREE.Vector3(crownLeft + 25 * sx, 381, frontZ + 0.12);
    for (const [a, b] of [
      [revealA, revealB], [revealB, revealC], [revealC, revealA],
    ] as [THREE.Vector3, THREE.Vector3][]) {
      g.add(hyDetail(strut(a, b, 0.42, HY_STEEL, 7)));
    }

    // City Climb follows the exposed south crown slope to the highest outdoor
    // platform. Twelve real step landings and paired rails make the ascent read
    // in close helicopter passes without creating hundreds of objects.
    const climbA = frontC.clone().add(new THREE.Vector3(0, 0.6, 0.45));
    const climbB = frontB.clone().add(new THREE.Vector3(0, 0.6, 0.45));
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const p = climbA.clone().lerp(climbB, t);
      g.add(hyDetail(box(2.8, 0.18, 1.2, HY_DARK_STEEL, p.x, p.y, p.z)));
    }
    for (const zOff of [-0.75, 0.75]) {
      g.add(hyDetail(strut(
        climbA.clone().add(new THREE.Vector3(0, 1.1, zOff)),
        climbB.clone().add(new THREE.Vector3(0, 1.1, zOff)),
        0.08, HY_STEEL, 5,
      )));
    }
    g.add(hyDetail(box(9, 0.55, 5, HY_DARK_STEEL, crownLeft + 3.5 * sx, tipY - 0.3, frontZ - 2.5)));
    g.add(hyDetail(box(8, 0.18, 0.18, HY_GLOW, crownLeft + 3.5 * sx, tipY + 0.08, frontZ)));

    // Edge at the official 1,100ft elevation. The mapped 7,500ft² outline
    // fixes the old miniature deck's 16m placement error and gives it a true
    // 80ft city-facing cantilever.
    const deckY = 335;
    const deckPlan = scaled([
      [12.5, 16.1], [8.9, 9.9], [-8.3, -19.5], [48.4, -19.3],
    ]);
    const deckSlab = polygonPrism(deckPlan, 0.8, HY_STEEL, deckY);
    const deckTop = deckY + 0.8;
    deckSlab.userData.noCollision = true;
    g.add(deckSlab);
    const deckCenter: HyPoint = [
      deckPlan.reduce((sum, p) => sum + p[0], 0) / deckPlan.length,
      deckPlan.reduce((sum, p) => sum + p[1], 0) / deckPlan.length,
    ];
    // The real underside is a field of triangular linen-finish stainless
    // plates. Four broad facets plus radial seams give the same shifting
    // reflection at one merged draw call rather than a costly panel array.
    for (let i = 0; i < deckPlan.length; i++) {
      const next = (i + 1) % deckPlan.length;
      g.add(hyHorizontalPanel(
        [deckCenter, deckPlan[i], deckPlan[next]],
        deckY - 0.025,
        i % 2 ? HY_EDGE_UNDERSIDE : HY_STEEL,
      ));
      g.add(hyDetail(strut(
        new THREE.Vector3(deckCenter[0], deckY - 0.08, deckCenter[1]),
        new THREE.Vector3(deckPlan[i][0], deckY - 0.08, deckPlan[i][1]),
        0.09, HY_DARK_STEEL, 5,
      )));
    }
    // Collision extraction intentionally ignores sub-2m decorative meshes.
    // Preserve the thin real slab visually while supplying the same footprint
    // as an invisible 2m landing surface for flight-to-foot transitions.
    g.add(polygonPrism(deckPlan, 2.0, HY_COLLISION, deckTop - 2.0));

    // 225ft² triangular glass floor with a stainless perimeter.
    const floorGlass = scaled([[11.8, 13.2], [2.6, -1.0], [21.3, -1.0]]);
    g.add(hyHorizontalPanel(floorGlass, deckTop + 0.035, HY_EDGE_GLASS));
    for (let i = 0; i < floorGlass.length; i++) {
      const next = (i + 1) % floorGlass.length;
      g.add(hyDetail(edgeBar(
        floorGlass[i][0], floorGlass[i][1],
        floorGlass[next][0], floorGlass[next][1],
        deckTop + 0.10, 0.12, 0.18, HY_STEEL,
      )));
    }

    // The real 79 non-reflective panels become three continuous glass walls
    // plus correctly spaced posts, each leaning 6.6° outward. Invisible low
    // walls preserve safe on-foot interaction without turning the whole crown
    // into a collision box.
    const publicEdges: [HyPoint, HyPoint][] = [
      [deckPlan[0], deckPlan[1]],
      [deckPlan[1], deckPlan[2]],
      [deckPlan[3], deckPlan[0]],
    ];
    for (const [a, b] of publicEdges) {
      const wall = hyEdgeWall(a, b, deckCenter, deckTop, 2.74);
      g.add(wall.panel);
      const len = wall.bottomA.distanceTo(wall.bottomB);
      const posts = Math.max(1, Math.ceil(len / 3.8));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        g.add(hyDetail(strut(
          wall.bottomA.clone().lerp(wall.bottomB, t),
          wall.topA.clone().lerp(wall.topB, t),
          0.055, HY_STEEL, 5,
        )));
      }
      g.add(edgeBar(a[0], a[1], b[0], b[1], deckTop + 1.37, 0.18, 2.74, HY_COLLISION));
    }

    // Skyline steps rise from level 100 to Peak on 101, with glass rails and
    // the exposed triangular underside truss visible from the plaza.
    for (let i = 0; i < 10; i++) {
      g.add(hyDetail(box(
        12, 0.28, 1.35, HY_DARK_STEEL,
        29 * sx, deckTop + i * 0.30, (-14 + i * 1.0) * sz,
      )));
    }
    for (const x of [23 * sx, 35 * sx]) {
      g.add(hyDetail(strut(
        new THREE.Vector3(x, deckTop + 0.7, -14 * sz),
        new THREE.Vector3(x, deckTop + 3.5, -4 * sz),
        0.08, HY_STEEL, 5,
      )));
    }
    const deckTip = new THREE.Vector3(deckPlan[0][0], deckY - 0.8, deckPlan[0][1]);
    for (const anchor of [
      new THREE.Vector3(-4 * sx, deckY - 22, -18 * sz),
      new THREE.Vector3(15 * sx, deckY - 24, -18 * sz),
      new THREE.Vector3(37 * sx, deckY - 21, -18 * sz),
    ]) {
      g.add(hyDetail(strut(deckTip, anchor, 0.34, HY_STEEL, 7)));
    }
    g.add(hyDetail(strut(
      new THREE.Vector3(deckPlan[2][0], deckY - 0.4, deckPlan[2][1]),
      new THREE.Vector3(deckPlan[3][0], deckY - 0.4, deckPlan[3][1]),
      0.32, HY_STEEL, 7,
    )));

    // Triple-height public lobby and Voices: a warm transparent cable-net wall,
    // broad entrances and eleven suspended steel letter-orb silhouettes.
    const lobbyZ = -29.2 * sz;
    g.add(hyDetail(box(47 * sx, 17.5, 0.28, HY_LOBBY, 18 * sx, 8.75, lobbyZ)));
    for (let x = -3; x <= 40; x += 5.4) {
      g.add(hyDetail(box(0.17, 17.8, 0.22, HY_STEEL, x * sx, 8.9, lobbyZ - 0.18)));
    }
    for (const x of [9, 15, 21, 27]) {
      g.add(hyDetail(box(4.7 * sx, 8.2, 0.18, HY_DOOR, x * sx, 4.1, lobbyZ - 0.34)));
    }
    g.add(hyDetail(box(22 * sx, 0.32, 6.2, HY_STEEL, 18 * sx, 8.4, lobbyZ - 3.1)));
    for (let i = 0; i < 11; i++) {
      const radius = 0.28 + (i % 4) * 0.12;
      const orb = hyDetail(new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 1), HY_STEEL));
      orb.position.set((-2 + i * 4) * sx, 10.5 + (i % 3) * 1.6, lobbyZ + 0.5);
      g.add(orb);
      g.add(hyDetail(strut(
        new THREE.Vector3(orb.position.x, orb.position.y + radius, orb.position.z),
        new THREE.Vector3(orb.position.x, 17.2, orb.position.z),
        0.025, HY_STEEL, 4,
      )));
    }

    // Conservative, tiered collision follows the real occupied massing and
    // leaves both the open crown and Edge's underside free. The podium, 310m
    // shaft, 370m upper roof and 335.8m deck are all independently landable.
    g.add(polygonPrism(podiumPlan, 130, HY_COLLISION));
    g.add(polygonPrism(main0, 310, HY_COLLISION));
    g.add(polygonPrism(upper310, 60, HY_COLLISION, 310));
    return g;
  },
};
