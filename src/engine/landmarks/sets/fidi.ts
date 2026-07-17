import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRICK_RED, BRONZE, VERDIGRIS, GOLD,
  STEEL_LM, GLASS_LM, WHITE_LM, WATER_LM, GREEN_PATINA,
  box, cyl, strut, colonnade, lathe, archWall, figure, twoSidedPanel, canvasTexture,
} from '../kit';

/**
 * Financial District + Harbor set. Every builder returns a group whose origin
 * sits at ground level (y=0) at the registry position; +z is the front. The
 * manager rotates/positions/merges each group and disposes it on the way out.
 */

// ---- local helpers ----------------------------------------------------------

/** Park/promenade bench (seat + back + two legs), like the Central Park kit one. */
function bench(mat: THREE.Material = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.06, 0.5, mat, 0, 0.45, 0));
  g.add(box(1.8, 0.5, 0.06, mat, 0, 0.7, -0.25));
  g.add(box(0.08, 0.45, 0.5, mat, -0.8, 0.22, 0));
  g.add(box(0.08, 0.45, 0.5, mat, 0.8, 0.22, 0));
  return g;
}

/** Triangular-prism pediment/gable (apex up), extruded along z, centered. */
function pediment(w: number, h: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, mat);
}

/** Flat multi-point star footprint laid in the xz plane, extruded up `depth`. */
function starPrism(points: number, rOuter: number, rInner: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const p: [number, number] = [Math.cos(a) * r, Math.sin(a) * r];
    if (i === 0) s.moveTo(p[0], p[1]);
    else s.lineTo(p[0], p[1]);
  }
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); // lay the plan flat, extrude toward +y
  return new THREE.Mesh(geo, mat);
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // One WTC spire only (tower massing is OSM): mechanical ring + lattice mast + beacon
  'one-wtc': () => {
    const g = new THREE.Group();
    const base = 417, tip = 541;
    g.add(cyl(7.5, 8.5, 7, STEEL_LM, 0, base + 3.5, 0, 12)); // mechanical equipment ring
    g.add(cyl(6, 6, 1.2, DARKSTONE, 0, base + 7.6, 0, 12));
    g.add(cyl(0.35, 1.6, tip - base, STEEL_LM, 0, (base + tip) / 2, 0, 8)); // central tapering mast
    const rings: [number, number][] = [[base + 2, 4.6], [base + 16, 3.4], [base + 34, 2.3], [base + 56, 1.2]];
    const legs = 4;
    for (let i = 0; i < legs; i++) {
      const a = (i / legs) * Math.PI * 2 + Math.PI / 4;
      const a2 = ((i + 1) / legs) * Math.PI * 2 + Math.PI / 4;
      for (let k = 0; k < rings.length - 1; k++) {
        const [y0, r0] = rings[k], [y1, r1] = rings[k + 1];
        const p0 = new THREE.Vector3(Math.cos(a) * r0, y0, Math.sin(a) * r0);
        const p1 = new THREE.Vector3(Math.cos(a) * r1, y1, Math.sin(a) * r1);
        const px = new THREE.Vector3(Math.cos(a2) * r1, y1, Math.sin(a2) * r1);
        g.add(strut(p0, p1, 0.16, STEEL_LM, 5)); // vertical leg
        g.add(strut(p0, px, 0.09, STEEL_LM, 4)); // diagonal cross-brace
      }
    }
    for (const [y, r] of rings) { // horizontal ties around the lattice
      for (let i = 0; i < legs; i++) {
        const a = (i / legs) * Math.PI * 2 + Math.PI / 4, b = ((i + 1) / legs) * Math.PI * 2 + Math.PI / 4;
        g.add(strut(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r), new THREE.Vector3(Math.cos(b) * r, y, Math.sin(b) * r), 0.08, STEEL_LM, 4));
      }
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.95, 10, 8), GOLD);
    beacon.position.y = tip;
    g.add(beacon);
    return g;
  },

  // 9/11 Museum pavilion: low deconstructivist glass wedge over a raking steel frame
  'sept11-museum': () => {
    const g = new THREE.Group();
    const L = 23;
    g.add(box(L + 0.4, 0.5, 12.4, STEEL_LM, 0, 0.25, 0)); // base sill
    g.add(box(L, 4.2, 12, GLASS_LM, 0, 2.3, 0)); // glass base volume
    const slabA = box(L, 8.5, 0.3, GLASS_LM, 0, 6.4, 2.2); // tilted glass planes leaning to an off-center ridge
    slabA.rotation.x = 0.32;
    g.add(slabA);
    const slabB = box(L, 7, 0.3, GLASS_LM, 0, 6.1, -3);
    slabB.rotation.x = -0.5;
    g.add(slabB);
    for (let x = -L / 2 + 1.6; x <= L / 2 - 1.6; x += 3.2) { // raking steel exoskeleton
      g.add(strut(new THREE.Vector3(x, 0.3, 6), new THREE.Vector3(x, 10.2, -0.5), 0.12, STEEL_LM, 5));
      g.add(strut(new THREE.Vector3(x, 0.3, -6), new THREE.Vector3(x, 8.4, -0.5), 0.12, STEEL_LM, 5));
    }
    for (const y of [3, 6, 9]) g.add(box(L, 0.14, 0.14, STEEL_LM, 0, y, 5.6)); // horizontal mullions
    g.add(box(4, 3, 0.5, DARKSTONE, 4, 1.5, 6.05)); // recessed entrance
    return g;
  },

  // 9/11 Memorial: bronze-rimmed parapet frames around the two REAL pools. The
  // tile pipeline bakes the memorial's water as two 54.2m squares (grid-rotated,
  // at grade) — the registry anchors this landmark at their midpoint with
  // rot -GRID, so the frames here land exactly on the baked water edges. Local
  // pool centers below are the measured offsets of those squares; don't nudge
  // them without re-measuring the tiles.
  'sept11-pools': () => {
    const g = new THREE.Group();
    const S = 53.8, t = 1.4; // inner clearance: parapet overlaps the 54.2m water edge 0.2m
    const makePool = (cx: number, cz: number): THREE.Group => {
      const p = new THREE.Group();
      for (const [dx, dz, w, d] of [[0, S / 2 + t / 2, S + 2 * t, t], [0, -(S / 2 + t / 2), S + 2 * t, t], [S / 2 + t / 2, 0, t, S], [-(S / 2 + t / 2), 0, t, S]]) {
        p.add(box(w, 1.0, d, DARKSTONE, dx, 0.5, dz)); // parapet
        p.add(box(w, 0.14, d, BRONZE, dx, 1.05, dz)); // bronze name-panel rim
      }
      p.position.set(cx, 0, cz);
      return p;
    };
    g.add(makePool(-33.4, -51.9), makePool(33.4, 51.9)); // north pool, south pool
    return g;
  },

  // NYSE: 6-column Corinthian temple front, pediment sculpture, striped banner (no stars/letters)
  'nyse': () => {
    const g = new THREE.Group();
    const W = 22, colH = 13;
    g.add(box(W, 1.6, 8, GRANITE, 0, 0.8, 0)); // podium
    g.add(box(W - 1, 0.6, 7, MARBLE, 0, 1.9, 0.3));
    for (let i = 0; i < 4; i++) g.add(box(W - i * 1.2, 0.35, 1.0, GRANITE, 0, 0.175 + i * 0.35, 5.5 - i * 0.5)); // front steps
    const cols = colonnade(6, 3.6, 0.7, colH, MARBLE, 2.2);
    cols.position.z = 2.5;
    g.add(cols);
    g.add(box(W, 1.9, 2.4, MARBLE, 0, 2.2 + colH + 0.95, 2.5)); // architrave
    const ped = pediment(W, 3.2, 2.4, MARBLE);
    ped.position.set(0, 2.2 + colH + 1.9, 2.5);
    g.add(ped);
    const tymp = new THREE.Group(); // sculptural group in the tympanum
    tymp.add(figure(1.9, MARBLE));
    for (const sx of [-3.2, 3.2]) { const f = figure(1.4, MARBLE); f.position.x = sx; tymp.add(f); }
    tymp.position.set(0, 2.2 + colH + 2.0, 3.6);
    g.add(tymp);
    const flag = canvasTexture((c, w, h) => { // abstract red/white/blue banner: stripes + plain blue canton
      const stripes = 7;
      for (let i = 0; i < stripes; i++) { c.fillStyle = i % 2 === 0 ? '#b22234' : '#ffffff'; c.fillRect(0, (i / stripes) * h, w, h / stripes + 1); }
      c.fillStyle = '#3c3b6e';
      c.fillRect(0, 0, w * 0.42, h * (4 / 7));
    }, 128, 96);
    const banner = twoSidedPanel(flag, 11, 7);
    banner.position.set(0, 9, 4.7);
    g.add(banner);
    return g;
  },

  // Federal Hall: 8-column Doric front on cascading steps, bronze Washington on a plinth
  'federal-hall': () => {
    const g = new THREE.Group();
    const W = 20, colH = 9, plat = 3.2;
    g.add(box(W, plat, 10, LIMESTONE, 0, plat / 2, -1)); // podium mass
    for (let i = 0; i < 8; i++) g.add(box(W, 0.42, 0.95, GRANITE, 0, 0.21 + i * (plat / 8), 8.4 - i * 0.7)); // cascading steps
    const cols = colonnade(8, 2.3, 0.55, colH, LIMESTONE, plat);
    cols.position.z = 1.6;
    g.add(cols);
    g.add(box(W, 1.4, 3.2, LIMESTONE, 0, plat + colH + 0.7, 1.6)); // entablature
    const ped = pediment(W, 2.4, 3.2, LIMESTONE);
    ped.position.set(0, plat + colH + 1.4, 1.6);
    g.add(ped);
    g.add(box(W - 2, colH, 2, LIMESTONE, 0, plat + colH / 2, -1)); // cella wall
    g.add(box(2, 1.8, 2, GRANITE, 0, plat + 0.9, 4.2)); // plinth
    const wash = figure(3, BRONZE);
    wash.position.set(0, plat + 1.8, 4.2);
    g.add(wash);
    return g;
  },

  // Trinity Church: brownstone gothic nave + square tower with a tall octagonal spire to ~86m
  'trinity-church': () => {
    const g = new THREE.Group();
    const STONE = BRICK_RED;
    g.add(box(14, 12, 26, STONE, 0, 6, -4)); // nave
    const roof = pediment(14, 5, 26, DARKSTONE); // steep gable roof (ridge along z)
    roof.position.set(0, 12, -4);
    g.add(roof);
    g.add(box(8, 40, 8, STONE, 0, 20, 12)); // square tower at the front
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(1.1, 43, 1.1, STONE, sx * 4.3, 21.5, 12 + sz * 4.3)); // corner buttress pinnacles
    g.add(cyl(0.2, 4.8, 46, DARKSTONE, 0, 63, 12, 8)); // octagonal tapering spire (40 -> 86m)
    const portal = archWall(8, 6, 0.8, 2.6, 4.5, STONE); // pointed-arch portal (round-arched helper)
    portal.position.set(0, 0, 16.05);
    g.add(portal);
    for (const [hx, hz] of [[-9, 6], [-8, 1.5], [9, 5], [8, -0.5], [-9, -4]]) g.add(box(0.5, 1.0, 0.14, DARKSTONE, hx, 0.5, hz)); // churchyard headstones
    return g;
  },

  // Charging Bull: bronze bull ~3.4m tall from overlapping muscle boxes, lowered horned head, curled tail
  'charging-bull': () => {
    const g = new THREE.Group();
    g.add(cyl(3.2, 3.4, 0.25, DARKSTONE, 0, 0.125, 0, 12)); // cobble pad
    const b = new THREE.Group();
    b.add(box(1.55, 1.6, 2.6, BRONZE, 0, 2.0, -0.2)); // barrel
    b.add(box(1.75, 1.7, 1.5, BRONZE, 0, 2.05, 0.8)); // shoulders (front)
    b.add(box(1.35, 1.4, 1.3, BRONZE, 0, 1.85, -1.5)); // haunches
    const neck = box(1.1, 1.05, 1.1, BRONZE, 0, 1.6, 1.7);
    neck.rotation.x = 0.5;
    b.add(neck);
    const head = new THREE.Group(); // lowered, horned head
    head.add(box(0.85, 0.9, 1.1, BRONZE, 0, 0, 0));
    head.add(box(0.68, 0.5, 0.55, BRONZE, 0, -0.42, 0.5));
    for (const sx of [-1, 1]) {
      const horn = cyl(0.03, 0.12, 0.95, BRONZE, sx * 0.42, 0.42, 0.1, 6);
      horn.rotation.z = sx * 0.95;
      horn.rotation.x = -0.3;
      head.add(horn);
      head.add(box(0.3, 0.13, 0.18, BRONZE, sx * 0.6, 0.16, -0.12)); // ear
    }
    head.position.set(0, 1.15, 2.35);
    head.rotation.x = 0.35;
    b.add(head);
    for (const [lx, lz] of [[-0.55, 1.05], [0.55, 1.05], [-0.5, -1.3], [0.5, -1.3]]) {
      b.add(cyl(0.18, 0.22, 1.6, BRONZE, lx, 0.8, lz, 6));
      b.add(box(0.32, 0.22, 0.42, BRONZE, lx, 0.11, lz + 0.05)); // hoof
    }
    const tail = [new THREE.Vector3(0, 1.85, -2.0), new THREE.Vector3(0.35, 1.25, -2.35), new THREE.Vector3(0.1, 0.75, -2.05), new THREE.Vector3(-0.25, 0.55, -1.6)];
    for (let i = 0; i < tail.length - 1; i++) b.add(strut(tail[i], tail[i + 1], 0.08, BRONZE, 5)); // curled tail
    g.add(b);
    return g;
  },

  // Fearless Girl: 1.27m bronze girl, arms akimbo, ponytail, flared skirt, facing +z
  'fearless-girl': () => {
    const g = new THREE.Group();
    const u = 1.27 / 1.8;
    g.add(figure(1.27, BRONZE));
    g.add(cyl(0.17, 0.32, 0.5, BRONZE, 0, 0.45 * u, 0, 8)); // flared skirt
    for (const sx of [-1, 1]) {
      g.add(box(0.32, 0.1, 0.12, BRONZE, sx * 0.28, 1.02 * u, 0)); // upper arm out (akimbo)
      g.add(box(0.1, 0.28, 0.12, BRONZE, sx * 0.42, 0.86 * u, 0)); // forearm down to hip
      g.add(box(0.14, 0.08, 0.26, BRONZE, sx * 0.1, 0.04, 0.05)); // planted foot
    }
    const pony = box(0.1, 0.3, 0.12, BRONZE, 0, 1.45 * u, -0.14); // ponytail wedge
    pony.rotation.x = -0.4;
    g.add(pony);
    return g;
  },

  // Bowling Green: small oval park, iron fence ring, central lathe fountain with a single jet
  'bowling-green': () => {
    const g = new THREE.Group();
    const rx = 12, rz = 8, N = 24;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 24), GREEN_PATINA);
    ground.rotation.x = -Math.PI / 2;
    ground.scale.set(rx - 1, rz - 1, 1);
    ground.position.y = 0.03;
    g.add(ground);
    const post: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, x = Math.cos(a) * rx, z = Math.sin(a) * rz;
      post.push(new THREE.Vector3(x, 0, z));
      g.add(cyl(0.05, 0.06, 1.2, DARKSTONE, x, 0.6, z, 6)); // fence post
    }
    for (let i = 0; i < N; i++) { // two rails between posts
      const a = post[i], b = post[(i + 1) % N];
      for (const y of [0.5, 1.0]) g.add(strut(new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z), 0.025, DARKSTONE, 4));
    }
    const basin = lathe([[1.8, 0], [1.9, 0.4], [1.6, 0.46]], GRANITE, 14); // fountain basin
    g.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(1.55, 14), WATER_LM);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.36;
    g.add(water);
    g.add(cyl(0.25, 0.3, 0.5, GRANITE, 0, 0.25, 0, 10)); // center pedestal
    g.add(cyl(0.04, 0.06, 1.4, WATER_LM, 0, 1.06, 0, 6)); // single jet
    return g;
  },

  // Castle Clinton: circular brownstone fort ring wall with an arched gate and merlon blocks
  'castle-clinton': () => {
    const g = new THREE.Group();
    const R = 24, H = 8, N = 14;
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5) / N) * Math.PI * 2, x = Math.cos(a) * R, z = Math.sin(a) * R, rot = Math.PI / 2 - a;
      if (i === 3) { // wide arched entrance at the front (+z)
        const gate = archWall(11, H, 3, 4, 6.2, BRICK_RED);
        gate.position.set(x, 0, z);
        gate.rotation.y = rot;
        g.add(gate);
      } else {
        const seg = box(11, H, 3, BRICK_RED, x, H / 2, z); // wall segment (tangent to the circle)
        seg.rotation.y = rot;
        g.add(seg);
      }
      const emb = box(1.6, 1.5, 3.2, DARKSTONE, x, H + 0.4, z); // darker embrasure/merlon block
      emb.rotation.y = rot;
      g.add(emb);
    }
    return g;
  },

  // Battery waterfront promenade: 30m railing, four benches facing the city, two binocular viewers
  'battery-waterfront': () => {
    const g = new THREE.Group();
    for (let x = -15; x <= 15; x += 1.5) g.add(cyl(0.05, 0.06, 1.1, DARKSTONE, x, 0.55, 3, 6)); // railing posts
    for (const y of [0.6, 1.05]) g.add(box(30, 0.06, 0.06, DARKSTONE, 0, y, 3)); // two rails
    for (const bx of [-10, -3.5, 3.5, 10]) {
      const b = bench();
      b.position.set(bx, 0, 0);
      b.rotation.y = Math.PI; // face -z (away from the water)
      g.add(b);
    }
    for (const vx of [-6, 6]) { // coin-op binocular viewers
      const v = new THREE.Group();
      v.add(cyl(0.12, 0.16, 1.3, STEEL_LM, 0, 0.65, 0, 8)); // pole
      v.add(box(0.5, 0.35, 0.32, STEEL_LM, 0, 1.45, 0)); // viewer head
      v.add(cyl(0.06, 0.06, 0.3, STEEL_LM, 0, 1.45, 0.28, 6)); // eyepiece barrel
      v.position.set(vx, 0, 2);
      g.add(v);
    }
    return g;
  },

  // Statue of Liberty: star-fort base, 27m pedestal, 34m verdigris figure, gold torch, 7-ray crown (~93m)
  'liberty-statue': () => {
    const g = new THREE.Group();
    // The statue stands 2.8km out in the harbor — far beyond the fog's far
    // plane, which would erase it entirely. These materials opt out of fog
    // (fog: false) and pre-bake the atmospheric haze into their colors so it
    // still sits believably behind the air, like the skyline layer does.
    const VERDIGRIS_FAR = new THREE.MeshLambertMaterial({ color: '#8fb5ad', fog: false });
    const GRANITE_FAR = new THREE.MeshLambertMaterial({ color: '#a9b0b8', fog: false });
    const GOLD_FAR = new THREE.MeshLambertMaterial({ color: '#d6c07a', fog: false });
    const s1 = starPrism(11, 20, 13, 8, GRANITE_FAR); // wide star fort
    s1.position.y = -2;
    g.add(s1);
    const s2 = starPrism(11, 15, 10, 3, GRANITE_FAR);
    s2.position.y = 6;
    g.add(s2);
    g.add(box(20, 3, 20, GRANITE_FAR, 0, 10.5, 0)); // pedestal base course
    g.add(box(16, 24, 16, GRANITE_FAR, 0, 24, 0)); // tapering pedestal shaft (~27m band)
    g.add(box(18, 2, 18, GRANITE_FAR, 0, 37, 0)); // cornice
    g.add(box(13, 7, 13, GRANITE_FAR, 0, 41.5, 0)); // upper pedestal (feet rest at y=45)
    const f = new THREE.Group(); // verdigris figure, heel at local 0
    f.add(cyl(3.2, 6.5, 14, VERDIGRIS_FAR, 0, 7, 0, 12)); // flared gown
    f.add(cyl(2.4, 3.2, 12, VERDIGRIS_FAR, 0, 20, 0, 12)); // upper robe
    f.add(box(5.5, 3, 3.2, VERDIGRIS_FAR, 0, 27.5, 0)); // shoulders
    f.add(cyl(1.0, 1.1, 1.5, VERDIGRIS_FAR, 0, 29.7, 0.2, 8)); // neck
    const head = new THREE.Mesh(new THREE.SphereGeometry(2.1, 12, 10), VERDIGRIS_FAR);
    head.position.set(0, 31.6, 0.3);
    f.add(head);
    for (let i = 0; i < 7; i++) { // 7-ray crown
      const a = (i / 6 - 0.5) * 2.6;
      const ray = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.4, 0.4), VERDIGRIS_FAR);
      ray.position.set(Math.sin(a) * 2.6, 32.2 + Math.cos(a) * 2.6, 0.3);
      ray.rotation.z = -a;
      f.add(ray);
    }
    const S = new THREE.Vector3(2.6, 28.5, 0.3), E = new THREE.Vector3(4.6, 36, 0.5), W = new THREE.Vector3(5.2, 43, 0.3);
    f.add(strut(S, E, 1.0, VERDIGRIS_FAR, 8)); // raised right arm
    f.add(strut(E, W, 0.8, VERDIGRIS_FAR, 8));
    f.add(cyl(0.4, 0.5, 2, GOLD_FAR, 5.2, 44, 0.3, 8)); // torch handle
    f.add(cyl(0, 1.1, 2.4, GOLD_FAR, 5.2, 46.2, 0.3, 8)); // gold flame (tip ~47 -> ~92m world)
    const tablet = box(3.2, 4.5, 0.7, VERDIGRIS_FAR, -3.2, 24, 1.6); // tablet arm at the side
    tablet.rotation.z = 0.35;
    tablet.rotation.x = -0.2;
    f.add(tablet);
    f.position.y = 45;
    g.add(f);
    return g;
  },

  // Whitehall ferry terminal: glass box under a curved steel roof with a bold orange facade band
  'whitehall-terminal': () => {
    const g = new THREE.Group();
    const ORANGE = new THREE.MeshLambertMaterial({ color: '#e0631b' });
    const W = 40, D = 22, H = 12;
    g.add(box(W, H, D, GLASS_LM, 0, H / 2, 0)); // glass hall
    for (let x = -W / 2; x <= W / 2; x += 5) g.add(box(0.3, H, 0.3, STEEL_LM, x, H / 2, D / 2 + 0.05)); // mullions
    for (const y of [3, 6, 9]) g.add(box(W, 0.25, 0.25, STEEL_LM, 0, y, D / 2 + 0.05));
    g.add(box(W, 2.2, 0.4, ORANGE, 0, H - 2.5, D / 2 + 0.1)); // bold orange band (color only)
    const segs = 12;
    for (let i = 0; i < segs; i++) { // curved steel barrel roof
      const t0 = i / segs, t1 = (i + 1) / segs;
      const x0 = -W / 2 + t0 * W, x1 = -W / 2 + t1 * W;
      const y0 = H + Math.sin(t0 * Math.PI) * 5, y1 = H + Math.sin(t1 * Math.PI) * 5;
      const panel = box(Math.hypot(x1 - x0, y1 - y0) + 0.1, 0.4, D + 2, STEEL_LM, (x0 + x1) / 2, (y0 + y1) / 2, 0);
      panel.rotation.z = Math.atan2(y1 - y0, x1 - x0);
      g.add(panel);
    }
    for (const sx of [-W / 2 + 2, W / 2 - 2]) g.add(cyl(0.3, 0.35, H, STEEL_LM, sx, H / 2, -D / 2 + 1, 8)); // roof columns
    return g;
  },

  // Fraunces Tavern: colonial brick block, white lintel grid, dark hipped roof, white door portico
  'fraunces-tavern': () => {
    const g = new THREE.Group();
    const floorH = 3.4, floors = 3, W = 14, D = 11, H = floorH * floors;
    g.add(box(W, H, D, BRICK_RED, 0, H / 2, 0)); // 3-story brick box
    for (let fl = 0; fl < floors; fl++) { // white lintel/sill window grid on the front
      const wy = 1.3 + fl * floorH;
      for (const wx of [-5, -2.5, 2.5, 5]) {
        g.add(box(1.1, 1.6, 0.15, DARKSTONE, wx, wy + 0.3, D / 2 + 0.02));
        g.add(box(1.4, 0.2, 0.25, WHITE_LM, wx, wy + 1.2, D / 2 + 0.05));
        g.add(box(1.4, 0.15, 0.3, WHITE_LM, wx, wy - 0.55, D / 2 + 0.05));
      }
    }
    for (let fl = 1; fl < floors; fl++) g.add(box(W + 0.1, 0.2, D + 0.1, WHITE_LM, 0, fl * floorH, 0)); // string courses
    const roof = cyl(0.3, W * 0.72, 3, DARKSTONE, 0, H + 1.5, 0, 4); // hipped roof (4-sided pyramid)
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, D / W);
    g.add(roof);
    for (const dx of [-3.5, 3.5]) g.add(box(1.2, 1.1, 1.3, DARKSTONE, dx, H + 0.85, 2)); // dormers
    for (const cx of [-5.5, 5.5]) g.add(box(1, 2, 1, BRICK_RED, cx, H + 2.2, 0)); // chimneys
    g.add(box(2.4, 0.2, 1.4, WHITE_LM, 0, 3.0, D / 2 + 0.7)); // portico roof
    for (const sx of [-0.9, 0.9]) g.add(cyl(0.12, 0.12, 3, WHITE_LM, sx, 1.5, D / 2 + 1.2, 8)); // portico columns
    g.add(box(1.4, 2.6, 0.2, DARKSTONE, 0, 1.3, D / 2 + 0.05)); // door
    return g;
  },

  // South Street Seaport: timber pier on piles + a moored three-masted tall ship
  'seaport': () => {
    const g = new THREE.Group();
    const WOOD = new THREE.MeshLambertMaterial({ color: '#5a4632' });
    const deckW = 26, deckD = 12;
    g.add(box(deckW, 0.4, deckD, WOOD, 0, 0.6, 0)); // pier deck
    for (let x = -deckW / 2 + 1.5; x <= deckW / 2 - 1.5; x += 4)
      for (const z of [-deckD / 2 + 1, deckD / 2 - 1]) g.add(cyl(0.25, 0.3, 1.2, DARKSTONE, x, 0.3, z, 6)); // piles
    for (let x = -deckW / 2; x <= deckW / 2; x += 2) g.add(cyl(0.06, 0.06, 0.9, WOOD, x, 1.25, deckD / 2 - 0.3, 6)); // rail posts
    g.add(box(deckW, 0.08, 0.08, WOOD, 0, 1.6, deckD / 2 - 0.3));
    const ship = new THREE.Group();
    const hull = lathe([[0, 0], [1.0, 0.5], [1.7, 1.6], [1.9, 3.4], [1.5, 4.6], [0, 5.2]], DARKSTONE, 10); // dark stretched-lathe hull
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(0.75, 2.7, 0.95);
    hull.position.y = 2.6;
    ship.add(hull);
    const deckY = 3.4;
    for (const mx of [-4.5, 0, 4.5]) { // three masts with yardarms + furled sails
      ship.add(cyl(0.18, 0.28, 15, WOOD, mx, deckY + 7.5, 0, 6));
      for (const my of [deckY + 5, deckY + 9, deckY + 12]) {
        ship.add(box(6.5, 0.14, 0.14, WOOD, mx, my, 0)); // yardarm
        const sail = cyl(0.35, 0.35, 6, WHITE_LM, mx, my - 0.2, 0, 6); // furled sail (rolled cloth)
        sail.rotation.z = Math.PI / 2;
        ship.add(sail);
      }
    }
    const bowsprit = cyl(0.12, 0.2, 6, WOOD, 8.5, deckY + 1.6, 0, 6); // bowsprit
    bowsprit.rotation.z = Math.PI / 2 - 0.4;
    ship.add(bowsprit);
    ship.position.set(0, 0, deckD / 2 + 3.5);
    g.add(ship);
    return g;
  },

  // The Oculus: white ribbed elliptical wings rising to a central spine (each rib a chain of struts)
  'oculus': () => {
    const g = new THREE.Group();
    const N = 11, halfL = 24;
    const spinePts: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const x = -halfL + (i / (N - 1)) * 2 * halfL;
      const yTop = 16 + 14 * Math.cos((Math.abs(x) / halfL) * (Math.PI / 2)); // 30 center -> 16 ends
      const zEdge = 12.5 * Math.sqrt(Math.max(0.02, 1 - (x / 26) ** 2)); // elliptical footprint
      spinePts.push(new THREE.Vector3(x, yTop, 0));
      for (const s of [1, -1]) {
        const pts = [
          new THREE.Vector3(x, 0, s * (zEdge + 2.5)), // splayed outward at the ground
          new THREE.Vector3(x, yTop * 0.34, s * (zEdge + 1.5)),
          new THREE.Vector3(x, yTop * 0.68, s * (zEdge * 0.6)),
          new THREE.Vector3(x, yTop * 0.9, s * (zEdge * 0.22)),
          new THREE.Vector3(x, yTop, 0), // meets the spine
        ];
        const radii = [0.42, 0.34, 0.26, 0.2];
        for (let k = 0; k < pts.length - 1; k++) g.add(strut(pts[k], pts[k + 1], radii[k], WHITE_LM, 5));
      }
    }
    for (let i = 0; i < spinePts.length - 1; i++) g.add(strut(spinePts[i], spinePts[i + 1], 0.5, WHITE_LM, 6)); // central spine ridge
    return g;
  },
};
