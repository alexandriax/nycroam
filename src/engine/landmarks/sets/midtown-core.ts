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
const ICE_WHITE = new THREE.MeshLambertMaterial({ color: '#dfe9f2' });
// unlit warm gold: Prometheus' fire reads as flame, not just polished bronze
const FIRE_GOLD = new THREE.MeshBasicMaterial({ color: '#ffd97a' });
// planting green (GREEN_PATINA is verdigris — it reads as teal plastic on a hedge)
const FOLIAGE = new THREE.MeshLambertMaterial({ color: '#2f5c2b' });
// Top of the Rock's warm pavers and nearly colourless laminated wind screens.
// The glass is intentionally transparent here: these eight broad panels are
// cheap to sort and should not read like the old opaque blue rooftop blocks.
const ROCK_TERRACE = new THREE.MeshStandardMaterial({ color: '#887567', roughness: 0.74, metalness: 0.04 });
const ROCK_GLASS = new THREE.MeshStandardMaterial({
  color: '#cde4ea', metalness: 0.12, roughness: 0.08,
  transparent: true, opacity: 0.34, depthWrite: false,
});

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

/**
 * Abstract gilded Art Deco relief for 30 Rock's entrance panel: a low sunburst
 * with stacked chevrons and a seated silhouette. Deliberately non-literal (no
 * text, no emblems) — it reads as Lawrie's limestone-and-gold screen at a
 * glance without reproducing the carving.
 */
function decoReliefTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    c.fillStyle = '#b09758';
    c.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.88;
    for (let i = 0; i <= 14; i++) { // rays fanning from a low centre
      const a = -Math.PI + (i / 14) * Math.PI;
      c.strokeStyle = i % 2 ? '#8a7132' : '#d8c184';
      c.lineWidth = w * 0.02;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a) * w, cy + Math.sin(a) * h * 1.3);
      c.stroke();
    }
    c.strokeStyle = '#6d5824';
    c.lineWidth = w * 0.028;
    for (let k = 0; k < 4; k++) { // stacked chevrons
      const y = h * (0.24 + k * 0.11);
      c.beginPath();
      c.moveTo(w * 0.1, y);
      c.lineTo(cx, y - h * 0.08);
      c.lineTo(w * 0.9, y);
      c.stroke();
    }
    c.fillStyle = '#e6d49d'; // shoulders + head of the seated figure
    c.beginPath();
    c.arc(cx, cy, w * 0.19, Math.PI, 0);
    c.fill();
    c.beginPath();
    c.arc(cx, cy - h * 0.19, w * 0.07, 0, Math.PI * 2);
    c.fill();
  }, 256, 144);
}

/** Gilded entrance cartouche for the Channel Gardens blocks: deco frame + sunburst. */
function cartoucheTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    c.fillStyle = '#9c8446';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#c9ae66';
    c.fillRect(w * 0.06, h * 0.08, w * 0.88, h * 0.84);
    c.fillStyle = '#7d6829';
    c.fillRect(w * 0.11, h * 0.15, w * 0.78, h * 0.7);
    const cx = w / 2, cy = h * 0.55;
    for (let i = 0; i < 18; i++) { // sunburst
      const a = (i / 18) * Math.PI * 2;
      c.strokeStyle = i % 2 ? '#e3cb8c' : '#b39a55';
      c.lineWidth = w * 0.016;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a) * w * 0.34, cy + Math.sin(a) * h * 0.38);
      c.stroke();
    }
    c.fillStyle = '#f0dda8';
    c.beginPath();
    c.arc(cx, cy, w * 0.1, 0, Math.PI * 2);
    c.fill();
  }, 192, 128);
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Rockefeller Center's Lower Plaza: the sunken ice rink under 30 Rock's
  // limestone cliff, gilded Prometheus over his fountain on the west wall, the
  // flag ring, and the Channel Gardens climbing east to Fifth Avenue between
  // the British Empire Building (-z) and La Maison Francaise (+z).
  //
  // The facades are registered to the MEASURED faces of the OSM blocks they
  // dress (30 Rock's east face at local x=-13, the two Channel Gardens blocks
  // at local z=+-11.5, all read out of the tile data), so this build is purely
  // ADDITIVE: it needs no LANDMARK_CLEAR and cannot leave a hole in the block
  // if the OSM extract shifts under it. Local +x runs to Fifth Ave; the whole
  // complex is symmetric about z=0 (the anchor sits on 30 Rock's centreline).
  'rockefeller-plaza': () => {
    const g = new THREE.Group();
    // WHY the rink sits AT grade rather than in a dug-out court: the tile ground
    // is a solid plane at y=0 that a landmark cannot punch a hole through, so a
    // sunken floor is simply buried and the ice never shows. The Lower Plaza's
    // "well" is modelled the other way round instead — the ice stays at grade
    // and the surrounding promenade is a raised granite terrace, which reads the
    // same from every angle a player can reach.
    const IX0 = -6, IX1 = 30;        // ice extent along the axis
    const IZ = 9;                    // half-width of the ice
    const TW = 8;                    // promenade terrace width
    const TH = 1.35;                 // terrace height above the ice

    // ---- Lower Plaza: ice sheet ringed by the raised granite promenade ----
    g.add(box(IX1 - IX0, 0.12, IZ * 2, ICE_WHITE, (IX0 + IX1) / 2, 0.06, 0));
    for (const sz of [-1, 1]) {      // north + south terraces
      g.add(box(IX1 - IX0 + TW * 2, TH, TW, GRANITE, (IX0 + IX1) / 2, TH / 2, sz * (IZ + TW / 2)));
      g.add(box(IX1 - IX0 + TW * 2, 0.35, 0.5, MARBLE, (IX0 + IX1) / 2, TH + 0.17, sz * (IZ + 0.25))); // kerb
      g.add(box(IX1 - IX0 + TW * 2, 0.14, 0.14, GOLD, (IX0 + IX1) / 2, TH + 0.42, sz * (IZ + 0.25)));  // gold rail
    }
    g.add(box(TW, TH, IZ * 2, GRANITE, IX1 + TW / 2, TH / 2, 0));    // east terrace
    g.add(box(0.5, 0.35, IZ * 2, MARBLE, IX1 + 0.25, TH + 0.17, 0));
    g.add(box(0.14, 0.14, IZ * 2, GOLD, IX1 + 0.25, TH + 0.42, 0));
    // twin stair flights down off the east terrace onto the ice
    for (const sz of [-1, 1]) for (let i = 0; i < 4; i++) {
      g.add(box(1.1, 0.34, 5.0, GRANITE, IX1 + 0.55 + i * 1.1, TH - 0.17 - i * 0.34, sz * 5.0));
    }

    // ---- Prometheus: gilded bronze over the west fountain wall ----
    const PZ = IZ;
    g.add(box(1.6, 9.5, PZ * 2 + TW * 2, GRANITE, IX0 - 0.8, 4.75, 0));   // granite backdrop cliff
    for (let i = 0; i <= 12; i++)                                          // shallow pilaster fluting
      g.add(box(0.5, 9.5, 0.7, MARBLE, IX0 + 0.05, 4.75, -PZ - TW + (i / 12) * (PZ + TW) * 2));
    g.add(box(2.0, 0.6, PZ * 2 + TW * 2, MARBLE, IX0 - 0.8, 9.8, 0));      // capping band
    g.add(box(0.2, 4.6, 15, WATER_LM, IX0 + 0.35, 2.3, 0));                // waterfall sheet
    g.add(box(5.5, 0.3, 15, WATER_LM, IX0 + 3.0, 0.15, 0));                // pool at his base
    g.add(box(6.0, 0.5, 15.6, GRANITE, IX0 + 3.0, 0.25, 0).translateY(-0.2)); // pool kerb
    const RC = new THREE.Vector3(IX0 + 3.4, 4.2, 0);
    const zod = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.24, 8, 28), GOLD);
    zod.rotation.y = Math.PI / 2; zod.position.copy(RC); g.add(zod);  // zodiac hoop behind him
    const zod2 = new THREE.Mesh(new THREE.TorusGeometry(3.9, 0.1, 6, 24), BRONZE);
    zod2.rotation.y = Math.PI / 2; zod2.position.copy(RC); g.add(zod2);
    const P = new THREE.Group();     // built head-toward +x, then slanted
    const ptorso = cyl(0.5, 0.62, 2.5, GOLD, 0, 0, 0, 10); ptorso.rotation.z = Math.PI / 2; P.add(ptorso);
    const phead = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), GOLD);
    phead.position.set(1.6, 0.18, 0); P.add(phead);
    P.add(strut(new THREE.Vector3(-1.2, -0.1, 0.35), new THREE.Vector3(-2.9, -0.55, 0.8), 0.32, GOLD, 8));  // trailing legs
    P.add(strut(new THREE.Vector3(-1.2, -0.1, -0.35), new THREE.Vector3(-3.1, 0.2, -0.65), 0.32, GOLD, 8));
    P.add(strut(new THREE.Vector3(0.9, 0.25, 0.5), new THREE.Vector3(-0.5, 0.55, 1.6), 0.22, GOLD, 8));     // trailing arm
    P.add(strut(new THREE.Vector3(1.0, 0.3, -0.3), new THREE.Vector3(2.6, 1.5, -0.2), 0.22, GOLD, 8));      // arm bearing fire
    P.add(cyl(0, 0.42, 1.4, FIRE_GOLD, 2.8, 2.4, -0.2, 8));
    const drape = box(2.3, 0.14, 1.5, GOLD, -0.6, -0.4, 0); drape.rotation.z = 0.2; P.add(drape);
    P.rotation.z = 0.28; P.position.copy(RC); g.add(P);

    // ---- flag ring standing on the terrace, ringing the ice ----
    let fi = 0;
    for (const sz of [-1, 1]) for (let i = 0; i < 8; i++) {
      const p = flagpole(8, FLAG_COLORS[fi++ % FLAG_COLORS.length]);
      p.position.set(IX0 + 2 + i * 4.4, TH, sz * (IZ + 1.6)); g.add(p);
    }
    for (const pz of [-5, 0, 5]) { const p = flagpole(8, FLAG_COLORS[fi++ % FLAG_COLORS.length]); p.position.set(IX1 + 2.0, TH, pz); g.add(p); }

    // ---- 30 Rock's plaza front, on the measured OSM face (x = -13) ----
    const RX = -12.9, RH = 30, RZ = 15.5;
    g.add(box(1.0, RH, RZ * 2, LIMESTONE, RX - 0.5, RH / 2, 0));       // backing slab
    for (let i = 0; i <= 10; i++) {                                     // vertical limestone piers
      g.add(box(1.6, RH, 1.5, LIMESTONE, RX + 0.4, RH / 2, -RZ + (i / 10) * RZ * 2));
    }
    for (let i = 0; i < 10; i++) {                                      // recessed glazing between piers
      g.add(box(0.6, RH - 11, 1.55, DARKSTONE, RX + 0.5, (RH - 11) / 2 + 10, -RZ + ((i + 0.5) / 10) * RZ * 2));
    }
    g.add(box(1.8, 1.1, RZ * 2 + 1, MARBLE, RX + 0.5, RH + 0.55, 0));   // crowning band
    g.add(box(1.2, 9, 13, LIMESTONE, RX + 0.6, 4.5, 0));                // entrance surround
    for (const dz of [-4.2, 0, 4.2]) g.add(box(0.5, 5, 3.0, DARKSTONE, RX + 1.25, 2.5, dz)); // door bank
    const wisdom = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 5.2), new THREE.MeshLambertMaterial({ map: decoReliefTexture() }));
    wisdom.rotation.y = Math.PI / 2; wisdom.position.set(RX + 1.28, 11.2, 0); g.add(wisdom);
    g.add(box(0.6, 7, 10.5, GLASS_LM, RX + 1.0, 18, 0));                // glass screen over the panel

    // ---- Channel Gardens climbing to Fifth Avenue ----
    const GX0 = 42, GX1 = 96;
    g.add(box(GX1 - GX0, 0.1, 22, GRANITE, (GX0 + GX1) / 2, 0.05, 0));
    for (const pz of [-7, 7]) {
      g.add(box(GX1 - GX0, 0.55, 2.2, GRANITE, (GX0 + GX1) / 2, 0.275, pz));      // planter curb
      g.add(box(GX1 - GX0 - 0.8, 0.5, 1.9, FOLIAGE, (GX0 + GX1) / 2, 0.8, pz)); // clipped planting
    }
    for (let i = 0; i < 6; i++) {   // six basins, each with a bronze fountain figure
      const bx = GX0 + 4 + i * 9.6;
      g.add(box(4.2, 0.45, 3.4, GRANITE, bx, 0.225, 0));
      g.add(box(3.8, 0.1, 3.0, WATER_LM, bx, 0.5, 0));
      g.add(cyl(0.18, 0.26, 1.2, BRONZE, bx, 1.05, 0, 8));
      const tri = figure(1.5, BRONZE); tri.position.set(bx, 1.6, 0); tri.rotation.y = i * 1.1; g.add(tri);
    }

    // ---- the two Channel Gardens blocks, dressed on their measured inner faces ----
    for (const sz of [-1, 1]) {
      const fz = sz * 11.4;
      for (const [x0, x1, h] of [[44, 72, 29], [72, 103, 24]] as const) {
        g.add(box(x1 - x0, h, 0.6, LIMESTONE, (x0 + x1) / 2, h / 2, fz));
        const n = Math.round((x1 - x0) / 4);
        for (let i = 0; i <= n; i++) {  // limestone piers standing proud of the face
          g.add(box(1.3, h, 1.2, LIMESTONE, x0 + (i / n) * (x1 - x0), h / 2, fz - sz * 0.55));
        }
        for (let i = 0; i < n; i++) {   // recessed spandrel glazing between them
          g.add(box(2.2, h - 7.5, 0.6, DARKSTONE, x0 + ((i + 0.5) / n) * (x1 - x0), (h - 7.5) / 2 + 5, fz - sz * 0.5));
        }
        g.add(box(x1 - x0 + 1, 1.2, 1.9, MARBLE, (x0 + x1) / 2, h + 0.6, fz - sz * 0.45));        // cornice
        g.add(box(x1 - x0 - 2, 0.35, 1.5, FOLIAGE, (x0 + x1) / 2, h + 1.4, fz - sz * 0.45)); // roof garden
      }
      // gilded cartouche over the block's Channel Gardens entrance
      const cart = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 4.2), new THREE.MeshLambertMaterial({ map: cartoucheTexture() }));
      cart.rotation.y = sz > 0 ? Math.PI : 0;
      cart.position.set(58, 8.6, fz - sz * 0.62);
      g.add(cart);
      g.add(box(4.0, 5.0, 0.6, DARKSTONE, 58, 2.5, fz - sz * 0.55)); // entrance doors
    }
    return g;
  },

  // Atlas at 630 Fifth: a muscular bronze kneeling under an open armillary
  // sphere with a broad tilted zodiac belt, facing Fifth Ave (+x) and St
  // Patrick's across the street. ~14m to the top of the sphere, like the real
  // 45ft group, on Lawrie's stepped granite pedestal in the forecourt.
  atlas: () => {
    const g = new THREE.Group();
    // stepped granite pedestal
    g.add(box(9, 0.5, 9, GRANITE, 0, 0.25, 0));
    g.add(box(7.4, 0.5, 7.4, GRANITE, 0, 0.75, 0));
    g.add(box(5.6, 2.0, 5.6, GRANITE, 0, 2.0, 0));
    g.add(box(6.2, 0.4, 6.2, DARKSTONE, 0, 3.2, 0));
    const y0 = 3.4;

    // figure + sphere built facing +z, then swung to face Fifth Ave (+x)
    const A = new THREE.Group();
    A.add(box(1.35, 0.75, 1.0, BRONZE, 0, y0 + 1.05, 0));                    // pelvis
    const torso = cyl(0.92, 0.76, 2.1, BRONZE, 0, y0 + 2.35, 0.18, 10);
    torso.rotation.x = -0.22; A.add(torso);
    A.add(box(1.95, 0.55, 0.85, BRONZE, 0, y0 + 3.3, 0.3));                  // shoulders
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), BRONZE);
    head.position.set(0, y0 + 3.85, 0.42); A.add(head);
    // braced forward leg + kneeling back leg
    A.add(strut(new THREE.Vector3(-0.55, y0 + 0.85, 0.15), new THREE.Vector3(-0.85, y0 + 0.1, 1.3), 0.33, BRONZE, 8));
    A.add(strut(new THREE.Vector3(-0.85, y0 + 0.1, 1.3), new THREE.Vector3(-0.85, y0 - 0.05, 2.35), 0.28, BRONZE, 8));
    A.add(box(0.75, 0.24, 1.1, BRONZE, -0.85, y0 - 0.03, 2.7));              // forward foot
    A.add(strut(new THREE.Vector3(0.55, y0 + 0.85, 0.0), new THREE.Vector3(0.85, y0 + 0.05, -1.0), 0.33, BRONZE, 8));
    A.add(strut(new THREE.Vector3(0.85, y0 + 0.05, -1.0), new THREE.Vector3(0.85, y0, -2.2), 0.28, BRONZE, 8));
    // both arms thrust up and out to the sphere's underside
    for (const sx of [-1, 1]) {
      A.add(strut(new THREE.Vector3(sx * 0.88, y0 + 3.25, 0.25), new THREE.Vector3(sx * 1.8, y0 + 4.3, -0.1), 0.26, BRONZE, 8));
      A.add(strut(new THREE.Vector3(sx * 1.8, y0 + 4.3, -0.1), new THREE.Vector3(sx * 1.5, y0 + 5.5, -0.35), 0.22, BRONZE, 8));
    }
    // open armillary sphere on a polar axis, with a broad gilded zodiac belt
    const C = new THREE.Vector3(0, y0 + 8.0, -0.25), R = 3.2;
    const eq = new THREE.Mesh(new THREE.TorusGeometry(R, 0.13, 8, 28), BRONZE);
    eq.rotation.x = Math.PI / 2; eq.position.copy(C); A.add(eq);
    for (let i = 0; i < 3; i++) { // meridians
      const m = new THREE.Mesh(new THREE.TorusGeometry(R, 0.1, 6, 24), BRONZE);
      m.rotation.y = (i / 3) * Math.PI; m.position.copy(C); A.add(m);
    }
    const belt = new THREE.Mesh(new THREE.TorusGeometry(R + 0.06, 0.45, 4, 30), GOLD);
    belt.rotation.x = Math.PI / 2 - 0.41; belt.rotation.z = 0.22; belt.position.copy(C); A.add(belt);
    const axis = cyl(0.11, 0.11, R * 2 + 2.6, BRONZE, C.x, C.y, C.z, 8);
    axis.rotation.x = 0.72; A.add(axis);
    A.rotation.y = Math.PI / 2;
    g.add(A);

    // forecourt: low granite steps and flanking kerbs out toward Fifth Ave
    for (let i = 0; i < 3; i++) g.add(box(1.0, 0.18, 13 - i * 1.6, GRANITE, 5.2 + i, 0.09 + i * 0.0, 0));
    for (const sz of [-1, 1]) g.add(box(11, 0.5, 1.0, GRANITE, 1.5, 0.25, sz * 6.4));
    return g;
  },

  // Top of the Rock spans the source massing's real 235m, 245m and 260m
  // setbacks (67th, 69th and 70th floors). The old build started at 259.5m,
  // then stacked three decks and a 12m equipment box to roughly 280m even
  // though 30 Rock's documented architectural top is 850ft / 259.1m.
  'top-of-the-rock': (ctx) => {
    const g = new THREE.Group();
    const fitW = ctx.fit?.w ?? 100.4;
    const fitD = ctx.fit?.d ?? 31.3;
    const roof = ctx.fit?.roofH ?? 260;
    const topW = ctx.fit?.topW ?? 70.5;
    const topD = ctx.fit?.topD ?? 19.3;

    // These footprint centers and dimensions come directly from the retained
    // OSM bands after transforming them into the fit's local frame. Thin
    // terrace skins sit just above the existing roofs, eliminating coplanar
    // overlap while preserving the accurate Art Deco setback silhouette.
    const decks = [
      { x: 2.4, y: roof - 25, w: fitW - 4.8, d: fitD, glass: true },
      { x: 4.7, y: roof - 15, w: fitW - 9.4, d: fitD, glass: true },
      { x: -5.6, y: roof, w: topW, d: topD, glass: false },
    ] as const;
    for (const deck of decks) {
      g.add(box(deck.w - 0.4, 0.12, deck.d - 0.4, ROCK_TERRACE, deck.x, deck.y + 0.07, 0));
      if (deck.glass) {
        // The 67th/69th floors use laminated glass wind screens. Four broad
        // panes and four steel cap rails per level retain their transparent,
        // ocean-liner-deck character for only eight transparent objects.
        const ph = 2.05, inset = 0.18;
        for (const z of [-deck.d / 2 + inset, deck.d / 2 - inset]) {
          g.add(box(deck.w - 0.8, ph, 0.10, ROCK_GLASS, deck.x, deck.y + ph / 2 + 0.12, z));
          g.add(box(deck.w - 0.6, 0.09, 0.16, STEEL_LM, deck.x, deck.y + ph + 0.16, z));
        }
        for (const x of [deck.x - deck.w / 2 + inset, deck.x + deck.w / 2 - inset]) {
          g.add(box(0.10, ph, deck.d - 0.8, ROCK_GLASS, x, deck.y + ph / 2 + 0.12, 0));
          g.add(box(0.16, 0.09, deck.d - 0.6, STEEL_LM, x, deck.y + ph + 0.16, 0));
        }
      } else {
        // The 70th-floor roof is explicitly fully open-air and has no glass
        // screen. A waist-high limestone parapet is the complete skyline cap;
        // no invented equipment room or crown rises above it.
        const h = 0.72, t = 0.42;
        for (const z of [-deck.d / 2 + t / 2, deck.d / 2 - t / 2]) {
          g.add(box(deck.w, h, t, LIMESTONE, deck.x, deck.y + h / 2 + 0.12, z));
        }
        for (const x of [deck.x - deck.w / 2 + t / 2, deck.x + deck.w / 2 - t / 2]) {
          g.add(box(t, h, deck.d - t * 2, LIMESTONE, x, deck.y + h / 2 + 0.12, 0));
        }
      }
    }
    return g;
  },

  // St. Patrick's at full block scale. The old build was a 20x50 box whose
  // front sat at local z=+9 — but the cleared block runs from the 5th Ave
  // frontage at z~+70 back to z~-55 by Madison (the OSM spire parts stood at
  // z=63, r=16 clear), so the replica floated 60m back on an empty apron and
  // read toy-sized from the street. Rebuilt to the measured envelope: 124m
  // front-to-apse, 53m across the transepts, centred on the block (x=+7),
  // with the west front ON the avenue building line. Real proportions: nave
  // ridge ~34m, twin spires 100.5m.
  'st-patricks': () => {
    const g = new THREE.Group();
    const CX = 7;        // block centreline (measured from the clears)
    const FZ = 68;       // west-front plane, on the 5th Ave building line
    const NW = 33;       // nave-with-aisles width
    // gabled roof as a true triangular prism (the stretched-pyramid trick used
    // on small hipped roofs splays into a flat sheet at nave length: scale is
    // applied before rotation, so the stretch lands on a diagonal)
    const ridge = (w: number, len: number, h: number, x: number, y: number, z: number, alongX = false): void => {
      const shp = new THREE.Shape();
      shp.moveTo(-w / 2, 0);
      shp.lineTo(w / 2, 0);
      shp.lineTo(0, h);
      shp.closePath();
      const geo = new THREE.ExtrudeGeometry(shp, { depth: len, bevelEnabled: false });
      geo.translate(0, 0, -len / 2);
      const m = new THREE.Mesh(geo, DARKSTONE);
      if (alongX) m.rotation.y = Math.PI / 2;
      m.position.set(x, y, z);
      g.add(m);
    };

    // ---- nave: aisles + clerestory running the full block ----
    const NZ0 = -34, NZ1 = FZ - 2;               // nave extent, front to crossing-past-choir
    const NLEN = NZ1 - NZ0, NMID = (NZ0 + NZ1) / 2;
    g.add(box(NW, 15, NLEN, MARBLE, CX, 7.5, NMID));          // aisle band
    g.add(box(NW - 12, 25, NLEN, MARBLE, CX, 12.5, NMID));    // clerestory
    ridge(NW - 12, NLEN, 9, CX, 25, NMID);                    // steep nave roof to ~34m
    for (const sx of [-1, 1]) {                               // aisle roofs (sloped slabs)
      const ar = box(7.2, 0.7, NLEN, DARKSTONE, CX + sx * (NW / 2 - 3.4), 16.4, NMID);
      ar.rotation.z = sx * 0.32;
      g.add(ar);
    }
    // buttress piers + pinnacles marching down both aisles
    for (let z = NZ1 - 8; z > NZ0 + 2; z -= 8.5) for (const sx of [-1, 1]) {
      const bx = CX + sx * (NW / 2 + 0.4);
      g.add(box(1.6, 15, 2.2, MARBLE, bx, 7.5, z));
      g.add(cyl(0.05, 0.7, 4.2, MARBLE, bx, 17.1, z, 4));
      g.add(strut(new THREE.Vector3(bx, 14.5, z), new THREE.Vector3(CX + sx * (NW / 2 - 6.2), 24, z), 0.35, MARBLE, 6)); // flyer
    }
    // clerestory + aisle windows: dark pointed lancets
    for (let z = NZ1 - 10; z > NZ0 + 4; z -= 8.5) for (const sx of [-1, 1]) {
      g.add(box(0.3, 7, 2.4, DARKSTONE, CX + sx * (NW / 2 - 5.9), 20, z - 4.2));
      g.add(box(0.3, 8, 3.2, DARKSTONE, CX + sx * (NW / 2 + 0.05), 8, z - 4.2));
    }

    // ---- transepts: the 53m cross-arms ----
    const TZ = 6, TW = 53;                        // transept centreline + full width
    g.add(box(TW, 15, 18, MARBLE, CX, 7.5, TZ));
    g.add(box(TW, 25, 12, MARBLE, CX, 12.5, TZ));
    ridge(12, TW, 8, CX, 25, TZ, true);
    for (const sx of [-1, 1]) {                   // transept gable fronts: rose + portal
      const tx = CX + sx * (TW / 2 - 0.6);
      const trose = new THREE.Mesh(new THREE.CircleGeometry(3.4, 20), new THREE.MeshBasicMaterial({ map: roseTexture() }));
      trose.position.set(tx + sx * 0.45, 20, TZ);
      trose.rotation.y = sx * Math.PI / 2;
      g.add(trose);
      g.add(box(0.4, 8, 5, DARKSTONE, tx + sx * 0.15, 4, TZ));
      for (const dz of [-5, 5]) g.add(cyl(0.05, 0.8, 5, MARBLE, tx, 27.5, TZ + dz, 4)); // gable pinnacles
    }

    // ---- choir + Lady Chapel apse toward Madison ----
    g.add(box(NW - 6, 13, 14, MARBLE, CX, 6.5, NZ0 - 7));     // choir
    g.add(box(NW - 18, 21, 14, MARBLE, CX, 10.5, NZ0 - 7));
    ridge(NW - 18, 14, 7, CX, 21, NZ0 - 7);
    // Lady Chapel + rounded apse held to the Madison Ave building line (~z=-55):
    // Madison here is a 14m "secondary" (7m half-roadbed), and the earlier
    // NZ0-19/NZ0-25 layout pushed the apse out to z~-66 — 11m into the avenue,
    // so the choir's rounded back read as spilling across the Madison roadbed.
    g.add(box(14, 16, 12, MARBLE, CX, 8, NZ0 - 10));          // Lady Chapel
    const apse = cyl(6, 6, 16, MARBLE, CX, 8, NZ0 - 15, 10);  // rounded apse end, at the building line
    g.add(apse);
    g.add(cyl(0.2, 6.5, 5, DARKSTONE, CX, 18.5, NZ0 - 15, 10)); // apse cone roof

    // ---- west front on the avenue: twin towers, spires to 100.5m ----
    for (const sx of [-1, 1]) {
      const tx = CX + sx * 13.5;
      g.add(box(10, 55, 10, MARBLE, tx, 27.5, FZ - 5));       // square tower
      g.add(box(11, 1.2, 11, MARBLE, tx, 55.6, FZ - 5));      // cornice
      g.add(cyl(0.4, 4.6, 44, MARBLE, tx, 78.5, FZ - 5, 8));  // octagonal spire (tip 100.5)
      for (const [px, pz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const)
        g.add(cyl(0.05, 0.7, 6, MARBLE, tx + px, 59, FZ - 5 + pz, 4)); // corner pinnacles
      for (const wy of [12, 26, 40]) g.add(box(3.4, 6.5, 0.4, DARKSTONE, tx, wy, FZ - 0.15)); // tower lancets
    }
    g.add(box(19, 34, 3, MARBLE, CX, 17, FZ - 1.5));          // gabled centre bay
    const rose = new THREE.Mesh(new THREE.CircleGeometry(4.6, 24), new THREE.MeshBasicMaterial({ map: roseTexture() }));
    rose.position.set(CX, 22.5, FZ + 0.06);
    g.add(rose);
    const roseArch = archWall(13, 15, 0.7, 10.2, 14, MARBLE); // pointed surround over the rose
    roseArch.position.set(CX, 14, FZ + 0.2);
    g.add(roseArch);
    for (const s of [-1, 1]) {                                // centre gable peak
      const gb = box(1.0, 13, 1.1, MARBLE, CX + s * 4.6, 37.5, FZ - 1.2);
      gb.rotation.z = s * 0.62;
      g.add(gb);
    }
    // triple pointed-arch portals with dark recesses
    for (const [dx, pw, ph] of [[-8, 5.4, 11], [0, 7, 14], [8, 5.4, 11]] as const) {
      const p = archWall(pw, ph, 0.9, pw - 2.2, ph - 2.5, MARBLE);
      p.position.set(CX + dx, 0, FZ + 0.3);
      g.add(p);
      g.add(box(pw - 2.4, ph - 3, 0.3, DARKSTONE, CX + dx, (ph - 3) / 2, FZ));
    }
    // shallow entrance steps down to the sidewalk
    for (let i = 0; i < 3; i++) g.add(box(30, 0.18, 1.1, GRANITE, CX, 0.09 + i * 0.0, FZ + 1.2 + i));
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
