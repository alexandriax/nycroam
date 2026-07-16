import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, GOLD, STEEL_LM, GLASS_LM, WHITE_LM,
  box, cyl, strut, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Midtown East set — Grand Central's Beaux-Arts front, the Chrysler crown, the
 * One Vanderbilt spire, the UN Secretariat, the Roosevelt Island Tram and the
 * Queensboro cantilever. Each builder returns a group whose origin sits at
 * ground level; the manager rotates/positions/merges it. The Chrysler and One
 * Vanderbilt shafts already exist from OSM — those builders add only the
 * signature crown that OSM lacks.
 */

// Set-local materials (justified: the brief mandates a specific tram red and a
// warm-tinted steel, neither of which is in the shared kit).
const RED_TRAM = new THREE.MeshStandardMaterial({ color: '#b3231f', metalness: 0.3, roughness: 0.5 });
const WARM_STEEL = new THREE.MeshStandardMaterial({ color: '#9a9184', metalness: 0.72, roughness: 0.42 });

// Tapered 4-leg lattice tower (X-braced), origin at ground; reused by tram + bridge.
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

// Rounded red tram cabin with a wrap-around glass band and roof grip.
function tramCabin(): THREE.Group {
  const c = new THREE.Group();
  c.add(box(5.4, 3.2, 3.2, RED_TRAM, 0, 0, 0)); // body
  for (const [sx, sz] of [[2.7, 1.6], [-2.7, 1.6], [2.7, -1.6], [-2.7, -1.6]] as const)
    c.add(cyl(0.5, 0.5, 3.2, RED_TRAM, sx, 0, sz, 8)); // rounded vertical corners
  c.add(box(5.5, 1.3, 3.3, GLASS_LM, 0, 0.4, 0)); // window band
  c.add(box(5.6, 0.3, 3.4, STEEL_LM, 0, 1.75, 0)); // roof cap
  c.add(box(1.2, 0.7, 0.9, STEEL_LM, 0, 2.15, 0)); // grip bogie
  return c;
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
  chrysler: () => {
    const g = new THREE.Group();
    // real crown base is ~15m radius — 24 made it flare wider than the tower
    g.add(cyl(4, 15, 42, STEEL_LM, 0, 261, 0, 8)); // tapered core mass under the arches (y 240..282)
    const depth = 3;
    for (let f = 0; f < 4; f++) {
      const facePane = new THREE.Group();
      facePane.rotation.y = (f * Math.PI) / 2;
      for (let i = 0; i < 7; i++) {
        const r = 15 - 1.85 * i; // 15 -> 3.9
        const cy = 240 + 6 * i; // spring line 240 -> 276
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
    g.add(cyl(0.05, 1.2, 37, STEEL_LM, 0, 300.5, 0, 8)); // needle spire 282 -> 319
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 5), STEEL_LM);
    ball.position.y = 319;
    g.add(ball);
    for (let k = 0; k < 4; k++) {
      const e = chryslerEagle();
      e.position.set(0, 235, 0);
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
    // General Assembly hall in front (+z): low sweeping form with a shallow dome
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
    ga.position.set(0, 0, 42);
    g.add(ga);
    // 30-flag row along the avenue edge, each a plain solid-color flag (no emblems)
    const N = 30, span = 84;
    for (let i = 0; i < N; i++) {
      const x = -span / 2 + (i * span) / (N - 1);
      g.add(cyl(0.09, 0.11, 13, WHITE_LM, x, 6.5, 62, 6));
      const flagMat = new THREE.MeshLambertMaterial({ color: `hsl(${Math.floor((i / N) * 360)}, 68%, 55%)` });
      g.add(box(2.4, 1.5, 0.06, flagMat, x + 1.3, 11.8, 62));
    }
    return g;
  },

  // Roosevelt Island Tram: two red lattice pylons, cable pairs, a hanging red cabin, ground canopy
  'roosevelt-tram': () => {
    const g = new THREE.Group();
    const p1 = latticeTower(25, 2.4, 1.4, RED_TRAM, 0.22, 4);
    p1.position.set(8, 0, 0);
    g.add(p1);
    const p2 = latticeTower(40, 3.0, 1.6, RED_TRAM, 0.26, 6);
    p2.position.set(26, 0, 0);
    g.add(p2);
    // two cable pairs: terminal -> pylon1 top -> pylon2 top -> up toward the +x (river) edge
    const anchors = [
      new THREE.Vector3(-3, 7, 0),
      new THREE.Vector3(8, 25, 0),
      new THREE.Vector3(26, 40, 0),
      new THREE.Vector3(48, 56, 0),
    ];
    for (const dz of [-1.2, -0.7, 0.7, 1.2]) {
      for (let i = 0; i < anchors.length - 1; i++) {
        const a = anchors[i].clone(); a.z += dz;
        const b = anchors[i + 1].clone(); b.z += dz;
        g.add(strut(a, b, 0.07, STEEL_LM));
      }
    }
    const cabin = tramCabin();
    cabin.position.set(16, 26, 0); // hanging between the pylons
    g.add(cabin);
    g.add(strut(new THREE.Vector3(16, 31.7, 0), new THREE.Vector3(16, 28, 0), 0.12, STEEL_LM)); // hanger to cable
    // terminal canopy at the -x (Manhattan) ground end
    const term = new THREE.Group();
    term.add(box(8, 0.4, 6, STEEL_LM, 0, 5.5, 0));
    for (const [cx, cz] of [[-3.4, -2.4], [3.4, -2.4], [-3.4, 2.4], [3.4, 2.4]] as const)
      term.add(cyl(0.16, 0.16, 5.5, GRANITE, cx, 2.75, cz, 6));
    term.position.set(-3, 0, 0);
    g.add(term);
    return g;
  },

  // Queensboro (Ed Koch) cantilever: twin riveted masts + humped outline truss, spanning +x (no deck)
  'queensboro-bridge': () => {
    const g = new THREE.Group();
    const zc = 13, xT1 = 0, xT2 = 180, MH = 106;
    // two cantilever towers, each a pair of X-braced masts joined by portal bracing + finials
    for (const tx of [xT1, xT2]) {
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
    }
    // humped cantilever truss: upper chord peaks at the towers (106) and dips mid-span (72)
    const X = [-30, 0, 30, 60, 90, 120, 150, 180, 215, 250];
    const TOP = [52, 106, 92, 78, 72, 78, 92, 106, 74, 52];
    const BOT = [44, 40, 40, 40, 40, 40, 40, 40, 42, 46];
    for (const sz of [-zc, zc]) {
      for (let i = 0; i < X.length; i++) {
        g.add(strut(new THREE.Vector3(X[i], TOP[i], sz), new THREE.Vector3(X[i], BOT[i], sz), 0.24, WARM_STEEL)); // vertical
        if (i < X.length - 1) {
          g.add(strut(new THREE.Vector3(X[i], TOP[i], sz), new THREE.Vector3(X[i + 1], TOP[i + 1], sz), 0.26, WARM_STEEL)); // top chord
          g.add(strut(new THREE.Vector3(X[i], BOT[i], sz), new THREE.Vector3(X[i + 1], BOT[i + 1], sz), 0.26, WARM_STEEL)); // bottom chord
          g.add(strut(new THREE.Vector3(X[i], BOT[i], sz), new THREE.Vector3(X[i + 1], TOP[i + 1], sz), 0.16, WARM_STEEL)); // diagonal
        }
      }
    }
    // lateral bracing between the two truss planes along the top chord
    for (let i = 1; i < X.length - 1; i++) {
      g.add(strut(new THREE.Vector3(X[i], TOP[i], -zc), new THREE.Vector3(X[i], TOP[i], zc), 0.16, WARM_STEEL));
    }
    return g;
  },
};
