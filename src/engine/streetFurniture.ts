// Street-name sign assemblies + fire hydrants. Signs are batched per tile:
// one canvas atlas (all blade texts) + one merged mesh (poles + double-sided
// blades) = a single draw call per tile.
import * as THREE from 'three';
import { hash01 } from './palette';
import { SANS } from './fonts';

export interface WorldSign {
  x: number;
  y: number;
  z: number;
  names: string[]; // full OSM names; abbreviated for the blade
  angles: number[]; // degrees, direction of each street at the corner
}

const ABBREV: Record<string, string> = {
  street: 'St', streets: 'St', avenue: 'Av', boulevard: 'Blvd', place: 'Pl',
  road: 'Rd', drive: 'Dr', lane: 'Ln', court: 'Ct', terrace: 'Ter',
  parkway: 'Pkwy', square: 'Sq', plaza: 'Plz', expressway: 'Expwy',
  highway: 'Hwy', bridge: 'Br', crescent: 'Cres', alley: 'Aly',
};
const DIRECTION: Record<string, string> = { west: 'W', east: 'E', north: 'N', south: 'S' };

/** "West 42nd Street" -> "W 42 St", NYC blade style. */
export function abbreviateStreet(name: string): string {
  const tokens = name.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (i === 0 && DIRECTION[lower]) { out.push(DIRECTION[lower]); continue; }
    const ord = lower.match(/^(\d+)(st|nd|rd|th)$/);
    if (ord) { out.push(ord[1]); continue; }
    if (ABBREV[lower]) { out.push(ABBREV[lower]); continue; }
    out.push(t);
  }
  return out.join(' ');
}

const BLADE_GREEN = '#0e7443';
const CELL_W = 512, CELL_H = 80, COLS = 2, ROWS = 12;
const POLE_V = 1 - 4 / 1024; // bottom sliver of the atlas = pole color patch

interface BladeCell { u0: number; v0: number; u1: number; v1: number; widthM: number; }

function drawBlade(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string): BladeCell {
  ctx.save();
  ctx.translate(cx, cy);
  // fit text: shrink font until it fits the cell minus padding
  let font = 52;
  ctx.font = `bold ${font}px ${SANS}`;
  let tw = ctx.measureText(text).width;
  while (tw > CELL_W - 90 && font > 26) {
    font -= 3;
    ctx.font = `bold ${font}px ${SANS}`;
    tw = ctx.measureText(text).width;
  }
  const bw = Math.min(CELL_W, tw + 64);
  ctx.fillStyle = BLADE_GREEN;
  ctx.fillRect(0, 4, bw, CELL_H - 8);
  ctx.strokeStyle = '#e9ede9';
  ctx.lineWidth = 4;
  ctx.strokeRect(5, 9, bw - 10, CELL_H - 18);
  ctx.fillStyle = '#f4f7f4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bw / 2, CELL_H / 2 + 2);
  ctx.restore();
  return {
    u0: cx / (CELL_W * COLS),
    v0: cy / (CELL_H * ROWS + 64),
    u1: (cx + bw) / (CELL_W * COLS),
    v1: (cy + CELL_H) / (CELL_H * ROWS + 64),
    widthM: Math.max(0.55, Math.min(1.6, (bw / CELL_W) * 1.75)),
  };
}

/**
 * Build one merged mesh for all sign assemblies in a tile.
 * Returns the mesh plus its atlas texture (caller disposes both).
 */
export function buildSignsMesh(signs: WorldSign[]): { mesh: THREE.Mesh; texture: THREE.CanvasTexture } {
  const W = CELL_W * COLS, H = CELL_H * ROWS + 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // transparent background; pole patch strip at the bottom
  ctx.fillStyle = '#274d3d';
  ctx.fillRect(0, H - 64, W, 64);

  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];

  const quad = (
    corners: [number, number, number][], cell: { u0: number; v0: number; u1: number; v1: number }, flipU: boolean,
    normal: [number, number, number],
  ) => {
    const base = pos.length / 3;
    const us = flipU ? [cell.u1, cell.u0] : [cell.u0, cell.u1];
    const uvs = [
      [us[0], 1 - cell.v1], [us[1], 1 - cell.v1], [us[1], 1 - cell.v0], [us[0], 1 - cell.v0],
    ];
    for (let i = 0; i < 4; i++) {
      pos.push(...corners[i]);
      uv.push(uvs[i][0], uvs[i][1]);
      nrm.push(...normal);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const poleCell = { u0: 0.02, v0: (H - 50) / H, u1: 0.05, v1: (H - 14) / H };

  let cellIdx = 0;
  for (const sign of signs) {
    const { x, y, z } = sign;
    // pole: 4 thin quads (skip caps), 3.3m
    const ph = 3.3, pr = 0.045;
    const sides: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (const [sx, sz] of sides) {
      const ox = sx * pr, oz = sz * pr;
      const tx = -sz * pr, tz = sx * pr;
      quad(
        [
          [x + ox - tx, y, z + oz - tz],
          [x + ox + tx, y, z + oz + tz],
          [x + ox + tx, y + ph, z + oz + tz],
          [x + ox - tx, y + ph, z + oz - tz],
        ],
        poleCell, false, [sx, 0, sz],
      );
    }
    // blades
    for (let b = 0; b < Math.min(2, sign.names.length); b++) {
      if (cellIdx >= COLS * ROWS) break;
      const col = cellIdx % COLS, row = Math.floor(cellIdx / COLS);
      cellIdx++;
      const cell = drawBlade(ctx, col * CELL_W, row * CELL_H, abbreviateStreet(sign.names[b]));
      const ang = ((sign.angles[b] ?? 0) * Math.PI) / 180;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const nx = -dz, nz = dx;
      const w = cell.widthM, h = 0.24;
      const by = y + 3.08 - b * 0.27;
      const off = 0.052; // clear the pole faces
      for (const side of [1, -1] as const) {
        quad(
          [
            [x - dx * (w / 2) + nx * off * side, by - h / 2, z - dz * (w / 2) + nz * off * side],
            [x + dx * (w / 2) + nx * off * side, by - h / 2, z + dz * (w / 2) + nz * off * side],
            [x + dx * (w / 2) + nx * off * side, by + h / 2, z + dz * (w / 2) + nz * off * side],
            [x - dx * (w / 2) + nx * off * side, by + h / 2, z - dz * (w / 2) + nz * off * side],
          ],
          cell, side === -1, [nx * side, 0, nz * side],
        );
      }
    }
  }

  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  // DoubleSide: the pole/blade quads must read from every approach direction
  const mat = new THREE.MeshLambertMaterial({
    map: texture, transparent: true, alphaTest: 0.15, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  return { mesh, texture };
}

// ------------------------------------------------------------- fire hydrant --

let hydrantGeo: THREE.BufferGeometry | null = null;

/** Low-poly two-tone hydrant (vertex colors: black barrel, silver bonnet/caps). */
export function hydrantGeometry(): THREE.BufferGeometry {
  if (hydrantGeo) return hydrantGeo;
  const parts: { geo: THREE.BufferGeometry; color: THREE.Color }[] = [];
  const black = new THREE.Color('#1c1e20');
  const silver = new THREE.Color('#b4b7ba');
  const add = (geo: THREE.BufferGeometry, color: THREE.Color, x = 0, y = 0, z = 0, rz = 0) => {
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    parts.push({ geo, color });
  };
  add(new THREE.CylinderGeometry(0.16, 0.19, 0.08, 8), black, 0, 0.04, 0); // flange
  add(new THREE.CylinderGeometry(0.115, 0.13, 0.5, 8), black, 0, 0.33, 0); // barrel
  add(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 8), silver, 0, 0.6, 0); // collar
  add(new THREE.SphereGeometry(0.115, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), silver, 0, 0.62, 0); // bonnet
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 6), silver, 0, 0.76, 0); // stem nut
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 6), silver, 0.15, 0.42, 0, Math.PI / 2); // side cap
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 6), silver, -0.15, 0.42, 0, Math.PI / 2); // side cap
  const front = new THREE.CylinderGeometry(0.05, 0.05, 0.1, 6);
  front.rotateX(Math.PI / 2);
  front.translate(0, 0.38, 0.14);
  parts.push({ geo: front, color: silver });

  // merge manually with per-vertex colors
  const posArr: number[] = [];
  const nrmArr: number[] = [];
  const colArr: number[] = [];
  const idxArr: number[] = [];
  for (const { geo, color } of parts) {
    const p = geo.getAttribute('position');
    const n = geo.getAttribute('normal');
    const base = posArr.length / 3;
    for (let i = 0; i < p.count; i++) {
      posArr.push(p.getX(i), p.getY(i), p.getZ(i));
      nrmArr.push(n.getX(i), n.getY(i), n.getZ(i));
      colArr.push(color.r, color.g, color.b);
    }
    const gi = geo.getIndex();
    if (gi) {
      for (let i = 0; i < gi.count; i++) idxArr.push(base + gi.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) idxArr.push(base + i);
    }
    geo.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrmArr), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colArr), 3));
  geo.setIndex(idxArr);
  hydrantGeo = geo;
  return geo;
}

export function hydrantMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/** Instanced hydrants for one tile from [x,y,z,rot] transforms. */
export function buildHydrants(transforms: Float32Array, mat: THREE.Material): THREE.InstancedMesh {
  const count = transforms.length / 4;
  const inst = new THREE.InstancedMesh(hydrantGeometry(), mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const x = transforms[i * 4], y = transforms[i * 4 + 1], z = transforms[i * 4 + 2];
    const rot = transforms[i * 4 + 3];
    q.setFromAxisAngle(up, rot);
    const s = 0.92 + hash01(i * 13 + Math.round(x)) * 0.16;
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
    inst.setMatrixAt(i, m);
    // weathering tint variation (multiplies the vertex colors)
    const t = 0.75 + hash01(i * 29 + Math.round(z)) * 0.35;
    c.setRGB(t, t * (0.92 + hash01(i * 7) * 0.1), t * 0.9);
    inst.setColorAt(i, c);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.castShadow = true;
  return inst;
}
