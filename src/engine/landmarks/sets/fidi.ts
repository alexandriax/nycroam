import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

// One World Trade Center: four draw-call materials after LandmarkManager's
// merge. The body itself is only eight triangles; close-range richness comes
// from tiny repeating curtain-wall textures and naturally different facet
// normals, not thousands of panes.
const WTC_STEEL = new THREE.MeshStandardMaterial({
  color: '#bac5cb', metalness: 0.72, roughness: 0.25,
  emissive: '#263036', emissiveIntensity: 0.18,
});
const WTC_DARK_STEEL = new THREE.MeshStandardMaterial({
  color: '#4f6069', metalness: 0.62, roughness: 0.3,
  emissive: '#151d22', emissiveIntensity: 0.2,
});
const WTC_BEACON = new THREE.MeshBasicMaterial({ color: '#f5fbff' });
const WTC_RED = new THREE.MeshBasicMaterial({ color: '#ff3f38' });
// Invisible geometry is retained solely so collision follows the taper in six
// cheap polygon bands. Material.visible avoids even an empty render pass.
const WTC_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

function wtcDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

/** One outward-facing textured triangle of the tower's crystalline envelope. */
function wtcFacet(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  uvA: [number, number],
  uvB: [number, number],
  uvC: [number, number],
  mat: THREE.Material,
): THREE.Mesh {
  let vb = b, vc = c, ub = uvB, uc = uvC;
  const n = vb.clone().sub(a).cross(vc.clone().sub(a));
  const center = a.clone().add(vb).add(vc).multiplyScalar(1 / 3);
  if (n.x * center.x + n.z * center.z < 0) {
    vb = c; vc = b; ub = uvC; uc = uvB;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z,
  ], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([
    uvA[0], uvA[1], ub[0], ub[1], uc[0], uc[1],
  ], 2));
  geo.setIndex([0, 1, 2]);
  geo.computeVertexNormals();
  return wtcDetail(new THREE.Mesh(geo, mat));
}

/** Exact vertical collision prism from an x/z footprint, y0..y1. */
function wtcCollisionPrism(points: THREE.Vector2[], y0: number, y1: number): THREE.Mesh {
  const shape = new THREE.Shape();
  points.forEach((p, i) => {
    // A mesh-level -90deg X rotation maps Shape y -> local +z.
    if (i === 0) shape.moveTo(p.x, -p.y);
    else shape.lineTo(p.x, -p.y);
  });
  shape.closePath();
  const mesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, steps: 1 }),
    WTC_COLLISION,
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y0;
  return mesh;
}

/** Tower cross-section: base diamond -> middle octagon -> top axis-aligned square. */
function wtcRing(t: number, baseR: number, topHalf: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < 8; i++) {
    const cardinal = i % 2 === 0;
    const r0 = cardinal ? baseR : baseR * Math.SQRT1_2;
    const r1 = cardinal ? topHalf : topHalf * Math.SQRT2;
    const r = r0 + (r1 - r0) * t;
    const a = (i * Math.PI) / 4;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
}

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // One World Trade Center — complete replacement for OSM's overlapping prisms
  // and separate antenna. SOM's defining geometry is eight long triangular
  // facets: a 200ft square base becomes a perfect octagon at mid-height and a
  // 150ft square, rotated 45 degrees, at the 417m glass parapet. A 408ft steel
  // spire and beacon bring the exact source-measured tip to 541m / 1,776ft.
  'one-wtc': (ctx) => {
    const g = new THREE.Group();
    const roof = 417;
    const tip = ctx.fit?.roofH ?? 541;
    // Fit OBB is the 92m point-to-point envelope. In fit-local coordinates the
    // retained OSM top square measured 46m and is axis-aligned; the 65m base
    // square is the diamond whose vertices define this outer radius.
    const baseR = Math.min(ctx.fit?.w ?? 92, ctx.fit?.d ?? 92) / 2;
    const baseSide = baseR * Math.SQRT2;
    const topHalf = 22.85; // SOM's 150ft square parapet / 2
    const podiumH = 56.7; // 186ft security podium

    // ---- reflective podium: angled low-iron glass fins over the concrete shell
    const podiumTex = canvasTexture((c, w, h) => {
      const grad = c.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#73858d');
      grad.addColorStop(0.35, '#d4e0e3');
      grad.addColorStop(0.52, '#8a9da5');
      grad.addColorStop(0.72, '#e8f1f2');
      grad.addColorStop(1, '#6b7d84');
      c.fillStyle = grad;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(247,253,255,.82)';
      c.lineWidth = 1;
      for (let x = 0; x <= w; x += 4) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 2, h); c.stroke();
      }
      c.strokeStyle = 'rgba(35,48,54,.34)';
      for (let y = 0; y <= h; y += 13.5) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
      }
    }, 128, 256);
    const podiumMat = new THREE.MeshStandardMaterial({
      map: podiumTex, color: '#d5e0e3', metalness: 0.4, roughness: 0.27, envMapIntensity: 1.05,
    });
    const podium = wtcDetail(box(baseSide, podiumH, baseSide, podiumMat, 0, podiumH / 2, 0));
    podium.rotation.y = Math.PI / 4;
    g.add(podium);
    g.add(wtcCollisionPrism(wtcRing(0, baseR, topHalf).filter((_, i) => i % 2 === 0), 0, podiumH));

    // 60ft-high transparent entrance portals and cantilevered glass canopies on
    // all four sides. The textured podium supplies its thousands of small fins;
    // these few true volumes preserve close-up depth and reflections.
    const portalTex = canvasTexture((c, w, h) => {
      const glow = c.createLinearGradient(0, 0, 0, h);
      glow.addColorStop(0, '#5f8493');
      glow.addColorStop(0.65, '#789fac');
      glow.addColorStop(1, '#355866');
      c.fillStyle = glow;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(213,235,242,.72)';
      c.lineWidth = 1;
      for (let x = 0; x <= w; x += 16) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
      }
      for (let y = 0; y <= h; y += 16) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
      }
      c.strokeStyle = 'rgba(25,44,52,.62)';
      c.lineWidth = 2;
      c.strokeRect(1, 1, w - 2, h - 2);
    }, 128, 128);
    const portalMat = new THREE.MeshStandardMaterial({
      map: portalTex, color: '#b8d4de', metalness: 0.32, roughness: 0.14,
      emissive: '#294a57', emissiveIntensity: 0.52,
    });
    const doorMat = new THREE.MeshStandardMaterial({
      color: '#416b7a', metalness: 0.4, roughness: 0.12,
      emissive: '#183945', emissiveIntensity: 0.7,
    });
    const podiumApothem = baseR * Math.SQRT1_2;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const nx = Math.sin(a), nz = Math.cos(a);
      const tx = Math.cos(a), tz = -Math.sin(a);
      const portal = wtcDetail(box(18.3, 18.3, 0.4, portalMat, nx * (podiumApothem + 0.24), 9.15, nz * (podiumApothem + 0.24)));
      portal.rotation.y = a;
      g.add(portal);
      for (const side of [-1, 1]) {
        const frame = wtcDetail(box(0.72, 19.2, 0.72, WTC_STEEL,
          nx * (podiumApothem + 0.48) + tx * side * 9.45, 9.6,
          nz * (podiumApothem + 0.48) + tz * side * 9.45));
        frame.rotation.y = a;
        g.add(frame);
      }
      const header = wtcDetail(box(19.6, 0.75, 0.72, WTC_STEEL,
        nx * (podiumApothem + 0.48), 18.8, nz * (podiumApothem + 0.48)));
      header.rotation.y = a;
      g.add(header);
      const canopy = wtcDetail(box(19.2, 0.45, 6.6, WTC_STEEL,
        nx * (podiumApothem + 3.4), 7.1, nz * (podiumApothem + 3.4)));
      canopy.rotation.y = a;
      g.add(canopy);
      // Four human-scale revolving/door bays under each canopy.
      for (const off of [-6.6, -2.2, 2.2, 6.6]) {
        const door = wtcDetail(box(3.65, 5.25, 0.34, doorMat,
          nx * (podiumApothem + 0.52) + tx * off, 2.625,
          nz * (podiumApothem + 0.52) + tz * off));
        door.rotation.y = a;
        g.add(door);
        const mullion = wtcDetail(box(0.16, 5.4, 0.46, WTC_STEEL,
          nx * (podiumApothem + 0.7) + tx * (off - 1.82), 2.7,
          nz * (podiumApothem + 0.7) + tz * (off - 1.82)));
        mullion.rotation.y = a;
        g.add(mullion);
      }
    }

    // ---- 71-story crystalline office tower: eight real planar facets
    const curtain = canvasTexture((c, w, h) => {
      c.fillStyle = '#e4edf0';
      c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,.78)';
      c.fillRect(0, 0, 2, h);
      c.fillStyle = 'rgba(61,83,94,.34)';
      c.fillRect(0, 0, w, 2);
      c.fillStyle = 'rgba(255,255,255,.32)';
      c.fillRect(w * 0.55, 0, 1, h);
    }, 32, 32);
    curtain.wrapS = curtain.wrapT = THREE.RepeatWrapping;
    const glassA = new THREE.MeshStandardMaterial({
      map: curtain, color: '#d8ebf3', metalness: 0.28, roughness: 0.18,
      emissive: '#4d7182', emissiveIntensity: 0.38, envMapIntensity: 1.25,
    });
    const glassB = new THREE.MeshStandardMaterial({
      map: curtain, color: '#bad7e4', metalness: 0.34, roughness: 0.2,
      emissive: '#3c6173', emissiveIntensity: 0.4, envMapIntensity: 1.15,
    });
    const B = [
      new THREE.Vector3(baseR, podiumH, 0),
      new THREE.Vector3(0, podiumH, baseR),
      new THREE.Vector3(-baseR, podiumH, 0),
      new THREE.Vector3(0, podiumH, -baseR),
    ];
    const T = [
      new THREE.Vector3(topHalf, roof, topHalf),
      new THREE.Vector3(-topHalf, roof, topHalf),
      new THREE.Vector3(-topHalf, roof, -topHalf),
      new THREE.Vector3(topHalf, roof, -topHalf),
    ];
    const risePanels = (roof - podiumH) / 4.064; // real 13ft-4in full-floor glass panels
    const widthPanels = baseSide / 1.524; // real 5ft panel module
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4, prev = (i + 3) % 4;
      // Upward facet: broad base edge tapering to one corner of the top square.
      g.add(wtcFacet(
        B[i], B[next], T[i],
        [0, 0], [widthPanels, 0], [widthPanels / 2, risePanels],
        i % 2 ? glassB : glassA,
      ));
      // Downward facet: one base corner widening to an edge of the top square.
      g.add(wtcFacet(
        B[i], T[i], T[prev],
        [widthPanels / 2, 0], [widthPanels, risePanels], [0, risePanels],
        i % 2 ? glassA : glassB,
      ));
    }

    // Six exact collision bands follow the taper; each uses the lower (wider)
    // cross-section as a conservative envelope for its 60m vertical slice.
    for (let i = 0; i < 6; i++) {
      const y0 = podiumH + ((roof - podiumH) * i) / 6;
      const y1 = podiumH + ((roof - podiumH) * (i + 1)) / 6;
      g.add(wtcCollisionPrism(wtcRing(i / 6, baseR, topHalf), y0, y1));
    }

    // Glass parapet at the original Twin Towers' roof line and a dark,
    // stainless-steel communications platform above it.
    g.add(wtcDetail(box(topHalf * 2, 1.2, topHalf * 2, WTC_STEEL, 0, roof - 0.6, 0)));
    for (const z of [-topHalf, topHalf])
      g.add(wtcDetail(box(topHalf * 2, 3.2, 0.28, glassA, 0, roof - 1.6, z)));
    for (const x of [-topHalf, topHalf])
      g.add(wtcDetail(box(0.28, 3.2, topHalf * 2, glassA, x, roof - 1.6, 0)));
    g.add(cyl(13.2, 14.8, 2.4, WTC_STEEL, 0, roof + 1.2, 0, 18));
    g.add(cyl(11.0, 13.2, 3.0, WTC_DARK_STEEL, 0, roof + 3.9, 0, 18));
    g.add(cyl(10.4, 10.4, 0.7, WTC_STEEL, 0, roof + 5.75, 0, 18));

    // ---- cable-stayed broadcast spire and LED beacon
    const mastBase = roof + 5.8;
    g.add(cyl(0.22, 1.75, tip - mastBase, WTC_STEEL, 0, (mastBase + tip) / 2, 0, 10));
    const rings: [number, number][] = [
      [mastBase + 1, 5.8],
      [mastBase + 19, 4.9],
      [mastBase + 40, 3.8],
      [mastBase + 65, 2.7],
      [mastBase + 91, 1.45],
    ];
    // Build the 112-piece cable frame as two material batches rather than 112
    // scene nodes. The unit cylinders reproduce strut() exactly after their
    // transforms are baked, while the final noCollision meshes keep diagonal
    // cables from becoming broad AABB obstacles around the flyable spire.
    const spireSteelGeos: THREE.BufferGeometry[] = [];
    const spireDarkGeos: THREE.BufferGeometry[] = [];
    const spireUnit4 = new THREE.CylinderGeometry(1, 1, 1, 4);
    const spireUnit5 = new THREE.CylinderGeometry(1, 1, 1, 5);
    const spireUp = new THREE.Vector3(0, 1, 0);
    const spireMid = new THREE.Vector3();
    const spireDirection = new THREE.Vector3();
    const spireRotation = new THREE.Quaternion();
    const spireScale = new THREE.Vector3();
    const spireMatrix = new THREE.Matrix4();
    const addSpireStrut = (
      target: THREE.BufferGeometry[], unit: THREE.BufferGeometry,
      a: THREE.Vector3, b: THREE.Vector3, radius: number,
    ): void => {
      const len = a.distanceTo(b);
      spireMid.copy(a).add(b).multiplyScalar(0.5);
      spireDirection.copy(b).sub(a).normalize();
      spireRotation.setFromUnitVectors(spireUp, spireDirection);
      spireScale.set(radius, len, radius);
      spireMatrix.compose(spireMid, spireRotation, spireScale);
      target.push(unit.clone().applyMatrix4(spireMatrix));
    };
    const legs = 8;
    for (let i = 0; i < legs; i++) {
      const a = (i / legs) * Math.PI * 2 + Math.PI / 8;
      const a2 = ((i + 1) / legs) * Math.PI * 2 + Math.PI / 8;
      for (let k = 0; k < rings.length - 1; k++) {
        const [y0, r0] = rings[k], [y1, r1] = rings[k + 1];
        const p0 = new THREE.Vector3(Math.cos(a) * r0, y0, Math.sin(a) * r0);
        const p1 = new THREE.Vector3(Math.cos(a) * r1, y1, Math.sin(a) * r1);
        const px = new THREE.Vector3(Math.cos(a2) * r1, y1, Math.sin(a2) * r1);
        addSpireStrut(spireSteelGeos, spireUnit5, p0, p1, 0.15);
        addSpireStrut(spireDarkGeos, spireUnit4, p0, px, 0.075);
      }
    }
    for (const [y, r] of rings) {
      for (let i = 0; i < legs; i++) {
        const a = (i / legs) * Math.PI * 2 + Math.PI / 8;
        const b = ((i + 1) / legs) * Math.PI * 2 + Math.PI / 8;
        addSpireStrut(
          spireSteelGeos,
          spireUnit4,
          new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r),
          new THREE.Vector3(Math.cos(b) * r, y, Math.sin(b) * r),
          0.07,
        );
      }
    }
    // Eight long stays are the structure's most legible close-range signature.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      addSpireStrut(
        spireSteelGeos,
        spireUnit5,
        new THREE.Vector3(Math.cos(a) * 13.1, roof + 4.8, Math.sin(a) * 13.1),
        new THREE.Vector3(Math.cos(a) * 1.15, mastBase + 48, Math.sin(a) * 1.15),
        0.085,
      );
    }
    if (spireSteelGeos.length !== 80 || spireDarkGeos.length !== 32) {
      throw new Error(
        `One WTC spire count changed: ${spireSteelGeos.length} steel, ${spireDarkGeos.length} dark`,
      );
    }
    const addSpireBatch = (
      geos: THREE.BufferGeometry[], material: THREE.Material, label: string,
    ): void => {
      const merged = mergeGeometries(geos, false);
      if (!merged) throw new Error(`Could not merge One WTC ${label} geometry`);
      for (const geometry of geos) geometry.dispose();
      g.add(wtcDetail(new THREE.Mesh(merged, material)));
    };
    addSpireBatch(spireSteelGeos, WTC_STEEL, 'steel spire');
    addSpireBatch(spireDarkGeos, WTC_DARK_STEEL, 'dark spire');
    spireUnit4.dispose();
    spireUnit5.dispose();

    for (const y of [mastBase + 38, mastBase + 80]) {
      const warning = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), WTC_RED);
      warning.position.y = y;
      g.add(wtcDetail(warning));
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), WTC_BEACON);
    beacon.position.y = tip;
    g.add(wtcDetail(beacon));
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

  // Statue of Liberty: Fort Wood star base, Hunt pedestal w/ loggia colonnade,
  // lathe-robed verdigris figure, 7-spike crown, raised gold torch (~93m to flame)
  'liberty-statue': () => {
    const g = new THREE.Group();
    // The statue stands 2.8km out in the harbor — far beyond the fog's far
    // plane, which would erase it entirely. These materials opt out of fog
    // (fog: false) and pre-bake the atmospheric haze into their colors so it
    // still sits believably behind the air, like the skyline layer does.
    const VERDIGRIS_FAR = new THREE.MeshLambertMaterial({ color: '#8fb5ad', fog: false });
    const VERDIGRIS_DK = new THREE.MeshLambertMaterial({ color: '#7ba39b', fog: false }); // drapery/tablet shadow
    const GRANITE_FAR = new THREE.MeshLambertMaterial({ color: '#a9b0b8', fog: false });
    const GRANITE_DK = new THREE.MeshLambertMaterial({ color: '#8d949d', fog: false }); // recessed panels/joints
    const GOLD_FAR = new THREE.MeshLambertMaterial({ color: '#d6c07a', fog: false });
    const FLAME_FAR = new THREE.MeshBasicMaterial({ color: '#f4dc93', fog: false }); // unlit: reads as a lit torch

    // --- Fort Wood: 11-point granite star ramparts ---
    const s1 = starPrism(11, 22, 15, 9, GRANITE_FAR);
    s1.position.y = -2;
    g.add(s1);
    const s2 = starPrism(11, 16, 11, 4, GRANITE_DK); // inner rampart terrace (darker course)
    s2.position.y = 7;
    g.add(s2);

    // --- Richard Morris Hunt pedestal (square granite tower) ---
    g.add(box(21, 3, 21, GRANITE_FAR, 0, 11.5, 0)); // base plinth
    g.add(box(17, 21, 17, GRANITE_FAR, 0, 23.5, 0)); // main shaft
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) // corner pilasters
      g.add(box(2.2, 21, 2.2, GRANITE_DK, sx * 8, 23.5, sz * 8));
    for (const s of [-1, 1]) { // recessed panel on each of the 4 faces
      g.add(box(9, 13, 0.6, GRANITE_DK, 0, 23, s * 8.6));
      g.add(box(0.6, 13, 9, GRANITE_DK, s * 8.6, 23, 0));
    }
    // loggia: a short Doric colonnade ringing the top of the shaft
    const colH = 5, colY = 30;
    for (const s of [-1, 1]) for (const t of [-6, -2, 2, 6]) {
      g.add(cyl(0.85, 0.95, colH, GRANITE_FAR, t, colY + colH / 2, s * 8.7, 8)); // front/back faces
      g.add(cyl(0.85, 0.95, colH, GRANITE_FAR, s * 8.7, colY + colH / 2, t, 8)); // side faces
    }
    g.add(box(20, 2.2, 20, GRANITE_FAR, 0, 36.3, 0)); // projecting cornice over the colonnade
    g.add(box(14, 4, 14, GRANITE_FAR, 0, 39.5, 0)); // attic band
    g.add(box(16, 1.6, 16, GRANITE_FAR, 0, 42.3, 0)); // observation balcony deck
    for (const s of [-1, 1]) { // low parapet ring around the deck
      g.add(box(16, 1.3, 0.6, GRANITE_DK, 0, 43.7, s * 7.7));
      g.add(box(0.6, 1.3, 16, GRANITE_DK, s * 7.7, 43.7, 0));
    }

    // --- Verdigris figure (heel at local 0), feet on the pedestal deck ---
    const f = new THREE.Group();
    f.add(lathe([ // flowing robe: flared hem tapering to the shoulders
      [0.0, 0], [4.4, 0.5], [3.9, 1.8], [3.5, 4], [3.2, 8], [3.05, 12],
      [2.95, 16], [2.85, 20], [2.85, 23], [2.95, 25], [2.4, 26.6], [1.55, 27.6],
    ], VERDIGRIS_FAR, 18));
    for (const fa of [-0.9, -0.3, 0.3, 0.9]) // vertical drapery folds down the front
      f.add(box(0.5, 22, 0.5, VERDIGRIS_DK, Math.sin(fa) * 2.7, 12, Math.cos(fa) * 2.7 + 0.1));
    // palla (cloak) slung from the left shoulder across the body
    const cloak = box(5.6, 9, 0.8, VERDIGRIS_DK, -0.6, 21, 2.5);
    cloak.rotation.z = 0.25;
    f.add(cloak);
    f.add(cyl(0.85, 1.05, 1.8, VERDIGRIS_FAR, 0, 28.4, 0.15, 8)); // neck
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 10), VERDIGRIS_FAR);
    head.position.set(0, 30.4, 0.35);
    head.scale.set(0.9, 1.15, 1.0); // slight ovoid
    f.add(head);
    f.add(box(1.9, 0.9, 1.9, VERDIGRIS_FAR, 0, 31.5, 0.35)); // crown band/diadem
    for (let i = 0; i < 7; i++) { // 7 sharp crown spikes fanned over the head
      const a = (i / 6 - 0.5) * 2.5;
      const spike = cyl(0, 0.4, 3.8, VERDIGRIS_FAR, 0, 0, 0, 6);
      spike.position.set(Math.sin(a) * 2.0, 32.0 + Math.cos(a) * 2.0, 0.35);
      spike.rotation.z = -a;
      f.add(spike);
    }
    // raised right arm bearing the torch
    const A0 = new THREE.Vector3(2.2, 25.5, 0.3), A1 = new THREE.Vector3(3.4, 32, 0.4), A2 = new THREE.Vector3(4.3, 40, 0.4);
    f.add(strut(A0, A1, 1.0, VERDIGRIS_FAR, 8)); // upper arm
    f.add(strut(A1, A2, 0.8, VERDIGRIS_FAR, 8)); // forearm
    f.add(cyl(0.45, 0.6, 3, GOLD_FAR, 4.5, 41.4, 0.4, 8)); // torch handle
    f.add(cyl(1.4, 0.8, 1.3, GOLD_FAR, 4.6, 43.4, 0.4, 10)); // torch cup / balcony
    f.add(cyl(0, 1.3, 3.2, FLAME_FAR, 4.6, 45.5, 0.4, 10)); // flame (tip ~47 -> ~90m world)
    // left arm cradling the tablet against the body
    const L0 = new THREE.Vector3(-2.2, 25.2, 0.3), L1 = new THREE.Vector3(-2.7, 21.5, 1.4), L2 = new THREE.Vector3(-0.9, 19.5, 2.4);
    f.add(strut(L0, L1, 0.95, VERDIGRIS_FAR, 8)); // upper arm
    f.add(strut(L1, L2, 0.8, VERDIGRIS_FAR, 8)); // forearm across the body
    const tablet = box(2.7, 5.2, 0.7, VERDIGRIS_DK, -2.3, 21.5, 1.8); // TABULA held tilted
    tablet.rotation.z = 0.4;
    tablet.rotation.x = -0.18;
    f.add(tablet);
    f.position.y = 43;
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
