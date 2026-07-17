import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, GOLD, STEEL_LM, GLASS_LM, WHITE_LM, BRONZE, GREEN_PATINA,
  box, cyl, strut, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Midtown East set — Grand Central's Beaux-Arts front, the Chrysler crown, the
 * One Vanderbilt spire, the UN Secretariat, 270 Park (Chase HQ) and the
 * Queensboro cantilever. Each builder returns a group whose origin sits at
 * ground level; the manager rotates/positions/merges it. The Chrysler and One
 * Vanderbilt shafts already exist from OSM — those builders add only the
 * signature crown that OSM lacks. Chase HQ is a full replacement (the
 * pipeline clears the OSM massing at the site) — that builder owns everything
 * from the plaza up.
 */

// Set-local materials (justified: a warm-tinted steel for the Queensboro's
// ironwork, and JPMorganChase's signature bronze-tinted curtain glass, neither
// of which is in the shared kit).
const WARM_STEEL = new THREE.MeshStandardMaterial({ color: '#9a9184', metalness: 0.72, roughness: 0.42 });
// low metalness on purpose: the street scene has no environment map, and
// metalness > ~0.5 without one renders near-black (same lesson as the trains).
// The slight emissive keeps shaded faces reading warm bronze, not chocolate.
const BRONZE_GLASS = new THREE.MeshStandardMaterial({
  color: '#96805f', metalness: 0.35, roughness: 0.34, emissive: '#221a11',
});

// Tapered 4-leg lattice tower (X-braced), origin at ground; reused by the bridge towers.
function latticeTower(h: number, baseHalf: number, topHalf: number, mat: THREE.Material, legR: number, levels: number): THREE.Group {
  const t = new THREE.Group();
  const base = [[baseHalf, baseHalf], [-baseHalf, baseHalf], [-baseHalf, -baseHalf], [baseHalf, -baseHalf]]
    .map(([x, z]) => new THREE.Vector3(x, 0, z));
  const top = [[topHalf, topHalf], [-topHalf, topHalf], [-topHalf, -topHalf], [topHalf, -topHalf]]
    .map(([x, z]) => new THREE.Vector3(x, h, z));
  for (let i = 0; i < 4; i++) t.add(strut(base[i], top[i], legR, mat)); // legs
  for (let f = 0; f < 4; f++) {
    const a0 = base[f], a1 = top[f], b0 = base[(f + 1) % 4], b1 = top[(f + 1) % 4];
    for (let k = 0; k < levels; k++) {
      const t0 = k / levels, t1 = (k + 1) / levels;
      t.add(strut(a0.clone().lerp(a1, t0), b0.clone().lerp(b1, t1), legR * 0.5, mat)); // X brace
      t.add(strut(b0.clone().lerp(b1, t0), a0.clone().lerp(a1, t1), legR * 0.5, mat));
      t.add(strut(a0.clone().lerp(a1, t1), b0.clone().lerp(b1, t1), legR * 0.45, mat)); // horizontal tie
    }
  }
  return t;
}

// Abstract Chrysler corner eagle: angled neck + head block + beak cone, projecting +x.
function chryslerEagle(): THREE.Group {
  const e = new THREE.Group();
  const neck = box(8, 1.8, 1.8, STEEL_LM, 13, 0, 0);
  neck.rotation.z = 0.12;
  e.add(neck);
  e.add(box(2.2, 2.2, 2.2, STEEL_LM, 17.4, 0.7, 0)); // head
  const beak = cyl(0, 1.0, 3.0, STEEL_LM, 19.7, 0.5, 0, 6); // beak points +x
  beak.rotation.z = -Math.PI / 2;
  e.add(beak);
  return e;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Grand Central 42nd St front: limestone facade, three arched windows, Glory of Commerce + Tiffany clock
  'grand-central': () => {
    const g = new THREE.Group();
    g.add(box(62, 2, 9, GRANITE, 0, 1, 0)); // plinth
    g.add(box(60, 25, 8, LIMESTONE, 0, 12.5, 0)); // facade block (60w x 25h)
    g.add(box(62, 1.4, 9.2, LIMESTONE, 0, 25.7, 0)); // cornice
    // three monumental arched windows (10w x 18h) with inset glazing
    for (const wx of [-19, 0, 19]) {
      const frame = archWall(15, 21, 0.9, 10, 18, LIMESTONE);
      frame.position.set(wx, 2, 4.0);
      g.add(frame);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 17.4), GLASS_LM);
      glass.position.set(wx, 10.7, 4.06); // faces +z, sits just proud of the block
      g.add(glass);
    }
    // paired column fins in the two gaps between the windows
    for (const cx of [-10.3, -8.7, 8.7, 10.3]) {
      g.add(cyl(0.85, 0.95, 21, LIMESTONE, cx, 12.5, 4.2, 10));
      g.add(box(2.4, 0.6, 2.4, LIMESTONE, cx, 23.2, 4.2)); // capital
      g.add(box(2.6, 0.5, 2.6, LIMESTONE, cx, 2.4, 4.2)); // base
    }
    // crowning sculptural group over the center, at the cornice
    g.add(box(22, 3.4, 6, LIMESTONE, 0, 26.9, 1.0)); // attic pedestal (front at z=4)
    // Tiffany clock: opal-white face, black roman ticks (no numerals), gold rim
    const face = canvasTexture((c, w, h) => {
      c.fillStyle = '#f2eee4';
      c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#161616';
      c.translate(w / 2, h / 2);
      for (let i = 0; i < 12; i++) {
        c.save();
        c.rotate((i * Math.PI) / 6);
        c.lineWidth = i % 3 === 0 ? 8 : 3;
        c.beginPath();
        c.moveTo(0, -(w / 2 - 10));
        c.lineTo(0, -(w / 2 - 10) + (i % 3 === 0 ? 20 : 12));
        c.stroke();
        c.restore();
      }
    });
    const clock = new THREE.Mesh(new THREE.CircleGeometry(2, 16), new THREE.MeshLambertMaterial({ map: face }));
    clock.position.set(0, 27.8, 5.0); // faces +z, proud of the pedestal
    g.add(clock);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.2, 8, 16), GOLD);
    rim.position.set(0, 27.8, 5.0);
    g.add(rim);
    // Mercury (head ~y=32.5) with a winged-helm hint, flanked by two reclining figures
    const mercury = figure(5, LIMESTONE);
    mercury.position.set(0, 28.6, 3.3); // stands atop the pedestal
    g.add(mercury);
    for (const sx of [-1, 1]) {
      const wing = box(2.2, 0.5, 0.12, LIMESTONE, sx * 1.0, 32.6, 3.3);
      wing.rotation.z = sx * 0.7;
      g.add(wing); // winged helm hint at Mercury's head
    }
    g.add(box(1.0, 0.7, 1.0, LIMESTONE, 0, 33.0, 3.3)); // helm cap
    for (const sx of [-1, 1]) {
      const rec = figure(3, LIMESTONE);
      rec.position.set(sx * 8, 28.6, 4.2);
      rec.rotation.z = sx * 1.4; // reclining on the pediment ends
      g.add(rec);
    }
    return g;
  },

  // Chrysler iconic crown: seven terraced steel arcs with triangular window slots, needle spire, corner eagles
  chrysler: (ctx) => {
    const g = new THREE.Group();
    // The crown seats on the MEASURED shaft shoulder (the pipeline clears
    // OSM's stacked crown parts and tells us where the kept massing ends),
    // so it can never float above or sink into the tower.
    const base = ctx.fit?.keptH ?? 240; // shaft shoulder
    const tipY = (ctx.fit?.roofH ?? base + 42) + 37; // real spire tops ~37m past the old roof
    const crownH = (ctx.fit?.roofH ?? base + 42) - base;
    const R = Math.max(10, Math.min(16, ((ctx.fit?.topW ?? 30) + (ctx.fit?.topD ?? 30)) / 4 + 4));
    g.add(cyl(4, R, crownH, STEEL_LM, 0, base + crownH / 2, 0, 8)); // tapered core under the arches
    const depth = 3;
    for (let f = 0; f < 4; f++) {
      const facePane = new THREE.Group();
      facePane.rotation.y = (f * Math.PI) / 2;
      for (let i = 0; i < 7; i++) {
        const r = R - (R - 3.9) * (i / 6); // R -> 3.9
        const cy = base + (crownH / 7) * i; // spring lines climb the crown zone
        const zPos = r - depth / 2;
        const arch = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, depth, 12, 1, true, -Math.PI / 2, Math.PI),
          STEEL_LM,
        );
        arch.rotation.x = -Math.PI / 2; // lay the half-cylinder up as an arch (peak at cy + r)
        arch.position.set(0, cy, zPos);
        facePane.add(arch);
        for (const b of [0.45, 0.95, 1.57, 2.19, 2.69]) {
          const rr = r * 0.6;
          const slot = box(0.5, r * 0.34, 0.5, DARKSTONE, rr * Math.cos(b), cy + rr * Math.sin(b), zPos + 0.2);
          slot.rotation.z = b - Math.PI / 2; // radial triangular-window slot
          facePane.add(slot);
        }
      }
      g.add(facePane);
    }
    g.add(cyl(0.05, 1.2, 37, STEEL_LM, 0, tipY - 18.5, 0, 8)); // needle spire
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 5), STEEL_LM);
    ball.position.y = tipY;
    g.add(ball);
    for (let k = 0; k < 4; k++) {
      const e = chryslerEagle();
      e.position.set(0, base - 5, 0);
      e.rotation.y = Math.PI / 4 + (k * Math.PI) / 2; // diagonal corners
      g.add(e);
    }
    return g;
  },

  // One Vanderbilt crown: four tapering glass fins to a point at 427m + the Summit deck band
  'one-vanderbilt': () => {
    const g = new THREE.Group();
    const apex = new THREE.Vector3(0, 427, 0);
    const yBase = 397, rBase = 16, halfW = 5;
    for (let k = 0; k < 4; k++) {
      const phi = (k * Math.PI) / 2;
      const cx = Math.sin(phi), cz = Math.cos(phi); // radial
      const tx = Math.cos(phi), tz = -Math.sin(phi); // tangential
      const mid = new THREE.Vector3(rBase * cx, yBase, rBase * cz);
      const bl = new THREE.Vector3(mid.x + tx * halfW, yBase, mid.z + tz * halfW);
      const br = new THREE.Vector3(mid.x - tx * halfW, yBase, mid.z - tz * halfW);
      const dir = apex.clone().sub(mid);
      const fin = box(halfW * 1.7, dir.length(), 0.4, GLASS_LM); // angled glass slab
      fin.position.copy(mid).add(apex).multiplyScalar(0.5);
      fin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      g.add(fin);
      g.add(strut(bl, apex, 0.2, STEEL_LM)); // steel edge ribs converging to the point
      g.add(strut(br, apex, 0.2, STEEL_LM));
    }
    // Summit deck band at y=369: glass parapet ring over a mirrored steel band
    const parapet = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 3, 16, 1, true), GLASS_LM);
    parapet.position.y = 370.5;
    g.add(parapet);
    const mirror = new THREE.Mesh(new THREE.CylinderGeometry(22.3, 22.3, 1.6, 16, 1, true), STEEL_LM);
    mirror.position.y = 368.4;
    g.add(mirror);
    return g;
  },

  // United Nations: green-glass Secretariat slab, marble ends, the GA hall + dome, and the 30-flag row
  'united-nations': () => {
    const g = new THREE.Group();
    const W = 87, H = 154, D = 12;
    g.add(box(W, H, D, GLASS_LM, 0, H / 2, 0)); // Secretariat slab
    // curtain-wall mullion grid via a tiled canvas texture (cheaper than hundreds of boxes)
    const grid = canvasTexture((c, w, h) => {
      c.fillStyle = '#5f8fa6';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#2b3b44';
      c.lineWidth = 6;
      c.strokeRect(0, 0, w, h);
    }, 32, 32);
    grid.wrapS = grid.wrapT = THREE.RepeatWrapping;
    grid.repeat.set(W / 4, H / 4);
    const gridMat = new THREE.MeshLambertMaterial({ map: grid });
    for (const zs of [D / 2 + 0.05, -(D / 2 + 0.05)]) {
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), gridMat);
      pane.position.set(0, H / 2, zs);
      if (zs < 0) pane.rotation.y = Math.PI; // face outward, never a mirrored double-side
      g.add(pane);
    }
    for (const sx of [-1, 1]) g.add(box(2.5, H, D + 0.6, MARBLE, sx * (W / 2), H / 2, 0)); // marble end walls
    // General Assembly hall: the real hall sits off the slab's NORTH end (the
    // registry anchors this group on the measured Secretariat center with local
    // -x pointing up-campus), at the measured OSM centroid offset — not "in
    // front" of the slab as the old +z layout had it
    const ga = new THREE.Group();
    ga.add(box(58, 20, 34, WHITE_LM, 0, 10, 0));
    ga.add(box(60, 5, 40, WHITE_LM, 0, 20.5, 0)); // flared cornice
    for (const sx of [-1, 1]) {
      const wing = box(12, 20, 34, WHITE_LM, sx * 33, 10, 0);
      wing.rotation.y = sx * 0.2; // sweeping flared ends
      ga.add(wing);
    }
    const dome = lathe([[11, 0], [10.4, 1.6], [8, 3.2], [4.6, 4.2], [0, 4.6]], MARBLE, 16);
    dome.position.set(0, 22.8, 0);
    ga.add(dome);
    ga.position.set(-129, 0, 36);
    g.add(ga);
    // flag row along the 1st Ave (west) edge of the whole campus — slab AND hall
    const N = 30, x0 = -135, span = 180;
    for (let i = 0; i < N; i++) {
      const x = x0 + (i * span) / (N - 1);
      g.add(cyl(0.09, 0.11, 13, WHITE_LM, x, 6.5, 55, 6));
      const flagMat = new THREE.MeshLambertMaterial({ color: `hsl(${Math.floor((i / N) * 360)}, 68%, 55%)` });
      g.add(box(2.4, 1.5, 0.06, flagMat, x + 1.3, 11.8, 55));
    }
    return g;
  },

  // Chase HQ (270 Park Ave): full replacement, plaza to spire — vertical corner
  // megacolumns plus two angled bronze fan/V arrangements per Park-Ave face
  // lift the tower off an open plaza; a dark transfer-truss band hands off to
  // a three-volume bronze-glass shaft with fin ribs and floor bands; an open
  // fin crown with a beacon tops it at 423m.
  'chase-hq': () => {
    const g = new THREE.Group();
    const HX = 30, HZ = 37.5; // footprint half-extents: 60m (cross-street x) x 75m (Park Ave z)
    const BASE_H = 24; // colonnade height

    // plaza: paved slab, low step/planter blocks, open beneath the tower
    g.add(box(70, 0.3, 88, GRANITE, 0, 0.15, 0)); // paving, proud of the footprint on all sides
    for (const [px, pz] of [[-22, 30], [22, 30], [-22, -30], [22, -30]] as const) {
      g.add(box(3, 1.2, 3, GRANITE, px, 0.6, pz)); // low step/planter wall
      g.add(box(2.4, 0.9, 2.4, GREEN_PATINA, px, 1.65, pz)); // planting
    }

    // lift-off base: vertical corner megacolumns + two fan/V arrangements per Park-Ave face
    for (const cx of [-HX, HX]) for (const cz of [-HZ, HZ]) {
      g.add(cyl(1.7, 1.7, BASE_H, BRONZE, cx, BASE_H / 2, cz, 10)); // corner megacolumn
    }
    for (const sx of [-1, 1]) { // the two Park-Ave-facing long faces
      const faceX = sx * HX;
      for (const fz of [-20, 20]) { // two fans per face
        const apex = new THREE.Vector3(faceX - sx * 7, 22, fz); // common node ~22m up, inset ~7m
        for (const dz of [-7, 7]) {
          g.add(strut(new THREE.Vector3(faceX, 0, fz + dz), apex, 1.6, BRONZE)); // angled mega-column
        }
      }
    }

    // transfer-truss band y24..30: dark steel box + diagonal lattice on all four faces
    const TT0 = 24, TT1 = 30;
    g.add(box(HX * 2, TT1 - TT0, HZ * 2, DARKSTONE, 0, (TT0 + TT1) / 2, 0));
    for (const [a, b] of [
      [new THREE.Vector3(HX, TT0, -HZ), new THREE.Vector3(HX, TT1, HZ)],
      [new THREE.Vector3(HX, TT0, HZ), new THREE.Vector3(HX, TT1, -HZ)],
      [new THREE.Vector3(-HX, TT0, -HZ), new THREE.Vector3(-HX, TT1, HZ)],
      [new THREE.Vector3(-HX, TT0, HZ), new THREE.Vector3(-HX, TT1, -HZ)],
      [new THREE.Vector3(-HX, TT0, HZ), new THREE.Vector3(HX, TT1, HZ)],
      [new THREE.Vector3(HX, TT0, HZ), new THREE.Vector3(-HX, TT1, HZ)],
      [new THREE.Vector3(-HX, TT0, -HZ), new THREE.Vector3(HX, TT1, -HZ)],
      [new THREE.Vector3(HX, TT0, -HZ), new THREE.Vector3(-HX, TT1, -HZ)],
    ]) g.add(strut(a, b, 0.25, STEEL_LM)); // X-brace per face

    // ground detail: double-height lobby core inside the colonnade + avenue entrance canopies
    g.add(box(30, 18, 40, GLASS_LM, 0, 9, 0)); // lobby core
    for (const sx of [-1, 1]) g.add(box(6, 0.6, 14, STEEL_LM, sx * (HX + 3), 5, 0)); // entrance canopy

    // shaft: three bronze-glass volumes with two setbacks, fin ribs + floor bands
    const volumes = [
      { y0: 30, y1: 210, hx: HX, hz: HZ }, // volume A: full footprint
      { y0: 210, y1: 330, hx: HX - 6, hz: HZ - 6 }, // volume B: inset 6m each side
      { y0: 330, y1: 410, hx: HX - 7, hz: HZ - 7 }, // volume C: inset ~14m total
    ];
    for (const v of volumes) {
      const cy = (v.y0 + v.y1) / 2, h = v.y1 - v.y0;
      g.add(box(v.hx * 2, h, v.hz * 2, BRONZE_GLASS, 0, cy, 0));
      const finN = Math.round((v.hz * 2) / 7);
      for (let i = 0; i <= finN; i++) {
        const fz = -v.hz + (i * v.hz * 2) / finN;
        for (const sx of [-1, 1]) g.add(box(0.35, h, 0.45, BRONZE, sx * (v.hx + 0.2), cy, fz)); // slim fin rib
      }
      // Foster's signature EXPRESSED DIAGRID: big bronze diamonds across both
      // Park Ave faces (and the ends), proud of the glass so they read from
      // the street — the fan base visually continues up the shaft
      const rows = Math.max(1, Math.round(h / 60));
      const rh = h / rows;
      const facets: [number, number, 'x' | 'z'][] = [
        [v.hx + 0.7, v.hz, 'x'], [-(v.hx + 0.7), v.hz, 'x'], // long faces
        [v.hz + 0.7, v.hx, 'z'], [-(v.hz + 0.7), v.hx, 'z'], // end faces
      ];
      for (const [off, half, axis] of facets) {
        const cols = Math.max(2, Math.round((half * 2) / 32));
        const cw = (half * 2) / cols;
        const P = (u: number, y: number) =>
          axis === 'x' ? new THREE.Vector3(off, y, u) : new THREE.Vector3(u, y, off);
        for (let r = 0; r < rows; r++) {
          const yb = v.y0 + r * rh, yt = yb + rh, ym = (yb + yt) / 2;
          for (let c = 0; c < cols; c++) {
            const u0 = -half + c * cw, u1 = u0 + cw, um = (u0 + u1) / 2;
            g.add(strut(P(um, yb), P(u1, ym), 0.85, BRONZE, 5)); // diamond: 4 legs
            g.add(strut(P(u1, ym), P(um, yt), 0.85, BRONZE, 5));
            g.add(strut(P(um, yt), P(u0, ym), 0.85, BRONZE, 5));
            g.add(strut(P(u0, ym), P(um, yb), 0.85, BRONZE, 5));
          }
        }
      }
    }
    for (let y = 54; y < 410; y += 24) {
      const v = y < 210 ? volumes[0] : y < 330 ? volumes[1] : volumes[2];
      g.add(box(v.hx * 2 + 0.4, 1.2, v.hz * 2 + 0.4, STEEL_LM, 0, y, 0)); // floor band
    }

    // crown y410..423: open frame + tapering fins past the roofline + beacon
    const vC = volumes[2], C0 = 410, C1 = 423;
    for (const cx of [-1, 1]) for (const cz of [-1, 1]) {
      g.add(box(0.8, C1 - C0, 0.8, BRONZE, cx * vC.hx, (C0 + C1) / 2, cz * vC.hz)); // corner post
    }
    for (const cz of [-1, 1]) g.add(box(vC.hx * 2 + 0.8, 0.6, 0.8, BRONZE, 0, C1, cz * vC.hz)); // ring beam +-z
    for (const cx of [-1, 1]) g.add(box(0.8, 0.6, vC.hz * 2 + 0.8, BRONZE, cx * vC.hx, C1, 0)); // ring beam +-x
    const finNC = Math.round((vC.hz * 2) / 7);
    for (let i = 0; i <= finNC; i++) {
      const fz = -vC.hz + (i * vC.hz * 2) / finNC;
      for (const sx of [-1, 1]) g.add(cyl(0.05, 0.3, C1 - C0, BRONZE, sx * (vC.hx + 0.25), (C0 + C1) / 2, fz, 6)); // tapering fin
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    beacon.position.set(0, 423, 0);
    g.add(beacon); // subtle beacon

    return g;
  },

  // Queensboro (Ed Koch) cantilever: twin riveted masts + humped outline truss, spanning +x (no deck)
  // Full crossing (the old build was one short hump that stopped at the west
  // channel): Manhattan approach ramp -> cantilever hump over the west channel
  // -> low connector over Roosevelt Island -> second hump over the east channel
  // -> exit deck fading toward the data edge (fog swallows it). Local +x runs
  // along the measured bridge axis; anchor is the Manhattan waterfront.
  'queensboro-bridge': (ctx) => {
    const g = new THREE.Group();
    const zc = 13, MH = 106, DECK = 40;
    const TOWERS = [60, 500, 850, 1230]; // Manhattan-side, RI west, RI east, far shore
    const towerPair = (tx: number) => {
      for (const sz of [-zc, zc]) {
        const m = latticeTower(MH, 3.4, 1.6, WARM_STEEL, 0.32, 6);
        m.position.set(tx, 0, sz);
        g.add(m);
        g.add(cyl(0, 1.2, 6, WARM_STEEL, tx, MH + 3, sz, 6)); // finial cone
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 5), WARM_STEEL);
        knob.position.set(tx, MH + 6.4, sz);
        g.add(knob);
      }
      for (const y of [34, 68, MH]) g.add(strut(new THREE.Vector3(tx, y, -zc), new THREE.Vector3(tx, y, zc), 0.3, WARM_STEEL));
      for (const [y0, y1] of [[34, 68], [68, MH]] as const) {
        g.add(strut(new THREE.Vector3(tx, y0, -zc), new THREE.Vector3(tx, y1, zc), 0.2, WARM_STEEL));
        g.add(strut(new THREE.Vector3(tx, y0, zc), new THREE.Vector3(tx, y1, -zc), 0.2, WARM_STEEL));
      }
    };
    for (const tx of TOWERS) towerPair(tx);
    // one truss panel run between xa..xb; humped (106 at ends -> 72 mid) or low
    const truss = (xa: number, xb: number, humped: boolean) => {
      const n = Math.max(4, Math.round((xb - xa) / 45));
      const X: number[] = [], TOP: number[] = [], BOT: number[] = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        X.push(xa + (xb - xa) * u);
        TOP.push(humped ? MH - (MH - 72) * 4 * u * (1 - u) : 54);
        BOT.push(DECK);
      }
      for (const sz of [-zc, zc]) {
        for (let i = 0; i < X.length; i++) {
          g.add(strut(new THREE.Vector3(X[i], TOP[i], sz), new THREE.Vector3(X[i], BOT[i], sz), 0.24, WARM_STEEL));
          if (i < X.length - 1) {
            g.add(strut(new THREE.Vector3(X[i], TOP[i], sz), new THREE.Vector3(X[i + 1], TOP[i + 1], sz), 0.26, WARM_STEEL));
            g.add(strut(new THREE.Vector3(X[i], BOT[i], sz), new THREE.Vector3(X[i + 1], BOT[i + 1], sz), 0.26, WARM_STEEL));
            g.add(strut(new THREE.Vector3(X[i], BOT[i], sz), new THREE.Vector3(X[i + 1], TOP[i + 1], sz), 0.16, WARM_STEEL));
          }
        }
      }
      for (let i = 1; i < X.length - 1; i++) {
        g.add(strut(new THREE.Vector3(X[i], TOP[i], -zc), new THREE.Vector3(X[i], TOP[i], zc), 0.16, WARM_STEEL));
      }
    };
    truss(TOWERS[0], TOWERS[1], true);  // west channel cantilever
    truss(TOWERS[1], TOWERS[2], false); // low run across Roosevelt Island
    truss(TOWERS[2], TOWERS[3], true);  // east channel cantilever
    // continuous roadway deck: approach ramp, full crossing, exit stub
    g.add(box(220, 1.2, 2 * zc + 2, DARKSTONE, -50, DECK - 3.4, 0)); // approach at ramp top
    const ramp = box(150, 1.2, 2 * zc + 2, DARKSTONE, -220, DECK - 9, 0);
    ramp.rotation.z = -0.075; // descends toward 2nd Ave
    g.add(ramp);
    g.add(box(TOWERS[3] - TOWERS[0] + 40, 1.2, 2 * zc + 2, DARKSTONE, (TOWERS[0] + TOWERS[3]) / 2, DECK - 0.6, 0));
    g.add(box(90, 1.2, 2 * zc + 2, DARKSTONE, TOWERS[3] + 65, DECK - 0.6, 0)); // fades into the fog
    // masonry piers under the approach + the Roosevelt Island run
    for (const px of [-140, -60, 10, 560, 640, 720, 790]) {
      const gy = ctx.groundAt(px, 0);
      g.add(box(6, DECK - 1 - gy, 10, DARKSTONE, px, (DECK - 1 + gy) / 2, 0));
    }
    return g;
  },
};
