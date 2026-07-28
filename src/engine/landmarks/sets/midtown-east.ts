import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
  color: '#a8906a', metalness: 0.35, roughness: 0.3, emissive: '#3d2f1c',
});
// Chase's fins/braces: warmer + slightly emissive vs the kit BRONZE so the
// shaded faces keep reading as champagne metal over glass, not near-black
// slats (verified by shooting the shade side — kit BRONZE goes chocolate).
const CHASE_BRONZE = new THREE.MeshStandardMaterial({
  color: '#9c7c4f', metalness: 0.35, roughness: 0.38, emissive: '#2a1e10',
});

// One Vanderbilt's crown glass: kit GLASS_LM at metalness 0.6 reads near-black
// against the sky (no envmap in streetScene — the Chase bronze lesson), and the
// real crown is LIGHTER than the shaft. Low metalness + slight emissive keeps
// shaded facets silvery.
const ONE_V_GLASS = new THREE.MeshStandardMaterial({
  color: '#b9d2e2', metalness: 0.3, roughness: 0.16, emissive: '#2e3f4a',
  // flat facets: without this the 4-segment frustums smooth-shade into a
  // rounded bullet nose instead of crisp angled glass planes
  flatShading: true,
});

// Chrysler crown palette. High metalness rendered the old crown almost black
// because the street scene intentionally has no expensive environment map.
// These still react as stainless steel, but a cool emissive floor preserves
// Van Alen's bright, silvery sunburst on shaded and mobile-quality faces.
const CHRYSLER_STEEL = new THREE.MeshStandardMaterial({
  color: '#d5dde2', metalness: 0.42, roughness: 0.2,
  emissive: '#60717c', emissiveIntensity: 0.34,
  flatShading: true,
});
const CHRYSLER_STEEL_ALT = new THREE.MeshStandardMaterial({
  color: '#aebcc5', metalness: 0.38, roughness: 0.24,
  emissive: '#4d606b', emissiveIntensity: 0.3,
  flatShading: true,
});
const CHRYSLER_RIB = new THREE.MeshStandardMaterial({
  color: '#bac6cd', metalness: 0.44, roughness: 0.18,
  emissive: '#53656f', emissiveIntensity: 0.24,
});
const CHRYSLER_WINDOW = new THREE.MeshStandardMaterial({
  color: '#21333e', metalness: 0.18, roughness: 0.12,
  emissive: '#0a1820', emissiveIntensity: 0.72,
});
const CHRYSLER_RED = new THREE.MeshBasicMaterial({ color: '#ff3b30' });
const CHRYSLER_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

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

function chryslerDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

// Streamlined 61st-floor eagle gargoyle. The group projects toward local +z;
// callers rotate it onto all four corners of the tower.
function chryslerEagle(): THREE.Group {
  const e = new THREE.Group();
  const wing = new THREE.Shape();
  wing.moveTo(0, 0.5);
  wing.lineTo(-4.5, 1.4);
  wing.lineTo(-3.4, 3.2);
  wing.lineTo(-1.2, 4.2);
  wing.lineTo(0, 3.4);
  wing.lineTo(1.2, 4.2);
  wing.lineTo(3.4, 3.2);
  wing.lineTo(4.5, 1.4);
  wing.closePath();
  const wings = chryslerDetail(new THREE.Mesh(
    new THREE.ExtrudeGeometry(wing, { depth: 0.28, bevelEnabled: false }),
    CHRYSLER_RIB,
  ));
  wings.geometry.translate(0, 0, -0.14);
  wings.rotation.x = Math.PI / 2;
  wings.position.set(0, 0.2, 0.2);
  e.add(wings);
  e.add(chryslerDetail(strut(
    new THREE.Vector3(0, 0.35, 0.2),
    new THREE.Vector3(0, 0.7, 5.5),
    0.66, CHRYSLER_STEEL, 7,
  )));
  const head = chryslerDetail(new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), CHRYSLER_STEEL));
  head.position.set(0, 0.95, 5.7);
  e.add(head);
  const beak = chryslerDetail(cyl(0, 0.48, 1.5, CHRYSLER_RIB, 0, 0, 0, 6));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.9, 6.8);
  e.add(beak);
  return e;
}

/** One alternating stainless facet of the crown's groin-vault shell. */
function chryslerDomeSector(
  profile: [number, number][],
  a0: number,
  a1: number,
  mat: THREE.Material,
): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    const [y, r] = profile[i];
    pos.push(Math.sin(a0) * r, y, Math.cos(a0) * r);
    pos.push(Math.sin(a1) * r, y, Math.cos(a1) * r);
    uv.push(0, i / (profile.length - 1), 1, i / (profile.length - 1));
    if (i) {
      const o = (i - 1) * 2;
      // Counter-clockwise from outside the radial shell. The old order faced
      // inward, so back-face culling hid the stainless skin and left a hollow
      // cage of arch ribs against the sky.
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return chryslerDetail(new THREE.Mesh(geo, mat));
}

/** A true open stainless arch band in a vertical x/y plane. */
function chryslerArchBand(
  width: number,
  springY: number,
  peakY: number,
  thickness: number,
): THREE.Mesh {
  const rx = width / 2;
  const ry = peakY - springY;
  const innerRx = Math.max(0.25, rx - thickness);
  const innerSpring = springY + thickness * 0.28;
  const innerRy = Math.max(0.25, peakY - thickness - innerSpring);
  const shape = new THREE.Shape();
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI - (i / steps) * Math.PI;
    const x = Math.cos(a) * rx;
    const y = springY + Math.sin(a) * ry;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI;
    shape.lineTo(Math.cos(a) * innerRx, innerSpring + Math.sin(a) * innerRy);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.24, bevelEnabled: false, curveSegments: 1, steps: 1,
  });
  geo.translate(0, 0, -0.12);
  return chryslerDetail(new THREE.Mesh(geo, CHRYSLER_RIB));
}

/** Recessed triangular crown window, facing local +z. */
function chryslerWindow(x: number, y: number, w: number, h: number): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(0, h / 2);
  shape.closePath();
  const mesh = chryslerDetail(new THREE.Mesh(new THREE.ShapeGeometry(shape), CHRYSLER_WINDOW));
  mesh.position.set(x, y, 0);
  return mesh;
}

/** Exact octagonal collision band following one slice of the crown taper. */
function chryslerCollisionBand(radius: number, y0: number, y1: number): THREE.Mesh {
  const shape = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  }
  shape.closePath();
  const mesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, steps: 1 }),
    CHRYSLER_COLLISION,
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y0;
  return mesh;
}

/**
 * Pre-merge a same-material batch of throwaway meshes (never added to a
 * parent) into ONE BufferGeometry mesh. mergeByMaterial already collapses a
 * landmark to one draw call per material at render time, but that still means
 * constructing + matrix-baking hundreds of tiny meshes on every approach —
 * this does it once, up front, for repeated elements (fin rows, brace
 * struts). Same clone-then-applyMatrix4 technique as EntranceManager's
 * mergeByMaterial, just scoped to a caller-chosen batch instead of a whole
 * group, so the caller controls what stays geometrically "thin" for
 * deriveCollision (see the chase-hq tier loop for why that matters).
 */
function mergeBatch(meshes: THREE.Mesh[], mat: THREE.Material): THREE.Mesh {
  const geos = meshes.map((m) => {
    m.updateMatrix();
    return (m.geometry as THREE.BufferGeometry).clone().applyMatrix4(m.matrix);
  });
  const merged = mergeGeometries(geos, false) ?? geos[0];
  for (const gm of geos) if (gm !== merged) gm.dispose();
  for (const m of meshes) m.geometry.dispose();
  return new THREE.Mesh(merged, mat);
}

// Low hedge/planter cluster for a setback terrace: three uneven dark-green
// boxes, not a single lollipop blob — reuses the plaza's own GREEN_PATINA.
function terraceGreen(x: number, z: number, y: number): THREE.Mesh[] {
  return [
    box(2.6, 1.0, 2.2, GREEN_PATINA, x, y + 0.5, z),
    box(1.6, 0.7, 1.8, GREEN_PATINA, x + 1.8, y + 0.35, z + 0.6),
    box(1.8, 0.8, 1.4, GREEN_PATINA, x - 1.5, y + 0.4, z - 0.8),
  ];
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

  // Chrysler Building crown: a complete replacement for the overlapping OSM
  // roof prisms above the retained 199m shaft. The raw map geometry records the
  // real nested arc peaks at 229/235/242/249/256/262/267/272m and the crown cap
  // at 282m; CTBUH records the architectural tip at 318.9m. Four open arch
  // faces, recessed triangular glass, fan ribs and the 61st-floor eagles give
  // the close view its real Art Deco depth. Alternating faceted shell panels
  // retain the glint in the skyline with just two body-material draw calls.
  chrysler: (ctx) => {
    const g = new THREE.Group();
    const base = ctx.fit?.keptH ?? 199;
    const crownTop = ctx.fit?.roofH ?? 282;
    const tipY = 318.9;
    // The crown footprints in the raw OSM mapping average ~0.9m west and 1.1m
    // south of the full-shaft OBB center. Preserve that measured small offset
    // so the spire grows from the actual upper tower, not the block centroid.
    const ox = -0.9, oz = 1.1;
    const startR = Math.min(14.5, Math.max(11, (ctx.fit?.topW ?? 22) / 2 + 3.5));

    // Dark-brick mechanical shoulder closes the 199m handoff from the baked
    // shaft and carries the chrome terrace/eagle mounts.
    const shoulder = box(startR * 1.92, 2.2, startR * 1.92, DARKSTONE, ox, base + 1.1, oz);
    shoulder.userData.noCollision = true;
    g.add(shoulder);
    const terrace = chryslerDetail(cyl(startR * 0.92, startR, 1.25, CHRYSLER_RIB, ox, base + 1.8, oz, 8));
    terrace.rotation.y = Math.PI / 8;
    g.add(terrace);

    // Measured crown silhouette. Sixteen angular sectors create directional
    // stainless reflections; no transparent shell or dense window grid needed.
    const profile: [number, number][] = [
      [base + 1, startR],
      [229, 12.0],
      [235, 10.8],
      [242, 9.6],
      [249, 8.2],
      [256, 6.7],
      [262, 4.9],
      [267, 3.8],
      [272, 2.7],
      [crownTop, 0.72],
    ];
    for (let i = 0; i < 16; i++) {
      const panel = chryslerDomeSector(
        profile,
        (i / 16) * Math.PI * 2,
        ((i + 1) / 16) * Math.PI * 2,
        i % 2 ? CHRYSLER_STEEL_ALT : CHRYSLER_STEEL,
      );
      panel.position.set(ox, 0, oz);
      g.add(panel);
    }

    // The mapped upper roof is eight nested arch profiles. Render all four
    // outward faces instead of wrapping half-cylinders around a cone: the
    // result reads as the real cruciform groin vault from every approach.
    const arches: [number, number, number, number][] = [
      [28.6, base + 1, 229, 0.46],
      [22.3, 224, 235, 0.42],
      [20.6, base + 1, 242, 0.40],
      [17.4, base + 1, 249, 0.36],
      [13.9, base + 1, 256, 0.34],
      [10.0, 256, 262, 0.30],
      [8.2, 262, 267, 0.26],
      [5.9, 267, 272, 0.22],
    ];
    for (let f = 0; f < 4; f++) {
      const face = new THREE.Group();
      face.position.set(ox, 0, oz);
      face.rotation.y = (f * Math.PI) / 2;
      for (const [width, spring, peak, thick] of arches) {
        const arch = chryslerArchBand(width, spring, peak, thick);
        arch.position.z = width * 0.485 - 0.18;
        face.add(arch);
      }

      // Recessed triangular windows: genuine geometry rather than black bars.
      // The narrowing pairs reproduce the signature stacked chevrons at close
      // range and merge into one dark-glass draw call.
      const windows: [number, number, number, number][] = [
        [-7.6, 211.8, 3.7, 5.7], [0, 214.5, 4.0, 6.5], [7.6, 211.8, 3.7, 5.7],
        [-5.8, 225.0, 3.4, 5.5], [0, 228.3, 3.7, 6.1], [5.8, 225.0, 3.4, 5.5],
        [-4.5, 238.0, 2.9, 4.9], [0, 241.0, 3.2, 5.5], [4.5, 238.0, 2.9, 4.9],
        [-3.3, 249.0, 2.45, 4.2], [0, 251.5, 2.7, 4.7], [3.3, 249.0, 2.45, 4.2],
        [-2.2, 258.5, 1.9, 3.3], [0, 260.5, 2.05, 3.7], [2.2, 258.5, 1.9, 3.3],
        [-1.2, 266.5, 1.3, 2.4], [1.2, 266.5, 1.3, 2.4],
      ];
      for (const [x, y, w, h] of windows) {
        const win = chryslerWindow(x, y, w, h);
        // Face depth follows the taper; the slight inset leaves the bright
        // arch/rib geometry visibly proud of the dark glass.
        const t = (y - (base + 1)) / (crownTop - (base + 1));
        win.position.z = startR * (1 - t) + 0.72 * t + 0.42;
        face.add(win);
      }

      // Nine true stainless sunburst rays over each face. Cylinders are cheap
      // after merge, catch highlights in motion, and make the crown hold up at
      // helicopter-close distance without a large texture.
      for (const x of [-11.2, -8.5, -5.7, -2.8, 0, 2.8, 5.7, 8.5, 11.2]) {
        const q = Math.max(0, 1 - (x * x) / (14.3 * 14.3));
        const y = base + 1 + 28 * Math.sqrt(q);
        const t = (y - (base + 1)) / (crownTop - (base + 1));
        face.add(chryslerDetail(strut(
          new THREE.Vector3(0, base + 1.2, startR + 0.32),
          new THREE.Vector3(x, y, startR * (1 - t) + 0.72 * t + 0.34),
          0.065, CHRYSLER_RIB, 5,
        )));
      }
      g.add(face);
    }

    // Four polished 61st-floor eagle gargoyles project from the terrace corners.
    for (let k = 0; k < 4; k++) {
      const e = chryslerEagle();
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      // Suspend them below the crown ledge, as on the real 61st-floor
      // terrace. Sitting them on top of the 199m shoulder hid the projections
      // inside the first steel shell band from every normal approach.
      e.position.set(ox + Math.sin(a) * startR * 0.95, base - 4.8, oz + Math.cos(a) * startR * 0.95);
      e.rotation.y = a;
      g.add(e);
    }

    // The visible 121ft needle above the 282m crown cap. Three taper sections
    // and collars are more legible and accurate than one uniform black spike.
    const mast0 = crownTop - 0.3;
    const mast1 = mast0 + (tipY - mast0) * 0.45;
    const mast2 = mast0 + (tipY - mast0) * 0.78;
    g.add(chryslerDetail(cyl(0.43, 1.02, mast1 - mast0, CHRYSLER_STEEL, ox, (mast0 + mast1) / 2, oz, 8)));
    g.add(chryslerDetail(cyl(0.18, 0.5, mast2 - mast1, CHRYSLER_RIB, ox, (mast1 + mast2) / 2, oz, 8)));
    g.add(chryslerDetail(cyl(0.035, 0.2, tipY - mast2, CHRYSLER_RIB, ox, (mast2 + tipY) / 2, oz, 6)));
    for (const [y, r] of [[mast0 + 0.8, 1.25], [mast1, 0.58], [mast2, 0.26]] as [number, number][]) {
      g.add(chryslerDetail(cyl(r, r, 0.35, CHRYSLER_RIB, ox, y, oz, 10)));
    }
    const beacon = chryslerDetail(new THREE.Mesh(new THREE.SphereGeometry(0.19, 6, 5), CHRYSLER_RED));
    beacon.position.set(ox, tipY, oz);
    g.add(beacon);

    // Eight conservative octagonal bands make every major crown terrace
    // landable without the old giant conical AABB blocking empty air.
    for (let i = 0; i < profile.length - 2; i++) {
      const [y0, r0] = profile[i], [y1] = profile[i + 1];
      const col = chryslerCollisionBand(r0, y0, y1);
      col.position.x = ox;
      col.position.z = oz;
      g.add(col);
    }
    return g;
  },

  // One Vanderbilt crown. The OSM prisms above 380m (five 397m crown pieces +
  // a 3m-wide spire stick to 427m) are cleared at bake time (LANDMARK_FIT
  // clearAboveH) — kept, they interpenetrated the old glass-fin build, whose
  // fins and floating 44m parapet ring hung ~7m off the real crown cluster.
  // This replaces them with the tower's actual read: a faceted glass crown
  // tapering from the kept 350m setbacks to the 427m point. Everything here is
  // four-fold symmetric on purpose — the fit rot may map local +x onto either
  // grid axis depending on which shaft edge measures longest.
  'one-vanderbilt': (ctx) => {
    const g = new THREE.Group();
    const roof = ctx.fit?.keptH ?? 350; // tallest kept OSM setback
    const tip = ctx.fit?.roofH ?? 427; // OSM's cleared spire reached here
    const rise = tip - roof;
    // three tapering square tiers: [side at base, side at top, rise fractions].
    // Near-constant taper — increasing slopes read as a bulging bullet nose.
    const tiers: [number, number, number, number][] = [
      [26, 15.5, 0, 0.47],
      [15.5, 8.5, 0.47, 0.75],
      [8.5, 0.9, 0.75, 1],
    ];
    for (const [s0, s1, f0, f1] of tiers) {
      const y0 = roof + rise * f0, y1 = roof + rise * f1;
      const t = cyl(s1 * Math.SQRT1_2, s0 * Math.SQRT1_2, y1 - y0, ONE_V_GLASS, 0, (y0 + y1) / 2, 0, 4);
      t.rotation.y = Math.PI / 4; // square facets facing local ±x/±z
      g.add(t);
      // steel hip ribs up the four corners of each tier
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        g.add(strut(
          new THREE.Vector3((sx * s0) / 2, y0, (sz * s0) / 2),
          new THREE.Vector3((sx * s1) / 2, y1, (sz * s1) / 2),
          0.22, STEEL_LM,
        ));
      }
    }
    // Summit deck band: a pale glow wrapping the crown base at the roofline
    // (the old free-floating r=22 parapet ring is gone with the fins)
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(27.2, 2.4, 27.2),
      new THREE.MeshBasicMaterial({ color: '#d9ecf7' }),
    );
    band.position.y = roof + 1.6;
    g.add(band);
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

  // Chase HQ (270 Park Ave): full replacement, plaza to spire. The real
  // building's defining trait is a stepped ziggurat massing — six nested
  // tiers that step IN on ALTERNATING faces at staggered heights, not a
  // symmetric pyramid: each tier is its own independent [x0,x1]x[z0,z1] plan
  // box (not a shared half-extent), so setback ledges land off-center from
  // each other and the silhouette reads as an irregular cascading stack with
  // one shoulder higher than the other. Fan mega-columns + a transfer truss
  // still lift it off the plaza (kept from the old build, proportions
  // refined); every tier face then carries a giant bronze X-brace megapanel
  // (Foster's expressed diagrid, storeys tall — NOT a fine repeating lattice)
  // sitting proud of closely-spaced bronze mullion fins over glass. Flat
  // parapet top: no spire, no crown ornament.
  'chase-hq': () => {
    const g = new THREE.Group();

    // Six tiers, LOCAL PLAN BOUNDS (not half-extents) so faces can step
    // independently — see the header comment. T1's footprint matches the
    // measured OSM massing this replaces (60m cross-street x 75m along Park
    // Ave, same as the old HX/HZ); total height 423m, unchanged.
    const TIERS = [
      { y0: 32, y1: 150, x0: -30, x1: 30, z0: -37.5, z1: 37.5 }, // T1 full footprint
      { y0: 150, y1: 225, x0: -22, x1: 30, z0: -37.5, z1: 30.5 }, // T2: -x face + +z face step in
      { y0: 225, y1: 285, x0: -22, x1: 21, z0: -29.5, z1: 30.5 }, // T3: +x face + -z face step in
      { y0: 285, y1: 340, x0: -17, x1: 21, z0: -29.5, z1: 22.5 }, // T4: -x face + +z face step in again
      { y0: 340, y1: 385, x0: -17, x1: 14, z0: -22.5, z1: 22.5 }, // T5: +x face + -z face step in again
      { y0: 385, y1: 423, x0: -11, x1: 14, z0: -12.5, z1: 12.5 }, // T6: near-square crown
    ];
    const T1 = TIERS[0];

    // ---- iconic lifted base (0-32m) ----------------------------------------
    // 270 Park's signature: the whole tower stands on a handful of dramatic
    // splayed fan-columns, freeing a column-free glass lobby and public plaza.
    // Rebuilt for clarity/boldness: a set-back glass lobby the tower floats
    // over, bold tapered bronze fan-columns (two legs per unit meeting at an
    // apex node under the transfer truss), tapered corner columns, and a clean
    // granite plaza — replacing the old thin-strut tangle.
    const BASE_H = 26;
    const HW = T1.x1, HD = T1.z1; // 30 x 37.5 half-extents

    // granite plaza, proud of the footprint; low planters at the corners
    g.add(box(74, 0.3, 92, GRANITE, 0, 0.15, 0));
    g.add(box(64, 0.5, 82, GRANITE, 0, 0.55, 0)); // raised inner terrace
    for (const [px, pz] of [[-26, 34], [26, 34], [-26, -34], [26, -34]] as const) {
      g.add(box(5, 1.1, 5, GRANITE, px, 0.9, pz));
      g.add(box(4.2, 0.9, 4.2, GREEN_PATINA, px, 1.85, pz));
    }

    // set-back double-height glass lobby the tower floats above; the columns
    // land OUTSIDE it, so it reads as fully glazed and column-free
    const LOBBY_H = 22;
    g.add(box(2 * HW - 16, LOBBY_H, 2 * HD - 18, GLASS_LM, 0, LOBBY_H / 2 + 0.8, 0));
    for (let mx = -(HW - 8); mx <= HW - 8; mx += 4) // lobby mullions, long faces
      for (const mz of [-(HD - 9), HD - 9]) g.add(box(0.4, LOBBY_H, 0.4, STEEL_LM, mx, LOBBY_H / 2 + 0.8, mz));
    g.add(box(2 * HW - 15, 1.4, 2 * HD - 17, DARKSTONE, 0, LOBBY_H + 1.5, 0)); // lobby soffit

    // tapered fan-column: two bold legs splaying from plaza feet up to a shared
    // apex node at the transfer level. `taperLeg` orients a truncated cone
    // (wide base, narrower top) along the leg like strut() does.
    const taperLeg = (a: THREE.Vector3, b: THREE.Vector3, rBot: number, rTop: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, a.distanceTo(b), 12), CHASE_BRONZE);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      return m;
    };
    for (const faceX of [T1.x0, T1.x1]) {
      const sx = Math.sign(faceX);
      for (const fz of [-25, 0, 25]) { // three fan-columns per long (Park-Ave) face
        const apex = new THREE.Vector3(faceX - sx * 4, BASE_H, fz);
        g.add(box(6, 5, 6, CHASE_BRONZE, apex.x, BASE_H + 0.5, fz)); // apex capital under the truss
        for (const dz of [-9, 9]) {
          const foot = new THREE.Vector3(faceX, 0, fz + dz);
          g.add(taperLeg(foot, apex, 3.0, 1.7)); // bold splayed leg
          g.add(box(5, 1.2, 5, DARKSTONE, foot.x, 0.6, foot.z)); // granite footing pad
        }
      }
    }
    // tapered vertical corner columns
    for (const cx of [T1.x0, T1.x1]) for (const cz of [T1.z0, T1.z1])
      g.add(cyl(1.9, 2.6, BASE_H, CHASE_BRONZE, cx, BASE_H / 2, cz, 12));

    // transfer truss 26-32m: deep dark band + a clean diagonal X per face
    const TT0 = BASE_H, TT1 = BASE_H + 6;
    g.add(box(2 * HW + 1, TT1 - TT0, 2 * HD + 1, DARKSTONE, 0, (TT0 + TT1) / 2, 0));
    for (const faceX of [T1.x0, T1.x1]) {
      g.add(strut(new THREE.Vector3(faceX, TT0, T1.z0), new THREE.Vector3(faceX, TT1, T1.z1), 0.45, STEEL_LM));
      g.add(strut(new THREE.Vector3(faceX, TT0, T1.z1), new THREE.Vector3(faceX, TT1, T1.z0), 0.45, STEEL_LM));
    }
    for (const faceZ of [T1.z0, T1.z1]) {
      g.add(strut(new THREE.Vector3(T1.x0, TT0, faceZ), new THREE.Vector3(T1.x1, TT1, faceZ), 0.45, STEEL_LM));
      g.add(strut(new THREE.Vector3(T1.x1, TT0, faceZ), new THREE.Vector3(T1.x0, TT1, faceZ), 0.45, STEEL_LM));
    }

    // entrance canopies projecting over the avenue sidewalks
    for (const sx of [-1, 1]) g.add(box(8, 0.6, 22, STEEL_LM, sx * (HW + 4), 6, 0));

    // Tiers: bronze-glass volume + a giant per-face X-brace megapanel (1
    // module, or 2 side by side on wide lower faces) + a dense row of
    // vertical bronze fins recessed just behind the braces. Fins and braces
    // are pre-merged into ONE mesh per face (mergeBatch): at ~2.3m fin
    // spacing a 75m-wide face is ~30 raw meshes before merging, x4 faces x6
    // tiers. Each batch is scoped to a single tier FACE, not pooled across
    // faces or tiers — deriveCollision (LandmarkManager) treats a merged
    // batch as passable strut-work by its MINIMUM horizontal AABB dimension,
    // and only a per-face batch stays thin in its offset axis; pooling
    // multiple faces would inflate that axis into a false solid wall.
    const braceR = 1.3;
    for (const t of TIERS) {
      const cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2;
      const w = t.x1 - t.x0, d = t.z1 - t.z0, h = t.y1 - t.y0, cy = (t.y0 + t.y1) / 2;
      g.add(box(w, h, d, BRONZE_GLASS, cx, cy, cz));

      const faceDefs: { axis: 'x' | 'z'; sign: 1 | -1; off0: number; lo: number; hi: number }[] = [
        { axis: 'x', sign: 1, off0: t.x1, lo: t.z0, hi: t.z1 }, // +x face, spans z
        { axis: 'x', sign: -1, off0: t.x0, lo: t.z0, hi: t.z1 }, // -x face, spans z
        { axis: 'z', sign: 1, off0: t.z1, lo: t.x0, hi: t.x1 }, // +z face, spans x
        { axis: 'z', sign: -1, off0: t.z0, lo: t.x0, hi: t.x1 }, // -z face, spans x
      ];
      for (const fd of faceDefs) {
        const span = fd.hi - fd.lo;
        const P = (off: number) => (u: number, y: number) =>
          fd.axis === 'x' ? new THREE.Vector3(off, y, u) : new THREE.Vector3(u, y, off);

        // giant X-brace megapanel(s): full tier height, proud of the glass
        const braceOff = fd.off0 + fd.sign * 0.95;
        const Pb = P(braceOff);
        const mods = span > 45 ? 2 : 1; // very wide lower faces get 2 X's side by side
        const mw = span / mods;
        const braceStruts: THREE.Mesh[] = [];
        for (let m = 0; m < mods; m++) {
          const u0 = fd.lo + m * mw, u1 = u0 + mw;
          braceStruts.push(strut(Pb(u0, t.y0), Pb(u1, t.y1), braceR, CHASE_BRONZE));
          braceStruts.push(strut(Pb(u1, t.y0), Pb(u0, t.y1), braceR, CHASE_BRONZE));
        }
        g.add(mergeBatch(braceStruts, CHASE_BRONZE));

        // closely-spaced vertical bronze fins, recessed behind the braces —
        // the dominant facade texture; horizontals stay minimal (floor band only)
        const finOff = fd.off0 + fd.sign * 0.4;
        const Pf = P(finOff);
        const n = Math.max(2, Math.round(span / 3.0));
        const fins: THREE.Mesh[] = [];
        for (let i = 0; i <= n; i++) {
          const p = Pf(fd.lo + (i * span) / n, cy);
          fins.push(fd.axis === 'x'
            ? box(0.32, h, 0.26, CHASE_BRONZE, p.x, p.y, p.z)
            : box(0.26, h, 0.32, CHASE_BRONZE, p.x, p.y, p.z));
        }
        g.add(mergeBatch(fins, CHASE_BRONZE));
      }

      // parapet/floor-band lip at this tier's own top: mostly hidden under
      // the next tier except the exposed setback rim (or, on T6, the flat top)
      g.add(box(w + 0.5, 1.0, d + 0.5, STEEL_LM, cx, t.y1, cz));
    }

    // low terrace greenery on the two big lower setbacks (visible in photos):
    // sample points sit in the exposed L-shaped ring between one tier's
    // footprint and the next tier's smaller one, inset from the parapet lip
    for (const [gx, gz] of [[-26, 0], [-26, 20], [0, 34], [10, 34]] as const) {
      g.add(mergeBatch(terraceGreen(gx, gz, TIERS[0].y1), GREEN_PATINA));
    }
    for (const [gx, gz] of [[25, 0], [0, -33]] as const) {
      g.add(mergeBatch(terraceGreen(gx, gz, TIERS[1].y1), GREEN_PATINA));
    }

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
