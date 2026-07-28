import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRONZE, GOLD, STEEL_LM, GLASS_LM,
  WHITE_LM, WATER_LM, GREEN_PATINA,
  box, cyl, strut, colonnade, lathe, archWall, figure, canvasTexture,
} from '../kit';

/**
 * Uptown set: Columbus Circle, the Upper West Side spine (Lincoln Center,
 * the Dakota, AMNH) and the Fifth-Avenue museums (Met, Guggenheim), plus the
 * Intrepid on the Hudson. Every builder returns a group whose origin sits at
 * ground level at the registry position; the manager rotates/positions/merges.
 */

// ---- local materials (a few tints the shared kit doesn't carry) ------------
const DAKOTA_BRICK = new THREE.MeshLambertMaterial({ color: '#b08d6a' }); // pale tan brick
const WARM_GLOW = new THREE.MeshBasicMaterial({ color: '#f6c98a' });       // lit interiors (unlit = glows)
const BANNER_A = new THREE.MeshLambertMaterial({ color: '#9c2b2b' });      // museum banners
const BANNER_B = new THREE.MeshLambertMaterial({ color: '#2b4a7c' });
const BANNER_C = new THREE.MeshLambertMaterial({ color: '#8a6d1f' });
// Central Park Tower's skin is blue-gray glass articulated by bright,
// pattern-rolled stainless fins. Keep metalness moderate: the world avoids an
// expensive environment map, so a small emissive floor preserves the silvery
// pinstripes on shaded and mobile-quality faces instead of turning them black.
const CPT_STAINLESS = new THREE.MeshStandardMaterial({
  color: '#c7d1d6', metalness: 0.45, roughness: 0.2,
  emissive: '#536269', emissiveIntensity: 0.24,
});
const CPT_DARK = new THREE.MeshStandardMaterial({
  color: '#354650', metalness: 0.28, roughness: 0.32,
  emissive: '#18252c', emissiveIntensity: 0.35,
});
const CPT_DOOR = new THREE.MeshStandardMaterial({
  color: '#426572', metalness: 0.16, roughness: 0.13,
  emissive: '#294954', emissiveIntensity: 0.62,
});
const CPT_GLOW = new THREE.MeshBasicMaterial({ color: '#d9c49a' });
const CPT_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

// ---- shared local helpers ---------------------------------------------------

type PlanPoint = [number, number];

/** Decorative landmark detail never becomes its own coarse collision volume. */
function cptDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

/**
 * Physically UV-scaled polygonal curtain wall. A tiny repeating texture can
 * supply every floor, mullion and spandrel at close range while the complete
 * 422m shaft remains only four vertices per facade edge.
 */
function cptFacade(
  source: PlanPoint[],
  y0: number,
  y1: number,
  mat: THREE.Material,
  bayW = 1.5,
  floorH = 4.4,
): THREE.Mesh {
  let area2 = 0;
  for (let i = 0, j = source.length - 1; i < source.length; j = i++) {
    area2 += source[j][0] * source[i][1] - source[i][0] * source[j][1];
  }
  // Side winding below assumes CCW in x/z (interior to the left, exterior to
  // the right). The measured OSM rings happen to be clockwise.
  const points = area2 < 0 ? [...source].reverse() : source;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const u1 = Math.hypot(b[0] - a[0], b[1] - a[1]) / bayW;
    const n = pos.length / 3;
    pos.push(
      a[0], y0, a[1],
      a[0], y1, a[1],
      b[0], y1, b[1],
      b[0], y0, b[1],
    );
    uv.push(0, y0 / floorH, 0, y1 / floorH, u1, y1 / floorH, u1, y0 / floorH);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return cptDetail(new THREE.Mesh(geo, mat));
}

/** Exact invisible solid used only by LandmarkManager's polygonal collision. */
function cptSolid(points: PlanPoint[], y0: number, y1: number): THREE.Mesh {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  const mesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false }),
    CPT_COLLISION,
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y0;
  return mesh;
}

/** Flat roof following an exact measured plan. */
function cptRoof(points: PlanPoint[], y: number, mat: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  const mesh = cptDetail(new THREE.Mesh(new THREE.ShapeGeometry(shape), mat));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

/** Straight park bench (matches the exemplar set's proportions). */
function bench(mat: THREE.Material = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.06, 0.5, mat, 0, 0.45, 0));
  g.add(box(1.8, 0.5, 0.06, mat, 0, 0.7, -0.25));
  g.add(box(0.08, 0.45, 0.5, mat, -0.8, 0.22, 0));
  g.add(box(0.08, 0.45, 0.5, mat, 0.8, 0.22, 0));
  return g;
}

/** Bench whose seat segments follow an arc of the given radius, facing inward. */
function curvedBench(radius: number, arc: number, segs = 5, mat: THREE.Material = DARKSTONE): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < segs; i++) {
    const a = -arc / 2 + (arc * (i + 0.5)) / segs;
    const x = Math.sin(a) * radius, z = Math.cos(a) * radius;
    const seat = box(1.5, 0.1, 0.5, mat, x, 0.45, z); seat.rotation.y = -a; g.add(seat);
    const back = box(1.5, 0.5, 0.08, mat, x, 0.7, z + 0.24); back.rotation.y = -a; g.add(back);
  }
  return g;
}

/** Ornate gas lamp with a self-lit globe (the Dakota's famous entrance lamps). */
function gasLamp(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.12, 0.18, 0.5, DARKSTONE, 0, 0.25, 0, 8));
  g.add(cyl(0.07, 0.09, 3.6, DARKSTONE, 0, 2.0, 0, 8));
  g.add(box(0.4, 0.4, 0.4, DARKSTONE, 0, 3.9, 0));
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), WARM_GLOW);
  globe.position.y = 4.25; g.add(globe);
  g.add(cyl(0.0, 0.3, 0.5, DARKSTONE, 0, 4.7, 0, 6));
  return g;
}

/** Gilt finial: shaft, ball and spike, sitting with its foot at (x,y,z). */
function finialAt(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.08, 0.12, 1.6, GOLD, x, y + 0.8, z, 6));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), GOLD);
  ball.position.set(x, y + 1.7, z); g.add(ball);
  g.add(cyl(0.0, 0.12, 0.7, GOLD, x, y + 2.2, z, 6));
  return g;
}

/** Four steep sloped roof slabs (a mansard) leaning inward around a footprint. */
function mansardSlabs(W: number, D: number, y0: number, mh: number, inset: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const len = Math.hypot(mh, inset);
  const ang = Math.atan2(inset, mh);
  for (const s of [1, -1]) {
    const slab = box(W, len, 0.9, mat, 0, y0 + mh / 2, s * (D / 2 - inset / 2));
    slab.rotation.x = -s * ang; g.add(slab);
  }
  for (const s of [1, -1]) {
    const slab = box(0.9, len, D, mat, s * (W / 2 - inset / 2), y0 + mh / 2, 0);
    slab.rotation.z = s * ang; g.add(slab);
  }
  return g;
}

/** Stylized equestrian statue (horse + rider) ~2.7m tall at the withers. */
function equestrian(mat: THREE.Material): THREE.Group {
  const h = new THREE.Group();
  h.add(box(3.0, 1.4, 1.0, mat, 0, 1.7, 0));
  const neck = cyl(0.3, 0.4, 1.4, mat, 1.3, 2.4, 0, 8); neck.rotation.z = -0.6; h.add(neck);
  const head = box(1.0, 0.5, 0.5, mat, 1.9, 3.0, 0); head.rotation.z = -0.3; h.add(head);
  for (const lx of [-1.1, 1.0]) for (const lz of [-0.35, 0.35]) h.add(cyl(0.13, 0.13, 1.7, mat, lx, 0.85, lz, 6));
  const tail = cyl(0.1, 0.18, 1.2, mat, -1.55, 1.6, 0, 6); tail.rotation.z = 0.7; h.add(tail);
  const rider = figure(2.0, mat); rider.position.set(0.1, 2.4, 0); h.add(rider);
  return h;
}

/** A simple carrier-deck warplane silhouette (fuselage + cruciform wings/tail). */
function warplane(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(7, 0.7, 1.0, mat, 0, 0.5, 0));
  g.add(box(1.6, 0.25, 8, mat, 0.3, 0.5, 0));
  g.add(box(1.4, 1.0, 0.25, mat, -3.0, 0.9, 0));
  g.add(box(1.2, 0.2, 3.0, mat, -2.8, 0.5, 0));
  return g;
}

/** Angled hull plate (a box laid along the segment a->b in the XZ plane). */
function hullPlate(x1: number, z1: number, x2: number, z2: number, hh: number, yc: number, mat: THREE.Material): THREE.Mesh {
  const dx = x2 - x1, dz = z2 - z1;
  const m = box(Math.hypot(dx, dz), hh, 1.6, mat, (x1 + x2) / 2, yc, (z1 + z2) / 2);
  m.rotation.y = -Math.atan2(dz, dx);
  return m;
}

interface Face { half: number; fixed: number; axis: 'x' | 'z'; sign: number; }

export const builders: Record<string, (ctx: LandmarkCtx) => THREE.Group> = {
  // Columbus monument: granite rostral column on stepped base, marble Columbus, ring fountain, curved benches
  'columbus-circle': () => {
    const g = new THREE.Group();
    // stepped granite base
    g.add(box(9, 0.6, 9, GRANITE, 0, 0.3, 0));
    g.add(box(7, 0.6, 7, GRANITE, 0, 0.9, 0));
    g.add(box(5, 0.6, 5, GRANITE, 0, 1.5, 0));
    // rostral column: tapered shaft with protruding ship-prow rams at three levels
    const y0 = 1.8, shaftH = 21;
    g.add(cyl(1.05, 1.35, shaftH, GRANITE, 0, y0 + shaftH / 2, 0, 12));
    for (const frac of [0.3, 0.55, 0.8]) {
      const py = y0 + shaftH * frac, rr = 1.35 - 0.3 * frac;
      for (let s = 0; s < 4; s++) {
        const a = s * Math.PI / 2 + Math.PI / 4;
        const prow = new THREE.Group();
        prow.add(box(1.3, 0.5, 0.5, GRANITE, 0.65, 0, 0));       // ram body
        const tip = box(0.6, 0.4, 0.35, GRANITE, 1.45, 0, 0); tip.rotation.z = -0.15; prow.add(tip); // pointed beak
        prow.position.set(Math.cos(a) * (rr + 0.2), py, Math.sin(a) * (rr + 0.2));
        prow.rotation.y = -a; g.add(prow);
      }
    }
    g.add(cyl(1.6, 1.2, 1.1, GRANITE, 0, y0 + shaftH + 0.55, 0, 12)); // capital
    const columbus = figure(4, MARBLE); columbus.position.y = y0 + shaftH + 1.1; g.add(columbus);
    // ring fountain: lathe basin walls + water annulus
    g.add(lathe([[6.6, 0], [6.6, 0.75], [7.1, 0.75], [7.1, 0.05]], GRANITE, 20)); // outer rim
    g.add(lathe([[4.3, 0], [4.3, 0.6], [4.7, 0.6], [4.7, 0.05]], GRANITE, 18));   // inner curb
    const water = new THREE.Mesh(new THREE.RingGeometry(4.7, 6.6, 24), WATER_LM);
    water.rotation.x = -Math.PI / 2; water.position.y = 0.5; g.add(water);
    for (let q = 0; q < 4; q++) { const b = curvedBench(10.5, 1.0, 5); b.rotation.y = q * Math.PI / 2 + Math.PI / 4; g.add(b); }
    return g;
  },

  // Hearst Tower: diagrid steel overlay (zigzag diamonds, no corner verticals) wrapping the OSM tower footprint
  'hearst-tower': (ctx) => {
    // Hearst Tower: the 1928 Urban cast-stone base (OSM has no separate base
    // part, so the pipeline clears the whole massing and we own all of it),
    // with the diagrid tower rising out of it — glazed, not a bare frame:
    // a mullioned glass box wears the diagonal steel lattice, with the
    // signature bird's-mouth corner notches (no corner verticals).
    const g = new THREE.Group();
    const bw = (ctx.fit?.w ?? 79), bd = (ctx.fit?.d ?? 70);
    const baseH = 26;
    // -- 1928 base: cast stone with fluted pilasters and a deep cornice
    g.add(box(bw, baseH, bd, LIMESTONE, 0, baseH / 2, 0));
    g.add(box(bw + 1.6, 1.8, bd + 1.6, DARKSTONE, 0, baseH + 0.9, 0)); // cornice
    for (let x = -bw / 2 + 4; x <= bw / 2 - 4; x += 6.2) {
      for (const sz of [1, -1]) g.add(box(1.4, baseH - 4, 1.1, WHITE_LM, x, (baseH - 4) / 2 + 2, sz * (bd / 2 + 0.35)));
    }
    for (let z = -bd / 2 + 5; z <= bd / 2 - 5; z += 6.2) {
      for (const sx of [1, -1]) g.add(box(1.1, baseH - 4, 1.4, WHITE_LM, sx * (bw / 2 + 0.35), (baseH - 4) / 2 + 2, z));
    }
    // -- glazed tower: mullioned glass volume the lattice sits on
    const y0 = baseH, y1 = 182;
    const HW = 24, HD = 18.5; // ~48m x 37m tower footprint, centered on the base
    const glass = box(HW * 2 - 1.1, y1 - y0, HD * 2 - 1.1, GLASS_LM, 0, (y0 + y1) / 2, 0);
    g.add(glass);
    // floor bands every ~4 storeys so the glass reads as storeys, not a slab
    for (let y = y0 + 16; y < y1; y += 16) {
      g.add(box(HW * 2 - 0.9, 0.55, HD * 2 - 0.9, STEEL_LM, 0, y, 0));
    }
    const faces: Face[] = [
      { half: HW, fixed: HD, axis: 'z', sign: 1 }, { half: HW, fixed: HD, axis: 'z', sign: -1 },
      { half: HD, fixed: HW, axis: 'x', sign: 1 }, { half: HD, fixed: HW, axis: 'x', sign: -1 },
    ];
    const P = (f: Face, u: number, y: number): THREE.Vector3 =>
      f.axis === 'z' ? new THREE.Vector3(u, y, f.sign * f.fixed) : new THREE.Vector3(f.sign * f.fixed, y, u);
    const rows = 6, rowH = (y1 - y0) / rows;
    for (const f of faces) {
      const n = Math.max(3, Math.round((f.half * 2) / 12)), seg = (f.half * 2) / n;
      for (let r = 0; r < rows; r++) {
        const yb = y0 + r * rowH, yt = yb + rowH;
        for (let i = 0; i < n; i++) {
          const xL = -f.half + i * seg, xR = xL + seg;
          g.add(strut(P(f, xL, yb), P(f, xR, yt), 0.55, STEEL_LM, 6));
          g.add(strut(P(f, xL, yt), P(f, xR, yb), 0.55, STEEL_LM, 6));
        }
      }
      g.add(strut(P(f, -f.half, y0), P(f, f.half, y0), 0.45, STEEL_LM, 6));
      g.add(strut(P(f, -f.half, y1), P(f, f.half, y1), 0.45, STEEL_LM, 6));
    }
    g.add(box(HW * 2 - 2, 1.4, HD * 2 - 2, STEEL_LM, 0, y1 + 0.7, 0)); // roof rim
    return g;
  },

  // Central Park Tower: full replacement of its nine mapped ownership parts
  // plus the separately mapped eastern cantilever.
  // The measured 60x61m seven-storey Nordstrom podium stays broad at street
  // level; above it, the 22.5x29.7m residential shaft shifts to the east edge
  // and gains its separately mapped 8.4m cantilever at the residential datum.
  // A physically UV-scaled curtain texture supplies ~100 floors of glass,
  // mullions and spandrels for a few hundred triangles, while real geometry
  // is reserved for the
  // light-catching stainless fins, the wave-like retail facade and the crown.
  'central-park-tower': (ctx) => {
    const g = new THREE.Group();
    const tip = ctx.fit?.roofH ?? 472;

    const towerTex = canvasTexture((c, w, h) => {
      const glass = c.createLinearGradient(0, 0, w, h);
      glass.addColorStop(0, '#afc5cd');
      glass.addColorStop(0.45, '#7394a2');
      glass.addColorStop(1, '#4d7180');
      c.fillStyle = glass;
      c.fillRect(0, 0, w, h);
      // Pattern-rolled stainless pinstripe on every facade bay.
      const fin = c.createLinearGradient(0, 0, 7, 0);
      fin.addColorStop(0, '#71848d');
      fin.addColorStop(0.45, '#e5edf0');
      fin.addColorStop(1, '#778991');
      c.fillStyle = fin;
      c.fillRect(0, 0, 6, h);
      // Recessed spandrel and a soft high-floor reflection.
      c.fillStyle = 'rgba(25,48,58,.62)';
      c.fillRect(0, h - 9, w, 9);
      c.fillStyle = 'rgba(218,235,242,.13)';
      c.fillRect(w * 0.36, 8, w * 0.25, h - 22);
    }, 64, 96);
    towerTex.wrapS = towerTex.wrapT = THREE.RepeatWrapping;
    towerTex.anisotropy = 4;
    const towerGlass = new THREE.MeshStandardMaterial({
      map: towerTex, color: '#e4eef1', metalness: 0.2, roughness: 0.2,
      emissive: '#42606c', emissiveIntensity: 0.4,
    });

    const podiumTex = canvasTexture((c, w, h) => {
      const glass = c.createLinearGradient(0, 0, w, 0);
      glass.addColorStop(0, '#314c59');
      glass.addColorStop(0.5, '#9bb8c3');
      glass.addColorStop(1, '#385866');
      c.fillStyle = glass;
      c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(229,211,169,.34)';
      c.fillRect(8, 8, w - 16, h - 18);
      c.fillStyle = '#213640';
      c.fillRect(0, h - 8, w, 8);
      c.fillStyle = 'rgba(225,235,238,.8)';
      c.fillRect(0, 0, 5, h);
    }, 96, 96);
    podiumTex.wrapS = podiumTex.wrapT = THREE.RepeatWrapping;
    podiumTex.anisotropy = 4;
    const podiumGlass = new THREE.MeshStandardMaterial({
      map: podiumTex, color: '#d2e0e4', metalness: 0.16, roughness: 0.24,
      emissive: '#243b45', emissiveIntensity: 0.36,
    });

    const louverTex = canvasTexture((c, w, h) => {
      c.fillStyle = '#34464f';
      c.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 7) {
        c.fillStyle = y % 14 ? '#8b9ba2' : '#d4dde0';
        c.fillRect(0, y, w, 2);
      }
      c.fillStyle = 'rgba(218,231,235,.32)';
      c.fillRect(5, 0, 5, h);
    }, 48, 64);
    louverTex.wrapS = louverTex.wrapT = THREE.RepeatWrapping;
    const crownMat = new THREE.MeshStandardMaterial({
      map: louverTex, color: '#d0d9dc', metalness: 0.34, roughness: 0.26,
      emissive: '#34474f', emissiveIntensity: 0.28,
    });

    // Exact plans transformed into the fit frame by the tile audit. The broad
    // irregular plan preserves the Broadway/57th/58th Street notches instead
    // of walling off their sidewalks with a 60m generic bounding box.
    const PODIUM: PlanPoint[] = [
      [29.7, -15.7], [15.8, -15.6], [15.8, -30.5], [-24.2, -30.5],
      [-29.8, -30.5], [-29.8, -15], [-29.8, -6.6], [-29.8, -6.1],
      [-29.8, 17.9], [-29.7, 20], [-29.8, 22.6], [-29.8, 23],
      [-29.8, 25.5], [29.8, 25.6], [29.9, 0],
    ];
    const NORTH_WING: PlanPoint[] = [
      [29.8, 25.6], [29.9, 30.4], [-29.7, 30.3], [-29.8, 25.5],
    ];
    const SHAFT: PlanPoint[] = [
      [-10.6, -6.7], [-29.8, -6.6], [-29.8, -6.1], [-29.8, 17.9],
      [-29.7, 20], [-29.8, 22.6], [-29.8, 23], [-12.1, 22.8],
      [-12, 18.1], [-7.3, 18], [-7.3, 10.8], [-7.4, -2.1], [-10.5, -2],
    ];
    // OSM maps the record cantilever as a separate adjacent-owned part. Its
    // measured -38.2..-29.8m projection is 8.4m, matching Permasteelisa's
    // published 8.5m figure, and its 433m terminal matches the occupied crown.
    const CANTILEVER: PlanPoint[] = [
      [-29.8, -6.1], [-33.5, -6.2], [-33.4, 0.6],
      [-38.2, 0.7], [-38.1, 17.9], [-29.8, 17.9],
    ];
    const SOUTH_SHOULDER: PlanPoint[] = [
      [-29.8, -15], [-7.5, -14.9], [-7.4, -6.8], [-10.6, -6.7], [-29.8, -6.6],
    ];
    const NORTH_SHOULDER: PlanPoint[] = [
      [-7.3, 22.8], [11.7, 22.6], [11.8, 10.7], [-7.3, 10.8],
    ];

    const addSolidFacade = (
      plan: PlanPoint[], y0: number, y1: number, mat: THREE.Material,
      bay = 1.5, floor = 4.4,
    ) => {
      g.add(cptFacade(plan, y0, y1, mat, bay, floor));
      g.add(cptSolid(plan, y0, y1));
      g.add(cptRoof(plan, y1 + 0.02, CPT_DARK));
    };

    // Seven-storey 300,000ft² retail base and its low 58th Street wing.
    addSolidFacade(PODIUM, 0, 44, podiumGlass, 3.2, 7.25);
    addSolidFacade(NORTH_WING, 0, 23, podiumGlass, 3.2, 7.25);

    // Deep glazed entrance/display bays on the primary West 57th Street face.
    // Warm light is limited to thin headers: an opaque full-height glow plane
    // becomes a blank wall when inspected from the sidewalk.
    for (const x of [-19, -10, -1, 8]) {
      g.add(cptDetail(box(7.1, 7.5, 0.18, CPT_DOOR, x, 4.1, -30.72)));
      for (const dx of [-3.25, 0, 3.25]) {
        g.add(cptDetail(box(0.12, 7.3, 0.08, CPT_STAINLESS, x + dx, 4.1, -30.84)));
      }
      g.add(cptDetail(box(6.2, 0.22, 0.08, CPT_GLOW, x, 7.68, -30.85)));
    }
    // Pattern-rolled fins physically undulate in front of the podium glazing.
    for (let i = 0; i < 24; i++) {
      const x = -23 + i * 1.58;
      const wave = Math.sin(i * 0.72) * 0.75;
      g.add(cptDetail(box(0.16, 41, 0.32, CPT_STAINLESS, x, 22.5, -30.9 - wave)));
    }
    for (let i = 0; i < 34; i++) {
      const x = -27.5 + i * 1.67;
      const wave = Math.sin(i * 0.6 + 1.1) * 0.55;
      g.add(cptDetail(box(0.14, 20, 0.28, CPT_STAINLESS, x, 12, 25.8 + wave)));
    }

    // Mapped shoulder volumes rise independently above the podium. The primary
    // structural shaft continues from its source-mapped 44m datum; the separate
    // 8.4m eastern projection begins at the ~300ft residential datum.
    addSolidFacade(SOUTH_SHOULDER, 44, 127, towerGlass);
    addSolidFacade(NORTH_SHOULDER, 44, 163, towerGlass);
    addSolidFacade(SHAFT, 44, 91, towerGlass);
    g.add(cptDetail(box(31.5, 1.4, 30.5, CPT_STAINLESS, -22.45, 91, 8.15)));

    const occupiedTop = Math.min(432, tip - 34);
    addSolidFacade(SHAFT, 91, occupiedTop, towerGlass);
    addSolidFacade(CANTILEVER, 91, Math.min(433, tip - 6), towerGlass);
    addSolidFacade(SHAFT, occupiedTop, tip - 6, crownMat, 1.5, 2.3);
    addSolidFacade(SHAFT, tip - 6, tip, towerGlass);

    // True-depth stainless pinstripes remain legible when the player flies
    // inches from the facade; texture handles the interstitial bays.
    const finY0 = 91, finY1 = occupiedTop, finH = finY1 - finY0;
    for (let x = -28.7; x <= -8.3; x += 2.05) {
      g.add(cptDetail(box(0.14, finH, 0.26, CPT_STAINLESS, x, (finY0 + finY1) / 2, -6.86)));
      g.add(cptDetail(box(0.14, finH, 0.26, CPT_STAINLESS, x, (finY0 + finY1) / 2, 23.14)));
    }
    for (let z = -5.5; z <= 21.8; z += 2.1) {
      g.add(cptDetail(box(0.26, finH, 0.14, CPT_STAINLESS, -29.94, (finY0 + finY1) / 2, z)));
      g.add(cptDetail(box(0.26, finH, 0.14, CPT_STAINLESS, -7.16, (finY0 + finY1) / 2, z)));
    }
    for (let z = 1.6; z <= 17; z += 2.1) {
      g.add(cptDetail(box(0.26, finH, 0.14, CPT_STAINLESS, -38.24, (finY0 + finY1) / 2, z)));
    }
    // Mapped massing transitions double as subtle mechanical/refuge bands.
    for (const y of [127, 163, 237, 332, occupiedTop]) {
      if (y >= occupiedTop) continue;
      g.add(cptDetail(box(23.2, 0.55, 30.3, CPT_STAINLESS, -18.55, y, 8.15)));
    }
    g.add(cptDetail(box(23.5, 0.9, 30.6, CPT_STAINLESS, -18.55, tip + 0.45, 8.15)));
    return g;
  },

  // Plaza Hotel: copper mansard crown with dormers, turret cones + gold finials, plus a marble base colonnade
  'plaza-hotel': () => {
    const g = new THREE.Group();
    const W = 58, D = 46, roofY = 58, mh = 13, inset = 5;
    g.add(mansardSlabs(W, D, roofY, mh, inset, GREEN_PATINA));
    g.add(box(W - 2 * inset + 2, 1.5, D - 2 * inset + 2, GREEN_PATINA, 0, roofY + mh + 0.75, 0)); // flat top deck
    // dormer boxes poking through the slopes
    for (const [along, count, halfLen, zx] of [['x', 6, W / 2, D / 2 - inset * 0.5], ['z', 4, D / 2, W / 2 - inset * 0.5]] as const) {
      for (let i = 0; i < count; i++) {
        const t = -halfLen + 2 + (i + 0.5) * ((2 * halfLen - 4) / count);
        for (const s of [1, -1]) {
          const dm = new THREE.Group();
          dm.add(box(1.7, 2.2, 1.0, WHITE_LM, 0, 0, 0));
          dm.add(box(1.9, 0.8, 1.2, GREEN_PATINA, 0, 1.3, 0)); // little gable cap
          if (along === 'x') dm.position.set(t, roofY + 4, s * zx); else dm.position.set(s * zx, roofY + 4, t);
          g.add(dm);
        }
      }
    }
    // corner turrets with conical caps + gold finials
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const cx = sx * (W / 2 - 2), cz = sz * (D / 2 - 2);
      g.add(cyl(2.4, 2.6, mh + 4, WHITE_LM, cx, roofY + (mh + 4) / 2, cz, 12));
      g.add(cyl(0.1, 2.9, 5, GREEN_PATINA, cx, roofY + mh + 4 + 2.5, cz, 12));
      g.add(finialAt(cx, roofY + mh + 9, cz));
    }
    g.add(finialAt(0, roofY + mh + 1.5, 0));
    // three-story white marble base colonnade on the +z (avenue) face
    g.add(box(42, 2, 4, MARBLE, 0, 1, D / 2));
    const base = colonnade(9, 4.5, 0.7, 14, MARBLE); base.position.set(0, 2, D / 2); g.add(base);
    g.add(box(42, 3, 4, MARBLE, 0, 17.5, D / 2));
    return g;
  },

  // Pulitzer Fountain: five shrinking granite basins with water discs, gilt Pomona on top, ring of benches
  'pulitzer-fountain': () => {
    const g = new THREE.Group();
    const tiers = [[6.2, 0.0, 0.9], [4.7, 1.4, 0.8], [3.4, 2.6, 0.7], [2.3, 3.6, 0.6], [1.4, 4.5, 0.5]];
    let prevTop = 0;
    for (const [r, y, h] of tiers) {
      const basin = lathe([[r, 0], [r, h * 0.6], [r * 0.82, h]], GRANITE, 18); basin.position.y = y; g.add(basin);
      const w = new THREE.Mesh(new THREE.CircleGeometry(r * 0.9, 18), WATER_LM);
      w.rotation.x = -Math.PI / 2; w.position.y = y + h * 0.55; g.add(w);
      g.add(cyl(r * 0.34, r * 0.4, (y - prevTop) + 0.4, GRANITE, 0, (y + prevTop) / 2, 0, 12)); // support to next tier
      prevTop = y + h;
    }
    const pomona = figure(2.2, GOLD); pomona.position.y = 5.0; g.add(pomona);
    const basket = lathe([[0, 0], [0.55, 0.15], [0.45, 0.4]], GOLD, 10); basket.position.set(0.3, 5.4, 0.35); g.add(basket); // her fruit basket
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; const b = bench(); b.position.set(Math.cos(a) * 9, 0, Math.sin(a) * 9); b.rotation.y = -a + Math.PI / 2; g.add(b); }
    return g;
  },

  // Lincoln Center: glowing 5-arch Met Opera at -z, two travertine theaters flanking, central Revson fountain
  'lincoln-center': () => {
    const g = new THREE.Group();
    const operaZ = -26;
    for (let i = 0; i < 5; i++) {
      const ax = -22 + i * 11;
      const a = archWall(10.5, 22, 3, 6, 18, MARBLE); a.position.set(ax, 0, operaZ); g.add(a);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 17), WARM_GLOW); glow.position.set(ax, 9, operaZ - 1.6); g.add(glow);
    }
    g.add(box(58, 4, 4, MARBLE, 0, 24, operaZ));            // opera cornice
    g.add(box(58, 26, 1.5, MARBLE, 0, 13, operaZ - 2.2));   // back wall behind the glow
    for (const s of [-1, 1]) {                              // Geffen (+x) & Koch (-x) theaters
      const tx = s * 32;
      g.add(box(20, 20, 34, LIMESTONE, tx, 10, 0));
      g.add(box(22, 2, 36, LIMESTONE, tx, 21, 0));
      const col = colonnade(7, 4.2, 0.7, 16, LIMESTONE); col.rotation.y = s * Math.PI / 2; col.position.set(tx - s * 10.2, 0, 0); g.add(col);
    }
    // Revson fountain: flat granite disc, water ring, center jet cluster
    g.add(cyl(7, 7.2, 0.8, GRANITE, 0, 0.4, 4, 20));
    const w = new THREE.Mesh(new THREE.CircleGeometry(6.4, 20), WATER_LM); w.rotation.x = -Math.PI / 2; w.position.set(0, 0.75, 4); g.add(w);
    for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, jh = 1.4 + (i % 3) * 0.6; g.add(cyl(0.08, 0.12, jh, WATER_LM, Math.cos(a) * 1.2, 0.8 + jh / 2, 4 + Math.sin(a) * 1.2, 6)); }
    g.add(cyl(0.15, 0.2, 3.0, WATER_LM, 0, 2.3, 4, 6));    // tall center jet
    return g;
  },

  // The Dakota: tan-brick chateau block, steep dark roof, taller corner pavilions + finials, arched carriage entry
  'dakota': () => {
    const g = new THREE.Group();
    const S = 40, H = 30;
    g.add(box(S, H, S, DAKOTA_BRICK, 0, H / 2, 0));
    g.add(box(S + 1.5, 1.2, S + 1.5, DARKSTONE, 0, H, 0)); // cornice
    g.add(mansardSlabs(S, S, H, 9, 3.5, DARKSTONE));       // steep gabled roofline
    g.add(box(S - 5, 1.0, S - 5, DARKSTONE, 0, H + 9.5, 0));
    // deep-set window courses (dark reveals) on the four faces
    for (const s of [1, -1]) for (let row = 0; row < 4; row++) for (let i = 0; i < 5; i++) {
      g.add(box(1.8, 3.0, 0.4, DARKSTONE, -14 + i * 7, 5 + row * 6.5, s * (S / 2 + 0.05)));
      g.add(box(0.4, 3.0, 1.8, DARKSTONE, s * (S / 2 + 0.05), 5 + row * 6.5, -14 + i * 7));
    }
    // corner pavilions rising higher, each capped with a steep cone + finial
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const cx = sx * (S / 2 - 4.5), cz = sz * (S / 2 - 4.5);
      g.add(box(9, H + 9, 9, DAKOTA_BRICK, cx, (H + 9) / 2, cz));
      g.add(cyl(0.1, 6.4, 8, DARKSTONE, cx, H + 9 + 4, cz, 4));
      g.add(finialAt(cx, H + 9 + 8, cz));
    }
    // deep arched carriage entrance on +z with a dark stone surround
    g.add(box(13, 15, 2, DARKSTONE, 0, 7.5, S / 2 + 0.3));
    const gate = archWall(10, 12, 5, 5, 9, DARKSTONE); gate.position.set(0, 0, S / 2 + 1.3); g.add(gate);
    // iron area railing + twin gas lamps flanking the entry
    for (let x = -S / 2; x <= S / 2; x += 1.5) g.add(cyl(0.05, 0.05, 1.1, DARKSTONE, x, 0.55, S / 2 + 3, 6));
    g.add(box(S, 0.08, 0.08, DARKSTONE, 0, 1.05, S / 2 + 3));
    for (const lx of [-4.5, 4.5]) { const l = gasLamp(); l.position.set(lx, 0, S / 2 + 2); g.add(l); }
    return g;
  },

  // AMNH: the full four-block quadrangle (~224x176m), not just a facade strip —
  // Roosevelt Memorial pavilion on the CPW front (+z = east, toward the park),
  // long pink-granite perimeter ranges with round Romanesque corner towers and
  // conical caps (the 77th St look), cross wings meeting at a pyramid-roofed
  // central pavilion, and the Rose Center glass cube on the 81st St (north) side.
  'amnh': () => {
    const g = new THREE.Group();
    const PINK = new THREE.MeshLambertMaterial({ color: '#c6a091' }); // Milford pink granite
    // cheap round-arched window: dark inset + half-sunk disk head (much lighter
    // than archWall — the long ranges need ~100 of these)
    const archWin = (w: number, h: number): THREE.Group => {
      const win = new THREE.Group();
      win.add(box(w, h, 0.3, DARKSTONE, 0, h / 2, 0));
      const head = cyl(w / 2, w / 2, 0.3, DARKSTONE, 0, h, 0, 12);
      head.rotation.x = Math.PI / 2;
      win.add(head);
      return win;
    };
    // round Romanesque tower with a conical DARKSTONE cap
    const roundTower = (x: number, z: number, r: number, h: number): void => {
      g.add(cyl(r, r + 0.5, h, PINK, x, h / 2, z, 12));
      g.add(cyl(r + 0.5, r + 0.5, 1.2, MARBLE, x, h - 2, z, 12)); // band below the eave
      g.add(cyl(0, r + 1.4, r * 1.7, DARKSTONE, x, h + r * 0.85, z, 12)); // conical cap
    };

    // ---- central Roosevelt Memorial pavilion (front plane at z = FZ) ----
    const FZ = 8;      // front face of the granite wall
    const PW = 46;     // pavilion width
    g.add(box(PW + 6, 3, 22, GRANITE, 0, 1.5, FZ - 4));        // rusticated podium the whole pavilion sits on
    g.add(box(PW, 34, 16, PINK, 0, 17 + 3, FZ - 8));          // main granite mass (behind the columns)
    // deep recessed triumphal arch in the center
    const arch = archWall(20, 30, 4, 13, 22, PINK); arch.position.set(0, 3, FZ); g.add(arch);
    g.add(box(24, 3, 4.5, MARBLE, 0, 26, FZ + 0.3));          // sculpted archivolt band over the arch

    // 4 colossal Ionic columns in front of the wall on tall pedestals
    const COL_H = 26, COL_Y = 5;
    for (const cxp of [-16.5, -5.5, 5.5, 16.5]) {
      g.add(box(4, COL_Y, 4, GRANITE, cxp, COL_Y / 2 + 3, FZ + 6));      // pedestal
      g.add(cyl(1.35, 1.55, COL_H, MARBLE, cxp, COL_Y + 3 + COL_H / 2, FZ + 6, 14)); // shaft
      // Ionic capital: volute scrolls approximated by two side cylinders + abacus
      const capY = COL_Y + 3 + COL_H;
      g.add(box(4, 1.0, 2.4, MARBLE, cxp, capY + 0.5, FZ + 6));
      for (const sx of [-1, 1]) g.add(cyl(0.7, 0.7, 0.6, MARBLE, cxp + sx * 1.5, capY + 0.5, FZ + 6, 10).rotateX(Math.PI / 2));
    }
    // entablature + attic story with allegorical statues on pedestals
    g.add(box(PW + 4, 3, 6, MARBLE, 0, COL_Y + 3 + COL_H + 2.5, FZ + 4));   // entablature
    g.add(box(PW + 6, 10, 10, PINK, 0, COL_Y + 3 + COL_H + 9, FZ - 1));     // attic block (inscription band)
    g.add(box(PW + 7, 1.5, 11, MARBLE, 0, COL_Y + 3 + COL_H + 14.5, FZ - 1)); // attic cornice
    for (const sxp of [-15, 0, 15]) {                                       // 3 allegorical figures atop
      g.add(box(4, 3, 4, MARBLE, sxp, COL_Y + 3 + COL_H + 15.2, FZ + 2));
      const fig = figure(6, MARBLE); fig.position.set(sxp, COL_Y + 3 + COL_H + 16.7, FZ + 2); g.add(fig);
    }

    // grand staircase cascading toward the park (+z), flanked by cheek walls
    for (let i = 0; i < 12; i++) g.add(box(PW - 4, 0.4, 1.3, GRANITE, 0, 0.2 + i * 0.4, FZ + 8 + i * 1.2));
    for (const sx of [-1, 1]) g.add(box(2.5, 3.5, 16, GRANITE, sx * (PW / 2 - 1), 1.75, FZ + 14));

    // equestrian Roosevelt on a granite plinth at the stair foot
    g.add(box(5, 3.5, 8, GRANITE, 0, 1.75, FZ + 24));
    const teddy = equestrian(BRONZE); teddy.position.set(0, 3.5, FZ + 24); g.add(teddy);
    for (const sx of [-1, 1]) { const flag = box(0.4, 16, 0.4, DARKSTONE, sx * 10, 8, FZ + 24); g.add(flag); } // flanking flagpoles

    // ---- site plan: quadrangle footprint (+x = north along CPW) ----
    const HW = 112;          // half-width along the avenue (224m, ~the real 700ft plan)
    const BACK = -168;       // west (Columbus-side) back plane
    // granite terrace under the whole complex (covers the cleared OSM footprint)
    g.add(box(HW * 2 + 8, 0.6, FZ + 10 - (BACK - 2), GRANITE, 0, 0.3, (FZ + 10 + BACK - 2) / 2));

    // ---- east range: the full CPW frontage the memorial pavilion centers ----
    g.add(box(HW * 2, 4, 22, GRANITE, 0, 2, FZ - 9));                      // rusticated base
    g.add(box(HW * 2, 24, 20, PINK, 0, 16, FZ - 10));                      // range wall
    g.add(box(HW * 2 + 2, 2, 22, MARBLE, 0, 29, FZ - 10));                 // cornice
    g.add(box(HW * 2 - 8, 3, 10, DARKSTONE, 0, 31.5, FZ - 10));            // roof ridge
    // two storeys of round-arched windows flanking the memorial (archWall here:
    // this is the facade you approach from the park, it earns the real arches)
    for (const sx of [-1, 1]) for (let i = 0; i < 11; i++) {
      const ax = sx * (32 + i * 6.5);
      for (const ay of [10, 21]) { const win = archWall(3.6, 8, 1, 2.6, 6, DARKSTONE); win.position.set(ax, ay - 4, FZ + 0.6); g.add(win); }
    }
    // round towers on the CPW corners (77th/81st), conical caps
    roundTower(-(HW - 3), FZ - 10, 9, 34);
    roundTower(HW - 3, FZ - 10, 9, 34);

    // ---- south range (77th St): the long Romanesque facade ----
    g.add(box(20, 22, 156, PINK, -(HW - 10), 13, -90));                    // range wall (z -12..-168)
    g.add(box(22, 2, 158, MARBLE, -(HW - 10), 25, -90));                   // cornice
    g.add(box(10, 3, 150, DARKSTONE, -(HW - 10), 27.5, -90));              // roof ridge
    for (let i = 0; i < 17; i++) for (const wy of [7, 16]) {               // arched window rows facing 77th
      const win = archWin(2.6, 6); win.rotation.y = -Math.PI / 2;
      win.position.set(-HW - 0.35, wy - 3, -22 - i * 8); g.add(win);
    }
    // central 77th St entrance: projecting pavilion + twin round towers + arch
    g.add(box(26, 30, 30, PINK, -(HW - 8), 15, -90));
    g.add(box(28, 2, 32, MARBLE, -(HW - 8), 31, -90));
    const sArch = archWall(18, 22, 4, 9, 14, PINK);
    sArch.rotation.y = -Math.PI / 2; sArch.position.set(-(HW + 5), 0.6, -90); g.add(sArch);
    roundTower(-(HW + 2), -90 - 17, 7, 36);
    roundTower(-(HW + 2), -90 + 17, 7, 36);

    // ---- north range (81st St) with the Rose Center glass cube ----
    g.add(box(20, 22, 86, PINK, HW - 10, 13, -55));                        // masonry east of the cube (z -12..-98)
    g.add(box(22, 2, 88, MARBLE, HW - 10, 25, -55));
    g.add(box(10, 3, 82, DARKSTONE, HW - 10, 27.5, -55));
    for (let i = 0; i < 9; i++) for (const wy of [7, 16]) {
      const win = archWin(2.6, 6); win.rotation.y = Math.PI / 2;
      win.position.set(HW + 0.35, wy - 3, -22 - i * 8); g.add(win);
    }
    // Rose Center for Earth and Space: glass cube + Hayden sphere, fronting 81st
    const cs = 44, ccx = HW - 12, ccy = cs / 2 + 2, ccz = -120;
    g.add(box(cs + 2, 2, cs + 2, DARKSTONE, ccx, 1, ccz));                 // dark plinth
    g.add(box(cs, cs, cs, GLASS_LM, ccx, ccy, ccz));                       // glass cube
    for (let mz = -cs / 2; mz <= cs / 2; mz += 4) g.add(box(0.35, cs, 0.35, STEEL_LM, ccx + cs / 2, ccy, ccz + mz)); // mullions on the north face
    for (const my of [-cs / 4, 0, cs / 4]) g.add(box(0.3, 0.3, cs, STEEL_LM, ccx + cs / 2, ccy + my, ccz));
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(17.5, 20, 15), WHITE_LM); sphere.position.set(ccx, ccy + 1, ccz); g.add(sphere);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(21, 0.5, 6, 40), STEEL_LM); // armillary ring around the sphere
    ring.rotation.x = Math.PI / 2; ring.position.set(ccx, ccy + 1, ccz); g.add(ring);

    // ---- west range (Columbus side) closing the quadrangle ----
    g.add(box(HW * 2, 20, 20, PINK, 0, 12, -158));                         // z -168..-148
    g.add(box(HW * 2 + 2, 2, 22, MARBLE, 0, 23, -158));
    g.add(box(HW * 2 - 8, 3, 10, DARKSTONE, 0, 25.5, -158));
    for (let i = 0; i < 24; i++) for (const wy of [7, 15]) {
      const win = archWin(2.6, 5.5); win.rotation.y = Math.PI;
      win.position.set(-92 + i * 8, wy - 2.75, -168.35); g.add(win);
    }
    roundTower(-(HW - 8), -158, 7.5, 30);                                  // SW round turret
    g.add(box(16, 30, 16, PINK, HW - 8, 15, -158));                        // NW square pavilion
    const nwCap = cyl(0.3, 11.5, 11, DARKSTONE, HW - 8, 35, -158, 4);
    nwCap.rotation.y = Math.PI / 4; g.add(nwCap);

    // ---- cross wings meeting at a central pyramid-roofed pavilion ----
    g.add(box(24, 20, 130, PINK, 0, 12, -85));                             // E-W spine (z -20..-150)
    g.add(box(12, 3, 124, DARKSTONE, 0, 23.5, -85));
    g.add(box(190, 20, 24, PINK, 0, 12, -85));                             // N-S cross wing
    g.add(box(184, 3, 12, DARKSTONE, 0, 23.5, -85));
    g.add(box(32, 40, 32, PINK, 0, 20, -85));                              // central pavilion
    g.add(box(34, 2, 34, MARBLE, 0, 41, -85));
    const cCap = cyl(0.4, 23, 14, DARKSTONE, 0, 49, -85, 4);
    cCap.rotation.y = Math.PI / 4; g.add(cCap);
    for (const tx of [-13, 13]) for (const tz of [-98, -72]) {             // four corner turrets
      g.add(cyl(1.6, 1.8, 8, PINK, tx, 44, tz, 8));
      g.add(cyl(0, 2.4, 4, DARKSTONE, tx, 50, tz, 8));
    }
    return g;
  },

  // Met Museum: 100m Beaux-Arts facade (paired columns, 3 arched niches, attic), grand stairs, flanking fountains, banners
  'met-museum': () => {
    const g = new THREE.Group();
    const W = 100;
    g.add(box(W, 4, 8, LIMESTONE, 0, 2, -3));       // stylobate the facade sits on
    g.add(box(W, 30, 6, LIMESTONE, 0, 19, -3));     // main facade wall
    g.add(box(W + 2, 1.5, 8, MARBLE, 0, 34.5, -3)); // cornice band
    g.add(box(W, 5, 7, LIMESTONE, 0, 37.5, -3));    // attic
    for (const bx of [-30, 0, 30]) { const niche = archWall(22, 24, 4, 10, 17, MARBLE); niche.position.set(bx, 4, 0.5); g.add(niche); } // 3 arched niches
    for (const px of [-45, -15, 15, 45]) for (const off of [-1.7, 1.7]) { // paired Corinthian columns
      g.add(cyl(0.9, 1.0, 24, MARBLE, px + off, 16, 2.5, 12));
      g.add(box(2.4, 0.8, 2.4, MARBLE, px + off, 28.4, 2.5));
      g.add(box(2.6, 0.7, 2.6, MARBLE, px + off, 4.35, 2.5));
    }
    g.add(box(W, 2.5, 3, MARBLE, 0, 30, 3)); // entablature over the columns
    const banners = [BANNER_A, BANNER_B, BANNER_C];
    for (let i = 0; i < 3; i++) g.add(box(6, 14, 0.2, banners[i], [-30, 0, 30][i], 18, 4.3)); // solid-color banners
    // grand stairs cascading full width toward +z
    for (let i = 0; i < 14; i++) g.add(box(W, 0.32, 1.1, LIMESTONE, 0, 0.16 + i * 0.29, 15 - i * 1.0));
    // two flanking fountains (rect basins + water)
    for (const sx of [-1, 1]) {
      g.add(box(9, 1.0, 5, GRANITE, sx * 40, 0.5, 17));
      const w = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 3.6), WATER_LM); w.rotation.x = -Math.PI / 2; w.position.set(sx * 40, 0.85, 17); g.add(w);
    }
    return g;
  },

  // Guggenheim: Wright's inverted ziggurat of white cylinders growing upward with dark reveals, slab wing, street drum
  'guggenheim': () => {
    const g = new THREE.Group();
    const levels = 5, rBot = 12, rTop = 16, lh = 4.6;
    g.add(cyl(11.5, 12.2, 2.5, WHITE_LM, 0, 1.25, 0, 16)); // base ring
    let y = 2.5;
    for (let i = 0; i < levels; i++) {
      const r0 = rBot + (rTop - rBot) * (i / levels), r1 = rBot + (rTop - rBot) * ((i + 1) / levels);
      g.add(cyl(r1, r0, lh, WHITE_LM, 0, y + lh / 2, 0, 16));                  // widening band
      g.add(cyl(r1 + 0.06, r1 + 0.06, 0.25, DARKSTONE, 0, y + lh + 0.1, 0, 16)); // hairline dark reveal
      y += lh;
    }
    g.add(cyl(rTop + 0.3, rTop, 1.0, WHITE_LM, 0, y + 0.5, 0, 16)); // parapet
    // low horizontal slab wing at +x, and the small entrance drum at street
    g.add(box(14, 9, 16, WHITE_LM, 18, 4.5, 2));
    g.add(box(15, 1.0, 17, WHITE_LM, 18, 9.2, 2));
    g.add(cyl(4.5, 4.5, 5, WHITE_LM, -2, 2.5, 13, 16));
    return g;
  },

  // Intrepid: 270m carrier hull with angled bow + flight deck, island + radar masts, deck aircraft
  'intrepid': (ctx) => {
    const outer = new THREE.Group();
    const g = new THREE.Group();
    // FLOAT, don't sit on terrain: the manager lifts every landmark group to
    // heightAt(anchor), but a moored ship rides the water plane (y -0.7) no
    // matter what the shore berm under the anchor measures
    g.position.y = -(ctx.groundAt(0, 0)) - 0.7;
    outer.add(g);
    // hull (dark sides) from y=-4 to the flight deck at y=15, with an angled bow wedge at +x
    g.add(box(250, 19, 26, DARKSTONE, -10, 5.5, 0));
    g.add(hullPlate(115, 13, 140, 0, 19, 5.5, DARKSTONE));  // port bow plate
    g.add(hullPlate(115, -13, 140, 0, 19, 5.5, DARKSTONE)); // starboard bow plate
    g.add(box(24, 19, 14, DARKSTONE, 126, 5.5, 0));         // bow filler
    // flight deck (lighter), overhanging the hull, plus the angled deck extension aft-port
    g.add(box(272, 1.2, 34, GRANITE, 0, 14.4, 0));
    const angled = box(90, 0.8, 16, GRANITE, -40, 15.2, -22); angled.rotation.y = 0.16; g.add(angled);
    // island superstructure on the river (-z) edge toward the bow, with radar masts
    g.add(box(16, 8, 10, GRANITE, 45, 19, -7));
    g.add(box(10, 6, 8, GRANITE, 46, 26, -7));
    g.add(box(6, 4, 7, DARKSTONE, 47, 31, -7));
    for (const mx of [44, 48]) { g.add(strut(new THREE.Vector3(mx, 33, -7), new THREE.Vector3(mx, 44, -7), 0.25, STEEL_LM, 6)); g.add(box(0.2, 0.2, 4, STEEL_LM, mx, 40, -7)); }
    // deck aircraft, varied placement + heading
    const planeMats = [WHITE_LM, GRANITE, DARKSTONE, WHITE_LM, GRANITE, DARKSTONE];
    const spots: [number, number, number][] = [[-90, 6, 0.2], [-60, -6, -0.3], [-30, 5, 0.1], [5, -7, 2.9], [-110, -4, 3.0], [-45, 8, -0.2]];
    for (let i = 0; i < spots.length; i++) { const [px, pz, ry] = spots[i]; const p = warplane(planeMats[i]); p.position.set(px, 15.3, pz); p.rotation.y = ry; g.add(p); }
    // no built pier: the ship rides in the river off the REAL Pier 86 OSM
    // building, stern toward the bank
    return outer;
  },
};
