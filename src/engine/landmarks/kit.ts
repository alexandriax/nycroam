import * as THREE from 'three';

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
export const LIMESTONE = new THREE.MeshLambertMaterial({ color: '#cfc8b8' });
export const GRANITE = new THREE.MeshLambertMaterial({ color: '#8e8d90' });
export const DARKSTONE = new THREE.MeshLambertMaterial({ color: '#6d6a63' });
export const MARBLE = new THREE.MeshLambertMaterial({ color: '#e8e4da' });
export const BRICK_RED = new THREE.MeshLambertMaterial({ color: '#8d5744' });
export const BRONZE = new THREE.MeshStandardMaterial({ color: '#6d4f2f', metalness: 0.75, roughness: 0.45 });
export const VERDIGRIS = new THREE.MeshLambertMaterial({ color: '#5e9c8a' });
export const GOLD = new THREE.MeshStandardMaterial({ color: '#c9a227', metalness: 0.85, roughness: 0.3 });
export const STEEL_LM = new THREE.MeshStandardMaterial({ color: '#9aa3ab', metalness: 0.8, roughness: 0.35 });
export const GLASS_LM = new THREE.MeshStandardMaterial({ color: '#7fa8c4', metalness: 0.6, roughness: 0.12 });
export const WHITE_LM = new THREE.MeshLambertMaterial({ color: '#e9ecef' });
export const WATER_LM = new THREE.MeshStandardMaterial({ color: '#2a5a70', metalness: 0.3, roughness: 0.25 });
export const GREEN_PATINA = new THREE.MeshLambertMaterial({ color: '#3f7f63' });

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
export function archWall(w: number, h: number, depth: number, archW: number, archH: number, mat: THREE.Material): THREE.Mesh {
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
  hole.absarc(0, spring, r, Math.PI, 0, true);
  hole.lineTo(r, 0);
  hole.closePath();
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 10 });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, mat);
}

/** Simple standing figure silhouette (~`h` tall) for statues; deliberately stylized. */
export function figure(h: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const u = h / 1.8;
  g.add(cyl(0.16 * u, 0.2 * u, 0.75 * u, mat, 0, 0.375 * u, 0, 8)); // legs/robe
  g.add(box(0.42 * u, 0.55 * u, 0.24 * u, mat, 0, 1.0 * u, 0)); // torso
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13 * u, 8, 7), mat);
  head.position.set(0, 1.42 * u, 0);
  g.add(head);
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
