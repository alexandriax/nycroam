import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, VERDIGRIS, GOLD, WHITE_LM,
  STEEL_LM, GREEN_PATINA,
  box, cyl, strut, colonnade, lathe, archWall, figure, canvasTexture, twoSidedPanel,
} from '../kit';

/**
 * Civic Center / Chinatown / East River bridges set. Each builder returns a
 * group whose origin sits at ground (water) level at the registry position;
 * the manager rotates/positions/merges it. Several landmarks exist from OSM
 * The Woolworth builder replaces its generic upper tower from the 30th-floor
 * shoulder; Municipal keeps its mapped shaft and adds only the missing crown.
 * The three suspension towers stand in the river, so their bases begin at y=-3.
 */

// ---- local materials specific to this set ----------------------------------
const BLACK_GRANITE = new THREE.MeshStandardMaterial({ color: '#26242b', metalness: 0.25, roughness: 0.35 });
const RED_LACQUER = new THREE.MeshLambertMaterial({ color: '#c0272d' });
const WMB_STEEL = new THREE.MeshStandardMaterial({ color: '#8a6d6d', metalness: 0.6, roughness: 0.5 });
const BULB_G = new THREE.MeshBasicMaterial({ color: '#2f9e57' });
const BULB_W = new THREE.MeshBasicMaterial({ color: '#f3f1e7' });
const BULB_R = new THREE.MeshBasicMaterial({ color: '#e23b3b' });
const TRICOLOR = [BULB_G, BULB_W, BULB_R];
const WOOL_STONE = new THREE.MeshStandardMaterial({ color: '#ded6bd', roughness: 0.62, metalness: 0.02 });
const WOOL_STONE_HI = new THREE.MeshStandardMaterial({ color: '#f0e8d2', roughness: 0.56, metalness: 0.02 });
const WOOL_GLASS = new THREE.MeshStandardMaterial({ color: '#263b45', roughness: 0.18, metalness: 0.38 });
const WOOL_COPPER = new THREE.MeshStandardMaterial({ color: '#4d846d', roughness: 0.38, metalness: 0.48 });
const WOOL_COPPER_HI = new THREE.MeshStandardMaterial({ color: '#6d9b81', roughness: 0.34, metalness: 0.42 });
const MUNI_STONE = new THREE.MeshStandardMaterial({ color: '#d8d1bf', roughness: 0.68, metalness: 0.01 });
const MUNI_STONE_HI = new THREE.MeshStandardMaterial({ color: '#eee7d7', roughness: 0.60, metalness: 0.01 });
const MUNI_GLASS = new THREE.MeshStandardMaterial({ color: '#31444b', roughness: 0.20, metalness: 0.30 });

// ---- local geometry helpers ------------------------------------------------

/** Sphere mesh shorthand. */
function ball(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 10): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2)), mat);
  m.position.set(x, y, z);
  return m;
}

/** Triangular gable/pediment prism; origin at bottom-center, face toward +z. */
function pediment(w: number, h: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, mat);
}

/** Rectangular hipped roof/frustum with crisp planar facets. */
function hippedRoof(
  bottomW: number, bottomD: number, topW: number, topD: number,
  y0: number, y1: number, mat: THREE.Material,
): THREE.Mesh {
  const p: number[] = [];
  const idx: number[] = [];
  const lower = [
    [-bottomW / 2, y0, -bottomD / 2], [bottomW / 2, y0, -bottomD / 2],
    [bottomW / 2, y0, bottomD / 2], [-bottomW / 2, y0, bottomD / 2],
  ];
  const upper = [
    [-topW / 2, y1, -topD / 2], [topW / 2, y1, -topD / 2],
    [topW / 2, y1, topD / 2], [-topW / 2, y1, topD / 2],
  ];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    const base = p.length / 3;
    for (const v of [lower[side], upper[side], upper[next], lower[next]]) p.push(...v);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // A small top cap prevents a view through the roof beneath the next stage.
  const cap = p.length / 3;
  for (const v of upper) p.push(...v);
  idx.push(cap, cap + 2, cap + 1, cap, cap + 3, cap + 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

/** Columns arranged around a circle (peristyle / tempietto). */
function ringColonnade(count: number, radius: number, r: number, h: number, mat: THREE.Material, y = 0): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    g.add(cyl(r, r * 1.05, h, mat, Math.cos(a) * radius, y + h / 2, Math.sin(a) * radius, 8));
  }
  return g;
}

/** Quarter-parabola cable: high at the tower, low (vertex) at the far end. */
function quarterCable(g: THREE.Group, x: number, zT: number, yT: number, zL: number, yL: number, segs: number, r: number, mat: THREE.Material): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(x, yL + (yT - yL) * (1 - t) * (1 - t), zT + (zL - zT) * t));
  }
  for (let i = 0; i < segs; i++) g.add(strut(pts[i], pts[i + 1], r, mat, 5));
  return pts;
}

/** Sagging catenary chain between two (z,y) endpoints at fixed x. */
function catenary(g: THREE.Group, x: number, z0: number, y0: number, z1: number, y1: number, sag: number, segs: number, r: number, mat: THREE.Material): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(x, y0 + (y1 - y0) * t - sag * 4 * t * (1 - t), z0 + (z1 - z0) * t));
  }
  for (let i = 0; i < segs; i++) g.add(strut(pts[i], pts[i + 1], r, mat, 5));
  return pts;
}

/** Vertical suspender struts from cable points down toward the deck line. */
function suspenders(g: THREE.Group, pts: THREE.Vector3[], deckY: number, r: number, mat: THREE.Material): void {
  for (const p of pts) {
    if (p.y > deckY + 1.2) g.add(strut(p, new THREE.Vector3(p.x, deckY, p.z), r, mat, 4));
  }
}

/** Battered lattice steel tower: 4 tapered legs + ringed cross-bracing; base at y=-3. */
function latticeTower(h: number, hx: number, hz: number, legR: number, braceR: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const base = -3, top = 0.62;
  const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const corner = (fx: number, fz: number, t: number) =>
    new THREE.Vector3(fx * hx * (1 - (1 - top) * t), base + h * t, fz * hz * (1 - (1 - top) * t));
  for (const [fx, fz] of signs) g.add(strut(corner(fx, fz, 0), corner(fx, fz, 1), legR, mat, 6));
  const levels = 5;
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels, t1 = (i + 1) / levels;
    for (let s = 0; s < 4; s++) {
      const a = signs[s], b = signs[(s + 1) % 4];
      g.add(strut(corner(a[0], a[1], t1), corner(b[0], b[1], t1), braceR, mat, 5)); // horizontal ring
      g.add(strut(corner(a[0], a[1], t0), corner(b[0], b[1], t1), braceR, mat, 5)); // X brace
      g.add(strut(corner(b[0], b[1], t0), corner(a[0], a[1], t1), braceR, mat, 5));
    }
  }
  g.add(box(hx * 2 * top + 1.5, 1.4, hz * 2 * top + 1.5, mat, 0, base + h + 0.7, 0)); // cable saddle cap
  return g;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // City Hall: Federal limestone palace, columned porch, clock cupola w/ gilt Justice
  'city-hall': () => {
    const g = new THREE.Group();
    g.add(box(62, 1.2, 26, GRANITE, 0, 0.6, 0)); // plinth
    g.add(box(60, 13, 22, LIMESTONE, 0, 7.7, 0)); // body
    g.add(box(61, 1.3, 23, MARBLE, 0, 14.75, 0)); // cornice
    for (const sx of [-27, 27]) { // end pavilions
      g.add(box(9, 15, 23, LIMESTONE, sx, 8.7, 0));
      g.add(box(9.6, 1.2, 23.6, MARBLE, sx, 16.9, 0));
    }
    for (const wy of [5.5, 10.5]) for (let wx = -25; wx <= 25; wx += 5) g.add(box(1.8, 2.6, 0.3, DARKSTONE, wx, wy, 11.02)); // windows
    g.add(box(20, 16, 5, LIMESTONE, 0, 8.2, 13.5)); // projecting center pavilion
    // columned entry porch (temple front)
    g.add(box(22, 1.2, 6, MARBLE, 0, 0.6, 16));
    const porch = colonnade(6, 3.4, 0.5, 9, LIMESTONE);
    porch.position.set(0, 1.2, 17.5);
    g.add(porch);
    g.add(box(22, 1.7, 2.4, MARBLE, 0, 11.05, 17.5)); // entablature
    const ped = pediment(22, 4.2, 2.4, MARBLE);
    ped.position.set(0, 11.9, 17.5);
    g.add(ped);
    // clock cupola on the roof centerline
    g.add(box(9, 2, 9, MARBLE, 0, 16.4, 0)); // attic base
    g.add(cyl(3.0, 3.3, 5, LIMESTONE, 0, 19.9, 0, 12)); // drum
    g.add(ringColonnade(10, 3.2, 0.2, 4.4, MARBLE, 17.4));
    g.add(cyl(3.5, 3.5, 0.8, MARBLE, 0, 22.2, 0, 12)); // entablature ring
    for (const cz of [3.05, -3.05]) { // clock faces
      const cl = cyl(0.95, 0.95, 0.25, WHITE_LM, 0, 19.9, cz, 14);
      cl.rotation.x = Math.PI / 2;
      g.add(cl);
      g.add(box(0.1, 1.1, 0.12, DARKSTONE, 0, 19.9, cz + Math.sign(cz) * 0.05)); // hand
      g.add(box(0.9, 0.1, 0.12, DARKSTONE, 0, 19.9, cz + Math.sign(cz) * 0.05)); // hand
    }
    const dome = lathe([[3.4, 0], [3.0, 1.2], [2.0, 2.4], [0.8, 3.2], [0, 3.5]], MARBLE, 14);
    dome.position.y = 22.6;
    g.add(dome);
    g.add(cyl(0.7, 0.9, 1.6, MARBLE, 0, 26.4, 0, 10)); // lantern
    const justice = figure(3.0, GOLD);
    justice.position.y = 27.0;
    g.add(justice);
    return g;
  },

  // Woolworth: coherent upper-tower replacement from the 30th-floor shoulder.
  // The surveyed source bands are 120/170/194/237.8m; the custom composition
  // preserves them while restoring Cass Gilbert's pale terra-cotta piers,
  // corner tourelles, copper roof, open observation arcades and 241m tip.
  woolworth: (ctx) => {
    const g = new THREE.Group();
    const W = ctx.fit?.w ?? 29.6, D = ctx.fit?.d ?? 29.6;
    const stageW = 24.4, stageD = 24.3;
    const crownW = 20.3, crownD = 20.1;

    // Square lower tower (floors 31–45), followed by the tighter 46–50 stage.
    // Thin projecting courses and emphatic piers make the vertical Gothic
    // rhythm legible without needing hundreds of separate draw calls.
    g.add(box(W, 50, D, WOOL_STONE, 0, 145, 0));
    g.add(box(stageW, 24, stageD, WOOL_STONE, 0, 182, 0));
    for (const [w, d, y, h] of [
      [W + 1.0, D + 1.0, 120.5, 1.0],
      [W + 1.5, D + 1.5, 169.2, 1.6],
      [stageW + 1.3, stageD + 1.3, 193.2, 1.6],
    ] as const) g.add(box(w, h, d, WOOL_STONE_HI, 0, y, 0));

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
        cx + vx, cy - vy, cz + vz,
        cx + vx, cy + vy, cz + vz,
        cx - vx, cy + vy, cz - vz,
      );
      for (let i = 0; i < 4; i++) norm.push(nx, 0, nz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const addFaceRow = (
      width: number, depth: number, bays: number, y: number, paneH: number,
    ) => {
      const pitchX = (width - 3.2) / bays;
      const pitchZ = (depth - 3.2) / bays;
      for (let bay = 0; bay < bays; bay++) {
        const x = -width / 2 + 1.6 + pitchX * (bay + 0.5);
        const z = -depth / 2 + 1.6 + pitchZ * (bay + 0.5);
        addQuad(x, y, depth / 2 + 0.025, 1, 0, 0, 1, pitchX * 0.54, paneH);
        addQuad(-x, y, -depth / 2 - 0.025, -1, 0, 0, -1, pitchX * 0.54, paneH);
        addQuad(width / 2 + 0.025, y, -z, 0, -1, 1, 0, pitchZ * 0.54, paneH);
        addQuad(-width / 2 - 0.025, y, z, 0, 1, -1, 0, pitchZ * 0.54, paneH);
      }
    };
    for (let y = 123.6; y < 168; y += 3.65) addFaceRow(W, D, 7, y, 2.28);
    for (let y = 173.1; y < 192; y += 3.75) addFaceRow(stageW, stageD, 5, y, 2.35);
    const panes = new THREE.BufferGeometry();
    panes.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    panes.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    panes.setIndex(idx);
    const paneMesh = new THREE.Mesh(panes, WOOL_GLASS);
    paneMesh.userData.noCollision = true;
    g.add(paneMesh);

    // Projecting terra-cotta piers divide the historic seven- and five-window
    // faces. They merge into the same stone draw; collision remains the two
    // clean shaft solids rather than dozens of ornamental slivers.
    const piers = (
      width: number, depth: number, bays: number, y0: number, y1: number,
    ) => {
      for (let i = 1; i < bays; i++) {
        const x = -width / 2 + 1.6 + ((width - 3.2) * i) / bays;
        const z = -depth / 2 + 1.6 + ((depth - 3.2) * i) / bays;
        for (const face of [-1, 1]) {
          const px = box(0.32, y1 - y0, 0.42, WOOL_STONE_HI, x, (y0 + y1) / 2, face * (depth / 2 + 0.16));
          const pz = box(0.42, y1 - y0, 0.32, WOOL_STONE_HI, face * (width / 2 + 0.16), (y0 + y1) / 2, z);
          px.userData.noCollision = true;
          pz.userData.noCollision = true;
          g.add(px, pz);
        }
      }
    };
    piers(W, D, 7, 121, 169);
    piers(stageW, stageD, 5, 170, 193);

    // Three tall pointed-window bays per face form the 50th-floor crown base.
    g.add(box(crownW, 11, crownD, WOOL_STONE, 0, 199.5, 0));
    const crownGlass = new THREE.Group();
    for (const [x, z, ry] of [
      [0, crownD / 2 + 0.03, 0], [0, -crownD / 2 - 0.03, Math.PI],
      [crownW / 2 + 0.03, 0, -Math.PI / 2], [-crownW / 2 - 0.03, 0, Math.PI / 2],
    ] as const) {
      for (const u of [-5.3, 0, 5.3]) {
        const recess = box(2.7, 6.2, 0.12, WOOL_GLASS, u, 199.3, 0);
        const point = pediment(2.7, 1.8, 0.12, WOOL_GLASS);
        point.position.set(u, 202.4, 0);
        const surroundL = box(0.38, 8.2, 0.34, WOOL_STONE_HI, u - 1.55, 199.7, 0);
        const surroundR = box(0.38, 8.2, 0.34, WOOL_STONE_HI, u + 1.55, 199.7, 0);
        crownGlass.add(recess, point, surroundL, surroundR);
      }
      crownGlass.position.set(x, 0, z);
      crownGlass.rotation.y = ry;
      for (const child of crownGlass.children) child.userData.noCollision = true;
      g.add(crownGlass.clone());
      crownGlass.clear();
      crownGlass.position.set(0, 0, 0);
      crownGlass.rotation.set(0, 0, 0);
    }
    g.add(box(crownW + 1.3, 1.1, crownD + 1.3, WOOL_STONE_HI, 0, 205.1, 0));

    // Four oversized tourelles anchor the 50th-floor setback, exactly where
    // the source footprint records its 215m corner pinnacles.
    for (const sx of [-8.6, 8.6]) for (const sz of [-8.5, 8.5]) {
      g.add(cyl(1.45, 1.65, 13.5, WOOL_STONE_HI, sx, 201.2, sz, 8));
      g.add(cyl(0.34, 1.7, 5.0, WOOL_COPPER_HI, sx, 210.45, sz, 8));
      g.add(cyl(0, 0.30, 1.5, WOOL_STONE_HI, sx, 213.7, sz, 6));
    }

    // The broad patinated roof and its dormers lead to the octagonal former
    // observation deck. Open dark arcades, pale tracery and alternating copper
    // facets keep the crown readable up close as well as in the skyline.
    g.add(hippedRoof(crownW + 0.2, crownD + 0.2, 11.6, 11.4, 205.65, 221.4, WOOL_COPPER));
    // Raised standing seams follow each roof plane's true slope. Twenty slim
    // struts merge into one copper-highlight draw and break up the broad roof
    // at close flying distance without a large texture or material budget.
    const roofBottomX = (crownW + 0.2) / 2, roofBottomZ = (crownD + 0.2) / 2;
    const roofTopX = 11.6 / 2, roofTopZ = 11.4 / 2;
    for (const t of [-0.66, -0.33, 0, 0.33, 0.66]) {
      for (const side of [-1, 1]) {
        const front = strut(
          new THREE.Vector3(t * roofBottomX, 205.8, side * roofBottomZ),
          new THREE.Vector3(t * roofTopX, 221.25, side * roofTopZ),
          0.065, WOOL_COPPER_HI, 5,
        );
        const flank = strut(
          new THREE.Vector3(side * roofBottomX, 205.8, t * roofBottomZ),
          new THREE.Vector3(side * roofTopX, 221.25, t * roofTopZ),
          0.065, WOOL_COPPER_HI, 5,
        );
        front.userData.noCollision = true;
        flank.userData.noCollision = true;
        g.add(front, flank);
      }
    }
    for (const [x, z, ry] of [
      [0, 8.1, 0], [0, -8.1, Math.PI], [8.2, 0, -Math.PI / 2], [-8.2, 0, Math.PI / 2],
    ] as const) {
      for (const u of [-3.0, 3.0]) {
        const px = x + (z ? u : 0), pz = z + (x ? u : 0);
        const opening = box(1.12, 1.75, 0.14, WOOL_GLASS, px, 211.0, pz);
        opening.rotation.y = ry;
        opening.userData.noCollision = true;
        g.add(opening);
        const dormer = pediment(2.2, 2.9, 0.75, WOOL_STONE_HI);
        dormer.position.set(px, 211.65, pz);
        dormer.rotation.y = ry;
        dormer.userData.noCollision = true;
        g.add(dormer);
      }
    }

    g.add(cyl(5.7, 5.7, 5.0, WOOL_GLASS, 0, 223.9, 0, 8));
    g.add(cyl(6.4, 6.4, 0.8, WOOL_STONE_HI, 0, 221.8, 0, 8));
    g.add(cyl(6.5, 6.5, 0.9, WOOL_STONE_HI, 0, 226.4, 0, 8));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const c = cyl(0.34, 0.42, 4.8, WOOL_STONE_HI, Math.sin(a) * 5.8, 224.0, Math.cos(a) * 5.8, 8);
      c.userData.noCollision = true;
      g.add(c);
    }

    const upperRoof = cyl(1.9, 6.15, 6.3, WOOL_COPPER_HI, 0, 229.95, 0, 8);
    upperRoof.rotation.y = Math.PI / 8;
    g.add(upperRoof);
    g.add(cyl(2.55, 2.55, 3.9, WOOL_GLASS, 0, 235.05, 0, 8));
    g.add(cyl(3.05, 3.05, 0.72, WOOL_STONE_HI, 0, 233.3, 0, 8));
    g.add(cyl(3.0, 3.0, 0.72, WOOL_STONE_HI, 0, 237.0, 0, 8));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const c = cyl(0.20, 0.27, 3.5, WOOL_STONE_HI, Math.sin(a) * 2.55, 235.15, Math.cos(a) * 2.55, 7);
      c.userData.noCollision = true;
      g.add(c);
    }
    g.add(cyl(0.18, 2.7, 2.9, WOOL_COPPER, 0, 238.8, 0, 8));
    g.add(cyl(0, 0.18, 2.2, WOOL_STONE_HI, 0, 239.9, 0, 7)); // 241m tip
    return g;
  },

  // Municipal Building: accurately centered wedding-cake tower and Civic Fame.
  // The street arch has a different architectural center about 50m southwest,
  // so it is placed at its surveyed offset instead of dragging the cupola off
  // the mapped tower (the severe old "floating topper" failure).
  'municipal-building': (ctx) => {
    const g = new THREE.Group();

    const W = ctx.fit?.w ?? 29, D = ctx.fit?.d ?? 26;
    const squareW = 21.0, squareD = 19.6;

    // The source survey records a 107m main roof, a broad 123m square stage,
    // four corner pavilion pairs to 144m and a central 149m block. Rebuilding
    // those exact bands removes twelve overlapping generic prisms while
    // preserving the real C-plan office block and both 113m wing pavilions.
    g.add(box(W, 16, D, MUNI_STONE, 0, 115, 0));              // 107..123
    g.add(box(squareW, 26, squareD, MUNI_STONE, 0, 136, 0));  // 123..149
    for (const [w, d, y, h] of [
      [W + 1.0, D + 1.0, 107.5, 1.0],
      [W + 1.6, D + 1.6, 122.3, 1.4],
      [squareW + 1.4, squareD + 1.4, 148.3, 1.4],
    ] as const) g.add(box(w, h, d, MUNI_STONE_HI, 0, y, 0));

    // Hand-pack the two-story lower-stage openings and six upper office rows
    // into one facade mesh. The whole premium crown remains a handful of draws.
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
        cx + vx, cy - vy, cz + vz,
        cx + vx, cy + vy, cz + vz,
        cx - vx, cy + vy, cz - vz,
      );
      for (let i = 0; i < 4; i++) norm.push(nx, 0, nz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const facadeRow = (w: number, d: number, bays: number, y: number, paneH: number) => {
      const pitchX = (w - 3.0) / bays, pitchZ = (d - 3.0) / bays;
      for (let i = 0; i < bays; i++) {
        const x = -w / 2 + 1.5 + pitchX * (i + 0.5);
        const z = -d / 2 + 1.5 + pitchZ * (i + 0.5);
        addQuad(x, y, d / 2 + 0.025, 1, 0, 0, 1, pitchX * 0.52, paneH);
        addQuad(-x, y, -d / 2 - 0.025, -1, 0, 0, -1, pitchX * 0.52, paneH);
        addQuad(w / 2 + 0.025, y, -z, 0, -1, 1, 0, pitchZ * 0.52, paneH);
        addQuad(-w / 2 - 0.025, y, z, 0, 1, -1, 0, pitchZ * 0.52, paneH);
      }
    };
    for (const y of [111.2, 117.8]) facadeRow(W, D, 7, y, 4.6);
    for (let y = 126.1; y < 147; y += 4.0) facadeRow(squareW, squareD, 5, y, 2.55);
    const windowGeo = new THREE.BufferGeometry();
    windowGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    windowGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    windowGeo.setIndex(idx);
    const windows = new THREE.Mesh(windowGeo, MUNI_GLASS);
    windows.userData.noCollision = true;
    g.add(windows);

    // Tall engaged piers carry the eye through the central block. Like the
    // packed glazing, they are ornamental and never inflate player collision.
    for (const face of [-1, 1]) for (const u of [-7.7, -3.85, 0, 3.85, 7.7]) {
      const front = box(0.42, 24.5, 0.48, MUNI_STONE_HI, u, 136, face * (squareD / 2 + 0.18));
      const flank = box(0.48, 24.5, 0.42, MUNI_STONE_HI, face * (squareW / 2 + 0.18), 136, u * squareD / squareW);
      front.userData.noCollision = true;
      flank.userData.noCollision = true;
      g.add(front, flank);
    }

    // Four classical corner pavilions/obelisks retain the mapped 135m and 144m
    // steps rather than collapsing into a single anonymous center shaft.
    for (const sx of [-10.9, 10.9]) for (const sz of [-9.4, 9.4]) {
      g.add(box(5.0, 12.0, 5.0, MUNI_STONE, sx, 129.0, sz));
      const roof = hippedRoof(5.2, 5.2, 2.1, 2.1, 135.0, 142.8, MUNI_STONE_HI);
      roof.position.set(sx, 0, sz);
      g.add(roof);
      const finial = cyl(0, 0.34, 1.2, MUNI_STONE_HI, sx, 143.4, sz, 6);
      finial.userData.noCollision = true;
      g.add(finial);
    }

    // Two stacked circular peristyles and a low dome form the documented
    // wedding-cake cupola. Dark inner drums keep every opening genuinely deep.
    g.add(box(14.2, 2.8, 14.2, MUNI_STONE_HI, 0, 150.4, 0));
    g.add(cyl(5.0, 5.0, 8.2, MUNI_GLASS, 0, 156.0, 0, 16));
    const lowerCols = ringColonnade(12, 5.8, 0.38, 7.8, MUNI_STONE_HI, 152.0);
    lowerCols.traverse((o) => { o.userData.noCollision = true; });
    g.add(lowerCols);
    g.add(cyl(6.5, 6.5, 1.0, MUNI_STONE_HI, 0, 160.4, 0, 16));
    g.add(cyl(4.1, 4.8, 2.4, MUNI_STONE, 0, 162.1, 0, 14));
    g.add(cyl(2.55, 2.55, 4.6, MUNI_GLASS, 0, 165.6, 0, 12));
    const upperCols = ringColonnade(8, 3.15, 0.28, 4.4, MUNI_STONE_HI, 163.3);
    upperCols.traverse((o) => { o.userData.noCollision = true; });
    g.add(upperCols);
    g.add(cyl(3.7, 3.7, 0.85, MUNI_STONE_HI, 0, 168.1, 0, 14));
    const dome = lathe([[3.4, 0], [3.0, 0.6], [2.1, 1.25], [1.0, 1.8], [0, 2.05]], MUNI_STONE_HI, 14);
    dome.position.y = 168.5;
    g.add(dome);

    // Civic Fame: the official DCAS description calls it a 20-foot gilded
    // copper figure. A sphere, shield, laurel and five-point crown make the
    // skyline marker identifiable instead of a featureless gold pin.
    g.add(ball(0.82, GOLD, 0, 170.65, 0, 12));
    const fame = figure(7.1, GOLD);
    fame.position.y = 170.65;
    g.add(fame);
    g.add(strut(new THREE.Vector3(-0.35, 174.45, 0), new THREE.Vector3(-1.65, 175.0, 0), 0.13, GOLD, 7));
    g.add(strut(new THREE.Vector3(0.35, 174.45, 0), new THREE.Vector3(1.65, 174.15, 0), 0.13, GOLD, 7));
    g.add(strut(new THREE.Vector3(-1.65, 175.0, 0), new THREE.Vector3(-1.85, 176.2, 0), 0.07, GOLD, 6));
    const shield = ball(0.52, GOLD, 1.45, 173.75, 0.12, 10);
    shield.scale.set(0.55, 1.0, 0.28);
    g.add(shield);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(cyl(0, 0.09, 0.42, GOLD, Math.cos(a) * 0.28, 176.25, Math.sin(a) * 0.28, 5));
    }

    // Chambers Street passage. The old registry anchor happened to mark this
    // arch, not the tower; transform that surveyed world delta into the fitted
    // tower frame. Terrain delta keeps the large screen seated on its plaza.
    const archX = 47.5, archZ = 15.9;
    const archY = ctx.groundAt(archX, archZ) - ctx.groundAt(0, 0);
    const passage = archWall(24, 23, 6, 13.5, 18.0, MUNI_STONE);
    passage.position.set(archX, archY, archZ);
    g.add(passage);
    for (const side of [-1, 1]) {
      const screen = colonnade(4, 3.25, 0.58, 19, MUNI_STONE_HI);
      screen.position.set(archX + side * 18.0, archY, archZ);
      g.add(screen);
    }
    g.add(box(50, 2.0, 6.6, MUNI_STONE_HI, archX, archY + 23.2, archZ));
    return g;
  },

  // Foley Square: 10-column Corinthian courthouse portico + black-granite "Triumph" sculpture
  'foley-square': () => {
    const g = new THREE.Group();
    g.add(box(44, 22, 22, LIMESTONE, 0, 12, -7)); // body (front face ~z4)
    g.add(box(45, 1.6, 23, MARBLE, 0, 23.6, -7)); // cornice
    for (let i = 0; i < 8; i++) g.add(box(40 - i * 0.6, 0.55, 1.5, GRANITE, 0, 0.3 + i * 0.55, 13.2 - i * 1.4)); // broad steps
    g.add(box(40, 0.6, 8, LIMESTONE, 0, 4.5, 5.5)); // portico floor
    const port = colonnade(10, 3.9, 0.72, 14, LIMESTONE);
    port.position.set(0, 4.8, 6);
    g.add(port);
    g.add(box(40.5, 2.6, 3.2, LIMESTONE, 0, 20.1, 6)); // entablature
    const ped = pediment(40.5, 7.5, 3.2, LIMESTONE); // massive triangular pediment
    ped.position.set(0, 21.4, 6);
    g.add(ped);
    // Triumph of the Human Spirit: abstract black-granite blade in the square
    const sculpt = new THREE.Group();
    sculpt.add(box(5, 1, 5, BLACK_GRANITE, 0, 0.5, 0));
    for (let i = 0; i < 9; i++) {
      const b = box(2.6 - i * 0.18, 2.0, 0.9, BLACK_GRANITE, Math.sin(i * 0.5) * 1.4, 1.6 + i * 1.5, 0);
      b.rotation.z = Math.sin(i * 0.5) * 0.5;
      b.rotation.y = i * 0.2;
      sculpt.add(b);
    }
    sculpt.position.set(0, 0, 34);
    g.add(sculpt);
    return g;
  },

  // African Burial Ground: black-granite Ancestral Libation Chamber + engraved spiral court
  'african-burial-ground': () => {
    const g = new THREE.Group();
    const tex = canvasTexture((c, w, h) => { // Circle of the Diaspora spiral
      c.fillStyle = '#1c1b20';
      c.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      c.strokeStyle = '#6f6a63';
      c.lineWidth = 3;
      c.beginPath();
      for (let a = 0; a < Math.PI * 8; a += 0.15) {
        const r = a * 3.3, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (a === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.strokeStyle = '#4a5a55';
      c.lineWidth = 2;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(a) * w * 0.5, cy + Math.sin(a) * h * 0.5);
        c.stroke();
      }
    });
    const court = new THREE.Mesh(new THREE.CircleGeometry(6, 40), new THREE.MeshLambertMaterial({ map: tex }));
    court.rotation.x = -Math.PI / 2;
    court.position.y = 0.05;
    g.add(court);
    g.add(lathe([[6, 0], [6.3, 0.45], [6.0, 0.5]], BLACK_GRANITE, 28)); // low granite rim
    for (let i = 0; i < 7; i++) { // curved wedge from boxes at slight angles (~7m tall end)
      const a = -0.55 + i * 0.18, hh = 3 + i * 0.72;
      const b = box(1.7, hh, 1.0, BLACK_GRANITE, Math.cos(a) * 4.2, hh / 2, Math.sin(a) * 4.2 - 1.5);
      b.rotation.y = -a;
      g.add(b);
    }
    g.add(box(9, 0.5, 3, BLACK_GRANITE, 0, 0.25, 3)); // base slab
    return g;
  },

  // Chinatown gate: red-lacquer paifang, triple green tiled roofs, gold panel, hung lanterns
  'chinatown-gate': () => {
    const g = new THREE.Group();
    const panelTex = canvasTexture((c, w, h) => { // decorative gold panel, no characters
      c.fillStyle = '#c9a227';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#8d2b22';
      c.lineWidth = 8;
      for (let k = 0; k < 4; k++) c.strokeRect(20 + k * 10, 20 + k * 10, w - 40 - k * 20, h - 40 - k * 20);
      c.fillStyle = '#8d2b22';
      c.beginPath();
      c.arc(w / 2, h / 2, 24, 0, Math.PI * 2);
      c.fill();
    }, 256, 96);
    for (const sx of [-7, 7]) { // red columns on stone drums
      g.add(box(1.5, 0.7, 1.5, DARKSTONE, sx, 0.35, 0));
      g.add(cyl(0.5, 0.56, 9, RED_LACQUER, sx, 5.05, 0, 10));
    }
    g.add(box(16, 1.0, 1.0, RED_LACQUER, 0, 8.0, 0)); // beams
    g.add(box(16, 0.8, 0.8, RED_LACQUER, 0, 6.4, 0));
    g.add(box(16, 0.25, 1.05, GOLD, 0, 8.6, 0)); // gold trim bands
    g.add(box(16, 0.2, 0.85, GOLD, 0, 6.95, 0));
    const panel = twoSidedPanel(panelTex, 4, 1.5);
    panel.position.set(0, 8.05, 0);
    g.add(panel);
    const tier = (w: number, d: number, y: number) => { // green tiled roof with upturned eaves
      const t = new THREE.Group();
      t.add(box(w, 0.6, d, GREEN_PATINA, 0, y, 0));
      t.add(box(w + 0.2, 0.16, d + 0.2, GOLD, 0, y - 0.35, 0));
      for (const sx of [-1, 1]) {
        const e = box(2.6, 0.5, d, GREEN_PATINA, sx * (w / 2 + 0.5), y + 0.16, 0);
        e.rotation.z = -sx * 0.5;
        t.add(e);
      }
      return t;
    };
    g.add(tier(16, 3.0, 9.6));
    g.add(tier(12, 2.6, 10.7));
    g.add(tier(8, 2.2, 11.7));
    g.add(cyl(0.3, 0.4, 1.2, GOLD, 0, 12.4, 0, 8)); // ridge finial
    for (const sx of [-5.4, 5.4]) { // hanging red lantern spheres
      g.add(cyl(0.02, 0.02, 1.1, DARKSTONE, sx, 6.9, 0, 4));
      g.add(cyl(0.2, 0.2, 0.14, GOLD, sx, 6.3, 0, 8));
      const lan = ball(0.55, RED_LACQUER, sx, 5.7, 0, 10);
      lan.scale.y = 0.85;
      g.add(lan);
      g.add(cyl(0.14, 0.14, 0.12, GOLD, sx, 5.0, 0, 8));
      g.add(box(0.05, 0.5, 0.05, GOLD, sx, 4.6, 0)); // tassel
    }
    return g;
  },

  // Little Italy: zig-zag tricolor string lights + sidewalk-cafe tables with umbrellas
  'little-italy': () => {
    const g = new THREE.Group();
    const A: THREE.Vector3[] = [], B: THREE.Vector3[] = [];
    for (const x of [-9, -3, 3, 9]) { // two rows of four poles
      g.add(cyl(0.09, 0.11, 5.2, DARKSTONE, x, 2.6, -4.5, 6));
      g.add(cyl(0.09, 0.11, 5.2, DARKSTONE, x, 2.6, 4.5, 6));
      g.add(ball(0.12, GOLD, x, 5.25, -4.5, 8));
      g.add(ball(0.12, GOLD, x, 5.25, 4.5, 8));
      A.push(new THREE.Vector3(x, 5.1, -4.5));
      B.push(new THREE.Vector3(x, 5.1, 4.5));
    }
    const seq: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) { seq.push(A[i]); seq.push(B[i]); }
    let bulb = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      g.add(strut(seq[i], seq[i + 1], 0.02, DARKSTONE, 4)); // string wire
      for (const t of [0.25, 0.5, 0.75]) {
        const p = seq[i].clone().lerp(seq[i + 1], t);
        p.y -= 0.25;
        g.add(ball(0.12, TRICOLOR[bulb++ % 3], p.x, p.y, p.z, 8)); // alternating bulbs
      }
    }
    const table = (umb: THREE.Material) => {
      const t = new THREE.Group();
      t.add(cyl(0.05, 0.05, 0.78, DARKSTONE, 0, 0.39, 0, 6));
      t.add(cyl(0.55, 0.55, 0.06, WHITE_LM, 0, 0.8, 0, 12));
      t.add(cyl(0.04, 0.04, 2.5, DARKSTONE, 0, 1.6, 0, 6));
      t.add(cyl(0, 1.4, 0.7, umb, 0, 2.9, 0, 10)); // umbrella canopy
      for (const a of [0, 2.1, 4.2]) t.add(box(0.4, 0.5, 0.4, DARKSTONE, Math.cos(a) * 0.95, 0.25, Math.sin(a) * 0.95)); // stools
      return t;
    };
    const cafe: [number, number, THREE.Material][] = [[-6, 9, RED_LACQUER], [0, 10.5, GREEN_PATINA], [6, 9, RED_LACQUER]];
    for (const [tx, tz, um] of cafe) {
      const t = table(um);
      t.position.set(tx, 0, tz);
      g.add(t);
    }
    return g;
  },

  // Brooklyn Bridge: neo-gothic granite tower w/ twin arches, catenary cables + fan stays
  'brooklyn-bridge': () => {
    const g = new THREE.Group();
    const deck = 7, TOP = 84;
    g.add(box(36, 9, 16, GRANITE, 0, 1.5, 0)); // battered base in the river (-3..6)
    for (const sx of [-7.5, 7.5]) { // two pointed-arch openings (two archWalls side by side)
      const aw = archWall(15, 44, 12, 8, 24, GRANITE);
      aw.position.set(sx, 6, 0);
      g.add(aw);
    }
    g.add(box(30, 34, 14, GRANITE, 0, 67, 0)); // upper tower 50..84 (tapered)
    g.add(box(31, 1.6, 15, GRANITE, 0, 84.8, 0)); // cornice
    for (const mx of [-13, -4.5, 4.5, 13]) for (const mz of [-6, 6]) g.add(box(2.2, 3.2, 2.2, GRANITE, mx, 86.5, mz)); // pinnacles
    g.add(box(20, 22, 18, GRANITE, 0, 8, -78)); // anchorage
    for (const cx of [-11, -4, 4, 11]) { // 4 main cables (chains of struts) + suspenders
      const main = quarterCable(g, cx, 0, TOP, 140, deck + 7, 10, 0.28, STEEL_LM);
      catenary(g, cx, 0, TOP, -78, 22, 6, 8, 0.28, STEEL_LM); // backspan to anchorage
      if (Math.abs(cx) > 8) suspenders(g, main, deck, 0.06, STEEL_LM);
    }
    for (const sx of [-11, 11]) for (const dz of [24, 48, 72, 96, 120]) { // iconic diagonal stays
      g.add(strut(new THREE.Vector3(sx, TOP, 0), new THREE.Vector3(sx, deck, dz), 0.05, STEEL_LM, 4));
    }
    return g;
  },

  // Manhattan Bridge: blue-gray steel towers, suspension cables, Beaux-Arts approach arch
  'manhattan-bridge': () => {
    const g = new THREE.Group();
    const deck = 8, TOP = 100, SPAN = 180;
    g.add(latticeTower(103, 6.5, 4.5, 0.7, 0.16, STEEL_LM)); // Manhattan tower at origin
    const tB = latticeTower(103, 6.5, 4.5, 0.7, 0.16, STEEL_LM); // river tower
    tB.position.z = SPAN;
    g.add(tB);
    g.add(box(16, 18, 16, GRANITE, 0, 6, -68)); // anchorages
    g.add(box(16, 18, 16, GRANITE, 0, 6, SPAN + 68));
    for (const cx of [-7, -2.5, 2.5, 7]) { // 4 catenary cables + suspenders
      const mid = catenary(g, cx, 0, TOP, SPAN, TOP, TOP - 14, 10, 0.22, STEEL_LM);
      catenary(g, cx, 0, TOP, -68, 22, 4, 6, 0.22, STEEL_LM);
      catenary(g, cx, SPAN, TOP, SPAN + 68, 22, 4, 6, 0.22, STEEL_LM);
      if (Math.abs(cx) > 4) suspenders(g, mid, deck, 0.05, STEEL_LM);
    }
    // Beaux-Arts Manhattan approach at -z: triumphal arch + flanking curved colonnades
    const arch = archWall(22, 20, 6, 11, 15, LIMESTONE);
    arch.position.set(0, 0, -60);
    g.add(arch);
    g.add(box(24, 3, 7.5, LIMESTONE, 0, 21, -60)); // attic
    for (const sx of [-8, 8]) { // roofline sculpture
      const f = figure(3.2, LIMESTONE);
      f.position.set(sx, 22.5, -60);
      g.add(f);
    }
    for (const side of [-1, 1]) {
      const col = colonnade(5, 3.0, 0.5, 9, LIMESTONE);
      col.position.set(side * 16, 0, -54);
      col.rotation.y = -side * 0.6;
      g.add(col);
      const ent = box(15, 1.4, 2.2, LIMESTONE, side * 16, 9.8, -54);
      ent.rotation.y = -side * 0.6;
      g.add(ent);
    }
    return g;
  },

  // Williamsburg Bridge: utilitarian riveted lattice towers in distinctive pink-brown steel
  'williamsburg-bridge': () => {
    const g = new THREE.Group();
    const deck = 8, TOP = 96, SPAN = 170;
    g.add(latticeTower(99, 7, 5, 0.85, 0.2, WMB_STEEL)); // Manhattan tower at origin
    const tB = latticeTower(99, 7, 5, 0.85, 0.2, WMB_STEEL);
    tB.position.z = SPAN;
    g.add(tB);
    g.add(box(16, 18, 16, GRANITE, 0, 6, -64)); // anchorages
    g.add(box(16, 18, 16, GRANITE, 0, 6, SPAN + 64));
    for (const cx of [-8, -3, 3, 8]) { // 4 catenary cables + suspenders
      const mid = catenary(g, cx, 0, TOP, SPAN, TOP, TOP - 14, 10, 0.24, WMB_STEEL);
      catenary(g, cx, 0, TOP, -64, 22, 4, 6, 0.24, WMB_STEEL);
      catenary(g, cx, SPAN, TOP, SPAN + 64, 22, 4, 6, 0.24, WMB_STEEL);
      if (Math.abs(cx) > 4) suspenders(g, mid, deck, 0.06, WMB_STEEL);
    }
    for (const cz of [42, 85, 128]) g.add(box(15, 0.8, 0.5, WMB_STEEL, 0, TOP - 2, cz)); // upper lateral bracing hints
    return g;
  },
};
