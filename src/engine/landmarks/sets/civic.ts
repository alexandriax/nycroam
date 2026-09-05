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
 * (Woolworth & Municipal shafts) — those builders add only the missing crown.
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

  // Woolworth: neo-gothic verdigris copper crown from y=215 to a 241m spire tip
  woolworth: () => {
    const g = new THREE.Group();
    g.add(box(20, 3, 20, VERDIGRIS, 0, 216.5, 0)); // setback 215..218
    g.add(box(15, 3, 15, VERDIGRIS, 0, 219.5, 0)); // setback 218..221
    g.add(box(13, 1.2, 13, VERDIGRIS, 0, 221.6, 0)); // ring
    for (const sx of [-8, 8]) for (const sz of [-8, 8]) { // corner tourelles (cyl + cone pinnacle)
      g.add(cyl(0.9, 1.1, 12, VERDIGRIS, sx, 221, sz, 8));
      g.add(cyl(0, 1.2, 4, VERDIGRIS, sx, 229, sz, 8));
      g.add(cyl(0, 0.35, 1.4, VERDIGRIS, sx, 231.7, sz, 6));
    }
    const roof = cyl(0, 8.5, 15.5, VERDIGRIS, 0, 228.75, 0, 4); // pyramidal roof 221..236.5
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    const faces: [number, number, number][] = [[0, 6, 0], [0, -6, Math.PI], [6, 0, -Math.PI / 2], [-6, 0, Math.PI / 2]];
    for (const [dx, dz, ry] of faces) { // gabled gothic dormers
      const d = pediment(3, 2, 1.2, VERDIGRIS);
      d.position.set(dx, 224, dz);
      d.rotation.y = ry;
      g.add(d);
    }
    g.add(cyl(1.4, 1.8, 2, VERDIGRIS, 0, 237.5, 0, 8)); // lantern 236.5..238.5
    g.add(cyl(0, 1.2, 2.5, VERDIGRIS, 0, 239.75, 0, 8)); // spire tip → 241
    return g;
  },

  // Municipal Building: gilt Civic Fame atop a colonnaded tempietto; street-level triumphal arch
  'municipal-building': () => {
    const g = new THREE.Group();
    // street-level triumphal arch through the building line
    g.add(archWall(16, 13, 5, 6, 9, LIMESTONE));
    for (const sx of [-11, 11]) {
      const c = colonnade(3, 2.6, 0.6, 11, LIMESTONE);
      c.position.set(sx, 0, 0);
      g.add(c);
    }
    g.add(box(40, 2, 6, LIMESTONE, 0, 14, 0)); // entablature over arch + wings
    // crown from y=155
    g.add(box(20, 3, 20, LIMESTONE, 0, 156.5, 0)); // square base 155..158
    g.add(cyl(8, 8.6, 4, LIMESTONE, 0, 160, 0, 14)); // drum 158..162
    g.add(ringColonnade(10, 6.6, 0.5, 6, LIMESTONE, 162)); // round tempietto 162..168
    g.add(cyl(7.2, 7.2, 1.2, LIMESTONE, 0, 168.6, 0, 14)); // entablature ring
    g.add(cyl(4.6, 5.2, 4, LIMESTONE, 0, 171.2, 0, 12)); // stacked drum 169.2..173.2
    g.add(cyl(3.0, 3.6, 3, LIMESTONE, 0, 174.7, 0, 12)); // top drum 173.2..176.2
    g.add(ball(1.0, GOLD, 0, 176.4, 0)); // orb underfoot
    const fame = figure(6, GOLD); // gilt Civic Fame ~177m
    fame.position.y = 176.8;
    g.add(fame);
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
      const aw = archWall(15, 60, 12, 8, 49, GRANITE, true);
      aw.position.set(sx, 6, 0);
      g.add(aw);
    }
    g.add(box(30, 18, 14, GRANITE, 0, 75, 0)); // upper tower 50..84 (tapered)
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
