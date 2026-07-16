import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRICK_RED, BRONZE, WHITE_LM,
  WATER_LM, GREEN_PATINA, STEEL_LM, GLASS_LM,
  box, cyl, strut, lathe, archWall, figure,
} from '../kit';

/**
 * Greenwich Village / Chelsea / Hudson Yards set. Every builder returns a group
 * whose origin sits at ground level at the registry position; the manager
 * rotates/positions/merges it. +z is the front face.
 */

// local tones (kept module-scope so the merger sees one instance per material)
const GRASS = new THREE.MeshLambertMaterial({ color: '#6d8f3a' });
const GRAVEL = new THREE.MeshLambertMaterial({ color: '#9a958a' });

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
    const basin = lathe([[8, 0], [8.15, 0.5], [7.7, 0.55]], GRANITE, 16); // fountain plaza ring
    basin.position.set(0, 0, 16);
    g.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(7.5, 16), WATER_LM);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.42, 16);
    g.add(water);
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

  // Flatiron crown: heavy projecting cornice + parapet on the triangular wedge at y=86
  flatiron: () => {
    const g = new THREE.Group();
    const yC = 86;
    const V = [[-13, -31], [13, -31], [0, 31]] as const; // back-left, back-right, sharp nose (+z)
    const edges = [[V[0], V[1]], [V[0], V[2]], [V[1], V[2]]] as const;
    for (const [a, b] of edges) {
      g.add(edgeBar(a[0], a[1], b[0], b[1], yC, 2.6, 2.4, LIMESTONE)); // projecting cornice ring
      g.add(edgeBar(a[0], a[1], b[0], b[1], yC + 2.4, 0.8, 2.0, LIMESTONE)); // 2m parapet above
    }
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
