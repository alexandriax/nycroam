import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRONZE, VERDIGRIS, GOLD, WHITE_LM,
  WATER_LM, BRICK_RED, GREEN_PATINA,
  box, cyl, strut, colonnade, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Central Park set. Every builder returns a group whose origin sits at ground
 * level at the registry position; the manager rotates/positions/merges it.
 */

function bench(mat = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.06, 0.5, mat, 0, 0.45, 0));
  g.add(box(1.8, 0.5, 0.06, mat, 0, 0.7, -0.25));
  g.add(box(0.08, 0.45, 0.5, mat, -0.8, 0.22, 0));
  g.add(box(0.08, 0.45, 0.5, mat, 0.8, 0.22, 0));
  return g;
}

function lampPost(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.05, 0.07, 3.4, DARKSTONE, 0, 1.7, 0, 8));
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), WHITE_LM);
  globe.position.y = 3.6;
  g.add(globe);
  return g;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // USS Maine Monument at Merchants' Gate — gilded quadriga on a marble pylon
  'central-park': () => {
    const g = new THREE.Group();
    g.add(box(9, 1.2, 9, GRANITE, 0, 0.6, 0));
    g.add(box(6.5, 1.0, 6.5, MARBLE, 0, 1.7, 0));
    g.add(box(3.2, 9, 3.2, MARBLE, 0, 6.7, 0));
    g.add(box(4.2, 0.8, 4.2, MARBLE, 0, 11.5, 0));
    // gilded Columbia Triumphant in a seashell chariot
    const chariot = new THREE.Group();
    const shell = lathe([[0, 0], [1.1, 0.25], [1.3, 0.7], [0.9, 1.0]], GOLD, 10);
    shell.position.y = 11.9;
    chariot.add(shell);
    const col = figure(2.4, GOLD);
    col.position.y = 12.4;
    chariot.add(col);
    for (const sx of [-1.25, -0.45, 0.45, 1.25]) {
      const horse = new THREE.Group();
      horse.add(box(1.5, 0.75, 0.55, GOLD, 0, 0.85, 0));
      horse.add(cyl(0.14, 0.16, 0.8, GOLD, 0.62, 1.65, 0, 6));
      const head = box(0.55, 0.3, 0.3, GOLD, 0.85, 2.05, 0);
      head.rotation.z = -0.4;
      horse.add(head);
      for (const lx of [-0.5, 0.45]) for (const lz of [-0.16, 0.16]) horse.add(cyl(0.07, 0.07, 0.9, GOLD, lx, 0.42, lz, 6));
      horse.position.set(sx, 11.9, 1.7);
      chariot.add(horse);
    }
    g.add(chariot);
    // fountain basin at the pylon's front + marble figures at the base
    const basin = lathe([[3.4, 0], [3.5, 0.5], [3.2, 0.55]], GRANITE, 18);
    basin.position.set(0, 0, 7.2);
    g.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(3.1, 18), WATER_LM);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.42, 7.2);
    g.add(water);
    const fig = figure(2.6, MARBLE);
    fig.position.set(0, 1.2, 2.2);
    g.add(fig);
    return g;
  },

  // Bethesda Terrace: sandstone balustrades, twin stairs, Angel of the Waters
  bethesda: () => {
    const g = new THREE.Group();
    const SAND = LIMESTONE;
    // upper terrace balustrade line
    for (const zrow of [-16]) {
      g.add(box(30, 1.05, 0.5, SAND, 0, 4.3, zrow));
      for (let x = -14; x <= 14; x += 1.4) g.add(cyl(0.11, 0.15, 0.85, SAND, x, 3.65, zrow, 6));
      g.add(box(30, 0.5, 1.6, SAND, 0, 3.1, zrow));
    }
    // twin stairs flanking the arcade
    for (const sx of [-11, 11]) {
      for (let i = 0; i < 10; i++) {
        g.add(box(6, 0.42, 1.0, SAND, sx, 3.8 - i * 0.42 - 0.21, -15 + i * 1.0));
      }
      // stair cheeks
      g.add(box(0.6, 2.2, 10.5, SAND, sx - 3.2, 2.0, -10.5));
      g.add(box(0.6, 2.2, 10.5, SAND, sx + 3.2, 2.0, -10.5));
    }
    // arcade wall under the terrace (7 arches)
    const arcade = archWall(26, 4.6, 3.5, 2.6, 3.6, SAND);
    arcade.position.set(0, 0, -14.5);
    g.add(arcade);
    // Angel of the Waters fountain
    const lower = lathe([[6.2, 0], [6.4, 0.55], [6.0, 0.62]], SAND, 22);
    g.add(lower);
    const water = new THREE.Mesh(new THREE.CircleGeometry(5.9, 22), WATER_LM);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.5;
    g.add(water);
    const pedestal = lathe([[0.5, 0], [1.9, 0.15], [1.6, 0.7], [0.55, 0.9], [1.35, 1.05], [1.15, 1.55], [0.4, 1.7], [0.95, 1.85], [0.8, 2.3]], BRONZE, 14);
    pedestal.position.y = 0.5;
    g.add(pedestal);
    const angel = figure(2.5, BRONZE);
    angel.position.y = 2.85;
    g.add(angel);
    for (const a of [0.6, 2.2, 3.8, 5.4]) {
      const wing = box(1.5, 0.55, 0.08, BRONZE, Math.cos(a) * 0.7, 4.6, Math.sin(a) * 0.7);
      wing.rotation.y = -a;
      wing.rotation.z = 0.5;
      g.add(wing);
    }
    for (const a of [0, 1, 2, 3, 4, 5]) {
      const b = bench();
      b.position.set(Math.cos(a * 1.05) * 9.5, 0, Math.sin(a * 1.05) * 9.5 + 2);
      b.rotation.y = -a * 1.05 + Math.PI / 2;
      g.add(b);
    }
    return g;
  },

  // Bow Bridge: low cream cast-iron span over the Lake
  'bow-bridge': (ctx) => {
    const g = new THREE.Group();
    const CREAM = WHITE_LM;
    const span = 26, rise = 1.6;
    const y0 = ctx.groundAt(0, 0) - ctx.groundAt(0, 0); // deck reference (local 0)
    const segs = 16;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs - 0.5, t1 = (i + 1) / segs - 0.5;
      const x0 = t0 * span, x1 = t1 * span;
      const h0 = rise * (1 - (t0 * 2) ** 2), h1 = rise * (1 - (t1 * 2) ** 2);
      const deck = box(Math.hypot(x1 - x0, h1 - h0) + 0.05, 0.18, 3.6, CREAM, (x0 + x1) / 2, y0 + 1.2 + (h0 + h1) / 2, 0);
      deck.rotation.z = Math.atan2(h1 - h0, x1 - x0);
      g.add(deck);
      // railing posts + rail
      for (const zr of [-1.7, 1.7]) {
        g.add(cyl(0.05, 0.05, 0.95, CREAM, (x0 + x1) / 2, y0 + 1.75 + (h0 + h1) / 2, zr, 6));
        const rail = box(Math.hypot(x1 - x0, h1 - h0) + 0.05, 0.09, 0.09, CREAM, (x0 + x1) / 2, y0 + 2.25 + (h0 + h1) / 2, zr);
        rail.rotation.z = Math.atan2(h1 - h0, x1 - x0);
        g.add(rail);
      }
    }
    // arch soffit (underside curve) + abutments
    for (const sx of [-1, 1]) {
      g.add(box(2.6, 1.6, 4.4, GRANITE, sx * (span / 2 + 1.1), y0 + 0.8, 0));
    }
    const arc = lathe([[0.1, 0], [0.1, 0.1]], CREAM, 4); // placeholder-free tiny node to keep material present
    arc.visible = false;
    g.add(arc);
    return g;
  },

  // Belvedere Castle: schist mini-castle with a corner turret on Vista Rock
  belvedere: () => {
    const g = new THREE.Group();
    const SCHIST = DARKSTONE;
    g.add(box(10, 8, 8, SCHIST, 0, 4, 0));
    g.add(box(6, 3, 6, SCHIST, -1, 9.5, 0));
    // corner turret with conical cap
    const turret = cyl(2.2, 2.4, 13, SCHIST, 5.2, 6.5, 2.6, 12);
    g.add(turret);
    g.add(cyl(0.1, 2.7, 3.2, GRANITE, 5.2, 14.6, 2.6, 12));
    // crenellations
    for (let i = 0; i < 8; i++) {
      g.add(box(0.8, 0.7, 0.5, SCHIST, -4.5 + i * 1.3, 8.35, 3.8));
      g.add(box(0.8, 0.7, 0.5, SCHIST, -4.5 + i * 1.3, 8.35, -3.8));
    }
    // pointed-arch loggia windows
    const loggia = archWall(6, 3.4, 0.7, 1.5, 2.6, SCHIST);
    loggia.position.set(-1, 4, 4.05);
    g.add(loggia);
    // flag pole
    g.add(cyl(0.05, 0.05, 4.5, GRANITE, -1, 13.2, 0, 6));
    return g;
  },

  // Strawberry Fields: the Imagine mosaic set into the path
  'strawberry-fields': () => {
    const g = new THREE.Group();
    const tex = canvasTexture((c, w, h) => {
      c.fillStyle = '#d8d4c8';
      c.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      // radiating mosaic wedges
      for (let ring = 0; ring < 5; ring++) {
        const r0 = 22 + ring * 18, count = 18 + ring * 6;
        for (let i = 0; i < count; i++) {
          const a0 = (i / count) * Math.PI * 2, a1 = ((i + 0.82) / count) * Math.PI * 2;
          c.fillStyle = ring % 2 === 0 ? '#2b2b30' : '#c9c4b6';
          c.beginPath();
          c.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
          c.lineTo(cx + Math.cos(a1) * r0, cy + Math.sin(a1) * r0);
          c.lineTo(cx + Math.cos(a1) * (r0 + 14), cy + Math.sin(a1) * (r0 + 14));
          c.lineTo(cx + Math.cos(a0) * (r0 + 14), cy + Math.sin(a0) * (r0 + 14));
          c.closePath();
          c.fill();
        }
      }
      c.fillStyle = '#2b2b30';
      c.font = 'bold 26px Georgia, serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('IMAGINE', cx, cy);
    });
    const mosaic = new THREE.Mesh(new THREE.CircleGeometry(2.6, 24), new THREE.MeshLambertMaterial({ map: tex }));
    mosaic.rotation.x = -Math.PI / 2;
    mosaic.position.y = 0.04;
    g.add(mosaic);
    for (const a of [0.8, 2.4, 4.0, 5.6]) {
      const b = bench();
      b.position.set(Math.cos(a) * 5.5, 0, Math.sin(a) * 5.5);
      b.rotation.y = -a + Math.PI / 2;
      g.add(b);
    }
    return g;
  },

  // Reservoir south gatehouse + running-track rail
  'cp-reservoir': () => {
    const g = new THREE.Group();
    g.add(box(9, 6, 7, GRANITE, 0, 3, 0));
    g.add(box(9.6, 0.7, 7.6, LIMESTONE, 0, 6.35, 0));
    g.add(box(2.2, 3, 0.4, DARKSTONE, 0, 1.5, 3.55));
    // chain-link-ish rail along the running track
    for (let x = -22; x <= 22; x += 2.2) {
      g.add(cyl(0.045, 0.045, 1.25, DARKSTONE, x, 0.62, 6, 6));
    }
    g.add(box(45, 0.06, 0.06, DARKSTONE, 0, 1.22, 6));
    g.add(box(45, 0.05, 0.05, DARKSTONE, 0, 0.78, 6));
    return g;
  },

  // Zoo: sea lion pool with its four-clock Delacorte tower
  'cp-zoo': () => {
    const g = new THREE.Group();
    const pool = lathe([[5.4, 0], [5.6, 0.75], [5.2, 0.85]], GRANITE, 20);
    g.add(pool);
    const water = new THREE.Mesh(new THREE.CircleGeometry(5.1, 20), WATER_LM);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.65;
    g.add(water);
    const rock = box(2.4, 1.3, 1.8, DARKSTONE, 0, 1.1, 0);
    rock.rotation.y = 0.5;
    g.add(rock);
    // sea lion silhouettes
    for (const [sx, sz, a] of [[-0.6, 0.4, 0.6], [0.9, -0.5, -1.8]] as const) {
      const s = new THREE.Group();
      s.add(lathe([[0.1, 0], [0.34, 0.28], [0.2, 0.85], [0.1, 1.05]], DARKSTONE, 8));
      s.children[0].rotation.x = 1.1;
      s.position.set(sx, 1.85, sz);
      s.rotation.y = a;
      g.add(s);
    }
    // Delacorte clock tower: brick arch + verdigris crown of animals
    const t = new THREE.Group();
    t.add(box(3.2, 5.2, 2.2, BRICK_RED, 0, 2.6, 0));
    t.add(box(2.2, 1.4, 1.6, LIMESTONE, 0, 5.9, 0));
    const clock = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 1.7, 14), WHITE_LM);
    clock.rotation.x = Math.PI / 2;
    clock.position.set(0, 5.9, 0);
    t.add(clock);
    for (const a of [0, 1.57, 3.14, 4.71]) {
      const animal = figure(0.9, VERDIGRIS);
      animal.position.set(Math.cos(a) * 1.1, 6.7, Math.sin(a) * 1.1);
      t.add(animal);
    }
    t.add(cyl(0.5, 0.6, 0.9, VERDIGRIS, 0, 7.4, 0, 10));
    t.position.set(9.5, 0, -3);
    g.add(t);
    return g;
  },

  // The Mall: double row of elm-alley lamp posts + Shakespeare statue
  'the-mall': () => {
    const g = new THREE.Group();
    for (let z = -28; z <= 28; z += 8) {
      for (const x of [-4.5, 4.5]) {
        const lp = lampPost();
        lp.position.set(x, 0, z);
        g.add(lp);
      }
    }
    for (let z = -24; z <= 24; z += 12) {
      for (const x of [-3.4, 3.4]) {
        const b = bench();
        b.position.set(x, 0, z);
        b.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
        g.add(b);
      }
    }
    const ped = box(1.6, 2.4, 1.6, GRANITE, 0, 1.2, -32);
    g.add(ped);
    const bard = figure(2.2, BRONZE);
    bard.position.set(0, 2.4, -32);
    g.add(bard);
    return g;
  },

  // Tavern on the Green: low green-roofed pavilion + festoon courtyard
  'tavern-green': () => {
    const g = new THREE.Group();
    g.add(box(16, 4.5, 9, LIMESTONE, 0, 2.25, 0));
    const roof = box(17, 1.4, 10, GREEN_PATINA, 0, 5.4, 0);
    g.add(roof);
    g.add(box(5, 3.5, 5, LIMESTONE, 9.5, 1.75, 1));
    g.add(cyl(0.1, 3.6, 2.4, GREEN_PATINA, 9.5, 4.7, 1, 10));
    // courtyard string lights between poles
    const poles: THREE.Vector3[] = [];
    for (const [px, pz] of [[-6, 8], [0, 10], [6, 8], [-3, 13], [3, 13]] as const) {
      g.add(cyl(0.05, 0.06, 3.2, DARKSTONE, px, 1.6, pz, 6));
      poles.push(new THREE.Vector3(px, 3.2, pz));
    }
    for (let i = 0; i < poles.length - 1; i++) {
      g.add(strut(poles[i], poles[i + 1], 0.02, GOLD, 4));
    }
    for (let x = -5; x <= 5; x += 2.5) {
      g.add(cyl(0.5, 0.5, 0.04, WHITE_LM, x, 0.76, 10, 10));
      g.add(cyl(0.05, 0.05, 0.74, DARKSTONE, x, 0.38, 10, 6));
    }
    return g;
  },

  // Alice in Wonderland: bronze mushroom group
  alice: () => {
    const g = new THREE.Group();
    const base = lathe([[2.6, 0], [2.8, 0.35], [2.4, 0.5]], GRANITE, 16);
    g.add(base);
    const bigCap = lathe([[0, 0], [1.5, 0.12], [1.15, 0.6], [0.25, 0.75]], BRONZE, 14);
    bigCap.position.y = 1.5;
    g.add(bigCap);
    g.add(cyl(0.3, 0.42, 1.1, BRONZE, 0, 0.95, 0, 10));
    const alice = figure(1.5, BRONZE);
    alice.position.y = 2.2;
    g.add(alice);
    for (const [mx, mz, mr] of [[-1.7, 0.6, 0.55], [1.6, 0.8, 0.7], [0.9, -1.4, 0.5]] as const) {
      const cap = lathe([[0, 0], [mr, 0.1], [mr * 0.75, 0.35], [0.12, 0.45]], BRONZE, 10);
      cap.position.set(mx, 0.85, mz);
      g.add(cap);
      g.add(cyl(0.14, 0.2, 0.5, BRONZE, mx, 0.6, mz, 8));
      const critter = figure(0.8, BRONZE);
      critter.position.set(mx, 1.3, mz);
      g.add(critter);
    }
    return g;
  },

  // Conservatory Garden: parterre hedges, Untermyer fountain, pergola
  'conservatory-garden': () => {
    const g = new THREE.Group();
    const HEDGE = GREEN_PATINA;
    for (const zr of [-10, 10]) g.add(box(26, 1.0, 1.2, HEDGE, 0, 0.5, zr));
    for (const xr of [-13, 13]) g.add(box(1.2, 1.0, 21, HEDGE, xr, 0.5, 0));
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(22, 16), new THREE.MeshLambertMaterial({ color: '#4d7a3a' }));
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.y = 0.05;
    g.add(lawn);
    const basin = lathe([[2.6, 0], [2.75, 0.45], [2.45, 0.52]], GRANITE, 16);
    basin.position.set(0, 0, -6);
    g.add(basin);
    const w = new THREE.Mesh(new THREE.CircleGeometry(2.4, 16), WATER_LM);
    w.rotation.x = -Math.PI / 2;
    w.position.set(0, 0.4, -6);
    g.add(w);
    for (const a of [0, 2.09, 4.19]) {
      const d = figure(1.5, BRONZE);
      d.position.set(Math.cos(a) * 0.9, 0.5, -6 + Math.sin(a) * 0.9);
      g.add(d);
    }
    // wisteria pergola: two rows of slim columns with slatted roof
    const perg = new THREE.Group();
    perg.add(colonnade(7, 2.4, 0.14, 3.0, LIMESTONE));
    const backRow = colonnade(7, 2.4, 0.14, 3.0, LIMESTONE);
    backRow.position.z = -2.4;
    perg.add(backRow);
    for (let x = -7.5; x <= 7.5; x += 1.1) perg.add(box(0.14, 0.1, 3.4, DARKSTONE, x, 3.25, -1.2));
    perg.position.set(0, 0, 9);
    g.add(perg);
    return g;
  },

  // Harlem Meer: Dana Center dock rail + rowboat
  'harlem-meer': () => {
    const g = new THREE.Group();
    g.add(box(8, 0.35, 5, DARKSTONE, 0, 0.35, 0));
    for (const [px, pz] of [[-3.6, -2.2], [3.6, -2.2], [-3.6, 2.2], [3.6, 2.2]] as const) {
      g.add(cyl(0.09, 0.11, 1.0, DARKSTONE, px, 0.9, pz, 6));
    }
    for (const zr of [-2.2, 2.2]) g.add(box(7.4, 0.07, 0.07, DARKSTONE, 0, 1.35, zr));
    const boat = new THREE.Group();
    const hull = lathe([[0, 0], [0.75, 0.18], [0.85, 0.5]], BRICK_RED, 10);
    hull.scale.set(1, 1, 2.2);
    boat.add(hull);
    boat.position.set(2.5, 0.15, 5.5);
    boat.rotation.y = 0.7;
    g.add(boat);
    for (const a of [1.2, 2.6]) {
      const b = bench();
      b.position.set(Math.cos(a) * 6, 0, -3 - Math.sin(a) * 2);
      g.add(b);
    }
    return g;
  },
};
