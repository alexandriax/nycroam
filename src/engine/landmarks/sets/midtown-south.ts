import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, GOLD, STEEL_LM, GLASS_LM, WHITE_LM,
  WATER_LM, GREEN_PATINA,
  box, cyl, strut, colonnade, lathe, figure, twoSidedPanel,
  billboardTexture, billboardMaterial,
} from '../kit';

/**
 * Midtown South set — Empire State crown, NYPL, Bryant Park, MSG, Times Square,
 * the theater district. Each builder returns a group whose origin sits at
 * ground level; the manager rotates/positions/merges it. Several of these
 * landmarks (Empire State shaft, MSG bowl) already exist from OSM — those
 * builders add only the signature crown/skin that OSM lacks.
 */

// Reclining marble lion (Patience / Fortitude) on a granite plinth, facing +z.
function lion(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.4, 1.4, 5.4, GRANITE, 0, 0.7, 0)); // plinth
  g.add(box(1.3, 1.05, 3.2, MARBLE, 0, 2.0, -0.4)); // body
  const haunch = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), MARBLE);
  haunch.position.set(0, 2.05, -1.7);
  g.add(haunch); // rear haunch
  g.add(box(1.25, 0.95, 1.0, MARBLE, 0, 1.95, 1.15)); // chest
  for (const px of [-0.38, 0.38]) g.add(box(0.36, 0.32, 1.7, MARBLE, px, 1.55, 2.15)); // outstretched forepaws
  const mane = new THREE.Mesh(new THREE.SphereGeometry(0.72, 10, 8), MARBLE);
  mane.position.set(0, 2.55, 1.5);
  g.add(mane); // maned head
  g.add(box(0.5, 0.5, 0.6, MARBLE, 0, 2.5, 2.05)); // muzzle
  return g;
}

// Green cast-iron café chair (Bryant Park's famous folding chairs).
function bistroChair(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.22, 0.22, 0.04, GREEN_PATINA, 0, 0.45, 0, 8)); // seat
  for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const)
    g.add(cyl(0.02, 0.02, 0.45, GREEN_PATINA, lx, 0.225, lz, 5)); // legs
  g.add(box(0.42, 0.4, 0.03, GREEN_PATINA, 0, 0.66, -0.2)); // backrest
  return g;
}

// Small round green café table.
function bistroTable(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.36, 0.36, 0.03, GREEN_PATINA, 0, 0.7, 0, 10)); // top
  g.add(cyl(0.03, 0.04, 0.7, GREEN_PATINA, 0, 0.35, 0, 6)); // stem
  g.add(cyl(0.18, 0.18, 0.03, GREEN_PATINA, 0, 0.02, 0, 8)); // foot
  return g;
}

// Terrace lamp post with a white globe.
function lampPost(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.06, 0.09, 4.0, DARKSTONE, 0, 2.0, 0, 8));
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), WHITE_LM);
  globe.position.y = 4.2;
  g.add(globe);
  return g;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Empire State: art-deco crown + dirigible mast only (OSM builds the shaft below y=373)
  'empire-state': (ctx) => {
    // ESB crown: OSM masses the tower to its 330m upper roof plus two crude
    // stick parts for the mast — the pipeline clears the sticks and we build
    // the art-deco drum + dirigible mast from the measured roof up.
    const g = new THREE.Group();
    const roof = ctx.fit?.keptH ?? 373;
    const tip = ctx.fit?.roofH ?? roof + 70; // OSM's cleared mast reached here
    for (const [i, [r, h]] of ([[8.5, 8], [6.5, 7], [4.8, 7]] as const).entries()) {
      const yb = roof + [0, 8, 15][i];
      g.add(cyl(r * 0.82, r, h, LIMESTONE, 0, yb + h / 2, 0, 12));
    }
    const mastBase = roof + 22;
    g.add(cyl(1.6, 2.6, (tip - 12) - mastBase, STEEL_LM, 0, (mastBase + tip - 12) / 2, 0, 8));
    g.add(cyl(0.12, 0.7, 12, STEEL_LM, 0, tip - 6, 0, 6)); // antenna
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      g.add(box(1.4, 6, 1.4, LIMESTONE, sx * 9.5, roof + 3, sz * 9.5)); // corner setback piers
    }
    // warm observation-deck glow band just below the drum
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(11.5, 11.5, 1.6, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffd9a0' }),
    );
    glow.position.y = roof - 4;
    g.add(glow);
    return g;
  },

  // NYPL main branch: marble Beaux-Arts portico, grand stair, Patience & Fortitude
  'nypl': () => {
    const g = new THREE.Group();
    // podium the portico stands on (terrace top at y=3)
    g.add(box(46, 3, 22, MARBLE, 0, 1.5, -6));
    // main facade wall behind the colonnade
    g.add(box(40, 17, 4, MARBLE, 0, 11.5, -6));
    // six-column Corinthian portico
    const cols = colonnade(6, 6, 0.95, 12, MARBLE, 3);
    cols.position.z = -1;
    g.add(cols);
    // entablature + attic story crowned with allegorical figures
    g.add(box(42, 3, 5, MARBLE, 0, 16.5, -3.5));
    g.add(box(40, 3.5, 4, MARBLE, 0, 19.7, -4.5));
    for (const fx of [-16, -8, 0, 8, 16]) {
      const f = figure(3, MARBLE);
      f.position.set(fx, 21.4, -4.5);
      g.add(f);
    }
    // grand staircase cascading to the street (+z)
    for (let i = 0; i < 12; i++) g.add(box(34, 0.28, 0.95, GRANITE, 0, 2.86 - i * 0.25, 1 + i * 0.9));
    for (const cx of [-17.6, 17.6]) g.add(box(1.4, 3.2, 12, MARBLE, cx, 1.6, 6)); // stair cheeks
    // the two lions flanking the steps, facing the avenue
    for (const lx of [-19.5, 19.5]) {
      const l = lion();
      l.position.set(lx, 0, 10.5);
      g.add(l);
    }
    return g;
  },

  // Bryant Park: great lawn, gravel terraces, Lowell fountain, café chairs, lamps
  'bryant-park': () => {
    const g = new THREE.Group();
    const GRAVEL = new THREE.MeshLambertMaterial({ color: '#c2b49a' });
    const LAWN = new THREE.MeshLambertMaterial({ color: '#4d7a3a' });
    const PINK_GRANITE = new THREE.MeshLambertMaterial({ color: '#b28a80' });
    // gravel border paths (wider base) with the great lawn floated on top
    const gravel = new THREE.Mesh(new THREE.PlaneGeometry(70, 50), GRAVEL);
    gravel.rotation.x = -Math.PI / 2;
    gravel.position.y = 0.02;
    g.add(gravel);
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), LAWN);
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.y = 0.04;
    g.add(lawn);
    // Josephine Shaw Lowell memorial fountain at the west terrace
    const basin = lathe(
      [[2.6, 0], [2.8, 0.5], [2.5, 0.6], [0.5, 0.72], [0.7, 1.5], [1.5, 1.75], [1.3, 1.95], [0.2, 2.05]],
      PINK_GRANITE, 16,
    );
    basin.position.set(-26, 0, 0);
    g.add(basin);
    const fwater = new THREE.Mesh(new THREE.CircleGeometry(2.4, 16), WATER_LM);
    fwater.rotation.x = -Math.PI / 2;
    fwater.position.set(-26, 0.55, 0);
    g.add(fwater);
    // two rows of lamp posts along the north/south terraces
    for (const zr of [-22, 22]) for (let x = -28; x <= 28; x += 8) {
      const lp = lampPost();
      lp.position.set(x, 0, zr);
      g.add(lp);
    }
    // café chairs + tables scattered across the gravel terraces
    for (const [cx, cz, ry] of [[-8, 22.5, 0.6], [-2, 23, 2.1], [6, 22, 1.2], [12, 23.5, 3.4], [-32, 6, 0.3], [32, -6, 5.0]] as const) {
      const c = bistroChair();
      c.position.set(cx, 0, cz);
      c.rotation.y = ry;
      g.add(c);
    }
    for (const [tx, tz] of [[-5, 22.8], [9, 22.8], [32, 0]] as const) {
      const t = bistroTable();
      t.position.set(tx, 0, tz);
      g.add(t);
    }
    return g;
  },

  // Madison Square Garden: signature ribbed white drum + cable-stayed roof ring (wraps OSM)
  'msg': () => {
    const g = new THREE.Group();
    const R = 65;
    // hollow ribbed band from y=20 to y=35 — no cap, so it sleeves whatever OSM has
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 15, 16, 1, true), WHITE_LM);
    drum.position.y = 27.5;
    g.add(drum);
    // alternating thin vertical ribs around the facade
    const ribs = 36;
    for (let i = 0; i < ribs; i++) {
      const a = (i / ribs) * Math.PI * 2;
      const rib = box(0.6, 15, 1.0, WHITE_LM, Math.cos(a) * (R + 0.4), 27.5, Math.sin(a) * (R + 0.4));
      rib.rotation.y = -a;
      g.add(rib);
    }
    // roof edge ring + lifted tension ring joined by radial cables (center stays open)
    const outer = new THREE.Mesh(new THREE.TorusGeometry(R, 1.2, 6, 16), STEEL_LM);
    outer.rotation.x = Math.PI / 2;
    outer.position.y = 35;
    g.add(outer);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(44, 0.8, 6, 14), STEEL_LM);
    inner.rotation.x = Math.PI / 2;
    inner.position.y = 38.5;
    g.add(inner);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      g.add(strut(
        new THREE.Vector3(Math.cos(a) * R, 35, Math.sin(a) * R),
        new THREE.Vector3(Math.cos(a) * 44, 38.5, Math.sin(a) * 44),
        0.15, STEEL_LM, 4,
      ));
    }
    return g;
  },

  // Times Square: billboard-stack canyon, a curved wrap screen, the red TKTS steps
  'times-square': (ctx) => {
    const g = new THREE.Group();
    const DARK_STEEL = new THREE.MeshStandardMaterial({ color: '#26292d', metalness: 0.6, roughness: 0.5 });
    const TKTS_RED = new THREE.MeshStandardMaterial({ color: '#c1121f', roughness: 0.15, emissive: '#6b0000', transparent: true, opacity: 0.55 });
    let seed = 1;
    // a dark-steel frame carrying n stacked abstract billboard panels facing the canyon
    const signStack = (x: number, z: number, faceX: number, panelW: number, top: number, n: number) => {
      const s = new THREE.Group();
      s.add(box(1.2, top, 1.2, DARK_STEEL, 0, top / 2, 0)); // mast
      s.add(box(panelW + 1.5, 1.2, 1.2, DARK_STEEL, 0, top - 1, 0)); // crossbeam
      const panelH = (top - 8) / n;
      for (let i = 0; i < n; i++) {
        const py = 8 + panelH * (i + 0.5);
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH * 0.9), billboardMaterial(seed++));
        panel.position.set(faceX * 0.7, py, 0);
        panel.rotation.y = faceX < 0 ? -Math.PI / 2 : Math.PI / 2; // face inward across the avenue
        panel.rotation.z = Math.sin(seed * 12.9) * 0.05; // slight tilt
        s.add(panel);
        s.add(box(panelW + 0.4, 0.3, 0.4, DARK_STEEL, faceX * 0.6, py - panelH * 0.46, 0)); // panel ledge
      }
      s.position.set(x, 0, z);
      return s;
    };
    // A dense two-sided billboard canyon — real Times Square is wall-to-wall
    // spectaculars. The tall masts march up both avenue walls at ~3x the former
    // density; heights/widths/counts vary per index (deterministic), and a
    // low tier of projecting panels fills the gaps just above street level.
    for (const side of [1, -1] as const) {
      const wallX = side === 1 ? -38 : 39;
      let k = 0;
      for (let z = -60; z <= 62; z += 12.5, k++) {
        const top = 22 + ((k * 7) % 16);     // 22..37 m
        const panelW = 10 + ((k * 5) % 7);   // 10..16 m
        const n = 2 + (k % 3);               // 2..4 stacked panels
        const depth = (k % 2) * 2.4;         // stagger so planes don't co-merge
        const [cx, cz] = ctx.clearRoad(wallX + side * depth, z, 1.6);
        g.add(signStack(cx, cz, side, panelW, top, n));
      }
    }
    for (const side of [1, -1] as const) {
      const wallX = side === 1 ? -33 : 34;
      let k = 0;
      for (let z = -54; z <= 58; z += 15, k++) {
        const pw = 7 + ((k * 3) % 5);
        const ph = 4 + (k % 3);
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), billboardMaterial(seed++));
        const [px2, pz2] = ctx.clearRoad(wallX, z, 1.2);
        panel.position.set(px2, 4 + (k % 2) * 3.6, pz2);
        panel.rotation.y = side === 1 ? Math.PI / 2 : -Math.PI / 2;
        g.add(panel);
      }
    }
    // one giant curved wrap screen at the south point of the bowtie
    const wrap = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 12, 12, 12, 1, true, Math.PI / 2 - 0.85, 1.7),
      billboardMaterial(seed++),
    );
    wrap.position.set(0, 24, -58);
    g.add(wrap);
    // TKTS translucent-red glass steps at the north end, with a glass parapet
    for (let i = 0; i < 12; i++) g.add(box(15, 0.6, 0.95, TKTS_RED, 0, 0.3 + i * 0.55, 50 + i * 0.9));
    g.add(box(15, 1.1, 0.12, GLASS_LM, 0, 7.3, 60)); // parapet
    return g;
  },

  // Broadway theaters: three projecting marquees, blade signs, street-level poster cases
  'broadway-theaters': () => {
    const g = new THREE.Group();
    const WARM = new THREE.MeshBasicMaterial({ color: '#ffedc2' }); // marquee underside glow
    let seed = 200;
    // theater block facade + cornice
    g.add(box(42, 16, 2, LIMESTONE, 0, 8, -1));
    g.add(box(42, 1.2, 3, DARKSTONE, 0, 15.5, -0.5));
    // a projecting marquee: dark canopy, warm underside, gold-framed abstract poster fascia
    const marquee = (x: number) => {
      const m = new THREE.Group();
      m.add(box(8, 0.9, 3.2, DARKSTONE, 0, 5.8, 1.6)); // canopy box
      const under = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 2.9), WARM);
      under.rotation.x = Math.PI / 2; // face down
      under.position.set(0, 5.34, 1.6);
      m.add(under);
      m.add(strut(new THREE.Vector3(-3, 6.2, 3.0), new THREE.Vector3(-3, 9, 0), 0.06, GOLD, 5)); // tie rods
      m.add(strut(new THREE.Vector3(3, 6.2, 3.0), new THREE.Vector3(3, 9, 0), 0.06, GOLD, 5));
      m.add(box(8.2, 1.8, 0.15, GOLD, 0, 6.7, 3.15)); // fascia frame
      const poster = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 1.3), billboardMaterial(seed++));
      poster.position.set(0, 6.7, 3.24);
      m.add(poster);
      m.position.x = x;
      return m;
    };
    for (const mx of [-13, 0, 13]) g.add(marquee(mx));
    // vertical blade signs (two-sided abstract panels) between the marquees
    for (const bx of [-6.5, 6.5]) {
      g.add(box(0.6, 9, 1.4, DARKSTONE, bx, 10.5, 1.2)); // blade mast
      const blade = twoSidedPanel(billboardTexture(seed++), 1.3, 6.5);
      blade.rotation.y = Math.PI / 2; // faces up/down the street
      blade.position.set(bx, 11, 1.9);
      g.add(blade);
    }
    // row of gold-framed poster cases at street level
    for (const px of [-18, -15, -6, -3, 6, 9, 16, 19]) {
      g.add(box(1.5, 2.4, 0.12, GOLD, px, 2.6, 0.05));
      const pc = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 2.0), billboardMaterial(seed++));
      pc.position.set(px, 2.6, 0.14);
      g.add(pc);
    }
    return g;
  },
};
