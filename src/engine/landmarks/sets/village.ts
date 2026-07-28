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
const NYL_GLASS = new THREE.MeshStandardMaterial({ color: '#263a3e', metalness: 0.38, roughness: 0.23 });
const NYL_GOLD = new THREE.MeshStandardMaterial({
  color: '#d7ad2f', metalness: 0.84, roughness: 0.27,
  emissive: '#392400', emissiveIntensity: 0.12,
});
const NYL_GOLD_SHADE = new THREE.MeshStandardMaterial({
  color: '#a77914', metalness: 0.88, roughness: 0.32,
  emissive: '#281700', emissiveIntensity: 0.1,
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

    // Limestone upper tower. Individual recessed panes retain close-up Gothic
    // rhythm but merge into one glass draw call when the landmark is placed.
    g.add(box(shaftW, shaftTop - setbackY, shaftD, LIMESTONE, 0, (setbackY + shaftTop) / 2, 0));
    g.add(box(shaftW + 2.2, 1.2, shaftD + 2.2, LIMESTONE, 0, setbackY + 0.6, 0));
    g.add(box(shaftW + 1.6, 1.5, shaftD + 1.6, LIMESTONE, 0, shaftTop - 0.75, 0));

    const floorCount = 8;
    for (let floor = 0; floor < floorCount; floor++) {
      const y = setbackY + 3.0 + floor * ((shaftTop - setbackY - 5.2) / (floorCount - 1));
      for (let bay = -3; bay <= 3; bay++) {
        const u = bay * 4.05;
        g.add(box(2.65, 2.25, 0.16, NYL_GLASS, u, y, shaftD / 2 + 0.09));
        g.add(box(2.65, 2.25, 0.16, NYL_GLASS, u, y, -shaftD / 2 - 0.09));
        g.add(box(0.16, 2.25, 2.65, NYL_GLASS, shaftW / 2 + 0.09, y, u));
        g.add(box(0.16, 2.25, 2.65, NYL_GLASS, -shaftW / 2 - 0.09, y, u));
      }
    }
    // Strong vertical piers and a final row of tall arched-window proportions.
    for (const x of [-15.2, 15.2]) for (const z of [-15.8, 15.8]) {
      g.add(box(1.2, shaftTop - setbackY + 1.0, 1.2, LIMESTONE, x, (setbackY + shaftTop) / 2, z));
    }
    for (const u of [-8, 0, 8]) {
      g.add(box(4.3, 4.7, 0.18, NYL_GLASS, u, shaftTop - 3.4, shaftD / 2 + 0.1));
      g.add(box(4.3, 4.7, 0.18, NYL_GLASS, u, shaftTop - 3.4, -shaftD / 2 - 0.1));
      g.add(box(0.18, 4.7, 4.3, NYL_GLASS, shaftW / 2 + 0.1, shaftTop - 3.4, u));
      g.add(box(0.18, 4.7, 4.3, NYL_GLASS, -shaftW / 2 - 0.1, shaftTop - 3.4, u));
    }

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
  'met-life-tower': () => {
    const g = new THREE.Group();
    const W = 33, D = 32;
    const shaftTop = 151;
    const roofBase = 178;
    const pyramidTop = 197;
    const totalH = 213.4;

    // Subtle entasis and stepped cornices preserve the tower's base/shaft/
    // capital proportions after its simplified 1960s limestone recladding.
    g.add(box(W, 50, D, MET_STONE, 0, 25, 0));
    g.add(box(W - 0.5, 50, D - 0.5, MET_STONE, 0, 75, 0));
    g.add(box(W - 1.0, 51, D - 1.0, MET_STONE, 0, 125.5, 0));
    for (const [y, grow, h] of [[8, 1.0, 0.8], [50, 0.8, 0.65], [100, 0.7, 0.65], [150, 2.0, 1.8]] as const) {
      g.add(box(W + grow, h, D + grow, MET_STONE, 0, y, 0));
    }

    // All regular windows live in one hand-packed quad mesh: 1,116 panes but
    // only one primitive and one final draw, avoiding a four-figure object-tree
    // hitch when this skyline landmark streams in.
    const pos: number[] = [], norm: number[] = [], idx: number[] = [];
    const clockY = 133.5, clockSize = 10.2;
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
    for (let row = 0; row < 31; row++) {
      const y = 12 + row * 3.55;
      const faceW = y < 50 ? W : y < 100 ? W - 0.5 : W - 1.0;
      const faceD = y < 50 ? D : y < 100 ? D - 0.5 : D - 1.0;
      for (let bay = -4; bay <= 4; bay++) {
        const u = bay * 2.9;
        addQuad(u, y, faceD / 2 + 0.025, 1, 0, 0, 1, 1.55, 2.05);
        addQuad(u, y, -faceD / 2 - 0.025, -1, 0, 0, -1, 1.55, 2.05);
        addQuad(faceW / 2 + 0.025, y, u, 0, -1, 1, 0, 1.55, 2.05);
        addQuad(-faceW / 2 - 0.025, y, u, 0, 1, -1, 0, 1.55, 2.05);
      }
    }
    // Continue the fenestration through the clock tier, omitting only panes
    // physically covered by each 8m dial instead of leaving a blank stone band.
    for (const y of [123, 127, 131, 136, 141, 146]) {
      for (let bay = -4; bay <= 4; bay++) {
        const u = bay * 2.9;
        if (Math.abs(u) < 5.5 && Math.abs(y - clockY) < 5.5) continue;
        addQuad(u, y, (D - 1) / 2 + 0.025, 1, 0, 0, 1, 1.55, 2.05);
        addQuad(u, y, -(D - 1) / 2 - 0.025, -1, 0, 0, -1, 1.55, 2.05);
        addQuad((W - 1) / 2 + 0.025, y, u, 0, -1, 1, 0, 1.55, 2.05);
        addQuad(-(W - 1) / 2 - 0.025, y, u, 0, 1, -1, 0, 1.55, 2.05);
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
      const romans = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
      c.fillStyle = '#263238'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = 'bold 18px Georgia, serif';
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.fillText(romans[i], Math.sin(a) * (r - 29), -Math.cos(a) * (r - 29));
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
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), 0, D / 2 + 0.09, 0);
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), 0, -D / 2 - 0.09, Math.PI);
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), W / 2 + 0.09, 0, Math.PI / 2);
    addFace(new THREE.Mesh(new THREE.PlaneGeometry(clockSize, clockSize), clockMat), -W / 2 - 0.09, 0, -Math.PI / 2);
    for (const [x, z, ry] of [[0, D / 2 + 0.04, 0], [0, -D / 2 - 0.04, Math.PI], [W / 2 + 0.04, 0, Math.PI / 2], [-W / 2 - 0.04, 0, -Math.PI / 2]] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(5.05, 0.38, 8, 32), MET_STONE);
      ring.position.set(x, clockY, z); ring.rotation.y = ry; g.add(ring);
    }

    // Five-bay arcaded capital and open balustrade, retained through the tower's
    // modern recladding and essential to its St Mark's Campanile silhouette.
    g.add(box(W + 3.2, 2.2, D + 3.2, MET_STONE, 0, shaftTop + 1.1, 0));
    g.add(box(W + 1.2, roofBase - shaftTop - 2.2, D + 1.2, MET_STONE, 0, (shaftTop + roofBase + 2.2) / 2, 0));
    const archPanel = (w: number, h: number) => {
      const s = new THREE.Shape();
      const r = w / 2, spring = h / 2 - r;
      s.moveTo(-r, -h / 2); s.lineTo(r, -h / 2); s.lineTo(r, spring);
      s.absarc(0, spring, r, 0, Math.PI, false); s.lineTo(-r, -h / 2); s.closePath();
      return new THREE.ShapeGeometry(s, 8);
    };
    for (let bay = -2; bay <= 2; bay++) {
      const u = bay * 5.0;
      const panels = [
        { x: u, z: D / 2 + 0.72, ry: 0 },
        { x: -u, z: -D / 2 - 0.72, ry: Math.PI },
        { x: W / 2 + 0.72, z: -u, ry: Math.PI / 2 },
        { x: -W / 2 - 0.72, z: u, ry: -Math.PI / 2 },
      ];
      for (const p of panels) {
        const panel = new THREE.Mesh(archPanel(3.2, 10.8), MET_GLASS);
        panel.position.set(p.x, 161.6, p.z); panel.rotation.y = p.ry; g.add(panel);
      }
    }
    for (const z of [-D / 2 - 1.0, D / 2 + 1.0]) {
      g.add(box(W + 2.0, 0.7, 0.55, MET_STONE, 0, 169.2, z));
      for (let x = -14; x <= 14; x += 2) g.add(box(0.28, 2.0, 0.28, MET_STONE, x, 170.2, z));
    }
    for (const x of [-W / 2 - 1.0, W / 2 + 1.0]) {
      g.add(box(0.55, 0.7, D + 2.0, MET_STONE, x, 169.2, 0));
      for (let z = -13.5; z <= 13.5; z += 2) g.add(box(0.28, 2.0, 0.28, MET_STONE, x, 170.2, z));
    }
    g.add(box(29, 7.2, 28, MET_STONE, 0, 174.4, 0));
    g.add(box(31, 1.2, 30, MET_STONE, 0, roofBase - 0.6, 0));

    // Four steep roof facets, seam ribs and oculi. Normal-aware triangle winding
    // keeps every face visible with standard one-sided materials.
    const rhw = 15, rhd = 14.5;
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
    g.add(cyl(3.7, 4.2, 1.0, MET_GOLD, 0, pyramidTop + 0.5, 0, 8));
    g.add(cyl(2.7, 2.7, 6.2, MET_GLASS, 0, pyramidTop + 4.0, 0, 8));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.add(cyl(0.16, 0.19, 6.4, MET_GOLD, Math.cos(a) * 2.75, pyramidTop + 4.0, Math.sin(a) * 2.75, 6));
    }
    g.add(cyl(3.4, 3.1, 0.8, MET_GOLD, 0, pyramidTop + 7.4, 0, 8));
    g.add(cyl(0.45, 3.0, 2.8, MET_GOLD, 0, pyramidTop + 9.2, 0, 8));
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

  // Edge deck: the triangular cantilevered observation platform jutting at y=335
  'edge-deck': () => {
    const g = new THREE.Group();
    const y = 335;
    const shape = new THREE.Shape(); // triangle, point at +z
    shape.moveTo(-14, 0); shape.lineTo(14, 0); shape.lineTo(0, 24); shape.closePath();
    const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.7, bevelEnabled: false }), STEEL_LM);
    slab.rotation.x = Math.PI / 2; slab.position.y = y; g.add(slab);
    g.add(box(28, 1.3, 0.12, GLASS_LM, 0, y + 0.65, 0)); // back-edge glass parapet
    g.add(edgeBar(-14, 0, 0, 24, y + 0.65, 0.12, 1.3, GLASS_LM)); // left-edge glass
    g.add(edgeBar(14, 0, 0, 24, y + 0.65, 0.12, 1.3, GLASS_LM)); // right-edge glass
    const tip = new THREE.Vector3(0, y - 0.7, 23);
    g.add(strut(tip, new THREE.Vector3(-7, y - 20, 0), 0.35, STEEL_LM, 6)); // underside brace back to tower face
    g.add(strut(tip, new THREE.Vector3(7, y - 20, 0), 0.35, STEEL_LM, 6));
    g.add(strut(new THREE.Vector3(-11, y - 0.7, 1), new THREE.Vector3(-5, y - 18, 0), 0.3, STEEL_LM, 6));
    g.add(strut(new THREE.Vector3(11, y - 0.7, 1), new THREE.Vector3(5, y - 18, 0), 0.3, STEEL_LM, 6));
    return g;
  },
};
