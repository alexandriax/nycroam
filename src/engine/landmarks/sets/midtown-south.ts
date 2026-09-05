import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, GOLD, STEEL_LM, GLASS_LM, WHITE_LM,
  WATER_LM, GREEN_PATINA,
  box, cyl, strut, lathe, figure, twoSidedPanel,
  billboardTexture, billboardMaterial,
} from '../kit';

/**
 * Midtown South set — Empire State crown, NYPL, Bryant Park, MSG, Times Square,
 * the theater district. Each builder returns a group whose origin sits at
 * ground level; the manager rotates/positions/merges it. Several of these
 * landmarks (Empire State shaft, MSG bowl) already exist from OSM — those
 * builders add only the signature crown/skin that OSM lacks.
 */

// Warm pink-Tennessee-marble tint for the lions (Patience & Fortitude).
const LION_MARBLE = new THREE.MeshLambertMaterial({ color: '#ece0cf' });

// Scaled-sphere ellipsoid (semi-axes rx,ry,rz) — the organic masses of the lions.
function blob(rx: number, ry: number, rz: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), mat);
  m.scale.set(rx, ry, rz);
  m.position.set(x, y, z);
  return m;
}

// Reclining marble lion (Patience / Fortitude) on a tall granite plinth, facing +z:
// hindquarters low at the rear (-z), chest raised and head held high at the front,
// both forelegs stretched forward to paws, layered mane, tail curled on the flank.
function lion(): THREE.Group {
  const g = new THREE.Group();
  // stepped granite plinth (~4.2 m so the ~3.6 m lion rests fully on it)
  g.add(box(2.4, 0.45, 4.2, GRANITE, 0, 0.225, 0));        // base slab
  g.add(box(2.0, 1.15, 3.75, GRANITE, 0, 1.02, 0));        // die
  g.add(box(2.3, 0.34, 4.05, GRANITE, 0, 1.76, 0));        // cornice cap
  const PT = 1.93;                                          // plinth top the lion rests on
  // Proportions per the real pair: ~3.4 m nose-to-rump, head held at ~1.8 m
  // over the plinth, and the MANE reads as a collar around a distinct head —
  // an oversized mane ball swallows the whole animal from the front.
  // body barrel: one long low ellipsoid, clearly the dominant mass
  g.add(blob(0.60, 0.62, 1.35, LION_MARBLE, 0, PT + 0.92, -0.30));    // body barrel
  g.add(blob(0.46, 0.58, 0.70, LION_MARBLE, 0.40, PT + 0.72, -1.30)); // right haunch
  g.add(blob(0.46, 0.58, 0.70, LION_MARBLE, -0.40, PT + 0.72, -1.30));// left haunch
  for (const sx of [-0.56, 0.56])
    g.add(box(0.26, 0.30, 0.9, LION_MARBLE, sx, PT + 0.24, -0.95));   // folded hind shanks
  g.add(blob(0.52, 0.66, 0.52, LION_MARBLE, 0, PT + 1.10, 0.55));     // deep raised chest
  // forelegs stretched straight to paws at the plinth edge
  for (const sx of [-0.33, 0.33]) {
    g.add(box(0.28, 0.32, 1.35, LION_MARBLE, sx, PT + 0.18, 1.10));   // foreleg
    g.add(box(0.36, 0.24, 0.52, LION_MARBLE, sx, PT + 0.12, 1.88));   // paw
  }
  // head group: skull + muzzle proud of the mane ruff
  g.add(blob(0.30, 0.32, 0.30, LION_MARBLE, 0, PT + 1.80, 1.28));     // skull
  g.add(blob(0.19, 0.16, 0.26, LION_MARBLE, 0, PT + 1.72, 1.56));     // rounded muzzle
  g.add(blob(0.24, 0.09, 0.14, LION_MARBLE, 0, PT + 1.95, 1.44));     // heavy brow
  for (const sx of [-0.22, 0.22]) g.add(box(0.14, 0.18, 0.12, LION_MARBLE, sx, PT + 2.04, 1.14)); // ears
  // mane: ONE consolidated ruff behind the head sloping into the chest — a
  // ring of separate lobes reads as poodle pom-poms from the avenue
  g.add(blob(0.54, 0.58, 0.30, LION_MARBLE, 0, PT + 1.74, 1.02));     // face ruff disc
  g.add(blob(0.46, 0.54, 0.44, LION_MARBLE, 0, PT + 1.52, 0.78));     // mane body into shoulders
  g.add(blob(0.34, 0.46, 0.28, LION_MARBLE, 0, PT + 1.12, 0.96));     // chest bib
  // tail curled forward along the right flank, resting on the plinth
  g.add(strut(new THREE.Vector3(0.1, PT + 0.62, -1.85), new THREE.Vector3(0.62, PT + 0.5, -1.0), 0.10, LION_MARBLE, 6));
  g.add(strut(new THREE.Vector3(0.62, PT + 0.5, -1.0), new THREE.Vector3(0.66, PT + 0.40, -0.1), 0.10, LION_MARBLE, 6));
  g.add(blob(0.15, 0.15, 0.19, LION_MARBLE, 0.66, PT + 0.40, 0.0));   // tail tuft
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

// Round-arched opening (portico arch or wing window): a dark recess + a
// semicircular shadowed head + a marble archivolt ring, all facing +z. `cx`
// is the local-x center, `sill` the bottom y, `w` the opening width, `rectH`
// the straight jamb height below the semicircle, `z` the wall plane.
function archOpening(cx: number, sill: number, w: number, rectH: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const r = w / 2;
  const spring = sill + rectH;                                              // where the semicircle starts
  g.add(box(w, rectH, 0.4, DARKSTONE, cx, sill + rectH / 2, z));            // rectangular recess
  const head = cyl(r, r, 0.4, DARKSTONE, cx, spring, z, 14);               // disc → arched head
  head.rotation.x = Math.PI / 2;                                           // face the avenue
  g.add(head);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.24, 0.26, 6, 14, Math.PI), MARBLE);
  ring.position.set(cx, spring, z + 0.2);                                  // marble archivolt (top half)
  g.add(ring);
  return g;
}

// One monumental Corinthian column (base, tapered shaft, flared capital, abacus)
// standing on the terrace at local-x `cx`, projected forward to `z`.
function corinthianColumn(cx: number, z: number): THREE.Group {
  const c = new THREE.Group();
  c.add(box(1.9, 0.6, 1.9, MARBLE, cx, 3.0, z));            // base plinth (y 2.7..3.3)
  c.add(cyl(0.78, 0.92, 13.7, MARBLE, cx, 10.15, z, 12));   // shaft (y 3.3..17)
  c.add(cyl(0.98, 0.8, 1.1, MARBLE, cx, 17.55, z, 12));     // capital bell (y 17..18.1)
  c.add(box(1.9, 0.4, 1.9, MARBLE, cx, 18.3, z));           // abacus (y 18.1..18.5)
  return c;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Empire State: art-deco crown + dirigible mast only (OSM builds the shaft below y=373)
  'empire-state': (ctx) => {
    // ESB crown: OSM masses the tower to its 330m upper roof plus two crude
    // stick parts for the mast — the pipeline clears the sticks and we build
    // the art-deco drum + dirigible mast from the measured roof up.
    const g = new THREE.Group();
    const roof = ctx.fit?.keptH ?? 330;
    const tip = Math.max(ctx.fit?.roofH ?? 443.2, 443.2); // OSM's cleared mast reached here
    // The limestone observation tower continues to 381 m; the antenna is
    // the final 62 m. Keep the measured OSM roof as the attachment datum.
    const crownTop = 381;
    const crownRise = Math.max(8, crownTop - roof);
    for (let i = 0; i < 3; i++) {
      const h = crownRise / 3, w = 16 - i * 3.5;
      const y = roof + i*h;
      g.add(box(w,h,w,LIMESTONE,0,y+h/2,0));
      for (const side of [-1,1]) for (let x = -w/2+2; x < w/2; x += 2.4) {
        g.add(box(.95,h-1.2,.16,GLASS_LM,x,y+h/2,side*(w/2+.02)));
        g.add(box(.16,h-1.2,.95,GLASS_LM,side*(w/2+.02),y+h/2,x));
      }
      g.add(box(w+.6,.65,w+.6,STEEL_LM,0,y+h,0));
    }
    const mastBase = Math.max(crownTop, roof+crownRise);
    g.add(cyl(.35,1.45,tip-mastBase,STEEL_LM,0,(mastBase+tip)/2,0,16));
    for (let y=mastBase+4;y<tip-5;y+=5.5) {
      g.add(cyl(.8,.8,.28,STEEL_LM,0,y,0,12));
    }
    return g;
  },

  // NYPL main branch (Carrère & Hastings, 1911): white-marble Beaux-Arts Fifth
  // Ave facade — triple-arch portico, arcaded wings, balustraded parapet, wall
  // fountains, flagpoles, a granite terrace stair, and Patience & Fortitude.
  // A pure facade fronting the kept OSM massing (front wall z=-21, 22 m tall,
  // ~113 m frontage). Composition centered on that massing at local x=6.5.
  'nypl': () => {
    const g = new THREE.Group();
    const FC = 6.5;          // frontage center (the OSM front face runs x -50..+63)
    const HW = 57;           // half of the 114 m Fifth-Avenue frontage
    const WZ = -19;          // front plane of the marble facade wall (OSM wall at z=-21)
    const TERR = 2.7;        // terrace top height
    const CORN = 22;         // main cornice line — caps the 22 m OSM box
    // OSM models the library's projecting central pavilion as its own part
    // reaching z=-14.9 — 4 m PROUD of the wing wall plane. The whole portico
    // composition sits on that pavilion (as on the real building), fronted by
    // a solid marble block that swallows the tan OSM faces; anything left at
    // the WZ plane in the centre would be hidden behind it.
    const PAV = -13.9;       // front plane of the portico pavilion cladding

    // ---- raised terrace / podium and the marble facade wall behind it ----
    g.add(box(2 * HW, TERR, 15, GRANITE, FC, TERR / 2, -12));        // terrace platform (z -19.5..-4.5)
    g.add(box(2 * HW, 0.5, 0.6, MARBLE, FC, TERR - 0.25, -4.5));     // marble front nosing
    g.add(box(2 * HW, CORN - TERR, 2, MARBLE, FC, (CORN + TERR) / 2, WZ - 1)); // wall, y 2.7..22, z -21..-19
    // solid pavilion block: clads the OSM part (x -17.1..26.2, front -14.9)
    // front AND flanks so no window-grid face survives inside the portico
    g.add(box(45, CORN - TERR, 5.5, MARBLE, 4.5, (CORN + TERR) / 2, PAV - 2.75));

    // ---- flanking wings: tall round-arched windows between engaged pilasters ----
    for (const wc of [-31, 44]) {
      for (const dx of [-11.7, -3.9, 3.9, 11.7]) g.add(archOpening(wc + dx, 7, 3.2, 8, WZ + 0.1));
      for (const dx of [-15.6, -7.8, 0, 7.8, 15.6]) g.add(box(0.9, 15.3, 0.6, MARBLE, wc + dx, 10.35, WZ + 0.3));
    }
    // ---- end pavilions, slightly proud, each with a tall niche ----
    for (const cx of [-48, 61]) {
      g.add(box(6, CORN - TERR, 1.0, MARBLE, cx, (CORN + TERR) / 2, WZ + 0.5));
      g.add(box(6.5, 1.3, 1.6, MARBLE, cx, 22.0, WZ + 0.7));
      g.add(archOpening(cx, 8, 2.6, 5.5, WZ + 0.6));
    }

    // ---- central triple-arch portico: six Corinthian columns, three arches ----
    // (all on the pavilion plane, proud of the wings like the real porch)
    for (const cx of [-7.5, 1.1, 2.9, 10.1, 11.9, 20.5]) g.add(corinthianColumn(cx, PAV + 2));
    for (const cx of [-3.2, 6.5, 16.2]) g.add(archOpening(cx, TERR, 6, 8.3, PAV + 0.1));

    // ---- entablature: continuous frieze + cornice, breaking forward at the portico ----
    g.add(box(2 * HW, 2.2, 1.0, MARBLE, FC, 20.4, WZ + 0.0));        // wing frieze
    g.add(box(2 * HW + 1, 1.1, 1.8, MARBLE, FC, 21.95, WZ + 0.4));   // wing cornice (top 22.5 caps OSM)
    g.add(box(46, 2.2, 1.6, MARBLE, 4.5, 20.4, PAV + 2.2));         // portico frieze (over columns)
    g.add(box(47, 1.2, 2.0, MARBLE, 4.5, 22.0, PAV + 2.6));         // portico cornice, projecting

    // ---- inscribed attic over the portico, crowned by six allegorical figures ----
    g.add(box(44, 5, 2, MARBLE, 4.5, 25, PAV + 1.5));               // attic block y 22.5..27.5
    g.add(box(45, 0.6, 2.4, MARBLE, 4.5, 27.8, PAV + 1.7));         // attic cornice cap
    g.add(box(33, 1.6, 0.3, DARKSTONE, 4.5, 24.6, PAV + 2.5));      // suggested inscription band
    for (const cx of [-8.5, -2.5, 3.5, 9.5, 15.5, 21.5]) {
      const f = figure(3, MARBLE);
      f.position.set(cx, 28.1, PAV + 1.7);
      g.add(f);
    }
    // ---- low green-copper hip roof peeking behind the parapet center ----
    const roof = cyl(0.3, 15, 4, GREEN_PATINA, FC, 24.2, -32, 4);
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.5, 1, 0.9);
    g.add(roof);

    // ---- balustraded parapet along the wing rooflines ----
    for (const [x0, x1] of [[-49, -13], [26, 62]] as const) {
      const w = x1 - x0, xc = (x0 + x1) / 2;
      g.add(box(w, 0.4, 0.9, MARBLE, xc, 22.8, WZ + 0.5));          // bottom rail
      g.add(box(w, 0.4, 1.0, MARBLE, xc, 24.1, WZ + 0.5));          // coping
      for (let x = x0 + 1.4; x <= x1 - 1; x += 3.2) g.add(cyl(0.15, 0.19, 0.9, MARBLE, x, 23.45, WZ + 0.5, 6));
    }

    // ---- two wall fountains (Truth / Beauty) set into the wings just clear
    // of the projecting pavilion (block spans x -18..27) ----
    for (const sx of [-24, 33]) {
      g.add(box(3.4, 2.6, 0.8, MARBLE, sx, TERR + 1.3, WZ + 0.4));  // pylon backing
      g.add(box(3.0, 0.7, 1.6, MARBLE, sx, TERR + 0.35, WZ + 1.4)); // basin
      const water = new THREE.Mesh(new THREE.CircleGeometry(1.2, 12), WATER_LM);
      water.rotation.x = -Math.PI / 2;
      water.position.set(sx, TERR + 0.3, WZ + 1.4);
      g.add(water);
    }
    // ---- flagpoles with gilt finials on the terrace ----
    for (const sx of [-9.5, 22.5]) {
      g.add(box(1.8, 1.4, 1.8, DARKSTONE, sx, TERR + 0.7, -7));     // ornate bronze base
      g.add(cyl(0.16, 0.22, 13, STEEL_LM, sx, TERR + 7.9, -7, 8));  // pole (y 4.1..17.1)
      const fin = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), GOLD);
      fin.position.set(sx, TERR + 14.7, -7);
      g.add(fin);
    }

    // ---- grand granite stair descending toward the avenue (+z), with cheeks ----
    for (let i = 0; i < 9; i++) g.add(box(20, 0.32, 0.75, GRANITE, FC, 2.56 - i * 0.30, -4.2 + i * 0.72));
    for (const sx of [-4.5, 17.5]) {
      g.add(box(2.2, 3.0, 7, GRANITE, sx, 1.5, -1.2));              // cheek wall
      g.add(box(2.6, 0.6, 7.4, MARBLE, sx, 3.1, -1.2));            // cheek coping
      const urn = lathe([[0.2, 0], [0.45, 0.2], [0.55, 0.5], [0.35, 0.8], [0.5, 1.0], [0.2, 1.15]], MARBLE, 10);
      urn.position.set(sx, 3.4, 1.5);
      g.add(urn);
    }

    // ---- Patience & Fortitude on tall granite plinths at the sidewalk, facing +z ----
    for (const sx of [-7, 20]) {
      const l = lion();
      l.position.set(sx, 0, 1.5);
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
    // near-opaque ruby glass: at 0.55 the steps ghosted against whatever drove
    // past behind them (transparent sorting) — depthWrite keeps them solid
    const TKTS_RED = new THREE.MeshStandardMaterial({
      color: '#c1121f', roughness: 0.15, emissive: '#6b0000',
      transparent: true, opacity: 0.92, depthWrite: true,
    });
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
    // TKTS red glass steps at the north end, with a glass parapet. The whole
    // staircase shifts by ONE road-clearance offset (computed at its center,
    // sized to its footprint) so it lands on the Duffy Square island as a
    // unit instead of straddling the 7th Av roadbed.
    {
      const [tx, tz] = ctx.clearRoad(0, 55, 9);
      const dxS = tx - 0, dzS = tz - 55;
      for (let i = 0; i < 12; i++) {
        g.add(box(15, 0.6, 0.95, TKTS_RED, dxS, 0.3 + i * 0.55, 50 + i * 0.9 + dzS));
      }
      g.add(box(15, 1.1, 0.12, GLASS_LM, dxS, 7.3, 60 + dzS)); // parapet
    }
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
