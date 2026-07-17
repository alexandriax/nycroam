import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRONZE, GOLD, STEEL_LM, GLASS_LM,
  WATER_LM, GREEN_PATINA,
  box, cyl, strut, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Rockefeller Center / Fifth Avenue set. Every builder returns a group whose
 * origin sits at ground level at the registry position; the manager rotates,
 * positions and merges it per material. +z is the avenue-facing front.
 */

// varied solid flag colours (no emblems), shared across the flag builders
const FLAG_COLORS = ['#c0392b', '#2471a3', '#27ae60', '#f1c40f', '#e67e22', '#8e44ad', '#17a589', '#ecf0f1']
  .map((c) => new THREE.MeshLambertMaterial({ color: c }));
// glossy pop-art red for the LOVE letterforms (local per spec)
const LOVE_RED = new THREE.MeshStandardMaterial({ color: '#d1202a', roughness: 0.3 });
// deep Radio City marquee red
const RADIO_RED = new THREE.MeshStandardMaterial({ color: '#7d1620', roughness: 0.45, metalness: 0.1 });
// lightened warm terracotta brick for Carnegie Hall
const TERRACOTTA = new THREE.MeshLambertMaterial({ color: '#b06a4f' });
// ice-white rink surface (Rockefeller Plaza)
const ICE_WHITE = new THREE.MeshLambertMaterial({ color: '#e8edf2' });

/** Thin two-sided solid-colour flag jutting +x from a vertical pole. */
function flagpole(h: number, flagMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.06, 0.08, h, GRANITE, 0, h / 2, 0, 6));
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), GOLD);
  finial.position.y = h;
  g.add(finial);
  g.add(box(1.7, 1.05, 0.05, flagMat, 0.95, h - 0.75, 0)); // flag (both faces read)
  return g;
}

/** Low granite planter that doubles as a bench. */
function planterBench(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(3.2, 0.7, 1.4, GRANITE, 0, 0.35, 0));
  g.add(box(3.0, 0.22, 1.2, GREEN_PATINA, 0, 0.8, 0)); // greenery
  g.add(box(1.7, 0.12, 1.4, GRANITE, 2.3, 0.72, 0)); // seat slab
  return g;
}

/** Radial stained-glass rose window (rich blues/reds, stone tracery). */
function roseTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    const cx = w / 2, cy = h / 2;
    c.fillStyle = '#0b1a3a';
    c.fillRect(0, 0, w, h);
    const petals = 12;
    for (let ring = 3; ring >= 0; ring--) {
      const r = ((ring + 1) / 4) * (w * 0.46);
      for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2 + ring * 0.2;
        c.fillStyle = (i + ring) % 2 === 0 ? (ring % 2 === 0 ? '#c0392b' : '#e74c3c') : (ring % 2 === 0 ? '#2471a3' : '#5dade2');
        c.beginPath();
        c.moveTo(cx, cy);
        c.arc(cx, cy, r, a - 0.22, a + 0.22);
        c.closePath();
        c.fill();
      }
      c.strokeStyle = '#d9d2c0';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = '#e4c14a';
    c.beginPath();
    c.arc(cx, cy, w * 0.07, 0, Math.PI * 2);
    c.fill();
  }, 256, 256);
}

/** Abstract neon marquee blade: stacked red/blue bars, no letters. */
function neonTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    c.fillStyle = '#14060a';
    c.fillRect(0, 0, w, h);
    const bars = 14;
    for (let i = 0; i < bars; i++) {
      const y = (i / bars) * h;
      c.fillStyle = i % 2 === 0 ? '#ff2d55' : '#2d6cff';
      c.fillRect(w * 0.18, y + h * 0.015, w * 0.64, (h / bars) * 0.6);
      c.fillStyle = i % 2 === 0 ? '#ff9db1' : '#9dbcff';
      c.fillRect(w * 0.18, y + h * 0.015, w * 0.64, (h / bars) * 0.18);
    }
    c.fillStyle = '#fff2c4';
    c.fillRect(w * 0.08, 0, w * 0.05, h);
    c.fillRect(w * 0.87, 0, w * 0.05, h);
  }, 96, 256);
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Sunken rink court (ice floor), gilt Prometheus against the west wall, Channel Gardens running to 5th Ave (+x)
  'rockefeller-plaza': () => {
    const g = new THREE.Group();
    // 1. sunken rink court (26 x 18, floor 3.5m below grade) — granite retaining walls, ice-white floor
    g.add(box(26, 0.3, 18, ICE_WHITE, 0, -3.65, 0));
    g.add(box(0.6, 3.5, 18, GRANITE, -13, -1.75, 0)); // west wall (Prometheus side)
    g.add(box(0.6, 3.5, 18, GRANITE, 13, -1.75, 0)); // east wall
    g.add(box(26, 3.5, 0.6, GRANITE, 0, -1.75, 9)); // south wall (toward W 49th St)
    g.add(box(26, 3.5, 0.6, GRANITE, 0, -1.75, -9)); // north wall (toward W 50th St)
    // thin gold rim rail ringing the rink edge at grade
    g.add(box(26.3, 0.15, 0.15, GOLD, 0, 0.08, 9));
    g.add(box(26.3, 0.15, 0.15, GOLD, 0, 0.08, -9));
    g.add(box(0.15, 0.15, 18.3, GOLD, 13, 0.08, 0));
    g.add(box(0.15, 0.15, 18.3, GOLD, -13, 0.08, 0));

    // 2. gilt Prometheus reclining against the west (-x) waterfall wall, facing +x toward 5th Ave
    g.add(box(0.1, 3.2, 16, WATER_LM, -12.6, -1.9, 0)); // waterfall sheet down the west retaining wall
    g.add(box(5, 0.2, 16, WATER_LM, -10.5, -3.4, 0)); // small pool at his base, on the court floor
    const zodiac = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.13, 6, 22), GOLD);
    zodiac.rotation.y = Math.PI / 2; // hoop faces +x, behind the figure
    zodiac.position.set(-11.7, -1.2, 0);
    g.add(zodiac);
    g.add(box(5.6, 0.3, 3, DARKSTONE, -9.8, -1.4, 0)); // dark plinth
    const prom = figure(3.4, GOLD);
    prom.rotation.z = -Math.PI / 2; // lay flat, head-to-foot along +x (facing 5th Ave)
    prom.rotation.y = 0.12; // slight reclining twist
    prom.position.set(-9.6, -1.2, 0);
    g.add(prom);

    // 4. flag ring around the rink rim — 16 poles, varied solid-colour flags
    let fi = 0;
    for (const x of [-12, -6, 0, 6, 12]) { const p = flagpole(7.5, FLAG_COLORS[fi++ % FLAG_COLORS.length]); p.position.set(x, 0, 10.5); g.add(p); }
    for (const x of [-12, -6, 0, 6, 12]) { const p = flagpole(7.5, FLAG_COLORS[fi++ % FLAG_COLORS.length]); p.position.set(x, 0, -10.5); g.add(p); }
    for (const z of [-6, 0, 6]) { const p = flagpole(7.5, FLAG_COLORS[fi++ % FLAG_COLORS.length]); p.position.set(14.5, 0, z); g.add(p); }
    for (const z of [-6, 0, 6]) { const p = flagpole(7.5, FLAG_COLORS[fi++ % FLAG_COLORS.length]); p.position.set(-14.5, 0, z); g.add(p); }

    // 5. upper-plaza paving frame around the rim + a wide apron connecting the rink to the gardens
    g.add(box(29, 0.1, 3, GRANITE, 0, 0.02, 10.5));
    g.add(box(29, 0.1, 3, GRANITE, 0, 0.02, -10.5));
    g.add(box(2.8, 0.1, 21, GRANITE, -14.4, 0.02, 0));
    g.add(box(2, 0.1, 21, GRANITE, 14, 0.02, 0)); // apron, rink rim (x=13) to the gardens (x=15)

    // 3. Channel Gardens toward +x (5th Ave): six fountain basins between two continuous planters
    g.add(box(37, 0.08, 14, GRANITE, 33.5, 0.04, 0)); // paved band under the whole strip
    for (const pz of [-6, 6]) {
      g.add(box(37, 0.5, 1.7, GRANITE, 33.5, 0.25, pz)); // planter curb
      g.add(box(36.6, 0.22, 1.4, GREEN_PATINA, 33.5, 0.61, pz)); // planting
    }
    for (let i = 0; i < 6; i++) {
      const bx = 18 + i * 6.2;
      g.add(box(3.5, 0.35, 2.4, GRANITE, bx, 0.175, 0)); // fountain basin
      g.add(box(3.2, 0.06, 2.1, WATER_LM, bx, 0.36, 0)); // water top
    }
    // 6. small bronze fountainhead tridents at the garden's 5th Ave end
    for (const tz of [-2.2, 2.2]) {
      g.add(cyl(0.05, 0.06, 1.0, BRONZE, 51, 0.5, tz, 6));
      g.add(strut(new THREE.Vector3(51 - 0.35, 1.0, tz), new THREE.Vector3(51 + 0.35, 1.0, tz), 0.04, BRONZE));
    }
    return g;
  },

  // Bronze Atlas kneeling, hoisting an open armillary sphere on a granite plinth
  atlas: () => {
    const g = new THREE.Group();
    // stepped granite plinth (~3m)
    g.add(box(6.5, 0.8, 6.5, GRANITE, 0, 0.4, 0));
    g.add(box(4.4, 3.0, 4.4, GRANITE, 0, 2.3, 0));
    const y0 = 3.8; // plinth top
    // muscular bronze figure in a kneeling stance
    g.add(box(1.1, 0.6, 0.8, BRONZE, 0, y0 + 0.9, 0)); // pelvis
    const torso = box(1.1, 1.9, 0.7, BRONZE, 0, y0 + 2.0, -0.15);
    torso.rotation.x = 0.2;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 7), BRONZE);
    head.position.set(0, y0 + 3.2, -0.25);
    g.add(head);
    // legs: one braced forward, one kneeling back
    g.add(strut(new THREE.Vector3(-0.45, y0 + 0.7, 0.1), new THREE.Vector3(-0.65, y0 + 0.15, 0.9), 0.27, BRONZE));
    g.add(strut(new THREE.Vector3(-0.65, y0 + 0.15, 0.9), new THREE.Vector3(-0.65, y0 + 0.05, 1.5), 0.24, BRONZE));
    g.add(strut(new THREE.Vector3(0.45, y0 + 0.7, 0.1), new THREE.Vector3(0.65, y0 + 0.2, -0.5), 0.27, BRONZE));
    g.add(strut(new THREE.Vector3(0.65, y0 + 0.2, -0.5), new THREE.Vector3(0.65, y0 + 0.05, -1.2), 0.24, BRONZE));
    // arms raised to the sphere's underside
    g.add(strut(new THREE.Vector3(-0.5, y0 + 2.7, -0.1), new THREE.Vector3(-1.0, y0 + 4.4, 0.3), 0.22, BRONZE));
    g.add(strut(new THREE.Vector3(0.5, y0 + 2.7, -0.1), new THREE.Vector3(1.0, y0 + 4.4, 0.3), 0.22, BRONZE));
    // open armillary sphere: three crossing bronze rings (r=3.5) on a tilted axis
    const C = new THREE.Vector3(0, y0 + 7.9, 0.2);
    const eq = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.1, 6, 18), BRONZE);
    eq.rotation.x = Math.PI / 2; eq.position.copy(C); g.add(eq);
    const m1 = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.1, 6, 18), BRONZE);
    m1.position.copy(C); g.add(m1);
    const m2 = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.1, 6, 18), BRONZE);
    m2.rotation.y = Math.PI / 2; m2.position.copy(C); g.add(m2);
    const axis = cyl(0.08, 0.08, 8, BRONZE, C.x, C.y, C.z, 6);
    axis.rotation.x = 0.4; g.add(axis);
    return g;
  },

  // Top of the Rock: 30 Rock's summit only — stepped decks + art-deco crown fins at y259
  'top-of-the-rock': () => {
    const g = new THREE.Group();
    // three tiered observation slabs with glass parapet walls
    const decks: [number, number, number][] = [[46, 22, 259.5], [38, 17, 263.4], [30, 13, 267.2]];
    for (const [w, d, y] of decks) {
      g.add(box(w, 1.0, d, LIMESTONE, 0, y, 0));
      g.add(box(w, 1.3, 0.25, GLASS_LM, 0, y + 1.1, d / 2));
      g.add(box(w, 1.3, 0.25, GLASS_LM, 0, y + 1.1, -d / 2));
      g.add(box(0.25, 1.3, d, GLASS_LM, w / 2, y + 1.1, 0));
      g.add(box(0.25, 1.3, d, GLASS_LM, -w / 2, y + 1.1, 0));
    }
    // crown mass on the top setback with stepped art-deco limestone fins
    const cy = 268;
    g.add(box(24, 12, 9, LIMESTONE, 0, cy + 6, -1));
    for (let i = 0; i < 11; i++) {
      const x = -10 + i * 2;
      const fh = 6 + (5 - Math.abs(i - 5)) * 1.3;
      g.add(box(1.1, fh, 0.8, LIMESTONE, x, cy + fh / 2, 4.2));
    }
    for (let i = 0; i < 5; i++) {
      const z = -4 + i * 2;
      const fh = 5 + i * 0.4;
      g.add(box(0.8, fh, 1.1, LIMESTONE, 12.5, cy + fh / 2, z));
      g.add(box(0.8, fh, 1.1, LIMESTONE, -12.5, cy + fh / 2, z));
    }
    return g;
  },

  // St. Patrick's: twin marble spires to 100m, rose window in a pointed arch, triple portals
  'st-patricks': () => {
    const g = new THREE.Group();
    // nave body behind the west front
    g.add(box(20, 26, 50, MARBLE, 0, 13, -18));
    g.add(box(20, 3, 50, MARBLE, 0, 27.5, -18)); // roof band
    // twin square towers rising to octagonal openwork spires (~100m)
    for (const sx of [-12, 12]) {
      g.add(box(9, 52, 9, MARBLE, sx, 26, 7));
      g.add(cyl(0.4, 4.4, 46, MARBLE, sx, 75, 7, 8)); // spire
      for (const [px, pz] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]] as const)
        g.add(cyl(0.05, 0.55, 4, MARBLE, sx + px, 54, 7 + pz, 4)); // base pinnacles
    }
    // west facade backing wall between the towers
    g.add(box(16, 30, 1.2, MARBLE, 0, 15, 8.0));
    // rose window (stained glass) set into a pointed-arch surround
    const roseArch = archWall(15, 17, 0.6, 9, 13.5, MARBLE);
    roseArch.position.set(0, 12, 8.9);
    g.add(roseArch);
    const rose = new THREE.Mesh(new THREE.CircleGeometry(4.2, 24), new THREE.MeshBasicMaterial({ map: roseTexture() }));
    rose.position.set(0, 21, 9.05);
    g.add(rose);
    // triple pointed-arch portals with dark recesses
    for (const px of [-5, 0, 5]) {
      const p = archWall(4.6, 9, 0.7, 2.6, 7, MARBLE);
      p.position.set(px, 0, 9.1);
      g.add(p);
      g.add(box(2.4, 6.8, 0.3, DARKSTONE, px, 3.6, 8.7));
    }
    // pointed gable peak above the rose
    for (const s of [-1, 1]) {
      const gb = box(0.9, 12, 1.0, MARBLE, s * 4.2, 33, 8.2);
      gb.rotation.z = s * 0.6;
      g.add(gb);
    }
    // pinnacles marching along the nave sides
    for (let z = 4; z >= -40; z -= 8) for (const sx of [-10.5, 10.5]) {
      g.add(box(0.9, 0.9, 0.9, MARBLE, sx, 26.5, z));
      g.add(cyl(0.05, 0.55, 3.2, MARBLE, sx, 28.6, z, 4));
    }
    return g;
  },

  // Radio City: rounded corner marquee (red+gold, warm underside), neon blades, stage-door arches
  'radio-city': () => {
    const g = new THREE.Group();
    // dark granite facade block (two street faces meet at the +x/+z corner)
    g.add(box(30, 20, 22, DARKSTONE, -3, 10, -3));
    // three tall stage-door arches on the +z front
    for (const px of [-9, -3, 3]) {
      const a = archWall(5, 12, 0.8, 3, 9, DARKSTONE);
      a.position.set(px, 0, 8.2);
      g.add(a);
      g.add(box(2.8, 9, 0.3, GRANITE, px, 4.6, 7.9));
    }
    const NEON = new THREE.MeshBasicMaterial({ map: neonTexture() });
    const GLOW = new THREE.MeshBasicMaterial({ color: '#ffcda1' });
    // horizontal marquee band wrapping the rounded corner
    g.add(box(26, 1.7, 2.6, RADIO_RED, 0, 6.4, 9.1)); // front band
    g.add(box(2.6, 1.7, 20, RADIO_RED, 13.1, 6.4, -3)); // side band
    g.add(cyl(2.3, 2.3, 1.7, RADIO_RED, 12, 6.4, 8, 12)); // rounded corner
    g.add(box(25, 0.28, 0.22, GOLD, 0, 5.5, 10.3)); // gold trim front
    g.add(box(0.22, 0.28, 19, GOLD, 14.3, 5.5, -3)); // gold trim side
    g.add(box(24.5, 0.12, 2.3, GLOW, 0, 5.55, 9.0)); // warm underside front
    g.add(box(2.3, 0.12, 19, GLOW, 13.1, 5.55, -3)); // warm underside side
    // great vertical neon blades on both faces
    g.add(box(2.4, 15, 0.7, NEON, 7.5, 15, 8.7)); // front blade
    g.add(box(0.7, 15, 2.4, NEON, 12.7, 15, 2.5)); // side blade
    return g;
  },

  // MoMA 53rd St front: dark glass curtain slab, marble ends, street canopy, sculpture garden
  moma: () => {
    const g = new THREE.Group();
    // eight-storey dark glass curtain slab
    g.add(box(40, 34, 3, GLASS_LM, 0, 17, 0));
    // dark mullion grid over the front
    for (let x = -18; x <= 18; x += 4) g.add(box(0.22, 34, 0.3, DARKSTONE, x, 17, 1.6));
    for (let y = 2; y <= 34; y += 4.2) g.add(box(40, 0.28, 0.3, DARKSTONE, 0, y, 1.6));
    // white marble end walls
    for (const sx of [-21.5, 21.5]) g.add(box(3, 36, 9, MARBLE, sx, 18, 0));
    // wide street-level glass canopy on thin steels
    g.add(box(22, 0.3, 6, GLASS_LM, 0, 5, 5));
    for (const cxp of [-9, -3, 3, 9]) g.add(cyl(0.12, 0.12, 5, STEEL_LM, cxp, 2.5, 7.6, 8));
    // sculpture-garden peek behind a low wall at +x
    g.add(box(1.0, 2.2, 20, MARBLE, 24, 1.1, -2));
    const blob = lathe([[0, 0], [1.3, 0.4], [1.7, 1.2], [1.1, 2.0], [1.5, 2.5], [0.5, 3.0]], BRONZE, 12);
    blob.position.set(28, 0, -8);
    g.add(blob);
    // tall thin steel stabile
    const apex = new THREE.Vector3(28, 5.5, 4);
    for (const [bx, bz] of [[-1.4, -1.2], [1.5, -1.0], [0, 1.6]] as const)
      g.add(strut(new THREE.Vector3(28 + bx, 0, 4 + bz), apex, 0.12, STEEL_LM));
    const plate = box(2.6, 0.16, 1.4, STEEL_LM, 28, 5.7, 4);
    plate.rotation.z = 0.3;
    g.add(plate);
    return g;
  },

  // LOVE sculpture: four glossy-red abstract letterforms stacked 2x2, the O a tilted torus
  'love-sculpture': () => {
    const g = new THREE.Group();
    g.add(box(4.6, 0.12, 3.0, GRANITE, 0, 0.06, 0)); // sidewalk pad
    // L (upper-left)
    g.add(box(0.5, 1.9, 0.55, LOVE_RED, -1.35, 3.0, 0));
    g.add(box(1.25, 0.5, 0.55, LOVE_RED, -1.0, 2.15, 0));
    // O -> tilted torus (upper-right, the slanted letter)
    const o = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.27, 8, 16), LOVE_RED);
    o.position.set(1.15, 3.05, 0);
    o.rotation.z = 0.5;
    o.rotation.x = 0.35;
    g.add(o);
    // V (lower-left)
    const v1 = box(0.42, 1.9, 0.55, LOVE_RED, -1.35, 1.0, 0); v1.rotation.z = 0.28; g.add(v1);
    const v2 = box(0.42, 1.9, 0.55, LOVE_RED, -0.75, 1.0, 0); v2.rotation.z = -0.28; g.add(v2);
    // E (lower-right)
    g.add(box(0.42, 1.9, 0.55, LOVE_RED, 0.6, 1.0, 0));
    for (const yy of [1.85, 1.0, 0.15]) g.add(box(1.05, 0.42, 0.55, LOVE_RED, 1.15, yy, 0));
    return g;
  },

  // Carnegie Hall: warm terracotta Renaissance corner, arched window trios, bracketed cornice
  'carnegie-hall': () => {
    const g = new THREE.Group();
    // six-storey terracotta corner block
    g.add(box(30, 27, 24, TERRACOTTA, 0, 13.5, -4));
    // arched window trios on the +z and +x faces (glass recesses behind)
    for (const fy of [7, 13, 19]) for (const px of [-7, 0, 7]) {
      const wA = archWall(4.2, 5.0, 0.5, 2.2, 3.8, TERRACOTTA);
      wA.position.set(px, fy, 8.1);
      g.add(wA);
      g.add(box(2.0, 3.4, 0.2, GLASS_LM, px, fy + 2.0, 7.9));
    }
    for (const fy of [7, 13]) for (const pz of [-9, -3, 3]) {
      const wA = archWall(4.2, 5.0, 0.5, 2.2, 3.8, TERRACOTTA);
      wA.rotation.y = Math.PI / 2;
      wA.position.set(15.1, fy, pz);
      g.add(wA);
      g.add(box(0.2, 3.4, 2.0, GLASS_LM, 15.3, fy + 2.0, pz));
    }
    // deep bracketed cornice (corbels under a projecting slab)
    g.add(box(33, 1.6, 27, LIMESTONE, 0, 27.6, -4));
    for (let x = -13; x <= 13; x += 2.4) g.add(box(0.5, 1.1, 0.7, LIMESTONE, x, 26.6, 8.2));
    for (let z = -14; z <= 6; z += 2.4) g.add(box(0.7, 1.1, 0.5, LIMESTONE, 15.2, 26.6, z));
    // corner entrance: small canopy + two poster cases
    g.add(box(5, 0.4, 5, DARKSTONE, 12, 5, 6));
    for (const [cx, cz] of [[8, 8.2], [13.2, 3]] as const) {
      g.add(box(1.4, 2.2, 0.2, DARKSTONE, cx, 3, cz));
      g.add(box(1.1, 1.8, 0.1, LIMESTONE, cx, 3, cz + 0.08));
    }
    return g;
  },

  // Fifth Avenue: ten flag-flying lamp-post poles up the block + two granite planter benches
  'fifth-avenue': () => {
    const g = new THREE.Group();
    // ten flagpoles marching along local z, jutting out over the avenue
    for (let i = 0; i < 10; i++) {
      const p = flagpole(7, FLAG_COLORS[i % FLAG_COLORS.length]);
      p.position.set(-4, 0, -54 + i * 12);
      p.rotation.z = -0.6;
      g.add(p);
    }
    // two granite planter benches
    for (const z of [-18, 18]) {
      const pb = planterBench();
      pb.position.set(4, 0, z);
      g.add(pb);
    }
    return g;
  },
};
