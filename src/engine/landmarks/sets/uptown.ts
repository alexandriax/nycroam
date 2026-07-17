import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRONZE, GOLD, STEEL_LM, GLASS_LM,
  WHITE_LM, WATER_LM, GREEN_PATINA,
  box, cyl, strut, colonnade, lathe, archWall, figure,
} from '../kit';

/**
 * Uptown set: Columbus Circle, the Upper West Side spine (Lincoln Center,
 * the Dakota, AMNH) and the Fifth-Avenue museums (Met, Guggenheim), plus the
 * Intrepid on the Hudson. Every builder returns a group whose origin sits at
 * ground level at the registry position; the manager rotates/positions/merges.
 */

// ---- local materials (a few tints the shared kit doesn't carry) ------------
const DAKOTA_BRICK = new THREE.MeshLambertMaterial({ color: '#b08d6a' }); // pale tan brick
const WARM_GLOW = new THREE.MeshBasicMaterial({ color: '#f6c98a' });       // lit interiors (unlit = glows)
const BANNER_A = new THREE.MeshLambertMaterial({ color: '#9c2b2b' });      // museum banners
const BANNER_B = new THREE.MeshLambertMaterial({ color: '#2b4a7c' });
const BANNER_C = new THREE.MeshLambertMaterial({ color: '#8a6d1f' });

// ---- shared local helpers ---------------------------------------------------

/** Straight park bench (matches the exemplar set's proportions). */
function bench(mat: THREE.Material = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.06, 0.5, mat, 0, 0.45, 0));
  g.add(box(1.8, 0.5, 0.06, mat, 0, 0.7, -0.25));
  g.add(box(0.08, 0.45, 0.5, mat, -0.8, 0.22, 0));
  g.add(box(0.08, 0.45, 0.5, mat, 0.8, 0.22, 0));
  return g;
}

/** Bench whose seat segments follow an arc of the given radius, facing inward. */
function curvedBench(radius: number, arc: number, segs = 5, mat: THREE.Material = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < segs; i++) {
    const a = -arc / 2 + (arc * (i + 0.5)) / segs;
    const x = Math.sin(a) * radius, z = Math.cos(a) * radius;
    const seat = box(1.5, 0.1, 0.5, mat, x, 0.45, z); seat.rotation.y = -a; g.add(seat);
    const back = box(1.5, 0.5, 0.08, mat, x, 0.7, z + 0.24); back.rotation.y = -a; g.add(back);
  }
  return g;
}

/** Ornate gas lamp with a self-lit globe (the Dakota's famous entrance lamps). */
function gasLamp(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.12, 0.18, 0.5, DARKSTONE, 0, 0.25, 0, 8));
  g.add(cyl(0.07, 0.09, 3.6, DARKSTONE, 0, 2.0, 0, 8));
  g.add(box(0.4, 0.4, 0.4, DARKSTONE, 0, 3.9, 0));
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), WARM_GLOW);
  globe.position.y = 4.25; g.add(globe);
  g.add(cyl(0.0, 0.3, 0.5, DARKSTONE, 0, 4.7, 0, 6));
  return g;
}

/** Gilt finial: shaft, ball and spike, sitting with its foot at (x,y,z). */
function finialAt(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.08, 0.12, 1.6, GOLD, x, y + 0.8, z, 6));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), GOLD);
  ball.position.set(x, y + 1.7, z); g.add(ball);
  g.add(cyl(0.0, 0.12, 0.7, GOLD, x, y + 2.2, z, 6));
  return g;
}

/** Four steep sloped roof slabs (a mansard) leaning inward around a footprint. */
function mansardSlabs(W: number, D: number, y0: number, mh: number, inset: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const len = Math.hypot(mh, inset);
  const ang = Math.atan2(inset, mh);
  for (const s of [1, -1]) {
    const slab = box(W, len, 0.9, mat, 0, y0 + mh / 2, s * (D / 2 - inset / 2));
    slab.rotation.x = -s * ang; g.add(slab);
  }
  for (const s of [1, -1]) {
    const slab = box(0.9, len, D, mat, s * (W / 2 - inset / 2), y0 + mh / 2, 0);
    slab.rotation.z = s * ang; g.add(slab);
  }
  return g;
}

/** Stylized equestrian statue (horse + rider) ~2.7m tall at the withers. */
function equestrian(mat: THREE.Material): THREE.Group {
  const h = new THREE.Group();
  h.add(box(3.0, 1.4, 1.0, mat, 0, 1.7, 0));
  const neck = cyl(0.3, 0.4, 1.4, mat, 1.3, 2.4, 0, 8); neck.rotation.z = -0.6; h.add(neck);
  const head = box(1.0, 0.5, 0.5, mat, 1.9, 3.0, 0); head.rotation.z = -0.3; h.add(head);
  for (const lx of [-1.1, 1.0]) for (const lz of [-0.35, 0.35]) h.add(cyl(0.13, 0.13, 1.7, mat, lx, 0.85, lz, 6));
  const tail = cyl(0.1, 0.18, 1.2, mat, -1.55, 1.6, 0, 6); tail.rotation.z = 0.7; h.add(tail);
  const rider = figure(2.0, mat); rider.position.set(0.1, 2.4, 0); h.add(rider);
  return h;
}

/** A simple carrier-deck warplane silhouette (fuselage + cruciform wings/tail). */
function warplane(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(7, 0.7, 1.0, mat, 0, 0.5, 0));
  g.add(box(1.6, 0.25, 8, mat, 0.3, 0.5, 0));
  g.add(box(1.4, 1.0, 0.25, mat, -3.0, 0.9, 0));
  g.add(box(1.2, 0.2, 3.0, mat, -2.8, 0.5, 0));
  return g;
}

/** Angled hull plate (a box laid along the segment a->b in the XZ plane). */
function hullPlate(x1: number, z1: number, x2: number, z2: number, hh: number, yc: number, mat: THREE.Material): THREE.Mesh {
  const dx = x2 - x1, dz = z2 - z1;
  const m = box(Math.hypot(dx, dz), hh, 1.6, mat, (x1 + x2) / 2, yc, (z1 + z2) / 2);
  m.rotation.y = -Math.atan2(dz, dx);
  return m;
}

interface Face { half: number; fixed: number; axis: 'x' | 'z'; sign: number; }

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Columbus monument: granite rostral column on stepped base, marble Columbus, ring fountain, curved benches
  'columbus-circle': () => {
    const g = new THREE.Group();
    // stepped granite base
    g.add(box(9, 0.6, 9, GRANITE, 0, 0.3, 0));
    g.add(box(7, 0.6, 7, GRANITE, 0, 0.9, 0));
    g.add(box(5, 0.6, 5, GRANITE, 0, 1.5, 0));
    // rostral column: tapered shaft with protruding ship-prow rams at three levels
    const y0 = 1.8, shaftH = 21;
    g.add(cyl(1.05, 1.35, shaftH, GRANITE, 0, y0 + shaftH / 2, 0, 12));
    for (const frac of [0.3, 0.55, 0.8]) {
      const py = y0 + shaftH * frac, rr = 1.35 - 0.3 * frac;
      for (let s = 0; s < 4; s++) {
        const a = s * Math.PI / 2 + Math.PI / 4;
        const prow = new THREE.Group();
        prow.add(box(1.3, 0.5, 0.5, GRANITE, 0.65, 0, 0));       // ram body
        const tip = box(0.6, 0.4, 0.35, GRANITE, 1.45, 0, 0); tip.rotation.z = -0.15; prow.add(tip); // pointed beak
        prow.position.set(Math.cos(a) * (rr + 0.2), py, Math.sin(a) * (rr + 0.2));
        prow.rotation.y = -a; g.add(prow);
      }
    }
    g.add(cyl(1.6, 1.2, 1.1, GRANITE, 0, y0 + shaftH + 0.55, 0, 12)); // capital
    const columbus = figure(4, MARBLE); columbus.position.y = y0 + shaftH + 1.1; g.add(columbus);
    // ring fountain: lathe basin walls + water annulus
    g.add(lathe([[6.6, 0], [6.6, 0.75], [7.1, 0.75], [7.1, 0.05]], GRANITE, 20)); // outer rim
    g.add(lathe([[4.3, 0], [4.3, 0.6], [4.7, 0.6], [4.7, 0.05]], GRANITE, 18));   // inner curb
    const water = new THREE.Mesh(new THREE.RingGeometry(4.7, 6.6, 24), WATER_LM);
    water.rotation.x = -Math.PI / 2; water.position.y = 0.5; g.add(water);
    for (let q = 0; q < 4; q++) { const b = curvedBench(10.5, 1.0, 5); b.rotation.y = q * Math.PI / 2 + Math.PI / 4; g.add(b); }
    return g;
  },

  // Hearst Tower: diagrid steel overlay (zigzag diamonds, no corner verticals) wrapping the OSM tower footprint
  'hearst-tower': (ctx) => {
    // Hearst Tower: the 1928 Urban cast-stone base (OSM has no separate base
    // part, so the pipeline clears the whole massing and we own all of it),
    // with the diagrid tower rising out of it — glazed, not a bare frame:
    // a mullioned glass box wears the diagonal steel lattice, with the
    // signature bird's-mouth corner notches (no corner verticals).
    const g = new THREE.Group();
    const bw = (ctx.fit?.w ?? 79), bd = (ctx.fit?.d ?? 70);
    const baseH = 26;
    // -- 1928 base: cast stone with fluted pilasters and a deep cornice
    g.add(box(bw, baseH, bd, LIMESTONE, 0, baseH / 2, 0));
    g.add(box(bw + 1.6, 1.8, bd + 1.6, DARKSTONE, 0, baseH + 0.9, 0)); // cornice
    for (let x = -bw / 2 + 4; x <= bw / 2 - 4; x += 6.2) {
      for (const sz of [1, -1]) g.add(box(1.4, baseH - 4, 1.1, WHITE_LM, x, (baseH - 4) / 2 + 2, sz * (bd / 2 + 0.35)));
    }
    for (let z = -bd / 2 + 5; z <= bd / 2 - 5; z += 6.2) {
      for (const sx of [1, -1]) g.add(box(1.1, baseH - 4, 1.4, WHITE_LM, sx * (bw / 2 + 0.35), (baseH - 4) / 2 + 2, z));
    }
    // -- glazed tower: mullioned glass volume the lattice sits on
    const y0 = baseH, y1 = 182;
    const HW = 24, HD = 18.5; // ~48m x 37m tower footprint, centered on the base
    const glass = box(HW * 2 - 1.1, y1 - y0, HD * 2 - 1.1, GLASS_LM, 0, (y0 + y1) / 2, 0);
    g.add(glass);
    // floor bands every ~4 storeys so the glass reads as storeys, not a slab
    for (let y = y0 + 16; y < y1; y += 16) {
      g.add(box(HW * 2 - 0.9, 0.55, HD * 2 - 0.9, STEEL_LM, 0, y, 0));
    }
    const faces: Face[] = [
      { half: HW, fixed: HD, axis: 'z', sign: 1 }, { half: HW, fixed: HD, axis: 'z', sign: -1 },
      { half: HD, fixed: HW, axis: 'x', sign: 1 }, { half: HD, fixed: HW, axis: 'x', sign: -1 },
    ];
    const P = (f: Face, u: number, y: number): THREE.Vector3 =>
      f.axis === 'z' ? new THREE.Vector3(u, y, f.sign * f.fixed) : new THREE.Vector3(f.sign * f.fixed, y, u);
    const rows = 6, rowH = (y1 - y0) / rows;
    for (const f of faces) {
      const n = Math.max(3, Math.round((f.half * 2) / 12)), seg = (f.half * 2) / n;
      for (let r = 0; r < rows; r++) {
        const yb = y0 + r * rowH, yt = yb + rowH;
        for (let i = 0; i < n; i++) {
          const xL = -f.half + i * seg, xR = xL + seg;
          g.add(strut(P(f, xL, yb), P(f, xR, yt), 0.55, STEEL_LM, 6));
          g.add(strut(P(f, xL, yt), P(f, xR, yb), 0.55, STEEL_LM, 6));
        }
      }
      g.add(strut(P(f, -f.half, y0), P(f, f.half, y0), 0.45, STEEL_LM, 6));
      g.add(strut(P(f, -f.half, y1), P(f, f.half, y1), 0.45, STEEL_LM, 6));
    }
    g.add(box(HW * 2 - 2, 1.4, HD * 2 - 2, STEEL_LM, 0, y1 + 0.7, 0)); // roof rim
    return g;
  },

  // Plaza Hotel: copper mansard crown with dormers, turret cones + gold finials, plus a marble base colonnade
  'plaza-hotel': () => {
    const g = new THREE.Group();
    const W = 58, D = 46, roofY = 58, mh = 13, inset = 5;
    g.add(mansardSlabs(W, D, roofY, mh, inset, GREEN_PATINA));
    g.add(box(W - 2 * inset + 2, 1.5, D - 2 * inset + 2, GREEN_PATINA, 0, roofY + mh + 0.75, 0)); // flat top deck
    // dormer boxes poking through the slopes
    for (const [along, count, halfLen, zx] of [['x', 6, W / 2, D / 2 - inset * 0.5], ['z', 4, D / 2, W / 2 - inset * 0.5]] as const) {
      for (let i = 0; i < count; i++) {
        const t = -halfLen + 2 + (i + 0.5) * ((2 * halfLen - 4) / count);
        for (const s of [1, -1]) {
          const dm = new THREE.Group();
          dm.add(box(1.7, 2.2, 1.0, WHITE_LM, 0, 0, 0));
          dm.add(box(1.9, 0.8, 1.2, GREEN_PATINA, 0, 1.3, 0)); // little gable cap
          if (along === 'x') dm.position.set(t, roofY + 4, s * zx); else dm.position.set(s * zx, roofY + 4, t);
          g.add(dm);
        }
      }
    }
    // corner turrets with conical caps + gold finials
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const cx = sx * (W / 2 - 2), cz = sz * (D / 2 - 2);
      g.add(cyl(2.4, 2.6, mh + 4, WHITE_LM, cx, roofY + (mh + 4) / 2, cz, 12));
      g.add(cyl(0.1, 2.9, 5, GREEN_PATINA, cx, roofY + mh + 4 + 2.5, cz, 12));
      g.add(finialAt(cx, roofY + mh + 9, cz));
    }
    g.add(finialAt(0, roofY + mh + 1.5, 0));
    // three-story white marble base colonnade on the +z (avenue) face
    g.add(box(42, 2, 4, MARBLE, 0, 1, D / 2));
    const base = colonnade(9, 4.5, 0.7, 14, MARBLE); base.position.set(0, 2, D / 2); g.add(base);
    g.add(box(42, 3, 4, MARBLE, 0, 17.5, D / 2));
    return g;
  },

  // Pulitzer Fountain: five shrinking granite basins with water discs, gilt Pomona on top, ring of benches
  'pulitzer-fountain': () => {
    const g = new THREE.Group();
    const tiers = [[6.2, 0.0, 0.9], [4.7, 1.4, 0.8], [3.4, 2.6, 0.7], [2.3, 3.6, 0.6], [1.4, 4.5, 0.5]];
    let prevTop = 0;
    for (const [r, y, h] of tiers) {
      const basin = lathe([[r, 0], [r, h * 0.6], [r * 0.82, h]], GRANITE, 18); basin.position.y = y; g.add(basin);
      const w = new THREE.Mesh(new THREE.CircleGeometry(r * 0.9, 18), WATER_LM);
      w.rotation.x = -Math.PI / 2; w.position.y = y + h * 0.55; g.add(w);
      g.add(cyl(r * 0.34, r * 0.4, (y - prevTop) + 0.4, GRANITE, 0, (y + prevTop) / 2, 0, 12)); // support to next tier
      prevTop = y + h;
    }
    const pomona = figure(2.2, GOLD); pomona.position.y = 5.0; g.add(pomona);
    const basket = lathe([[0, 0], [0.55, 0.15], [0.45, 0.4]], GOLD, 10); basket.position.set(0.3, 5.4, 0.35); g.add(basket); // her fruit basket
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; const b = bench(); b.position.set(Math.cos(a) * 9, 0, Math.sin(a) * 9); b.rotation.y = -a + Math.PI / 2; g.add(b); }
    return g;
  },

  // Lincoln Center: glowing 5-arch Met Opera at -z, two travertine theaters flanking, central Revson fountain
  'lincoln-center': () => {
    const g = new THREE.Group();
    const operaZ = -26;
    for (let i = 0; i < 5; i++) {
      const ax = -22 + i * 11;
      const a = archWall(10.5, 22, 3, 6, 18, MARBLE); a.position.set(ax, 0, operaZ); g.add(a);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 17), WARM_GLOW); glow.position.set(ax, 9, operaZ - 1.6); g.add(glow);
    }
    g.add(box(58, 4, 4, MARBLE, 0, 24, operaZ));            // opera cornice
    g.add(box(58, 26, 1.5, MARBLE, 0, 13, operaZ - 2.2));   // back wall behind the glow
    for (const s of [-1, 1]) {                              // Geffen (+x) & Koch (-x) theaters
      const tx = s * 32;
      g.add(box(20, 20, 34, LIMESTONE, tx, 10, 0));
      g.add(box(22, 2, 36, LIMESTONE, tx, 21, 0));
      const col = colonnade(7, 4.2, 0.7, 16, LIMESTONE); col.rotation.y = s * Math.PI / 2; col.position.set(tx - s * 10.2, 0, 0); g.add(col);
    }
    // Revson fountain: flat granite disc, water ring, center jet cluster
    g.add(cyl(7, 7.2, 0.8, GRANITE, 0, 0.4, 4, 20));
    const w = new THREE.Mesh(new THREE.CircleGeometry(6.4, 20), WATER_LM); w.rotation.x = -Math.PI / 2; w.position.set(0, 0.75, 4); g.add(w);
    for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, jh = 1.4 + (i % 3) * 0.6; g.add(cyl(0.08, 0.12, jh, WATER_LM, Math.cos(a) * 1.2, 0.8 + jh / 2, 4 + Math.sin(a) * 1.2, 6)); }
    g.add(cyl(0.15, 0.2, 3.0, WATER_LM, 0, 2.3, 4, 6));    // tall center jet
    return g;
  },

  // The Dakota: tan-brick chateau block, steep dark roof, taller corner pavilions + finials, arched carriage entry
  'dakota': () => {
    const g = new THREE.Group();
    const S = 40, H = 30;
    g.add(box(S, H, S, DAKOTA_BRICK, 0, H / 2, 0));
    g.add(box(S + 1.5, 1.2, S + 1.5, DARKSTONE, 0, H, 0)); // cornice
    g.add(mansardSlabs(S, S, H, 9, 3.5, DARKSTONE));       // steep gabled roofline
    g.add(box(S - 5, 1.0, S - 5, DARKSTONE, 0, H + 9.5, 0));
    // deep-set window courses (dark reveals) on the four faces
    for (const s of [1, -1]) for (let row = 0; row < 4; row++) for (let i = 0; i < 5; i++) {
      g.add(box(1.8, 3.0, 0.4, DARKSTONE, -14 + i * 7, 5 + row * 6.5, s * (S / 2 + 0.05)));
      g.add(box(0.4, 3.0, 1.8, DARKSTONE, s * (S / 2 + 0.05), 5 + row * 6.5, -14 + i * 7));
    }
    // corner pavilions rising higher, each capped with a steep cone + finial
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const cx = sx * (S / 2 - 4.5), cz = sz * (S / 2 - 4.5);
      g.add(box(9, H + 9, 9, DAKOTA_BRICK, cx, (H + 9) / 2, cz));
      g.add(cyl(0.1, 6.4, 8, DARKSTONE, cx, H + 9 + 4, cz, 4));
      g.add(finialAt(cx, H + 9 + 8, cz));
    }
    // deep arched carriage entrance on +z with a dark stone surround
    g.add(box(13, 15, 2, DARKSTONE, 0, 7.5, S / 2 + 0.3));
    const gate = archWall(10, 12, 5, 5, 9, DARKSTONE); gate.position.set(0, 0, S / 2 + 1.3); g.add(gate);
    // iron area railing + twin gas lamps flanking the entry
    for (let x = -S / 2; x <= S / 2; x += 1.5) g.add(cyl(0.05, 0.05, 1.1, DARKSTONE, x, 0.55, S / 2 + 3, 6));
    g.add(box(S, 0.08, 0.08, DARKSTONE, 0, 1.05, S / 2 + 3));
    for (const lx of [-4.5, 4.5]) { const l = gasLamp(); l.position.set(lx, 0, S / 2 + 2); g.add(l); }
    return g;
  },

  // AMNH: granite center pavilion w/ arch + columns, bronze equestrian Roosevelt, wings, and the Rose Center sphere
  'amnh': () => {
    const g = new THREE.Group();
    // central Roosevelt Memorial pavilion
    g.add(box(30, 26, 14, GRANITE, 0, 13, 8));
    g.add(box(34, 4, 16, LIMESTONE, 0, 27, 8));  // attic
    const arch = archWall(20, 18, 3, 7, 13, LIMESTONE); arch.position.set(0, 0, 15); g.add(arch);
    const cols = colonnade(4, 5.5, 0.9, 17, GRANITE); cols.position.set(0, 0, 16.5); g.add(cols);
    g.add(box(24, 2.5, 2, LIMESTONE, 0, 18.4, 16.5)); // entablature
    for (const s of [-1, 1]) { const rake = box(11, 1.1, 1.5, LIMESTONE, s * 5, 20.5, 16.5); rake.rotation.z = -s * 0.32; g.add(rake); } // pediment rakes
    // flanking wings with pilaster articulation
    for (const sx of [-1, 1]) {
      g.add(box(26, 18, 12, GRANITE, sx * 30, 9, 6));
      for (let i = 0; i < 6; i++) g.add(box(1.0, 16, 0.6, LIMESTONE, sx * 30 - 12.5 + i * 5, 9, 12.2));
    }
    // equestrian Roosevelt on a granite plinth, front and center
    g.add(box(4, 3, 6, GRANITE, 0, 1.5, 24));
    const teddy = equestrian(BRONZE); teddy.position.set(0, 3, 24); g.add(teddy);
    // Rose Center behind (-z): glass cube with the great white sphere floating on struts
    const cs = 25, cy = 15, cz = -26;
    g.add(box(cs, cs, cs, GLASS_LM, 0, cy, cz));
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(13, 16, 12), WHITE_LM); sphere.position.set(0, cy, cz); g.add(sphere);
    for (const a of [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4]) {
      const p1 = new THREE.Vector3(Math.cos(a) * 13, cy, cz + Math.sin(a) * 13);
      const p2 = new THREE.Vector3(Math.cos(a) * cs / 2, cy, cz + Math.sin(a) * cs / 2);
      g.add(strut(p1, p2, 0.15, STEEL_LM, 6));
    }
    g.add(strut(new THREE.Vector3(0, cy + 13, cz), new THREE.Vector3(0, cy + cs / 2, cz), 0.15, STEEL_LM, 6));
    return g;
  },

  // Met Museum: 100m Beaux-Arts facade (paired columns, 3 arched niches, attic), grand stairs, flanking fountains, banners
  'met-museum': () => {
    const g = new THREE.Group();
    const W = 100;
    g.add(box(W, 4, 8, LIMESTONE, 0, 2, -3));       // stylobate the facade sits on
    g.add(box(W, 30, 6, LIMESTONE, 0, 19, -3));     // main facade wall
    g.add(box(W + 2, 1.5, 8, MARBLE, 0, 34.5, -3)); // cornice band
    g.add(box(W, 5, 7, LIMESTONE, 0, 37.5, -3));    // attic
    for (const bx of [-30, 0, 30]) { const niche = archWall(22, 24, 4, 10, 17, MARBLE); niche.position.set(bx, 4, 0.5); g.add(niche); } // 3 arched niches
    for (const px of [-45, -15, 15, 45]) for (const off of [-1.7, 1.7]) { // paired Corinthian columns
      g.add(cyl(0.9, 1.0, 24, MARBLE, px + off, 16, 2.5, 12));
      g.add(box(2.4, 0.8, 2.4, MARBLE, px + off, 28.4, 2.5));
      g.add(box(2.6, 0.7, 2.6, MARBLE, px + off, 4.35, 2.5));
    }
    g.add(box(W, 2.5, 3, MARBLE, 0, 30, 3)); // entablature over the columns
    const banners = [BANNER_A, BANNER_B, BANNER_C];
    for (let i = 0; i < 3; i++) g.add(box(6, 14, 0.2, banners[i], [-30, 0, 30][i], 18, 4.3)); // solid-color banners
    // grand stairs cascading full width toward +z
    for (let i = 0; i < 14; i++) g.add(box(W, 0.32, 1.1, LIMESTONE, 0, 0.16 + i * 0.29, 15 - i * 1.0));
    // two flanking fountains (rect basins + water)
    for (const sx of [-1, 1]) {
      g.add(box(9, 1.0, 5, GRANITE, sx * 40, 0.5, 17));
      const w = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 3.6), WATER_LM); w.rotation.x = -Math.PI / 2; w.position.set(sx * 40, 0.85, 17); g.add(w);
    }
    return g;
  },

  // Guggenheim: Wright's inverted ziggurat of white cylinders growing upward with dark reveals, slab wing, street drum
  'guggenheim': () => {
    const g = new THREE.Group();
    const levels = 5, rBot = 12, rTop = 16, lh = 4.6;
    g.add(cyl(11.5, 12.2, 2.5, WHITE_LM, 0, 1.25, 0, 16)); // base ring
    let y = 2.5;
    for (let i = 0; i < levels; i++) {
      const r0 = rBot + (rTop - rBot) * (i / levels), r1 = rBot + (rTop - rBot) * ((i + 1) / levels);
      g.add(cyl(r1, r0, lh, WHITE_LM, 0, y + lh / 2, 0, 16));                  // widening band
      g.add(cyl(r1 + 0.06, r1 + 0.06, 0.25, DARKSTONE, 0, y + lh + 0.1, 0, 16)); // hairline dark reveal
      y += lh;
    }
    g.add(cyl(rTop + 0.3, rTop, 1.0, WHITE_LM, 0, y + 0.5, 0, 16)); // parapet
    // low horizontal slab wing at +x, and the small entrance drum at street
    g.add(box(14, 9, 16, WHITE_LM, 18, 4.5, 2));
    g.add(box(15, 1.0, 17, WHITE_LM, 18, 9.2, 2));
    g.add(cyl(4.5, 4.5, 5, WHITE_LM, -2, 2.5, 13, 16));
    return g;
  },

  // Intrepid: 270m carrier hull with angled bow + flight deck, island + radar masts, deck aircraft
  'intrepid': (ctx) => {
    const outer = new THREE.Group();
    const g = new THREE.Group();
    // FLOAT, don't sit on terrain: the manager lifts every landmark group to
    // heightAt(anchor), but a moored ship rides the water plane (y -0.7) no
    // matter what the shore berm under the anchor measures
    g.position.y = -(ctx.groundAt(0, 0)) - 0.7;
    outer.add(g);
    // hull (dark sides) from y=-4 to the flight deck at y=15, with an angled bow wedge at +x
    g.add(box(250, 19, 26, DARKSTONE, -10, 5.5, 0));
    g.add(hullPlate(115, 13, 140, 0, 19, 5.5, DARKSTONE));  // port bow plate
    g.add(hullPlate(115, -13, 140, 0, 19, 5.5, DARKSTONE)); // starboard bow plate
    g.add(box(24, 19, 14, DARKSTONE, 126, 5.5, 0));         // bow filler
    // flight deck (lighter), overhanging the hull, plus the angled deck extension aft-port
    g.add(box(272, 1.2, 34, GRANITE, 0, 14.4, 0));
    const angled = box(90, 0.8, 16, GRANITE, -40, 15.2, -22); angled.rotation.y = 0.16; g.add(angled);
    // island superstructure on the river (-z) edge toward the bow, with radar masts
    g.add(box(16, 8, 10, GRANITE, 45, 19, -7));
    g.add(box(10, 6, 8, GRANITE, 46, 26, -7));
    g.add(box(6, 4, 7, DARKSTONE, 47, 31, -7));
    for (const mx of [44, 48]) { g.add(strut(new THREE.Vector3(mx, 33, -7), new THREE.Vector3(mx, 44, -7), 0.25, STEEL_LM, 6)); g.add(box(0.2, 0.2, 4, STEEL_LM, mx, 40, -7)); }
    // deck aircraft, varied placement + heading
    const planeMats = [WHITE_LM, GRANITE, DARKSTONE, WHITE_LM, GRANITE, DARKSTONE];
    const spots: [number, number, number][] = [[-90, 6, 0.2], [-60, -6, -0.3], [-30, 5, 0.1], [5, -7, 2.9], [-110, -4, 3.0], [-45, 8, -0.2]];
    for (let i = 0; i < spots.length; i++) { const [px, pz, ry] = spots[i]; const p = warplane(planeMats[i]); p.position.set(px, 15.3, pz); p.rotation.y = ry; g.add(p); }
    // no built pier: the ship rides in the river off the REAL Pier 86 OSM
    // building, stern toward the bank
    return outer;
  },
};
