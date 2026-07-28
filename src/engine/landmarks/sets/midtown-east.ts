import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, GOLD, STEEL_LM, GLASS_LM, WHITE_LM, BRONZE, GREEN_PATINA,
  box, cyl, strut, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Midtown East set — Grand Central's Beaux-Arts front, the Chrysler crown, the
 * One Vanderbilt tower, the UN Secretariat, 270 Park (Chase HQ) and the
 * Queensboro cantilever. Each builder returns a group whose origin sits at
 * ground level; the manager rotates/positions/merges it. The Chrysler builder
 * replaces only its crown. One Vanderbilt and Chase HQ are full replacements
 * because their overlapping OSM parts rendered as generic/interpenetrating
 * slabs; those builders own everything from the plaza up.
 */

// Set-local materials (justified: warm steel for the Queensboro's ironwork and
// JPMorganChase's dark commercial-bronze structural skin).
const WARM_STEEL = new THREE.MeshStandardMaterial({ color: '#9a9184', metalness: 0.72, roughness: 0.42 });
// Low metalness is intentional: without an environment map, a physically
// metallic bronze goes black. The emissive floor preserves the real tower's
// copper-nickel perimeter structure on shaded/mobile-quality faces.
const CHASE_BRONZE = new THREE.MeshStandardMaterial({
  color: '#80624b', metalness: 0.38, roughness: 0.33,
  emissive: '#2d1c13', emissiveIntensity: 0.3,
});
const CHASE_DARK = new THREE.MeshStandardMaterial({
  color: '#34434a', metalness: 0.23, roughness: 0.36,
  emissive: '#1b2a30', emissiveIntensity: 0.48,
});
const CHASE_GLOW = new THREE.MeshBasicMaterial({ color: '#e8eef0' });
const CHASE_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

// One Vanderbilt palette. Its pale terracotta spandrels are essential: a
// blue-glass-only model reads as any recent supertall. Low metalness and an
// emissive floor keep shaded faces reflective-looking without an environment
// map, while the warm fins/spandrels remain distinct at skyline distance.
const ONE_V_TERRACOTTA = new THREE.MeshStandardMaterial({
  color: '#c5a48d', metalness: 0.22, roughness: 0.42,
  emissive: '#513a2d', emissiveIntensity: 0.28,
});
const ONE_V_STEEL = new THREE.MeshStandardMaterial({
  color: '#bdc8cd', metalness: 0.48, roughness: 0.24,
  emissive: '#39464d', emissiveIntensity: 0.22,
});
const ONE_V_SUMMIT = new THREE.MeshStandardMaterial({
  color: '#dcecf2', metalness: 0.2, roughness: 0.12,
  emissive: '#668793', emissiveIntensity: 0.5,
  transparent: true, opacity: 0.86,
});
const ONE_V_DOOR = new THREE.MeshStandardMaterial({
  color: '#345866', metalness: 0.26, roughness: 0.13,
  emissive: '#173946', emissiveIntensity: 0.72,
});
const ONE_V_RED = new THREE.MeshBasicMaterial({ color: '#ff3b30' });
const ONE_V_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

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

type FacadeRect = { x0: number; x1: number; z0: number; z1: number };

function oneVDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

/** Vertical prism from an exact x/z outline, used for the chamfered podium. */
function oneVPrism(points: THREE.Vector2[], y0: number, y1: number, mat: THREE.Material, detail = false): THREE.Mesh {
  const shape = new THREE.Shape();
  points.forEach((p, i) => {
    // Shape y -> local +z after the mesh-level stand-up rotation.
    if (i === 0) shape.moveTo(p.x, -p.y);
    else shape.lineTo(p.x, -p.y);
  });
  shape.closePath();
  const mesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, steps: 1 }),
    mat,
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y0;
  if (detail) mesh.userData.noCollision = true;
  return mesh;
}

/**
 * One textured, vertically tapered rectangular volume. Every side gets
 * physical-scale UVs, so a tiny repeating texture supplies hundreds of
 * mullions/spandrels for almost no geometry. One Vanderbilt uses the defaults;
 * newer office towers can pass their own bay and floor modules.
 */
function facadeFrustum(
  lower: FacadeRect,
  upper: FacadeRect,
  y0: number,
  y1: number,
  mat: THREE.Material,
  bayW = 1.55,
  floorH = 4.1,
): THREE.Mesh {
  const p: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const floor0 = y0 / floorH, floor1 = y1 / floorH;
  const addQuad = (verts: THREE.Vector3[], tex: [number, number][]) => {
    const n = p.length / 3;
    for (let i = 0; i < 4; i++) {
      p.push(verts[i].x, verts[i].y, verts[i].z);
      uv.push(tex[i][0], tex[i][1]);
    }
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  const l00 = new THREE.Vector3(lower.x0, y0, lower.z0);
  const l10 = new THREE.Vector3(lower.x1, y0, lower.z0);
  const l11 = new THREE.Vector3(lower.x1, y0, lower.z1);
  const l01 = new THREE.Vector3(lower.x0, y0, lower.z1);
  const u00 = new THREE.Vector3(upper.x0, y1, upper.z0);
  const u10 = new THREE.Vector3(upper.x1, y1, upper.z0);
  const u11 = new THREE.Vector3(upper.x1, y1, upper.z1);
  const u01 = new THREE.Vector3(upper.x0, y1, upper.z1);
  const ux = Math.max(
    lower.x1 - lower.x0,
    upper.x1 - upper.x0,
  ) / bayW;
  const uz = Math.max(
    lower.z1 - lower.z0,
    upper.z1 - upper.z0,
  ) / bayW;

  // Winding is outward for FrontSide materials.
  addQuad([l00, u00, u10, l10], [[0, floor0], [0, floor1], [ux, floor1], [ux, floor0]]); // -z
  addQuad([l01, l11, u11, u01], [[0, floor0], [ux, floor0], [ux, floor1], [0, floor1]]); // +z
  addQuad([l00, l01, u01, u00], [[0, floor0], [uz, floor0], [uz, floor1], [0, floor1]]); // -x
  addQuad([l10, u10, u11, l11], [[0, floor0], [0, floor1], [uz, floor1], [uz, floor0]]); // +x
  addQuad(
    [u00, u01, u11, u10],
    [[upper.x0 / bayW, upper.z0 / bayW], [upper.x0 / bayW, upper.z1 / bayW],
      [upper.x1 / bayW, upper.z1 / bayW], [upper.x1 / bayW, upper.z0 / bayW]],
  );

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
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

  // One Vanderbilt: a complete replacement for 24 overlapping source prisms.
  // The bake measures the exact 65x61m site and 427m tip, then clears the
  // generic massing. Four non-overlapping curtain-wall volumes share a tapered
  // envelope and terminate at the source-mapped 315/330/350m setbacks. This
  // preserves KPF's interlocking spiral while avoiding overlap flicker; a tiny
  // repeating texture carries the tower's fluted terracotta floor rhythm.
  'one-vanderbilt': (ctx) => {
    const g = new THREE.Group();
    const W = ctx.fit?.w ?? 65;
    const D = ctx.fit?.d ?? 61;
    const tip = ctx.fit?.roofH ?? 427;

    const curtain = canvasTexture((c, w, h) => {
      const glass = c.createLinearGradient(0, 0, w, 0);
      glass.addColorStop(0, '#7799a8');
      glass.addColorStop(0.22, '#c2dae2');
      glass.addColorStop(0.55, '#8aabb9');
      glass.addColorStop(0.72, '#d5e6eb');
      glass.addColorStop(1, '#6d8d9c');
      c.fillStyle = glass;
      c.fillRect(0, 0, w, h);
      // One fluted terracotta spandrel per real-looking 4.1m floor.
      c.fillStyle = '#b9947d';
      c.fillRect(0, h - 10, w, 8);
      c.fillStyle = 'rgba(244,220,200,.72)';
      c.fillRect(0, h - 10, w, 1);
      c.fillStyle = 'rgba(54,70,77,.7)';
      c.fillRect(0, h - 2, w, 2);
      // Slender mullion plus an off-axis reflection streak; the repeat period
      // is one 1.55m facade bay, so this stays legible inches away.
      c.fillStyle = 'rgba(226,237,238,.86)';
      c.fillRect(0, 0, 2, h);
      c.fillStyle = 'rgba(255,255,255,.28)';
      c.fillRect(Math.floor(w * 0.62), 0, 2, h - 10);
    }, 32, 64);
    curtain.wrapS = curtain.wrapT = THREE.RepeatWrapping;
    const glassA = new THREE.MeshStandardMaterial({
      map: curtain, color: '#c4dce5', metalness: 0.28, roughness: 0.17,
      emissive: '#3d6272', emissiveIntensity: 0.36, envMapIntensity: 1.2,
    });
    const glassB = new THREE.MeshStandardMaterial({
      map: curtain, color: '#aacbd8', metalness: 0.32, roughness: 0.2,
      emissive: '#315465', emissiveIntensity: 0.38, envMapIntensity: 1.1,
    });
    const podiumGlass = new THREE.MeshStandardMaterial({
      map: curtain, color: '#d3e2e7', metalness: 0.24, roughness: 0.2,
      emissive: '#456572', emissiveIntensity: 0.34,
    });

    // ---- public base: chamfered lobby, plaza-facing entrances and canopies
    const podiumW = W - 1.8, podiumD = D - 1.8, podiumH = 18;
    const cut = 5.2;
    const podiumPlan = [
      new THREE.Vector2(-podiumW / 2 + cut, -podiumD / 2),
      new THREE.Vector2(podiumW / 2 - cut, -podiumD / 2),
      new THREE.Vector2(podiumW / 2, -podiumD / 2 + cut),
      new THREE.Vector2(podiumW / 2, podiumD / 2 - cut),
      new THREE.Vector2(podiumW / 2 - cut, podiumD / 2),
      new THREE.Vector2(-podiumW / 2 + cut, podiumD / 2),
      new THREE.Vector2(-podiumW / 2, podiumD / 2 - cut),
      new THREE.Vector2(-podiumW / 2, -podiumD / 2 + cut),
    ];
    g.add(oneVPrism(podiumPlan, 0, podiumH, podiumGlass, true));
    g.add(oneVPrism(podiumPlan, 0, podiumH, ONE_V_COLLISION));

    const fins: THREE.Mesh[] = [];
    for (const sign of [-1, 1]) {
      for (let x = -podiumW / 2 + 6; x <= podiumW / 2 - 6; x += 3.1) {
        if (Math.abs(x) < 10) continue;
        fins.push(box(0.34, 17.4, 0.38, ONE_V_TERRACOTTA, x, 8.7, sign * (podiumD / 2 + 0.18)));
      }
      for (let z = -podiumD / 2 + 6; z <= podiumD / 2 - 6; z += 3.1) {
        if (Math.abs(z) < 10) continue;
        fins.push(box(0.38, 17.4, 0.34, ONE_V_TERRACOTTA, sign * (podiumW / 2 + 0.18), 8.7, z));
      }
    }
    g.add(oneVDetail(mergeBatch(fins, ONE_V_TERRACOTTA)));

    const entranceParts: THREE.Mesh[] = [];
    for (const sign of [-1, 1]) {
      // North/south portals.
      entranceParts.push(box(18.5, 9.2, 0.42, ONE_V_DOOR, 0, 4.6, sign * (podiumD / 2 + 0.25)));
      entranceParts.push(box(19.4, 0.42, 5.6, ONE_V_STEEL, 0, 7.0, sign * (podiumD / 2 + 2.8)));
      for (const x of [-9.2, -4.6, 0, 4.6, 9.2]) {
        entranceParts.push(box(0.22, 9.5, 0.55, ONE_V_STEEL, x, 4.75, sign * (podiumD / 2 + 0.48)));
      }
      // Madison/Vanderbilt Avenue portals.
      entranceParts.push(box(0.42, 9.2, 18.5, ONE_V_DOOR, sign * (podiumW / 2 + 0.25), 4.6, 0));
      entranceParts.push(box(5.6, 0.42, 19.4, ONE_V_STEEL, sign * (podiumW / 2 + 2.8), 7.0, 0));
      for (const z of [-9.2, -4.6, 0, 4.6, 9.2]) {
        entranceParts.push(box(0.55, 9.5, 0.22, ONE_V_STEEL, sign * (podiumW / 2 + 0.48), 4.75, z));
      }
    }
    for (const mesh of entranceParts) g.add(oneVDetail(mesh));

    type Level = { y: number; cx: number; cz: number; w: number; d: number };
    const levels: Level[] = [
      { y: 18, cx: 0, cz: 1, w: W - 3, d: D - 3 },
      { y: 150, cx: 0.8, cz: 0, w: W - 5, d: D - 5 },
      { y: 250, cx: 2, cz: -2, w: W - 10, d: D - 10 },
      { y: 285, cx: 3, cz: -4, w: W - 14, d: D - 13 },
      { y: 315, cx: 4, cz: -6, w: Math.min(47, W - 18), d: Math.min(44, D - 17) },
      { y: 330, cx: 5, cz: -7, w: Math.min(43, W - 22), d: Math.min(40, D - 21) },
      { y: 350, cx: 6, cz: -8, w: Math.min(38, W - 27), d: Math.min(35, D - 26) },
    ];
    const levelAt = new Map(levels.map((l) => [l.y, l]));
    // q0/q1 are the southern pair, which survive to the highest mapped
    // shoulder; the north-east and north-west volumes finish at 330/315m.
    const maxH = [350, 350, 330, 315];
    const rectFor = (l: Level, q: number): FacadeRect => {
      const east = q === 1 || q === 2;
      const north = q >= 2;
      return {
        x0: east ? l.cx : l.cx - l.w / 2,
        x1: east ? l.cx + l.w / 2 : l.cx,
        z0: north ? l.cz : l.cz - l.d / 2,
        z1: north ? l.cz + l.d / 2 : l.cz,
      };
    };

    // ---- four interlocking, individually terminating office volumes
    for (let i = 0; i < levels.length - 1; i++) {
      const a = levels[i], b = levels[i + 1];
      for (let q = 0; q < 4; q++) {
        if (a.y >= maxH[q]) continue;
        const y1 = Math.min(b.y, maxH[q]);
        const upper = levelAt.get(y1);
        if (!upper) continue; // every source-mapped terminal is a profile level
        g.add(facadeFrustum(rectFor(a, q), rectFor(upper, q), a.y, y1, (q + i) % 2 ? glassA : glassB));
      }
    }

    // Warm terrace caps make the rotating setback sequence read from the
    // ground; a merged glass rail gives close fly-bys real depth.
    const rails: THREE.Mesh[] = [];
    for (let q = 0; q < 4; q++) {
      const y = maxH[q];
      const r = rectFor(levelAt.get(y)!, q);
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const x = (r.x0 + r.x1) / 2, z = (r.z0 + r.z1) / 2;
      g.add(oneVDetail(box(w + 0.8, 0.75, d + 0.8, ONE_V_TERRACOTTA, x, y + 0.375, z)));
      rails.push(
        box(w + 0.5, 1.45, 0.18, ONE_V_SUMMIT, x, y + 1.1, r.z0 - 0.25),
        box(w + 0.5, 1.45, 0.18, ONE_V_SUMMIT, x, y + 1.1, r.z1 + 0.25),
        box(0.18, 1.45, d + 0.5, ONE_V_SUMMIT, r.x0 - 0.25, y + 1.1, z),
        box(0.18, 1.45, d + 0.5, ONE_V_SUMMIT, r.x1 + 0.25, y + 1.1, z),
      );
    }
    g.add(oneVDetail(mergeBatch(rails, ONE_V_SUMMIT)));

    // Sixteen conservative collision rings follow the real setbacks, rather
    // than one 427m AABB blocking the empty terrace air.
    for (const [y0, y1] of [[18, 250], [250, 315], [315, 330], [330, 350]] as [number, number][]) {
      const l = levelAt.get(y0)!;
      for (let q = 0; q < 4; q++) {
        if (y0 >= maxH[q]) continue;
        const top = Math.min(y1, maxH[q]);
        const r = rectFor(l, q);
        g.add(box(r.x1 - r.x0, top - y0, r.z1 - r.z0, ONE_V_COLLISION,
          (r.x0 + r.x1) / 2, (y0 + top) / 2, (r.z0 + r.z1) / 2));
      }
    }

    // ---- SUMMIT: observatory band, exterior glass boxes and Ascent lift
    const summitX = 6.5, summitZ = -8.5;
    g.add(oneVDetail(box(28, 1.2, 23, ONE_V_TERRACOTTA, summitX, 330.6, summitZ)));
    for (const sign of [-1, 1]) {
      g.add(oneVDetail(box(6.2, 4.2, 4.8, ONE_V_SUMMIT, summitX + sign * 14.2, 333.0, summitZ)));
    }
    const ascentX = summitX + 14.6;
    g.add(oneVDetail(box(3.2, 35, 2.5, ONE_V_SUMMIT, ascentX, 347.5, summitZ - 1.2)));
    for (const z of [summitZ - 2.5, summitZ + 0.1]) {
      g.add(oneVDetail(strut(
        new THREE.Vector3(ascentX + 1.8, 330, z),
        new THREE.Vector3(ascentX + 1.8, 365, z),
        0.14, ONE_V_STEEL, 5,
      )));
    }

    // The mapped crown cluster is centered at local (7,-9), not at the full
    // block center. Two crisp glass stages replace the former 77m gray pyramid.
    const crown0: FacadeRect = { x0: -5, x1: 19, z0: -20, z1: 2 };
    const crown1: FacadeRect = { x0: 0, x1: 15, z0: -16.5, z1: -2.5 };
    const crown2: FacadeRect = { x0: 4, x1: 10.5, z0: -12.5, z1: -5.5 };
    g.add(facadeFrustum(crown0, crown1, 350, 376, glassA));
    g.add(facadeFrustum(crown1, crown2, 376, 397, glassB));
    for (const [a, b, y0, y1] of [[crown0, crown1, 350, 376], [crown1, crown2, 376, 397]] as [FacadeRect, FacadeRect, number, number][]) {
      for (const [ix, iz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const ax = ix ? a.x1 : a.x0, az = iz ? a.z1 : a.z0;
        const bx = ix ? b.x1 : b.x0, bz = iz ? b.z1 : b.z0;
        g.add(oneVDetail(strut(
          new THREE.Vector3(ax, y0, az),
          new THREE.Vector3(bx, y1, bz),
          0.16, ONE_V_STEEL, 5,
        )));
      }
      // Lower section as the conservative collision envelope for its taper.
      g.add(box(a.x1 - a.x0, y1 - y0, a.z1 - a.z0, ONE_V_COLLISION,
        (a.x0 + a.x1) / 2, (y0 + y1) / 2, (a.z0 + a.z1) / 2));
    }

    // Slender architectural needle to the exact 427m source tip, with
    // mechanical collars and two aviation lights.
    const mastX = 7.25, mastZ = -8.85, mast0 = 397;
    g.add(oneVDetail(box(8.0, 1.4, 8.2, ONE_V_STEEL, mastX, mast0 + 0.7, mastZ)));
    g.add(oneVDetail(cyl(0.13, 0.9, tip - mast0, ONE_V_STEEL, mastX, (mast0 + tip) / 2, mastZ, 8)));
    for (const [y, r] of [[398.8, 1.1], [410, 0.48], [420, 0.25]] as [number, number][]) {
      g.add(oneVDetail(cyl(r, r, 0.34, ONE_V_STEEL, mastX, y, mastZ, 8)));
    }
    const midBeacon = oneVDetail(new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5), ONE_V_RED));
    midBeacon.position.set(mastX, 412, mastZ);
    g.add(midBeacon);
    const beacon = oneVDetail(new THREE.Mesh(new THREE.SphereGeometry(0.2, 6, 5), ONE_V_RED));
    beacon.position.set(mastX, tip, mastZ);
    g.add(beacon);
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

  // 270 Park Avenue: full measured replacement. Nine contiguous source bands
  // describe the completed tower's east/west fan profile exactly: the outer
  // bands finish at 130m, then 250/330/382m, with the narrow center reaching
  // 423m. Rendering those source parts directly made every strip a full-height
  // bronze box; this build uses their plan/roof data but recreates the 24m
  // lifted base, glass curtain wall, twenty perimeter columns and copper-nickel
  // diamonds only on the stepped east/west faces.
  'chase-hq': (ctx) => {
    const g = new THREE.Group();
    const siteW = ctx.fit?.w ?? 57;   // north/south, along the avenues
    const siteD = ctx.fit?.d ?? 109;  // Park Avenue to Madison Avenue
    const tip = ctx.fit?.roofH ?? 423;
    const BASE_TOP = 24; // official 80ft lift above the public realm
    const detail = (mesh: THREE.Mesh) => {
      mesh.userData.noCollision = true;
      return mesh;
    };

    const curtain = canvasTexture((c, w, h) => {
      const glass = c.createLinearGradient(0, 0, w, 0);
      glass.addColorStop(0, '#38515d');
      glass.addColorStop(0.22, '#789aa7');
      glass.addColorStop(0.53, '#526f7b');
      glass.addColorStop(0.72, '#9bb4bd');
      glass.addColorStop(1, '#304852');
      c.fillStyle = glass;
      c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(202,218,222,.3)';
      c.fillRect(Math.floor(w * 0.58), 0, 2, h - 5);
      c.fillStyle = '#6f503d'; // commercial-bronze vertical mullion
      c.fillRect(0, 0, 2, h);
      c.fillStyle = '#28343a'; // deep floor/spandrel band
      c.fillRect(0, h - 5, w, 5);
      c.fillStyle = 'rgba(197,158,125,.7)';
      c.fillRect(0, h - 5, w, 1);
    }, 32, 64);
    curtain.wrapS = curtain.wrapT = THREE.RepeatWrapping;
    const glassA = new THREE.MeshStandardMaterial({
      map: curtain, color: '#abc5cd', metalness: 0.2, roughness: 0.17,
      emissive: '#426774', emissiveIntensity: 0.58, envMapIntensity: 1.15,
    });
    const glassB = new THREE.MeshStandardMaterial({
      map: curtain, color: '#91adb7', metalness: 0.24, roughness: 0.2,
      emissive: '#365966', emissiveIntensity: 0.58, envMapIntensity: 1.05,
    });
    const lobbyGlass = new THREE.MeshStandardMaterial({
      map: curtain, color: '#a8c5cd', metalness: 0.18, roughness: 0.12,
      emissive: '#345b67', emissiveIntensity: 0.52,
    });

    // ---- public realm and transparent Park-to-Madison lobby ---------------
    g.add(box(siteW - 1, 0.3, siteD - 1, GRANITE, 0, 0.15, 0));
    // Madison Avenue garden and Maya Lin's low bedrock-inspired artwork.
    for (const [x, z, w, d] of [
      [-15, -siteD / 2 + 8, 12, 6],
      [0, -siteD / 2 + 7, 10, 7],
      [15, -siteD / 2 + 9, 12, 6],
    ] as [number, number, number, number][]) {
      g.add(box(w, 0.65, d, GRANITE, x, 0.48, z));
      g.add(box(w - 1, 0.72, d - 1, GREEN_PATINA, x, 1.05, z));
    }
    for (const [x, z, sx, sy, sz, ry] of [
      [-8, -siteD / 2 + 16, 4.8, 1.1, 2.3, 0.22],
      [0, -siteD / 2 + 14, 5.5, 1.35, 2.8, -0.35],
      [8, -siteD / 2 + 17, 4.1, 0.95, 2.0, 0.55],
    ] as [number, number, number, number, number, number][]) {
      const rock = detail(new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), DARKSTONE));
      rock.scale.set(sx, sy, sz);
      rock.position.set(x, 1.1, z);
      rock.rotation.y = ry;
      g.add(rock);
    }

    const lobbyW = siteW * 0.58, lobbyD = siteD * 0.68, lobbyH = 20.5;
    g.add(detail(box(lobbyW, lobbyH, lobbyD, lobbyGlass, 0, lobbyH / 2 + 0.4, 0)));
    g.add(box(lobbyW, lobbyH, lobbyD, CHASE_COLLISION, 0, lobbyH / 2 + 0.4, 0));
    for (const sign of [-1, 1]) {
      const z = sign * (lobbyD / 2 + 0.24);
      g.add(detail(box(17, 7.8, 0.38, CHASE_DARK, 0, 4.3, z)));
      g.add(detail(box(18.5, 0.4, 5.8, CHASE_BRONZE, 0, 7.1, sign * (lobbyD / 2 + 2.8))));
      for (const x of [-8.5, -4.25, 0, 4.25, 8.5]) {
        g.add(detail(box(0.22, 8.1, 0.5, CHASE_BRONZE, x, 4.35, sign * (lobbyD / 2 + 0.48))));
      }
    }

    // Twenty tapered legs form ten fan-column units on the north/south sides.
    // Their open V geometry preserves the 80ft-high sightline through the site.
    const taperLeg = (a: THREE.Vector3, b: THREE.Vector3) => {
      const mesh = detail(new THREE.Mesh(
        new THREE.CylinderGeometry(1.25, 2.15, a.distanceTo(b), 9),
        CHASE_BRONZE,
      ));
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      return mesh;
    };
    for (const sx of [-1, 1]) {
      for (const fz of [-siteD * 0.34, -siteD * 0.17, 0, siteD * 0.17, siteD * 0.34]) {
        const apex = new THREE.Vector3(sx * siteW * 0.38, BASE_TOP + 2, fz);
        g.add(detail(box(4.5, 3.5, 5.2, CHASE_BRONZE, apex.x, apex.y + 0.4, apex.z)));
        for (const dz of [-5.8, 5.8]) {
          const foot = new THREE.Vector3(sx * siteW * 0.47, 0.9, fz + dz);
          g.add(taperLeg(foot, apex));
          g.add(box(4.4, 1.0, 4.4, DARKSTONE, foot.x, 0.5, foot.z));
        }
      }
    }
    // A dark two-story transfer table reads behind, rather than replacing,
    // the fan structure.
    g.add(detail(box(siteW * 0.82, 5.0, siteD * 0.94, CHASE_DARK, 0, BASE_TOP + 2.5, 0)));

    type ChaseBand = { z0: number; z1: number; z: number; d: number; w: number; top: number };
    const bandD = siteD / 9;
    const tops = [130, 250, 330, 382, tip, 382, 330, 250, 130];
    const widthScale = [0.775, 0.837, 0.9, 0.965, 1, 0.965, 0.9, 0.837, 0.775];
    const bands: ChaseBand[] = tops.map((top, i) => {
      const z0 = -siteD / 2 + i * bandD, z1 = z0 + bandD;
      return { z0, z1, z: (z0 + z1) / 2, d: z1 - z0, w: siteW * widthScale[i], top };
    });

    // ---- nine non-overlapping measured bands: no coincident faces/flicker
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const rect: FacadeRect = { x0: -b.w / 2, x1: b.w / 2, z0: b.z0, z1: b.z1 };
      g.add(facadeFrustum(rect, rect, BASE_TOP, b.top, i % 2 ? glassA : glassB, 1.55, 6.65));
      // Exact invisible footprint: each setback roof remains landable without
      // one full-site 423m collision wall.
      g.add(box(b.w, b.top - BASE_TOP, b.d, CHASE_COLLISION, 0, (BASE_TOP + b.top) / 2, b.z));

      const louverH = 5.5;
      g.add(detail(box(b.w + 0.34, louverH, b.d + 0.34, CHASE_DARK, 0, b.top - louverH / 2, b.z)));
      g.add(detail(box(b.w + 0.7, 0.55, b.d + 0.7, CHASE_BRONZE, 0, b.top + 0.275, b.z)));

      // Two perimeter columns per strip = eighteen; the two lobby-end columns
      // below complete the real twenty-column read.
      for (const sx of [-1, 1]) {
        g.add(detail(box(0.76, b.top - BASE_TOP, 0.82, CHASE_BRONZE,
          sx * (b.w / 2 + 0.34), (BASE_TOP + b.top) / 2, b.z)));
      }
    }
    for (const z of [-lobbyD / 2, lobbyD / 2]) {
      g.add(detail(box(0.9, BASE_TOP, 0.9, CHASE_BRONZE, 0, BASE_TOP / 2, z)));
    }

    // Five stacked diamond panels on each stepped east/west elevation. The old
    // build put full-height X braces on all four faces, hiding the glass tower.
    for (const sign of [-1, 1]) {
      for (let level = 0; level < 5; level++) {
        const b = bands[sign < 0 ? level : 8 - level];
        const y0 = level === 0 ? BASE_TOP : tops[level - 1];
        const y1 = b.top - 5.5;
        const z = sign < 0 ? b.z0 - 0.52 : b.z1 + 0.52;
        const x0 = -b.w / 2, x1 = b.w / 2;
        const braces = [
          strut(new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y1, z), 0.62, CHASE_BRONZE, 7),
          strut(new THREE.Vector3(x1, y0, z), new THREE.Vector3(x0, y1, z), 0.62, CHASE_BRONZE, 7),
          strut(new THREE.Vector3(x0, y0, z), new THREE.Vector3(x0, y1, z), 0.48, CHASE_BRONZE, 7),
          strut(new THREE.Vector3(x1, y0, z), new THREE.Vector3(x1, y1, z), 0.48, CHASE_BRONZE, 7),
          strut(new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y0, z), 0.42, CHASE_BRONZE, 7),
          strut(new THREE.Vector3(x0, y1, z), new THREE.Vector3(x1, y1, z), 0.42, CHASE_BRONZE, 7),
        ];
        g.add(detail(mergeBatch(braces, CHASE_BRONZE)));
      }
    }

    // Landscaped lower setback roofs: four tiny merged clusters, visible on
    // close fly-bys but negligible at skyline distance.
    for (const i of [0, 1, 7, 8]) {
      const b = bands[i];
      g.add(detail(mergeBatch(terraceGreen(0, b.z, b.top + 0.55), GREEN_PATINA)));
    }

    // Celestial Passage: a restrained luminous rim at the client-center crown.
    // It is visible in daylight without turning the top into a white billboard.
    const crown = bands[4];
    g.add(detail(box(crown.w + 0.6, 0.12, 0.14, CHASE_GLOW, 0, tip + 0.62, crown.z0 - 0.2)));
    g.add(detail(box(crown.w + 0.6, 0.12, 0.14, CHASE_GLOW, 0, tip + 0.62, crown.z1 + 0.2)));
    g.add(detail(box(0.14, 0.12, crown.d + 0.6, CHASE_GLOW, -crown.w / 2 - 0.2, tip + 0.62, crown.z)));
    g.add(detail(box(0.14, 0.12, crown.d + 0.6, CHASE_GLOW, crown.w / 2 + 0.2, tip + 0.62, crown.z)));

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
