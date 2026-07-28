import * as THREE from 'three';
import {
  type LandmarkCtx,
  LIMESTONE, GRANITE, DARKSTONE, MARBLE, BRONZE, GOLD, STEEL_LM, GLASS_LM, WHITE_LM,
  WATER_LM, GREEN_PATINA, BRICK_RED,
  box, cyl, strut, lathe, figure, twoSidedPanel,
  canvasTexture, billboardTexture, billboardMaterial,
} from '../kit';

/**
 * Midtown South set — Empire State crown, One Bryant Park, NYPL, Bryant Park,
 * MSG, Times Square and the theater district. Each builder returns a group
 * whose origin sits at ground level; the manager rotates/positions/merges it.
 * Empire State and MSG retain useful OSM massing. One Bryant Park is a full,
 * compact replacement for the source's overlapping 12–366m solid prisms.
 */

// Warm pink-Tennessee-marble tint for the lions (Patience & Fortitude).
const LION_MARBLE = new THREE.MeshLambertMaterial({ color: '#ece0cf' });

// Empire State crown palette. Standard materials pick up the shared city
// environment map, so the aluminum mast reads as metal beside the dry Indiana
// limestone and the observation glazing keeps a subtle reflected-sky sheen.
const ESB_STONE = new THREE.MeshStandardMaterial({
  color: '#c9c5b9', metalness: 0.04, roughness: 0.66,
});
const ESB_ALUMINUM = new THREE.MeshStandardMaterial({
  color: '#c3cbd0', metalness: 0.52, roughness: 0.28,
  emissive: '#30383d', emissiveIntensity: 0.28,
});
const ESB_GLASS = new THREE.MeshStandardMaterial({
  color: '#718994', metalness: 0.32, roughness: 0.22,
  emissive: '#263a44', emissiveIntensity: 0.42,
});
const ESB_LIGHT = new THREE.MeshStandardMaterial({
  color: '#e7eef5', metalness: 0.08, roughness: 0.3,
  emissive: '#89bff4', emissiveIntensity: 1.15,
});
const ESB_BEACON = new THREE.MeshBasicMaterial({ color: '#ff493d' });

// One Bryant Park palette. Ceramic-fritted low-e glass is the building's
// dominant surface, but high metalness turns shaded mobile faces black in the
// intentionally inexpensive street environment. A cool emissive floor keeps
// the angular curtain wall bright without flattening its reflected-sky sheen.
const BRYANT_STEEL = new THREE.MeshStandardMaterial({
  color: '#b9c4c8', metalness: 0.46, roughness: 0.25,
  emissive: '#43535a', emissiveIntensity: 0.26,
});
const BRYANT_SCREEN = new THREE.MeshStandardMaterial({
  color: '#70858b', metalness: 0.28, roughness: 0.31,
  emissive: '#34535d', emissiveIntensity: 0.54,
});
const BRYANT_LIGHT_GLASS = new THREE.MeshStandardMaterial({
  color: '#b8d5dc', metalness: 0.16, roughness: 0.12,
  emissive: '#587c86', emissiveIntensity: 0.54,
  transparent: true, opacity: 0.76, depthWrite: false,
});
const BRYANT_LOBBY = new THREE.MeshStandardMaterial({
  color: '#9db8bc', metalness: 0.14, roughness: 0.13,
  emissive: '#b47e48', emissiveIntensity: 0.62,
});
const BRYANT_DOOR = new THREE.MeshStandardMaterial({
  color: '#233e44', metalness: 0.3, roughness: 0.16,
  emissive: '#183b43', emissiveIntensity: 0.7,
});
const BRYANT_WOOD = new THREE.MeshStandardMaterial({
  color: '#ad7a48', metalness: 0.02, roughness: 0.52,
  emissive: '#4e2d17', emissiveIntensity: 0.18,
});
const BRYANT_RED = new THREE.MeshBasicMaterial({ color: '#ff4136' });
const BRYANT_COLLISION = new THREE.MeshBasicMaterial({ visible: false });

// NYPL's deep window reveals are reflective bronze/glass, not featureless
// black voids. A little cool emissive lift preserves that read on inexpensive
// mobile lighting while the warm entry lanterns separate the three portals.
const NYPL_GLASS = new THREE.MeshStandardMaterial({
  color: '#50636b', metalness: 0.42, roughness: 0.2,
  emissive: '#172a32', emissiveIntensity: 0.48,
});
const NYPL_ENTRY_GLASS = new THREE.MeshStandardMaterial({
  color: '#34474d', metalness: 0.34, roughness: 0.16,
  emissive: '#182c33', emissiveIntensity: 0.58,
});
const NYPL_LANTERN = new THREE.MeshStandardMaterial({
  color: '#ffe2a6', metalness: 0.04, roughness: 0.28,
  emissive: '#ffad45', emissiveIntensity: 2.1,
});

/** Decorative facade pieces should never become separate collision volumes. */
function esbDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

function oneBryantDetail<T extends THREE.Mesh>(mesh: T): T {
  mesh.userData.noCollision = true;
  return mesh;
}

function nyplDetail<T extends THREE.Object3D>(object: T): T {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) child.userData.noCollision = true;
  });
  return object;
}

function nyplTextPanel(texture: THREE.Texture, w: number, h: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshLambertMaterial({ map: texture }),
  );
  return nyplDetail(mesh);
}

function nyplTitleTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    c.fillStyle = '#e8e4da';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#c9c2b5';
    c.lineWidth = 2;
    c.strokeRect(2, 3, w - 4, h - 6);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '500 38px Georgia, Times New Roman, serif';
    c.fillStyle = 'rgba(255,255,255,.76)';
    c.fillText('THE NEW YORK PUBLIC LIBRARY', w / 2 - 0.5, h / 2 - 1.2, w * 0.94);
    c.fillStyle = '#716d65';
    c.fillText('THE NEW YORK PUBLIC LIBRARY', w / 2 + 0.5, h / 2 + 0.8, w * 0.94);
  }, 512, 72);
}

function nyplDedicationTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    c.fillStyle = '#e8e4da';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#c8c1b4';
    c.lineWidth = 2;
    c.strokeRect(2, 2, w - 4, h - 4);
    for (const x of [w / 3, w * 2 / 3]) {
      c.beginPath();
      c.moveTo(x, 8);
      c.lineTo(x, h - 8);
      c.stroke();
    }
    const panels = [
      ['THE ASTOR LIBRARY', 'FOUNDED BY', 'JOHN JACOB ASTOR'],
      ['THE LENOX LIBRARY', 'FOUNDED BY', 'JAMES LENOX'],
      ['THE TILDEN TRUST', 'FOUNDED BY', 'SAMUEL J. TILDEN'],
    ];
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#77736b';
    for (let i = 0; i < panels.length; i++) {
      const x = (i + 0.5) * w / 3;
      c.font = '500 17px Georgia, Times New Roman, serif';
      c.fillText(panels[i][0], x, h * 0.31, w * 0.29);
      c.font = '500 10px Georgia, Times New Roman, serif';
      c.fillText(panels[i][1], x, h * 0.54, w * 0.27);
      c.font = '500 13px Georgia, Times New Roman, serif';
      c.fillText(panels[i][2], x, h * 0.72, w * 0.29);
    }
  }, 512, 128);
}

function nyplUsFlagTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    for (let i = 0; i < 13; i++) {
      c.fillStyle = i % 2 === 0 ? '#b22234' : '#f5f3ec';
      c.fillRect(0, i * h / 13, w, h / 13 + 1);
    }
    c.fillStyle = '#3c3b6e';
    c.fillRect(0, 0, w * 0.42, h * 7 / 13);
    c.fillStyle = '#ffffff';
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 6; col++) {
        c.beginPath();
        c.arc(w * (0.045 + col * 0.066), h * (0.045 + row * 0.075), 1.7, 0, Math.PI * 2);
        c.fill();
      }
    }
  }, 192, 120);
}

function nyplCityFlagTexture(): THREE.CanvasTexture {
  return canvasTexture((c, w, h) => {
    const third = w / 3;
    c.fillStyle = '#174f8b'; c.fillRect(0, 0, third, h);
    c.fillStyle = '#f4f1e8'; c.fillRect(third, 0, third, h);
    c.fillStyle = '#ef7f2d'; c.fillRect(third * 2, 0, third, h);
    c.strokeStyle = '#174f8b';
    c.lineWidth = 4;
    c.beginPath();
    c.arc(w / 2, h / 2, h * 0.22, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#174f8b';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '700 24px Georgia, Times New Roman, serif';
    c.fillText('NYC', w / 2, h / 2 + 1);
  }, 192, 120);
}

function nyplFlag(texture: THREE.Texture, w: number, h: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(w, h, 5, 2);
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const along = pos.getX(i) / w + 0.5;
    pos.setZ(i, Math.sin(along * Math.PI * 2) * 0.16 * along);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );
  return nyplDetail(mesh);
}

type BryantLevel = {
  y: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  clip: number;
};

/** Clockwise facade ring, beginning on the local -z face. */
function oneBryantRing(level: BryantLevel): THREE.Vector3[] {
  const x0 = level.cx - level.w / 2;
  const x1 = level.cx + level.w / 2;
  const z0 = level.cz - level.d / 2;
  const z1 = level.cz + level.d / 2;
  const c = Math.min(level.clip, level.w * 0.2, level.d * 0.3);
  return [
    new THREE.Vector3(x0 + c, level.y, z0),
    new THREE.Vector3(x1 - c, level.y, z0),
    new THREE.Vector3(x1, level.y, z0 + c),
    new THREE.Vector3(x1, level.y, z1 - c),
    new THREE.Vector3(x1 - c, level.y, z1),
    new THREE.Vector3(x0 + c, level.y, z1),
    new THREE.Vector3(x0, level.y, z1 - c),
    new THREE.Vector3(x0, level.y, z0 + c),
  ];
}

/**
 * One faceted, continuously tapered curtain-wall volume. Physical-scale UVs
 * repeat a four-bay/eight-floor atlas, carrying hundreds of fritted panes and
 * spandrels in eight clean facade strips rather than thousands of window
 * meshes. Every segment owns distinct vertices so its angled normals stay
 * crisp at the folds.
 */
function oneBryantEnvelope(
  levels: BryantLevel[],
  mat: THREE.Material,
  cap = true,
): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const BAY_ATLAS = 6.096 * 4; // four real 20ft structural bays
  const FLOOR_ATLAS = 4.42 * 8; // eight 14ft6in floors
  const addQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    u0: number, u1: number, v0: number, v1: number) => {
    const n = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z);
    uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);
    indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };

  for (let band = 0; band < levels.length - 1; band++) {
    const lower = oneBryantRing(levels[band]);
    const upper = oneBryantRing(levels[band + 1]);
    let along = 0;
    for (let side = 0; side < lower.length; side++) {
      const next = (side + 1) % lower.length;
      const span = Math.max(
        lower[side].distanceTo(lower[next]),
        upper[side].distanceTo(upper[next]),
      );
      addQuad(
        lower[side], upper[side], upper[next], lower[next],
        along / BAY_ATLAS, (along + span) / BAY_ATLAS,
        levels[band].y / FLOOR_ATLAS, levels[band + 1].y / FLOOR_ATLAS,
      );
      along += span;
    }
  }

  if (cap) {
    const ring = oneBryantRing(levels[levels.length - 1]);
    const center = new THREE.Vector3(
      levels[levels.length - 1].cx,
      levels[levels.length - 1].y,
      levels[levels.length - 1].cz,
    );
    for (let i = 0; i < ring.length; i++) {
      const next = (i + 1) % ring.length;
      const n = positions.length / 3;
      // Reversed facade-ring order points the cap normal upward.
      for (const p of [center, ring[next], ring[i]]) positions.push(p.x, p.y, p.z);
      uvs.push(0.5, 0.5, 1, 1, 0, 1);
      indices.push(n, n + 1, n + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return oneBryantDetail(new THREE.Mesh(geo, mat));
}

/**
 * The 52nd–55th-floor mechanical screen rises as an asymmetric crystalline
 * point. Individual top heights make the east/north faces climb toward the
 * spire while the southwest screen falls away, matching the tower's defining
 * "shard of quartz" silhouette.
 */
function oneBryantCrown(
  base: BryantLevel,
  mat: THREE.Material,
): { mesh: THREE.Mesh; baseRing: THREE.Vector3[]; topRing: THREE.Vector3[] } {
  const baseRing = oneBryantRing(base);
  const highest = new THREE.Vector2(base.cx + base.w * 0.34, base.cz - base.d * 0.18);
  const topHeights = [258, 285, 288, 276, 266, 248, 245, 252];
  const topRing = baseRing.map((p, i) => new THREE.Vector3(
    THREE.MathUtils.lerp(p.x, highest.x, 0.09),
    topHeights[i],
    THREE.MathUtils.lerp(p.z, highest.y, 0.09),
  ));
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < baseRing.length; i++) {
    const next = (i + 1) % baseRing.length;
    const n = positions.length / 3;
    for (const p of [baseRing[i], topRing[i], topRing[next], baseRing[next]]) {
      positions.push(p.x, p.y, p.z);
    }
    indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  // Triangulate the non-planar screen cap around a raised central ridge.
  const center = new THREE.Vector3(highest.x, 270, highest.y);
  for (let i = 0; i < topRing.length; i++) {
    const next = (i + 1) % topRing.length;
    const n = positions.length / 3;
    for (const p of [center, topRing[next], topRing[i]]) positions.push(p.x, p.y, p.z);
    indices.push(n, n + 1, n + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { mesh: oneBryantDetail(new THREE.Mesh(geo, mat)), baseRing, topRing };
}

/** Elliptical octagonal prism for the faceted aluminum/glass mooring mast. */
function esbOctagon(
  w: number, d: number, h: number, mat: THREE.Material,
  x: number, y: number, z: number,
): THREE.Mesh {
  const mesh = cyl(1, 1, h, mat, x, y, z, 8);
  mesh.scale.set(w / 2, 1, d / 2);
  return mesh;
}

/**
 * One limestone setback of the Empire State crown. Narrow, full-height inset
 * glazing and projecting mullions preserve the building's emphatic vertical
 * Art Deco rhythm without hundreds of individual window meshes.
 */
function esbCrownTier(
  g: THREE.Group,
  cx: number, cz: number,
  w: number, d: number,
  y0: number, y1: number,
  frontBays: number, sideBays: number,
) {
  const h = y1 - y0;
  g.add(box(w, h, d, ESB_STONE, cx, y0 + h / 2, cz));
  g.add(esbDetail(box(w + 0.8, 0.65, d + 0.8, ESB_STONE, cx, y1 - 0.325, cz)));

  const paneH = Math.max(2, h - 1.8);
  const frontSpan = w - 3.2;
  for (let i = 0; i < frontBays; i++) {
    const px = cx - frontSpan / 2 + ((i + 0.5) * frontSpan) / frontBays;
    const paneW = Math.min(1.15, (frontSpan / frontBays) * 0.5);
    for (const face of [-1, 1]) {
      g.add(esbDetail(box(paneW, paneH, 0.24, ESB_GLASS, px, y0 + h / 2, cz + face * (d / 2 + 0.13))));
      g.add(esbDetail(box(0.34, h + 0.4, 0.42, ESB_STONE, px, y0 + h / 2, cz + face * (d / 2 + 0.25))));
    }
  }

  const sideSpan = d - 3.2;
  for (let i = 0; i < sideBays; i++) {
    const pz = cz - sideSpan / 2 + ((i + 0.5) * sideSpan) / sideBays;
    const paneD = Math.min(1.15, (sideSpan / sideBays) * 0.5);
    for (const face of [-1, 1]) {
      g.add(esbDetail(box(0.24, paneH, paneD, ESB_GLASS, cx + face * (w / 2 + 0.13), y0 + h / 2, pz)));
      g.add(esbDetail(box(0.42, h + 0.4, 0.34, ESB_STONE, cx + face * (w / 2 + 0.25), y0 + h / 2, pz)));
    }
  }
}

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
function archOpening(
  cx: number,
  sill: number,
  w: number,
  rectH: number,
  z: number,
  recessMaterial: THREE.Material = DARKSTONE,
): THREE.Group {
  const g = new THREE.Group();
  const r = w / 2;
  const spring = sill + rectH;                                              // where the semicircle starts
  g.add(box(w, rectH, 0.4, recessMaterial, cx, sill + rectH / 2, z));        // rectangular recess
  const head = cyl(r, r, 0.4, recessMaterial, cx, spring, z, 14);            // disc → arched head
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
  // Empire State: the accurate OSM setbacks remain through the 330m roof. This
  // adds the 86th-floor terrace detailing, limestone crown, 14-story aluminum/
  // glass mooring mast to the 381m architectural top, and antenna to 443.2m.
  'empire-state': (ctx) => {
    const g = new THREE.Group();
    const roof = ctx.fit?.keptH ?? 330;
    const tip = ctx.fit?.roofH ?? 443.2;
    // The fit is centered on the full block-wide massing. OSM's eight upper
    // footprints independently agree on this local crown center to <0.2m.
    const cx = 2.6, cz = -0.35;

    // 86th-floor outdoor observatory (320m): the retained 320m tier is
    // 26.8x43.1m and the narrower 330m tier leaves a walkable perimeter.
    g.add(esbDetail(box(27.6, 0.75, 43.8, ESB_STONE, cx, 320.15, cz)));
    for (const z of [cz - 21.9, cz + 21.9]) {
      g.add(esbDetail(box(27.6, 1.65, 0.22, ESB_ALUMINUM, cx, 321.25, z)));
      g.add(esbDetail(box(22.0, 2.3, 0.24, ESB_GLASS, cx, 316.9, z - Math.sign(z - cz) * 0.32)));
    }
    for (const x of [cx - 13.8, cx + 13.8]) {
      g.add(esbDetail(box(0.22, 1.65, 43.8, ESB_ALUMINUM, x, 321.25, cz)));
      g.add(esbDetail(box(0.24, 2.3, 35.0, ESB_GLASS, x - Math.sign(x - cx) * 0.32, 316.9, cz)));
    }
    // Rail posts remain individually legible in close helicopter passes.
    for (let x = cx - 12.5; x <= cx + 12.5; x += 2.5) {
      for (const z of [cz - 21.9, cz + 21.9])
        g.add(esbDetail(box(0.10, 1.7, 0.12, ESB_ALUMINUM, x, 321.25, z)));
    }
    for (let z = cz - 20; z <= cz + 20; z += 2.5) {
      for (const x of [cx - 13.8, cx + 13.8])
        g.add(esbDetail(box(0.12, 1.7, 0.10, ESB_ALUMINUM, x, 321.25, z)));
    }

    // Overlay only narrow ribs on the retained 320–330m final setback. Its
    // generic window grid still supplies inexpensive fine detail underneath.
    for (const x of [cx - 6.5, cx - 3.25, cx, cx + 3.25, cx + 6.5]) {
      for (const z of [cz - 18.7, cz + 18.7])
        g.add(esbDetail(box(0.42, 10.2, 0.45, ESB_STONE, x, 325, z)));
    }
    for (const z of [cz - 12, cz - 6, cz, cz + 6, cz + 12]) {
      for (const x of [cx - 10.5, cx + 10.5])
        g.add(esbDetail(box(0.45, 10.2, 0.42, ESB_STONE, x, 325, z)));
    }

    // Stepped limestone crown above the OSM roof. The increasingly narrow,
    // ribbed rectangles continue the shaft's setbacks instead of abruptly
    // switching to the old stack of round cylinders.
    esbCrownTier(g, cx, cz, 18.6, 28.5, roof, roof + 9, 5, 7);
    esbCrownTier(g, cx, cz, 15.6, 22.5, roof + 9, roof + 18, 5, 5);
    esbCrownTier(g, cx, cz, 13.0, 17.2, roof + 18, roof + 27, 4, 5);

    // Four fluted buttresses visually tie the 330m roof to the mast base.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      g.add(esbDetail(box(1.0, 12.5, 1.0, ESB_STONE, cx + sx * 8.6, roof + 6.25, cz + sz * 12.8)));
      g.add(esbDetail(box(1.5, 0.6, 1.5, ESB_STONE, cx + sx * 8.6, roof + 12.2, cz + sz * 12.8)));
    }

    // The real 200-foot crowning spire is a faceted aluminum, steel, and glass
    // mooring mast, not a radio pole. Keep its broad occupied base through the
    // 102nd-floor observatory (373m), then taper to the 381m architectural top.
    const mast0 = roof + 27;
    g.add(esbOctagon(10.8, 13.2, 13.0, ESB_GLASS, cx, mast0 + 6.5, cz));
    for (const x of [cx - 4.9, cx, cx + 4.9])
      for (const z of [cz - 6.35, cz + 6.35])
        g.add(esbDetail(box(0.42, 13.4, 0.42, ESB_ALUMINUM, x, mast0 + 6.5, z)));
    for (const z of [cz - 3.7, cz, cz + 3.7])
      for (const x of [cx - 5.25, cx + 5.25])
        g.add(esbDetail(box(0.42, 13.4, 0.42, ESB_ALUMINUM, x, mast0 + 6.5, z)));
    for (const y of [mast0 + 4.2, mast0 + 9.1]) {
      const collar = esbDetail(cyl(1, 1, 0.48, ESB_ALUMINUM, cx, y, cz, 12));
      collar.scale.set(5.55, 1, 6.75);
      g.add(collar);
    }

    const deck102 = 373.1;
    g.add(esbOctagon(8.5, 9.8, 5.4, ESB_GLASS, cx, deck102 - 1.5, cz));
    const lowerBand = esbDetail(cyl(1, 1, 0.65, ESB_ALUMINUM, cx, deck102 - 4.0, cz, 12));
    lowerBand.scale.set(4.65, 1, 5.3);
    g.add(lowerBand);
    const deckBand = esbDetail(cyl(1, 1, 0.8, ESB_LIGHT, cx, deck102, cz, 12));
    deckBand.scale.set(4.65, 1, 5.3);
    g.add(deckBand);
    const upperBand = esbDetail(cyl(1, 1, 0.65, ESB_ALUMINUM, cx, deck102 + 2.7, cz, 12));
    upperBand.scale.set(4.2, 1, 4.8);
    g.add(upperBand);

    const capH = Math.max(4, 381 - (deck102 + 2.7));
    const cap = cyl(0.52, 1, capH, ESB_ALUMINUM, cx, deck102 + 2.7 + capH / 2, cz, 10);
    cap.scale.set(4.0, 1, 4.5);
    g.add(cap);

    // Broadcast antenna: three progressively finer reflective stages, collars,
    // and aviation beacons. Clamp to source data so future fit corrections keep
    // the landmark's measured tip rather than baking a second height constant.
    const archTop = deck102 + 2.7 + capH;
    const antennaH = Math.max(20, tip - archTop);
    g.add(cyl(1.0, 2.1, Math.min(10, antennaH * 0.18), ESB_ALUMINUM, cx, archTop + Math.min(10, antennaH * 0.18) / 2, cz, 10));
    const lowerAntennaTop = archTop + Math.min(10, antennaH * 0.18);
    const midTop = Math.min(tip - 10, lowerAntennaTop + antennaH * 0.66);
    g.add(cyl(0.42, 0.78, midTop - lowerAntennaTop, ESB_ALUMINUM, cx, (lowerAntennaTop + midTop) / 2, cz, 8));
    g.add(cyl(0.07, 0.31, tip - midTop, ESB_ALUMINUM, cx, (midTop + tip) / 2, cz, 6));
    for (const [y, r] of [
      [lowerAntennaTop, 1.15],
      [lowerAntennaTop + (midTop - lowerAntennaTop) * 0.5, 0.72],
      [midTop, 0.50],
    ] as const) {
      g.add(esbDetail(cyl(r, r, 0.45, ESB_ALUMINUM, cx, y, cz, 10)));
      const beacon = esbDetail(cyl(r * 0.32, r * 0.32, 0.7, ESB_BEACON, cx, y + 0.55, cz, 8));
      g.add(beacon);
    }
    return g;
  },

  // Bank of America Tower at One Bryant Park: full replacement for fourteen
  // overlapping source prisms. The pipeline supplies the surveyed two-acre
  // 131x62m host and 366m tip. A four-bay/eight-floor atlas, angular setbacks,
  // asymmetric 945ft screen wall and open 300ft lattice spire recreate
  // COOKFOX's quartz-like silhouette with a tiny skyline/runtime footprint.
  'one-bryant': (ctx) => {
    const g = new THREE.Group();
    const W = ctx.fit?.w ?? 131;
    const D = ctx.fit?.d ?? 62;
    const tip = ctx.fit?.roofH ?? 366;
    const occupiedTop = 234.5; // CTBUH highest occupied floor: 769ft
    const screenBase = 240;

    const curtain = canvasTexture((c, w, h) => {
      const cols = 4, rows = 8;
      const cw = w / cols, ch = h / rows;
      c.fillStyle = '#648994';
      c.fillRect(0, 0, w, h);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * cw, y = row * ch;
          const tone = (row * 11 + col * 7 + row * col) % 6;
          const grad = c.createLinearGradient(x, y, x + cw, y);
          grad.addColorStop(0, tone < 2 ? '#5c7f8a' : '#6f929c');
          grad.addColorStop(0.48, tone % 3 === 0 ? '#b2cbd1' : '#91adb5');
          grad.addColorStop(1, tone === 4 ? '#4e737e' : '#678b95');
          c.fillStyle = grad;
          c.fillRect(x, y, cw, ch);
          // Ceramic frit softens glare while the dark edge preserves the
          // floor-to-ceiling pane read from only a few meters away.
          c.fillStyle = 'rgba(235,241,239,.48)';
          c.fillRect(x, y + ch * 0.68, cw, ch * 0.08);
          c.fillStyle = 'rgba(42,62,69,.82)';
          c.fillRect(x, y + ch - 3, cw, 3);
          c.fillStyle = 'rgba(218,230,231,.9)';
          c.fillRect(x, y, 2, ch);
          if ((row * 5 + col * 3) % 7 === 0) {
            c.fillStyle = 'rgba(238,190,122,.26)';
            c.fillRect(x + 3, y + 3, cw - 6, ch * 0.48);
          }
        }
      }
    }, 192, 256);
    curtain.wrapS = curtain.wrapT = THREE.RepeatWrapping;
    curtain.anisotropy = 4;
    const glassA = new THREE.MeshStandardMaterial({
      map: curtain, color: '#bed6db', metalness: 0.22, roughness: 0.17,
      emissive: '#476d78', emissiveIntensity: 0.48, envMapIntensity: 1.12,
    });
    const glassB = new THREE.MeshStandardMaterial({
      map: curtain, color: '#a9c7ce', metalness: 0.25, roughness: 0.2,
      emissive: '#3b626e', emissiveIntensity: 0.5, envMapIntensity: 1.08,
    });

    // Broad, chamfered public base followed by the dramatically slimmer,
    // east-shifted office tower. Separate envelopes leave the real setback
    // terrace visible instead of stretching one frustum over the full site.
    const baseLevels: BryantLevel[] = [
      { y: 0, cx: 0, cz: 0, w: W - 1, d: D - 1, clip: 5.8 },
      { y: 20, cx: 1.5, cz: 0, w: W - 3, d: D - 2.5, clip: 5.4 },
      { y: 42, cx: 3.5, cz: -0.3, w: W - 9, d: D - 4, clip: 5.0 },
    ];
    const towerLevels: BryantLevel[] = [
      { y: 42, cx: 10, cz: -0.2, w: 102, d: 52, clip: 4.6 },
      { y: 120, cx: 12, cz: -0.5, w: 94, d: 49, clip: 4.2 },
      { y: 190, cx: 15.5, cz: -0.8, w: 78, d: 45, clip: 3.8 },
      { y: occupiedTop, cx: 19, cz: -1, w: 62, d: 41, clip: 3.2 },
    ];
    g.add(oneBryantEnvelope(baseLevels, glassB));
    g.add(oneBryantEnvelope(towerLevels, glassA));

    // Stainless fold lines and floor datum strips reinforce the tower's
    // shifting, angular planes from both Bryant Park and the skyline.
    for (let level = 0; level < towerLevels.length - 1; level++) {
      const a = oneBryantRing(towerLevels[level]);
      const b = oneBryantRing(towerLevels[level + 1]);
      for (let i = 0; i < a.length; i++) {
        g.add(oneBryantDetail(strut(a[i], b[i], 0.18, BRYANT_STEEL, 5)));
      }
    }
    for (const l of towerLevels.slice(1)) {
      const ring = oneBryantRing(l);
      for (let i = 0; i < ring.length; i++) {
        g.add(oneBryantDetail(strut(
          ring[i], ring[(i + 1) % ring.length], 0.16, BRYANT_STEEL, 5,
        )));
      }
    }

    // Bryant Park / Sixth Avenue double wall: a second, highly transparent
    // faceted veil floats outside the east face, with a diagonal fold and
    // visible stainless cable-net edges.
    const veil = new THREE.BufferGeometry();
    const veilPoints = [
      61.5, 12, -21, 63.2, 228, -16,
      51.2, 232, 16, 64.4, 12, 23,
    ];
    veil.setAttribute('position', new THREE.Float32BufferAttribute(veilPoints, 3));
    veil.setIndex([0, 1, 2, 0, 2, 3]);
    veil.computeVertexNormals();
    g.add(oneBryantDetail(new THREE.Mesh(veil, BRYANT_LIGHT_GLASS)));
    for (const [a, b] of [
      [[61.5, 12, -21], [63.2, 228, -16]],
      [[63.2, 228, -16], [51.2, 232, 16]],
      [[51.2, 232, 16], [64.4, 12, 23]],
      [[61.5, 12, -21], [64.4, 12, 23]],
      [[61.5, 12, -21], [51.2, 232, 16]],
    ] as [number[], number[]][]) {
      g.add(oneBryantDetail(strut(
        new THREE.Vector3(a[0], a[1], a[2]),
        new THREE.Vector3(b[0], b[1], b[2]),
        0.14, BRYANT_STEEL, 5,
      )));
    }

    // Floors 52–55: dark mechanical terrace and asymmetric crystalline
    // screen, rising from the 769ft occupied roof to the official 945ft wall.
    g.add(oneBryantDetail(box(58, 5.5, 37, BRYANT_SCREEN, 19, occupiedTop + 2.75, -1)));
    g.add(box(57.5, 5.5, 36.5, BRYANT_COLLISION, 19, occupiedTop + 2.75, -1));
    const crownBase: BryantLevel = {
      y: screenBase, cx: 19, cz: -1, w: 62, d: 41, clip: 3.2,
    };
    const crown = oneBryantCrown(crownBase, BRYANT_SCREEN);
    g.add(crown.mesh);
    for (let i = 0; i < crown.baseRing.length; i++) {
      g.add(oneBryantDetail(strut(crown.baseRing[i], crown.topRing[i], 0.22, BRYANT_STEEL, 5)));
      g.add(oneBryantDetail(strut(
        crown.topRing[i], crown.topRing[(i + 1) % crown.topRing.length],
        0.18, BRYANT_STEEL, 5,
      )));
    }
    // Horizontal louver rails stop the broad mechanical faces reading as one
    // opaque black sail while adding only forty low-segment struts.
    for (const t of [0.16, 0.32, 0.48, 0.64, 0.8]) {
      for (let i = 0; i < crown.baseRing.length; i++) {
        const next = (i + 1) % crown.baseRing.length;
        g.add(oneBryantDetail(strut(
          crown.baseRing[i].clone().lerp(crown.topRing[i], t),
          crown.baseRing[next].clone().lerp(crown.topRing[next], t),
          0.11, BRYANT_STEEL, 5,
        )));
      }
    }

    // Nearly 300ft architectural spire: four tapered lattice legs and five
    // crossed structural panels surround the real 5ft10in-to-2ft2in pipe.
    const mastX = 42.5, mastZ = -7.2, latticeTop = Math.min(338, tip - 18);
    const mast0 = 286.5;
    const baseHalf = 2.7, topHalf = 0.72;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    const mastPoint = (corner: number, t: number) => {
      const [sx, sz] = corners[corner];
      const half = THREE.MathUtils.lerp(baseHalf, topHalf, t);
      return new THREE.Vector3(
        mastX + sx * half,
        THREE.MathUtils.lerp(mast0, latticeTop, t),
        mastZ + sz * half,
      );
    };
    for (let i = 0; i < 4; i++) {
      g.add(oneBryantDetail(strut(mastPoint(i, 0), mastPoint(i, 1), 0.2, BRYANT_STEEL, 6)));
    }
    const braceLevels = 5;
    for (let face = 0; face < 4; face++) {
      const next = (face + 1) % 4;
      for (let level = 0; level < braceLevels; level++) {
        const t0 = level / braceLevels, t1 = (level + 1) / braceLevels;
        g.add(oneBryantDetail(strut(
          mastPoint(face, t0), mastPoint(next, t1), 0.09, BRYANT_STEEL, 5,
        )));
        g.add(oneBryantDetail(strut(
          mastPoint(next, t0), mastPoint(face, t1), 0.09, BRYANT_STEEL, 5,
        )));
        g.add(oneBryantDetail(strut(
          mastPoint(face, t1), mastPoint(next, t1), 0.08, BRYANT_STEEL, 5,
        )));
      }
    }
    g.add(oneBryantDetail(cyl(0.33, 0.89, latticeTop - mast0, BRYANT_STEEL,
      mastX, (mast0 + latticeTop) / 2, mastZ, 8)));
    g.add(oneBryantDetail(cyl(0.08, 0.33, tip - latticeTop, BRYANT_STEEL,
      mastX, (latticeTop + tip) / 2, mastZ, 6)));
    for (const [y, r] of [[mast0, 1.15], [306, 0.72], [326, 0.48], [latticeTop, 0.32]] as [number, number][]) {
      g.add(oneBryantDetail(cyl(r, r, 0.34, BRYANT_STEEL, mastX, y, mastZ, 8)));
    }
    for (const y of [latticeTop, tip]) {
      const beacon = oneBryantDetail(new THREE.Mesh(new THREE.SphereGeometry(0.2, 6, 5), BRYANT_RED));
      beacon.position.set(mastX, y, mastZ);
      g.add(beacon);
    }

    // Street-level Bryant Park corner: 40ft cable-net lobby, warm bamboo
    // canopy, green Urban Garden Room and transparent corner entrances.
    const east = W / 2 + 0.05;
    g.add(oneBryantDetail(box(0.32, 12.2, 43, BRYANT_LOBBY, east, 6.1, 1)));
    g.add(oneBryantDetail(box(0.12, 9.5, 15.5, GREEN_PATINA, east + 0.22, 5.0, -14)));
    for (const z of [-19, -14, -9, -4, 4, 9, 14, 19]) {
      g.add(oneBryantDetail(box(0.18, 12.5, 0.18, BRYANT_STEEL, east + 0.28, 6.25, z)));
    }
    for (const z of [-7.5, -2.5, 2.5, 7.5]) {
      g.add(oneBryantDetail(box(0.18, 8.8, 4.3, BRYANT_DOOR, east + 0.46, 4.4, z)));
    }
    for (const z of [-17.2, -5.7, 5.7, 17.2]) {
      g.add(oneBryantDetail(box(7.2, 0.3, 10.0, BRYANT_WOOD, east + 3.4, 11.8, z)));
      g.add(oneBryantDetail(box(0.18, 11.4, 0.18, BRYANT_STEEL, east + 6.5, 5.7, z - 3.9)));
      g.add(oneBryantDetail(box(0.18, 11.4, 0.18, BRYANT_STEEL, east + 6.5, 5.7, z + 3.9)));
    }

    // Stephen Sondheim Theatre: restored 1918 Henry Miller façade survives
    // within the north base, while the 1,055-seat house descends below grade.
    const theatreZ = -D / 2 - 0.12;
    g.add(oneBryantDetail(box(29, 18.5, 0.48, BRICK_RED, -37, 9.25, theatreZ)));
    g.add(oneBryantDetail(box(31, 1.0, 0.9, LIMESTONE, -37, 18.0, theatreZ - 0.12)));
    g.add(oneBryantDetail(box(29.8, 0.65, 0.72, LIMESTONE, -37, 4.1, theatreZ - 0.16)));
    for (const x of [-45, -37, -29]) {
      g.add(oneBryantDetail(box(5.0, 8.2, 0.34, BRYANT_DOOR, x, 8.1, theatreZ - 0.3)));
      const head = oneBryantDetail(cyl(2.5, 2.5, 0.34, BRYANT_DOOR, x, 12.2, theatreZ - 0.3, 12));
      head.rotation.x = Math.PI / 2;
      g.add(head);
      const arch = oneBryantDetail(new THREE.Mesh(
        new THREE.TorusGeometry(2.75, 0.26, 5, 12, Math.PI),
        LIMESTONE,
      ));
      arch.position.set(x, 12.2, theatreZ - 0.5);
      arch.rotation.z = Math.PI;
      g.add(arch);
    }

    // Four conservative bands follow the massing closely. Facade, lattice and
    // entrance detail remain non-colliding; the 240m mechanical terrace is
    // explicitly landable without a 366m full-site invisible wall.
    g.add(box(W - 2, 42, D - 2, BRYANT_COLLISION, 0.8, 21, 0));
    for (const [a, b] of [[towerLevels[0], towerLevels[1]], [towerLevels[1], towerLevels[2]], [towerLevels[2], towerLevels[3]]] as [BryantLevel, BryantLevel][]) {
      g.add(box(a.w - 2, b.y - a.y, a.d - 2, BRYANT_COLLISION,
        a.cx, (a.y + b.y) / 2, a.cz));
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
      for (const dx of [-11.7, -3.9, 3.9, 11.7]) {
        const x = wc + dx;
        g.add(archOpening(x, 7, 3.2, 8, WZ + 0.1, NYPL_GLASS));
        g.add(nyplDetail(box(0.13, 7.6, 0.14, BRONZE, x, 10.8, WZ + 0.36)));
        for (const y of [9.5, 12.2]) {
          g.add(nyplDetail(box(2.9, 0.13, 0.14, BRONZE, x, y, WZ + 0.36)));
        }
      }
      for (const dx of [-15.6, -7.8, 0, 7.8, 15.6]) g.add(box(0.9, 15.3, 0.6, MARBLE, wc + dx, 10.35, WZ + 0.3));
    }
    // ---- end pavilions, slightly proud, each with a tall niche ----
    for (const cx of [-48, 61]) {
      g.add(box(6, CORN - TERR, 1.0, MARBLE, cx, (CORN + TERR) / 2, WZ + 0.5));
      g.add(box(6.5, 1.3, 1.6, MARBLE, cx, 22.0, WZ + 0.7));
      g.add(archOpening(cx, 8, 2.6, 5.5, WZ + 0.6, NYPL_GLASS));
    }

    // ---- central triple-arch portico: six Corinthian columns, three arches ----
    // (all on the pavilion plane, proud of the wings like the real porch)
    for (const cx of [-7.5, 1.1, 2.9, 10.1, 11.9, 20.5]) g.add(corinthianColumn(cx, PAV + 2));
    for (const cx of [-3.2, 6.5, 16.2]) {
      g.add(archOpening(cx, TERR, 6, 8.3, PAV + 0.1, NYPL_ENTRY_GLASS));
      // Bronze-framed glazed doors and the large hanging lanterns are visible
      // through each real entrance arch, so the portico retains depth without
      // becoming three flat black voids.
      g.add(nyplDetail(box(5.15, 5.5, 0.16, NYPL_ENTRY_GLASS, cx, 5.55, PAV + 0.42)));
      for (const dx of [-1.7, 0, 1.7]) {
        g.add(nyplDetail(box(0.12, 5.3, 0.16, BRONZE, cx + dx, 5.55, PAV + 0.53)));
      }
      for (const y of [4.5, 6.6, 8.15]) {
        g.add(nyplDetail(box(5.0, 0.12, 0.16, BRONZE, cx, y, PAV + 0.53)));
      }
      g.add(nyplDetail(cyl(0.035, 0.035, 2.0, BRONZE, cx, 10.25, PAV + 0.58, 6)));
      const lantern = nyplDetail(new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 7), NYPL_LANTERN));
      lantern.position.set(cx, 9.08, PAV + 0.58);
      g.add(lantern);
    }

    // ---- entablature: continuous frieze + cornice, breaking forward at the portico ----
    g.add(box(2 * HW, 2.2, 1.0, MARBLE, FC, 20.4, WZ + 0.0));        // wing frieze
    g.add(box(2 * HW + 1, 1.1, 1.8, MARBLE, FC, 21.95, WZ + 0.4));   // wing cornice (top 22.5 caps OSM)
    g.add(box(46, 2.2, 1.6, MARBLE, 4.5, 20.4, PAV + 2.2));         // portico frieze (over columns)
    g.add(box(47, 1.2, 2.0, MARBLE, 4.5, 22.0, PAV + 2.6));         // portico cornice, projecting
    const title = nyplTextPanel(nyplTitleTexture(), 40.5, 1.32);
    title.position.set(4.5, 20.45, PAV + 3.02);
    g.add(title);

    // ---- inscribed attic over the portico with six allegorical figures ----
    g.add(box(44, 5, 2, MARBLE, 4.5, 25, PAV + 1.5));               // attic block y 22.5..27.5
    g.add(box(45, 0.6, 2.4, MARBLE, 4.5, 27.8, PAV + 1.7));         // attic cornice cap
    const dedication = nyplTextPanel(nyplDedicationTexture(), 41, 3.6);
    dedication.position.set(4.5, 25.05, PAV + 2.53);
    g.add(dedication);
    for (const cx of [-8.5, -2.5, 3.5, 9.5, 15.5, 21.5]) {
      // Slightly weathered stone preserves the shallow sculptural relief in
      // the shadow-free mobile renderer instead of dissolving into the marble.
      const f = figure(3, LIMESTONE);
      f.scale.x = 1.65; // the real draped figures read broadly between panels
      // The Wisdom/Knowledge figures stand against the inscribed attic face;
      // they are not a row of statues balanced on its roofline.
      f.position.set(cx, 22.8, PAV + 3.2);
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
    // ---- John Purroy Mitchel memorial flagstaffs ----
    // The 1911 poles flank the entire Fifth Avenue facade (not its portico)
    // and stand about 85ft tall. The north pole flies the City flag and the
    // south pole the United States flag.
    const flagTextures = [nyplUsFlagTexture(), nyplCityFlagTexture()];
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -49 : 62;
      g.add(box(2.5, 0.65, 2.5, MARBLE, sx, TERR + 0.325, -7));
      g.add(cyl(0.68, 0.9, 1.65, BRONZE, sx, TERR + 1.15, -7, 10));
      g.add(cyl(0.11, 0.18, 23.5, STEEL_LM, sx, TERR + 13.6, -7, 8));
      const fin = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), GOLD);
      fin.position.set(sx, TERR + 25.55, -7);
      g.add(fin);
      const flag = nyplFlag(flagTextures[i], 4.3, 2.7);
      flag.position.set(sx + 2.2, TERR + 23.8, -7);
      g.add(flag);
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
