import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRONZE, VERDIGRIS, STEEL_LM,
  WHITE_LM, BRICK_RED,
  box, cyl, strut, colonnade, lathe, archWall, figure, canvasTexture, twoSidedPanel,
} from '../kit';

/**
 * Heights set — Morningside / Harlem / Washington Heights / Inwood. Each
 * builder returns a group whose origin sits at ground level (y=0) at the
 * registry position; the manager rotates/positions/merges it. +z is front.
 */

// ---- local materials (module scope: one instance shared across landmarks) ----
const SIGN_RED = new THREE.MeshLambertMaterial({ color: '#c0392b' });        // Apollo blade + marquee frame
const WARM_GLOW = new THREE.MeshBasicMaterial({ color: '#ffe6ad' });         // self-lit bulbs / undersides / lantern
const LIGHTHOUSE_RED = new THREE.MeshLambertMaterial({ color: '#c8352b' });  // Little Red Lighthouse
const GRANGE_YELLOW = new THREE.MeshLambertMaterial({ color: '#d9c98f' });   // Hamilton Grange clapboard
const WOOD = new THREE.MeshLambertMaterial({ color: '#6b4a30' });            // rustic timber (fences, tables, benches)
const BLACK_LM = new THREE.MeshLambertMaterial({ color: '#2b2b2f' });        // shutters, lantern cap, doors
const LAWN = new THREE.MeshLambertMaterial({ color: '#4d7a3a' });            // lawns, garden beds, cloister garth

// ---- shared local props -----------------------------------------------------

/** Slatted park bench (timber seat, stone legs). */
function bench(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.06, 0.5, WOOD, 0, 0.45, 0));
  g.add(box(1.8, 0.5, 0.06, WOOD, 0, 0.7, -0.25));
  g.add(box(0.08, 0.45, 0.5, DARKSTONE, -0.8, 0.22, 0));
  g.add(box(0.08, 0.45, 0.5, DARKSTONE, 0.8, 0.22, 0));
  return g;
}

/** Globe lamp post. */
function lampPost(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.05, 0.07, 3.4, DARKSTONE, 0, 1.7, 0, 8));
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), WHITE_LM);
  globe.position.y = 3.6;
  g.add(globe);
  return g;
}

/** A-frame timber picnic table. */
function picnicTable(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.2, 0.1, 1.0, WOOD, 0, 0.75, 0));
  for (const sz of [-0.62, 0.62]) g.add(box(2.2, 0.09, 0.35, WOOD, 0, 0.45, sz));
  for (const sx of [-0.9, 0.9]) g.add(box(0.12, 0.78, 1.5, WOOD, sx, 0.39, 0));
  return g;
}

/** Post-and-rail timber fence run along local x. */
function fence(len: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(len, 0.08, 0.08, WOOD, 0, 1.0, 0));
  g.add(box(len, 0.08, 0.08, WOOD, 0, 0.6, 0));
  for (let x = -len / 2; x <= len / 2 + 0.01; x += 1.2) g.add(box(0.1, 1.2, 0.1, WOOD, x, 0.6, 0));
  return g;
}

/** WPA-era stone balustrade run along local x. */
function balustrade(len: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(len, 0.25, 0.5, mat, 0, 1.05, 0));
  g.add(box(len, 0.3, 0.6, mat, 0, 0.15, 0));
  for (let x = -len / 2 + 0.5; x <= len / 2 - 0.5 + 0.01; x += 0.7) g.add(cyl(0.09, 0.12, 0.78, mat, x, 0.62, 0, 6));
  return g;
}

/** Row of merlons (battlement) along local x, centered at (0,y,z). */
function merlons(len: number, y: number, z: number, mat: THREE.Material, n: number): THREE.Group {
  const g = new THREE.Group();
  const step = len / n;
  for (let i = 0; i < n; i++) g.add(box(step * 0.6, 0.7, 0.5, mat, -len / 2 + step * (i + 0.5), y + 0.35, z));
  return g;
}

/** Stylized spread-winged eagle silhouette, ~`s` metres. */
function eagle(s: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.5 * s, 0.5 * s, 0.85 * s, mat, 0, 0.35 * s, 0));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17 * s, 8, 6), mat);
  head.position.set(0, 0.68 * s, 0.4 * s);
  g.add(head);
  for (const sx of [-1, 1]) {
    const wing = box(0.95 * s, 0.09 * s, 0.5 * s, mat, sx * 0.55 * s, 0.55 * s, 0);
    wing.rotation.z = sx * 0.55;
    g.add(wing);
  }
  return g;
}

/** Pyramidal hip roof whose base corners land exactly on (+/-halfX, +/-halfZ). */
function hipRoof(halfX: number, halfZ: number, h: number, mat: THREE.Material, yBase: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0, 1, 1, 4), mat);
  m.rotation.y = Math.PI / 4;
  m.scale.set(halfX / Math.SQRT1_2, h, halfZ / Math.SQRT1_2);
  m.position.y = yBase + h / 2;
  return m;
}

/** Triangular gable prism (pediment) facing +z, base at y=0. */
function pediment(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  return new THREE.Mesh(geo, mat);
}

/** One exposed-lattice GWB tower leg (4 tapering corner chords + X-braced bays). */
function gwbLeg(y0: number, y1: number, cz: number, hb: number, ht: number): THREE.Group {
  const g = new THREE.Group();
  const bays = 9;
  const sign = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  const corner = (c: number, t: number): THREE.Vector3 => {
    const hw = hb + (ht - hb) * t;
    return new THREE.Vector3(sign[c][0] * hw, y0 + (y1 - y0) * t, cz + sign[c][1] * hw);
  };
  for (let c = 0; c < 4; c++) g.add(strut(corner(c, 0), corner(c, 1), 0.4, STEEL_LM, 6)); // corner chords
  for (let i = 0; i <= bays; i++) {
    const t = i / bays;
    for (let c = 0; c < 4; c++) g.add(strut(corner(c, t), corner((c + 1) % 4, t), 0.22, STEEL_LM, 6)); // rings
  }
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays, t1 = (i + 1) / bays;
    for (let c = 0; c < 4; c++) {
      const d = (c + 1) % 4;
      g.add(strut(corner(c, t0), corner(d, t1), 0.2, STEEL_LM, 6)); // X-bracing
      g.add(strut(corner(d, t0), corner(c, t1), 0.2, STEEL_LM, 6));
    }
  }
  return g;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Apollo Theater: brick front, glowing vertical blade sign, bulb-edged marquee
  apollo: () => {
    const g = new THREE.Group();
    const W = 20, H = 16, D = 12;
    g.add(box(W, H, D, BRICK_RED, 0, H / 2, 0)); // 4-story brick front
    g.add(box(W + 0.6, 0.9, D + 0.6, LIMESTONE, 0, H + 0.45, 0)); // cornice
    g.add(box(W, 0.5, D + 0.4, LIMESTONE, 0, 4.4, 0)); // string course
    for (let r = 0; r < 3; r++)
      for (let c = -3; c <= 3; c++)
        g.add(box(1.6, 2.2, 0.3, BLACK_LM, c * 2.6, 6.8 + r * 3.4, D / 2 + 0.02)); // windows
    g.add(box(6, 3.6, 0.4, BLACK_LM, 0, 1.9, D / 2 + 0.03)); // entrance doors
    // vertical blade sign: red frame + glowing letterform bars (no letters)
    const bladeTex = canvasTexture((c, w, h) => {
      c.fillStyle = '#7a1418';
      c.fillRect(0, 0, w, h);
      const n = 6;
      for (let i = 0; i < n; i++) {
        const yy = h * 0.05 + i * (h * 0.9 / n);
        const bh = (h * 0.9 / n) * 0.66;
        c.fillStyle = 'rgba(255,220,150,0.45)';
        c.beginPath(); c.roundRect(w * 0.1, yy - 3, w * 0.8, bh + 6, 8); c.fill();
        c.fillStyle = '#fff1cc';
        c.beginPath(); c.roundRect(w * 0.2, yy, w * 0.6, bh, 5); c.fill();
      }
    }, 48, 256);
    const bz = D / 2 + 1.5;
    for (const zz of [bz - 1.5, bz + 1.5]) g.add(box(0.6, 20, 0.5, SIGN_RED, -6.5, 15, zz)); // frame z-edges
    for (const yy of [5, 25]) g.add(box(0.6, 0.6, 3.2, SIGN_RED, -6.5, yy, bz)); // frame top/bottom
    const blade = twoSidedPanel(bladeTex, 2.4, 19);
    blade.rotation.y = Math.PI / 2;
    blade.position.set(-6.5, 15, bz);
    g.add(blade);
    // triangular marquee canopy with warm underside + bulb-edge fascia
    const proj = 5, half = 6.5;
    const canopy = pediment(half * 2, proj, 0.5, SIGN_RED);
    canopy.rotation.x = Math.PI / 2;
    canopy.position.set(0, 4.8, D / 2);
    g.add(canopy);
    const bulbTex = canvasTexture((c, w, h) => {
      c.fillStyle = '#8a1a1e';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 14; i++) {
        c.fillStyle = i % 2 ? '#fff2cf' : '#ffcf87';
        c.beginPath(); c.arc((i + 0.5) * w / 14, h / 2, h * 0.3, 0, Math.PI * 2); c.fill();
      }
    }, 256, 22);
    const bulbMat = new THREE.MeshBasicMaterial({ map: bulbTex });
    for (const sx of [-1, 1]) {
      const len = Math.hypot(half, proj);
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 0.12), bulbMat);
      fascia.position.set(sx * half / 2, 4.55, D / 2 + proj / 2);
      fascia.rotation.y = sx * Math.atan2(proj, half);
      g.add(fascia);
      const glow = box(len, 0.05, 0.9, WARM_GLOW, sx * half / 2, 4.52, D / 2 + proj / 2);
      glow.rotation.y = sx * Math.atan2(proj, half);
      g.add(glow);
    }
    return g;
  },

  // Cathedral of St. John the Divine: unfinished gothic west front + long nave
  'st-john-divine': () => {
    const g = new THREE.Group();
    g.add(box(24, 6, 57, GRANITE, 0, 3, -30)); // base course
    g.add(box(22, 40, 55, LIMESTONE, 0, 20, -30)); // nave rising 40m
    g.add(box(24, 6, 5, LIMESTONE, 0, 3, 0.5)); // front plinth
    g.add(archWall(11, 20, 5, 6, 14, GRANITE)); // great central portal
    for (const sx of [-8.5, 8.5]) {
      const p = archWall(7, 14, 5, 3, 9, GRANITE); // side portals
      p.position.set(sx, 0, 0);
      g.add(p);
    }
    g.add(box(24, 11, 5, LIMESTONE, 0, 25.5, 0)); // wall above portals
    // rose window: deep-blue radial stained glass in a pointed surround
    const roseTex = canvasTexture((c, w, h) => {
      const cx = w / 2, cy = h / 2;
      c.fillStyle = '#0a1a4a';
      c.fillRect(0, 0, w, h);
      for (let ring = 0; ring < 3; ring++) {
        const r0 = 18 + ring * 30, r1 = r0 + 28, spokes = 12;
        for (let i = 0; i < spokes; i++) {
          const a0 = (i / spokes) * Math.PI * 2, a1 = ((i + 1) / spokes) * Math.PI * 2;
          c.fillStyle = `hsl(${208 + ((i + ring) % 3) * 22}, 72%, ${28 + ((i + ring) % 4) * 12}%)`;
          c.beginPath();
          c.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
          c.arc(cx, cy, r1, a0, a1);
          c.arc(cx, cy, r0, a1, a0, true);
          c.closePath(); c.fill();
        }
      }
      c.strokeStyle = '#05102e';
      c.lineWidth = 3;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * 112, cy + Math.sin(a) * 112); c.stroke();
      }
      c.fillStyle = '#cfe0ff';
      c.beginPath(); c.arc(cx, cy, 15, 0, Math.PI * 2); c.fill();
    });
    g.add(box(9.6, 9.6, 0.4, GRANITE, 0, 24.5, 2.55)); // stone bezel
    const rose = new THREE.Mesh(new THREE.CircleGeometry(4.3, 24), new THREE.MeshBasicMaterial({ map: roseTex }));
    rose.position.set(0, 24.5, 2.75);
    g.add(rose);
    for (const sx of [-1, 1]) {
      const hood = box(0.5, 8, 0.6, LIMESTONE, sx * 3.6, 29, 2.7); // pointed surround
      hood.rotation.z = sx * 0.6;
      g.add(hood);
    }
    // twin square towers: south finished + crowned, north short + flat-topped
    g.add(box(10, 50, 10, LIMESTONE, -15, 25, 0));
    g.add(box(8, 6, 8, LIMESTONE, -15, 53, 0));
    for (const sz of [-3.6, 3.6]) {
      const row = merlons(8, 56, sz, LIMESTONE, 4);
      row.position.x = -15;
      g.add(row);
    }
    for (const sx of [-3.6, 3.6]) {
      const row = merlons(8, 56, 0, LIMESTONE, 4);
      row.rotation.y = Math.PI / 2;
      row.position.x = -15 + sx;
      g.add(row);
    }
    for (const [px, pz] of [[-4, 4], [4, 4], [-4, -4], [4, -4]] as const)
      g.add(cyl(0.1, 0.5, 4, LIMESTONE, -15 + px, 58, pz, 6)); // pinnacles
    g.add(box(10, 34, 10, LIMESTONE, 15, 17, 0)); // unfinished tower
    g.add(box(10.6, 1.2, 10.6, LIMESTONE, 15, 34.6, 0)); // flat top
    for (const sx of [-15, 15]) {
      const belfry = archWall(6, 6, 0.6, 2, 5, DARKSTONE);
      belfry.position.set(sx, 26, 5.1);
      g.add(belfry);
    }
    return g;
  },

  // Columbia — Low Memorial Library: Ionic colonnade, stepped dome, Alma Mater
  columbia: () => {
    const g = new THREE.Group();
    g.add(box(34, 14, 24, LIMESTONE, 0, 11, -14)); // library block
    for (let i = 0; i < 9; i++) g.add(box(30 - i * 0.3, 0.5, 1.3, GRANITE, 0, 0.25 + i * 0.5, 10 - i * 1.15)); // cascading steps
    g.add(box(30, 0.6, 8, GRANITE, 0, 4, -1)); // portico floor
    const cols = colonnade(10, 3.0, 0.55, 10, MARBLE); // 10-column Ionic front
    cols.position.set(0, 4.3, 1);
    g.add(cols);
    g.add(box(31, 2.2, 2.4, LIMESTONE, 0, 15.4, 1)); // entablature
    const ped = pediment(31, 4.2, 2.4, LIMESTONE);
    ped.position.set(0, 16.5, 1);
    g.add(ped);
    g.add(cyl(6.2, 6.4, 4, GRANITE, 0, 20, -6, 16)); // drum
    const dome = lathe([[6, 0], [5.7, 0.8], [5.7, 1.2], [5.2, 1.6], [5.2, 2.1], [4.4, 2.7], [4.4, 3.1], [3.3, 3.9], [1.9, 4.7], [0, 5.3]], GRANITE, 16);
    dome.position.set(0, 22, -6);
    g.add(dome);
    g.add(box(2.4, 1.4, 2.4, GRANITE, 0, 5.2, 5)); // Alma Mater throne
    const alma = figure(2.6, BRONZE);
    alma.position.set(0, 5.9, 5);
    g.add(alma);
    for (const sx of [-1, 1]) { // flanking lawns
      const lawn = new THREE.Mesh(new THREE.PlaneGeometry(9, 20), LAWN);
      lawn.rotation.x = -Math.PI / 2;
      lawn.position.set(sx * 21, 0.05, 2);
      g.add(lawn);
    }
    return g;
  },

  // Riverside Church: 120m slender gothic tower with openwork upper stage
  'riverside-church': () => {
    const g = new THREE.Group();
    g.add(box(20, 22, 34, LIMESTONE, 0, 11, 22)); // short nave
    const portal = archWall(7, 12, 1.5, 3.4, 9, GRANITE);
    portal.position.set(0, 0, 39.2);
    g.add(portal);
    const sizes = [16, 15, 14, 13, 12, 11];
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      g.add(box(s, 20, s, LIMESTONE, 0, i * 20 + 10, 0)); // tapering stacked tower
      for (const sx of [-1, 1]) for (const sz of [-1, 1])
        g.add(cyl(0.14, 0.2, 2.4, LIMESTONE, sx * s / 2, i * 20 + 20, sz * s / 2, 6)); // corner pinnacles
    }
    for (let stage = 4; stage < 6; stage++) { // openwork upper third: inset dark panels
      const s = sizes[stage];
      for (const sx of [-1, 1]) {
        for (const off of [-0.28, 0, 0.28])
          g.add(box(1.6, 15, 0.4, DARKSTONE, sx * (s / 2 + 0.05), stage * 20 + 10, off * s));
        for (const off of [-0.28, 0, 0.28])
          g.add(box(0.4, 15, 1.6, DARKSTONE, off * s, stage * 20 + 10, sx * (s / 2 + 0.05)));
      }
    }
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
      g.add(cyl(0.15, 0.35, 6, LIMESTONE, sx * 5, 122, sz * 5, 6)); // crown pinnacles
    g.add(cyl(0.1, 1.2, 4, LIMESTONE, 0, 122, 0, 8));
    return g;
  },

  // Grant's Tomb: white granite cube, Doric colonnade, stepped conical dome
  'grants-tomb': () => {
    const g = new THREE.Group();
    for (let i = 0; i < 6; i++) g.add(box(38 - i * 0.6, 0.5, 3 - i * 0.1, GRANITE, 0, 0.25 + i * 0.5, 20 - i * 1.4)); // steps
    g.add(box(30, 24, 30, GRANITE, 0, 12, 0)); // cube
    g.add(box(32, 2, 32, MARBLE, 0, 25, 0)); // cornice
    const front = colonnade(10, 2.7, 0.6, 11, MARBLE); // Doric portico
    front.position.set(0, 3, 15.4);
    g.add(front);
    g.add(box(26, 2.4, 2.4, MARBLE, 0, 15.2, 15.4)); // portico entablature
    const ped = pediment(26, 4, 2.4, MARBLE);
    ped.position.set(0, 16.4, 15.4);
    g.add(ped);
    for (const rot of [Math.PI / 2, -Math.PI / 2]) { // side colonnades (wrap)
      const side = colonnade(8, 3.2, 0.6, 11, MARBLE);
      side.rotation.y = rot;
      side.position.set(rot > 0 ? 15.4 : -15.4, 3, 0);
      g.add(side);
    }
    g.add(cyl(9, 10, 5, GRANITE, 0, 26.5, 0, 16)); // drum
    const dome = lathe([[9, 0], [8, 1.2], [8, 1.8], [6.6, 3], [6.6, 3.6], [5, 5], [5, 5.6], [3.2, 7.2], [0, 8.6]], GRANITE, 16);
    dome.position.set(0, 29, 0);
    g.add(dome);
    for (const sx of [-1, 1]) { // eagle plinths flanking the steps
      g.add(box(2.4, 3, 2.4, GRANITE, sx * 17, 1.5, 17));
      const e = eagle(1.2, VERDIGRIS);
      e.position.set(sx * 17, 3, 17);
      g.add(e);
    }
    return g;
  },

  // Riverside Park: stone entrance pylons, terraced stair, WPA balustrade
  'riverside-park': () => {
    const g = new THREE.Group();
    for (const sx of [-3, 3]) { // entrance pylons
      g.add(box(1.3, 3.2, 1.3, GRANITE, sx, 1.6, -2));
      g.add(box(1.6, 0.4, 1.6, LIMESTONE, sx, 3.4, -2));
    }
    for (let i = 0; i < 8; i++) g.add(box(5, 0.4, 1.1, GRANITE, 0, -0.2 - i * 0.4, i * 1.1)); // stair down
    for (const sx of [-1, 1]) { // balustrade run
      const bal = balustrade(20, LIMESTONE);
      bal.rotation.y = Math.PI / 2;
      bal.position.set(sx * 4.5, 0, 6);
      g.add(bal);
    }
    for (const [bx, bz] of [[-9, 2], [0, 3], [9, 2]] as const) {
      const b = bench();
      b.position.set(bx, 0, bz);
      g.add(b);
    }
    for (const sx of [-6, 6]) {
      const lp = lampPost();
      lp.position.set(sx, 0, -3);
      g.add(lp);
    }
    return g;
  },

  // Hamilton Grange: Federal-style yellow house, white porch wrap, hipped roof
  'hamilton-grange': () => {
    const g = new THREE.Group();
    g.add(box(14, 8, 11, GRANGE_YELLOW, 0, 4, 0)); // 2-story body
    g.add(box(14.4, 0.5, 11.4, WHITE_LM, 0, 8.2, 0)); // eave band
    for (let r = 0; r < 2; r++)
      for (const cx of [-4.5, -1.5, 1.5, 4.5])
        g.add(box(1.4, 2, 0.2, BLACK_LM, cx, 2.6 + r * 3.4, 5.55)); // windows
    g.add(hipRoof(7.6, 6.2, 4, DARKSTONE, 8.5)); // hipped roof
    for (const cx of [-4, 4]) g.add(box(1, 3, 1, BRICK_RED, cx, 11, 0)); // chimneys
    // white porch wrap: floor, thin columns, porch roof
    g.add(box(16, 0.4, 3.5, WHITE_LM, 0, 1.0, 6.5));
    const cols = colonnade(6, 2.8, 0.13, 5, WHITE_LM);
    cols.position.set(0, 1.2, 7.8);
    g.add(cols);
    g.add(box(16, 0.4, 4, WHITE_LM, 0, 6.4, 6.6));
    return g;
  },

  // Morris-Jumel Mansion: white colonial, 2-story portico, widow's walk
  'morris-jumel': () => {
    const g = new THREE.Group();
    g.add(box(13, 8, 11, WHITE_LM, 0, 4, 0)); // clapboard body
    for (const sx of [-1, 1]) // black shutters flanking windows
      for (let r = 0; r < 2; r++)
        for (const cx of [3, 5])
          g.add(box(0.3, 1.8, 0.15, BLACK_LM, sx * cx, 2.8 + r * 3, 5.55));
    g.add(hipRoof(7, 6, 3.2, DARKSTONE, 8)); // low hip roof
    g.add(box(3.6, 0.3, 3.6, WHITE_LM, 0, 10.4, 0)); // widow's-walk deck
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.1, 0.7, 0.1, WHITE_LM, sx * 1.7, 10.9, sz * 1.7));
    for (const sz of [-1.7, 1.7]) g.add(box(3.6, 0.08, 0.08, WHITE_LM, 0, 11.2, sz));
    for (const sx of [-1.7, 1.7]) g.add(box(0.08, 0.08, 3.6, WHITE_LM, sx, 11.2, 0));
    // 2-story portico: 4 thin columns + pediment
    const port = colonnade(4, 2.0, 0.16, 7.5, WHITE_LM);
    port.position.set(0, 0.4, 6.4);
    g.add(port);
    g.add(box(7, 0.5, 1, WHITE_LM, 0, 0.25, 6.4));
    g.add(box(7.2, 1.2, 1.4, WHITE_LM, 0, 8.4, 6.2));
    const ped = pediment(7.2, 2, 1.4, WHITE_LM);
    ped.position.set(0, 9, 6.2);
    g.add(ped);
    return g;
  },

  // Dyckman Farmhouse: white Dutch house, flared gambrel roof, porch, fence
  'dyckman-farmhouse': () => {
    const g = new THREE.Group();
    g.add(box(12, 5, 9, WHITE_LM, 0, 2.5, 0)); // low body
    // flared gambrel roof: shallow upper + steep lower slopes with kicked eaves
    const panel = (z0: number, y0: number, z1: number, y1: number): THREE.Mesh => {
      const dz = z1 - z0, dy = y1 - y0, L = Math.hypot(dz, dy);
      const m = box(13, 0.28, L, DARKSTONE, 0, (y0 + y1) / 2, (z0 + z1) / 2);
      m.rotation.x = Math.atan2(-dy, dz);
      return m;
    };
    g.add(panel(0, 8.6, 2.3, 7.2)); // upper slope +z
    g.add(panel(0, 8.6, -2.3, 7.2)); // upper slope -z
    g.add(panel(2.3, 7.2, 4.9, 5.0)); // lower slope +z
    g.add(panel(-2.3, 7.2, -4.9, 5.0)); // lower slope -z
    for (const sz of [1, -1]) g.add(box(13, 0.2, 0.7, DARKSTONE, 0, 4.85, sz * 5.1)); // flared eave kick
    for (const sx of [-1, 1]) g.add(box(0.2, 3.6, 9.8, WHITE_LM, sx * 6, 6.4, 0)); // gable-end fill
    g.add(box(14, 0.3, 3, WHITE_LM, 0, 0.6, 5)); // porch floor
    const porch = colonnade(6, 2.2, 0.11, 3, WOOD);
    porch.position.set(0, 0.7, 6.3);
    g.add(porch);
    g.add(box(14, 0.25, 3.4, DARKSTONE, 0, 3.8, 5.4)); // porch roof
    for (const [fx, fz, rot] of [[0, -7, 0], [-7, 0, Math.PI / 2], [7, 0, Math.PI / 2]] as const) {
      const f = fence(12);
      f.position.set(fx, 0, fz);
      f.rotation.y = rot;
      g.add(f);
    }
    return g;
  },

  // The Cloisters: battlemented tower, hall ranges, colonnaded cloister court
  cloisters: () => {
    const g = new THREE.Group();
    g.add(box(9, 22, 9, DARKSTONE, 0, 11, 0)); // square tower
    for (const sz of [-4.5, 4.5]) g.add(merlons(9, 22, sz, DARKSTONE, 4));
    for (const sx of [-4.5, 4.5]) {
      const row = merlons(9, 22, 0, DARKSTONE, 4);
      row.rotation.y = Math.PI / 2;
      row.position.x = sx;
      g.add(row);
    }
    for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) { // arched belfry openings
      const bel = archWall(4, 5, 0.6, 1.4, 4, DARKSTONE);
      bel.position.set(sx * 4.55, 15, sz * 4.55);
      bel.rotation.y = sx !== 0 ? Math.PI / 2 : 0;
      g.add(bel);
    }
    g.add(box(20, 12, 10, DARKSTONE, 12, 6, 3)); // hall range
    g.add(box(10, 10, 16, DARKSTONE, -9, 5, 8));
    // small cloister court: square ring of thin columns + garth
    const court = new THREE.Group();
    for (const [pos, rot] of [[-5, 0], [5, 0], [0, Math.PI / 2], [0, -Math.PI / 2]] as const) {
      const arc = colonnade(5, 2.4, 0.15, 3.2, LIMESTONE);
      arc.rotation.y = rot;
      if (rot === 0) arc.position.set(0, 0, pos);
      else arc.position.set(pos === 0 ? (rot > 0 ? 5 : -5) : 0, 0, 0);
      court.add(arc);
    }
    const garth = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), LAWN);
    garth.rotation.x = -Math.PI / 2;
    garth.position.y = 0.05;
    court.add(garth);
    court.position.set(2, 0, 22);
    g.add(court);
    // rampart wall segment with crenellation
    g.add(box(30, 5, 1.4, DARKSTONE, -4, 2.5, -12));
    const ramp = merlons(30, 5, -12, DARKSTONE, 12);
    ramp.position.x = -4;
    g.add(ramp);
    return g;
  },

  // Fort Tryon Park: rustic stone arch, terraced beds, benches, lamps
  'fort-tryon': () => {
    const g = new THREE.Group();
    const arch = archWall(7, 5.5, 1.4, 2.8, 4.6, DARKSTONE); // entrance arch
    g.add(arch);
    g.add(box(8, 0.6, 1.8, LIMESTONE, 0, 5.8, 0)); // arch coping
    for (let i = 0; i < 3; i++) { // terraced garden beds
      g.add(box(12 - i * 2, 0.8, 1.0, DARKSTONE, 0, 0.4 + i * 0.8, 5 - i * 2));
      const bed = new THREE.Mesh(new THREE.PlaneGeometry(11 - i * 2, 1.7), LAWN);
      bed.rotation.x = -Math.PI / 2;
      bed.position.set(0, 0.85 + i * 0.8, 4 - i * 2);
      g.add(bed);
    }
    for (const [bx, bz] of [[-6, 7], [6, 7]] as const) {
      const b = bench();
      b.position.set(bx, 0, bz);
      b.rotation.y = Math.PI;
      g.add(b);
    }
    for (const sx of [-8, 8]) {
      const lp = lampPost();
      lp.position.set(sx, 0, 1);
      g.add(lp);
    }
    return g;
  },

  // Inwood Hill Park: glacial pothole boulders, timber trailhead, eagle rock
  'inwood-hill': () => {
    const g = new THREE.Group();
    for (const [bx, bz, s, rot] of [[-4, 1, 2.2, 0.3], [-1.5, -2, 1.6, 1.1], [2, 1.5, 2.6, -0.6], [4, -1, 1.4, 0.8]] as const) {
      const rock = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 6), DARKSTONE); // glacial potholes
      rock.scale.set(1, 0.55, 1.1);
      rock.rotation.y = rot;
      rock.position.set(bx, s * 0.45, bz);
      g.add(rock);
    }
    for (const sx of [-2.2, 2.2]) g.add(box(0.35, 4, 0.35, WOOD, sx, 2, 6)); // trailhead posts
    g.add(box(5.4, 0.4, 0.4, WOOD, 0, 4, 6)); // trailhead crossbeam
    const eagleRock = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 6), DARKSTONE);
    eagleRock.scale.set(1, 0.7, 1);
    eagleRock.position.set(8, 1.2, -3);
    g.add(eagleRock);
    const e = eagle(1.3, VERDIGRIS); // bald-eagle commemoration
    e.position.set(8, 2.4, -3);
    g.add(e);
    const f = fence(10);
    f.position.set(0, 0, 9);
    g.add(f);
    return g;
  },

  // Fort Washington Park: stone comfort station, picnic tables, lamp
  'fort-washington-park': () => {
    const g = new THREE.Group();
    g.add(box(6, 3.5, 5, GRANITE, 0, 1.75, 0)); // comfort-station hut
    g.add(hipRoof(3.3, 2.8, 2.2, DARKSTONE, 3.5)); // hipped roof
    g.add(box(1.2, 2.2, 0.2, BLACK_LM, 0, 1.1, 2.55)); // doorway
    for (const [tx, tz, rot] of [[-7, 4, 0.2], [0, 6, -0.4], [7, 3, 0.9]] as const) {
      const t = picnicTable();
      t.position.set(tx, 0, tz);
      t.rotation.y = rot;
      g.add(t);
    }
    const lp = lampPost();
    lp.position.set(4, 0, -3);
    g.add(lp);
    return g;
  },

  // George Washington Bridge: exposed-lattice Manhattan tower rising from the river
  gwb: () => {
    const g = new THREE.Group();
    const baseY = -3, topY = 181, legZ = 15, hb = 4.5, ht = 3.2;
    for (const cz of [-legZ, legZ]) {
      g.add(box(12, 6, 12, GRANITE, 0, baseY + 3, cz)); // river pier base
      g.add(gwbLeg(baseY, topY, cz, hb, ht)); // open riveted steel leg
      g.add(box(9.5, 2, 9.5, STEEL_LM, 0, topY + 1, cz)); // cable saddle cap
    }
    const braceBand = (yb: number, hh: number): void => { // horizontal portal brace band
      const t = (yb - baseY) / (topY - baseY);
      const hw = hb + (ht - hb) * t;
      const zIn = legZ - hw;
      for (const sx of [-1, 1]) {
        const x = sx * hw;
        g.add(strut(new THREE.Vector3(x, yb, -zIn), new THREE.Vector3(x, yb, zIn), 0.26, STEEL_LM, 6));
        g.add(strut(new THREE.Vector3(x, yb + hh, -zIn), new THREE.Vector3(x, yb + hh, zIn), 0.26, STEEL_LM, 6));
        for (let k = 0; k < 4; k++) {
          const lo = new THREE.Vector3(x, yb, -zIn + (2 * zIn) * (k / 4));
          const hi = new THREE.Vector3(x, yb + hh, -zIn + (2 * zIn) * ((k + 1) / 4));
          g.add(strut(lo, hi, 0.18, STEEL_LM, 6));
        }
      }
    };
    braceBand(38, 5);
    braceBand(105, 5);
    braceBand(topY - 8, 5);
    // catenary main cables: anchorage(-x, low) over the tower to New Jersey(+x)
    const yCable = (x: number): number => (x <= 0 ? 184 + (20 - 184) * (-x / 120) : 45.5 + 8.65e-4 * (x - 400) ** 2);
    const xs: number[] = [];
    for (let i = 0; i <= 4; i++) xs.push(-120 + i * 30);
    for (let i = 1; i <= 12; i++) xs.push((i * 250) / 12);
    for (const cz of [-legZ - 1, -legZ + 1, legZ - 1, legZ + 1]) { // 4 cables (2 per side)
      for (let i = 0; i < xs.length - 1; i++)
        g.add(strut(new THREE.Vector3(xs[i], yCable(xs[i]), cz), new THREE.Vector3(xs[i + 1], yCable(xs[i + 1]), cz), 0.6, STEEL_LM, 6));
    }
    for (const cz of [-legZ, legZ]) // vertical suspenders every 10m
      for (let x = 10; x <= 240; x += 10) {
        const yc = yCable(x);
        if (yc > 67) g.add(strut(new THREE.Vector3(x, yc, cz), new THREE.Vector3(x, 65, cz), 0.12, STEEL_LM, 6));
      }
    g.add(box(14, 18, 42, GRANITE, -120, 9, 0)); // land anchorage
    return g;
  },

  // Little Red Lighthouse: bright-red conical tower on a rock outcrop under the GWB
  'little-red-lighthouse': () => {
    const g = new THREE.Group();
    const rock = new THREE.Mesh(new THREE.SphereGeometry(4, 10, 7), DARKSTONE); // rock outcrop pad
    rock.scale.set(1, 0.4, 1.2);
    rock.position.y = 0.6;
    g.add(rock);
    g.add(cyl(0.9, 1.7, 12, LIGHTHOUSE_RED, 0, 7, 0, 12)); // conical tower
    g.add(cyl(1.05, 1.05, 0.9, WHITE_LM, 0, 11.6, 0, 12)); // white gallery band
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      g.add(cyl(0.04, 0.04, 0.7, WHITE_LM, Math.cos(a) * 1.05, 12.2, Math.sin(a) * 1.05, 5)); // gallery rail posts
    }
    g.add(cyl(0.85, 0.95, 1.4, BLACK_LM, 0, 13.3, 0, 12)); // black lantern cap
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), WARM_GLOW);
    light.position.y = 13.3;
    g.add(light);
    g.add(cyl(0.05, 0.9, 1.1, BLACK_LM, 0, 14.6, 0, 12)); // conical roof
    const door = archWall(1.2, 1.9, 0.3, 0.7, 1.5, BLACK_LM); // tiny arched door
    door.position.set(0, 1.0, 1.55);
    g.add(door);
    return g;
  },
};
