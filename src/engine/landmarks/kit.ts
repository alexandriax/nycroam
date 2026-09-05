import * as THREE from 'three';
import { architecturalMaterial } from '../surfaceMaterial';

/**
 * Shared building blocks for landmark modules (src/engine/landmarks/sets/*).
 *
 * Contract for a landmark builder:
 *   - signature `(ctx: LandmarkCtx) => THREE.Group`
 *   - the group's origin is at GROUND level at the landmark's registry
 *     position; +y up, meters. The manager sets world position/rotation,
 *     merges meshes per material, and disposes on the way out.
 *   - keep a landmark under ~20k triangles; canvas textures 256px or less.
 *   - text must never be a single DoubleSide plane (it mirrors); use
 *     twoSidedPanel() below.
 *   - materials: reuse these shared ones wherever possible — the merger
 *     collapses meshes per material, so shared materials = fewer draws.
 */
export interface LandmarkCtx {
  /** Terrain height at a world offset from the landmark origin (dx, dz in local pre-rotation meters). */
  groundAt: (dx: number, dz: number) => number;
  /**
   * Host-building measurements from the tile pipeline (landmarks-fit.json),
   * present for building-attached landmarks. The group is already positioned
   * at the massing's oriented-bbox center and rotated to its long edge, so
   * local +-x spans `w` and +-z spans `d`. `keptH` is the roof of the massing
   * left standing (crowns start there); `roofH` includes any parts the
   * pipeline cleared for replacement.
   */
  fit?: { w: number; d: number; roofH: number; keptH: number; topW: number; topD: number };
  /**
   * Pushes a LOCAL prop position (dx, dz, pre-rotation meters) out of any
   * roadway onto the sidewalk, `clearance` meters past the curb, and returns
   * the adjusted LOCAL position. Identity when the landmark isn't
   * road-sensitive or road data isn't available yet.
   */
  clearRoad: (dx: number, dz: number, clearance?: number) => [number, number];
}

// ---- shared materials (module scope: one instance across all landmarks) ----
export const LIMESTONE = architecturalMaterial('#c8c0af', 'stone', 0.82);
export const GRANITE = architecturalMaterial('#96918a', 'stone', 0.9);
export const DARKSTONE = architecturalMaterial('#615f59', 'stone', 0.86);
export const MARBLE = architecturalMaterial('#e0dcd1', 'stone', 0.58);
export const BRICK_RED = architecturalMaterial('#92523e', 'brick', 0.91);
export const BRONZE = new THREE.MeshStandardMaterial({ color: '#6d4f2f', metalness: 0.75, roughness: 0.45 });
export const VERDIGRIS = architecturalMaterial('#72a798', 'patina', 0.8);
export const GOLD = new THREE.MeshStandardMaterial({ color: '#c9a227', metalness: 0.85, roughness: 0.3 });
export const STEEL_LM = architecturalMaterial('#b7bdc1', 'metal', 0.29);
export const GLASS_LM = new THREE.MeshStandardMaterial({ color: '#68878f', metalness: 0.25, roughness: 0.17, envMapIntensity: 1.15 });
export const WHITE_LM = architecturalMaterial('#e6e4dd', 'stone', 0.57);
export const WATER_LM = new THREE.MeshStandardMaterial({ color: '#2a5a70', metalness: 0.3, roughness: 0.25 });
export const GREEN_PATINA = architecturalMaterial('#46796a', 'patina', 0.85);

// ---- geometry helpers -------------------------------------------------------

/** Box mesh shorthand. */
export function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** Cylinder mesh shorthand (radialSegments kept low on purpose). */
export function cyl(rTop: number, rBot: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 10): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}

/** Cylinder stretched between two points (cables, struts, columns at angles). */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, seg = 6): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, seg), mat);
  const len = a.distanceTo(b);
  m.scale.set(1, len, 1);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

/** Row of columns along local x, centered. */
export function colonnade(count: number, spacing: number, r: number, h: number, mat: THREE.Material, y = 0): THREE.Group {
  const g = new THREE.Group();
  const start = -((count - 1) * spacing) / 2;
  for (let i = 0; i < count; i++) {
    const c = cyl(r, r * 1.06, h, mat, start + i * spacing, y + h / 2, 0, 10);
    g.add(c);
    g.add(box(r * 2.6, r * 0.7, r * 2.6, mat, start + i * spacing, y + h + r * 0.35, 0)); // capital
    g.add(box(r * 2.8, r * 0.6, r * 2.8, mat, start + i * spacing, y + r * 0.3, 0)); // base
  }
  return g;
}

/** Lathe (surface of revolution) from a 2D profile [radius, height][]. */
export function lathe(profile: [number, number][], mat: THREE.Material, seg = 14): THREE.Mesh {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.Mesh(new THREE.LatheGeometry(pts, seg), mat);
}

/**
 * Rectangular wall with a round-topped arch opening, extruded `depth` meters.
 * Origin at the wall's bottom-center; the arch is centered.
 */
export function archWall(w: number, h: number, depth: number, archW: number, archH: number, mat: THREE.Material, pointed = false): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h);
  shape.lineTo(-w / 2, h);
  shape.closePath();
  const hole = new THREE.Path();
  const r = archW / 2;
  const spring = Math.max(0.1, archH - r); // straight jamb height before the semicircle
  hole.moveTo(-r, 0);
  hole.lineTo(-r, spring);
  if (pointed) {
    hole.quadraticCurveTo(-r * 0.7, archH - r * 0.32, 0, archH);
    hole.quadraticCurveTo(r * 0.7, archH - r * 0.32, r, spring);
  } else hole.absarc(0, spring, r, Math.PI, 0, true);
  hole.lineTo(r, 0);
  hole.closePath();
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 10 });
  geo.translate(0, 0, -depth / 2);
  const mesh = new THREE.Mesh(geo, mat);
  // WHY: an arch is a wall with a walk-THROUGH opening. Landmark collision now
  // derives a footprint ring from every solid extruded mass, but this outline's
  // solid span would seal the very passage you walk under. Tag it so
  // deriveCollision leaves the arch passable — the surrounding piers/frieze/
  // cornice are separate box meshes that still block on their own.
  mesh.userData.passable = true;
  return mesh;
}

/** Smooth volume for anatomy/sculpture without expensive sculpted meshes. */
export function ellipsoid(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mat);
  mesh.scale.set(w / 2, h / 2, d / 2);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Draped statue with a continuous silhouette and correctly proportioned head. */
export function figure(h: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(lathe([[0,0], [.15,0], [.18,.08], [.14,.45], [.105,.58], [.15,.72], [.13,.8], [.06,.83]], mat, 18));
  g.add(ellipsoid(.14, .18, .16, mat, 0, .91, 0));
  for (const side of [-1, 1]) {
    g.add(strut(new THREE.Vector3(side*.13,.76,0), new THREE.Vector3(side*.19,.53,.015), .04, mat, 8));
    g.add(ellipsoid(.08,.09,.07,mat,side*.19,.5,.015));
  }
  g.scale.setScalar(h);
  return g;
}

/** Flat text panel readable from BOTH sides (two front-facing quads). */
export function twoSidedPanel(tex: THREE.Texture, w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const a = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  a.position.z = 0.012;
  const b = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  b.position.z = -0.012;
  b.rotation.y = Math.PI;
  g.add(a, b);
  return g;
}

/** Canvas → texture with sane defaults (sRGB, mipmaps). */
export function canvasTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/**
 * Abstract glowing billboard texture — colorful ad-like blocks with NO words
 * or logos (nothing trademarked ships with the world).
 */
export function billboardTexture(seed: number, w = 256, h = 128): THREE.CanvasTexture {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return canvasTexture((ctx) => {
    const hue = Math.floor(rnd() * 360);
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hue}, 85%, 55%)`);
    grad.addColorStop(1, `hsl(${(hue + 60 + rnd() * 120) % 360}, 85%, 45%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const blocks = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < blocks; i++) {
      ctx.fillStyle = `hsla(${Math.floor(rnd() * 360)}, 90%, ${60 + rnd() * 30}%, ${0.5 + rnd() * 0.5})`;
      const bw = (0.15 + rnd() * 0.4) * w, bh = (0.12 + rnd() * 0.35) * h;
      ctx.beginPath();
      ctx.roundRect(rnd() * (w - bw), rnd() * (h - bh), bw, bh, 6);
      ctx.fill();
    }
    // bright bar to read as a headline without being text
    ctx.fillStyle = `hsla(0, 0%, 100%, ${0.65 + rnd() * 0.3})`;
    ctx.fillRect(w * 0.08, h * (0.15 + rnd() * 0.5), w * (0.3 + rnd() * 0.45), h * 0.09);
  }, w, h);
}

/** Emissive billboard material from billboardTexture (self-lit day and night). */
export function billboardMaterial(seed: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: billboardTexture(seed) });
}
