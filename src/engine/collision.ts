import type { CollisionData } from './tileTypes';

/**
 * Push a point (player, radius r) out of building footprints.
 * Buildings are convex-ish rings; we do point-in-polygon + nearest-edge pushout,
 * plus edge-distance pushout for grazing contact.
 */
export function resolveBuildingCollision(
  x: number,
  z: number,
  r: number,
  sets: CollisionData[]
): [number, number] {
  let px = x, pz = z;
  for (const set of sets) {
    const ringCount = set.ringStart.length - 1;
    for (let ri = 0; ri < ringCount; ri++) {
      const minX = set.aabb[ri * 4], minZ = set.aabb[ri * 4 + 1];
      const maxX = set.aabb[ri * 4 + 2], maxZ = set.aabb[ri * 4 + 3];
      if (px < minX - r || px > maxX + r || pz < minZ - r || pz > maxZ + r) continue;

      const start = set.ringStart[ri], end = set.ringStart[ri + 1];
      // point in polygon (even-odd)
      let inside = false;
      for (let i = start, j = end - 1; i < end; j = i++) {
        const xi = set.points[i * 2], zi = set.points[i * 2 + 1];
        const xj = set.points[j * 2], zj = set.points[j * 2 + 1];
        if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
          inside = !inside;
        }
      }

      // nearest point on ring boundary
      let bestD2 = Infinity, bx = 0, bz = 0;
      for (let i = start, j = end - 1; i < end; j = i++) {
        const x1 = set.points[j * 2], z1 = set.points[j * 2 + 1];
        const x2 = set.points[i * 2], z2 = set.points[i * 2 + 1];
        const dx = x2 - x1, dz = z2 - z1;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = x1 + t * dx, qz = z1 + t * dz;
        const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
        if (d2 < bestD2) { bestD2 = d2; bx = qx; bz = qz; }
      }

      const d = Math.sqrt(bestD2);
      if (inside) {
        // push out through nearest boundary point + radius
        if (d > 1e-6) {
          const nx = (bx - px) / d, nz = (bz - pz) / d;
          px = bx + nx * r;
          pz = bz + nz * r;
        } else {
          px += r; // degenerate: nudge
        }
      } else if (d < r && d > 1e-6) {
        const nx = (px - bx) / d, nz = (pz - bz) / d;
        px = bx + nx * r;
        pz = bz + nz * r;
      }
    }
  }
  return [px, pz];
}

/** Axis-aligned walkable box with a floor height (stations). Ramps interpolate y along z or x. */
export interface WalkBox {
  minX: number; maxX: number; minZ: number; maxZ: number;
  y: number;
  // optional ramp: y at (min…max) along axis
  ramp?: { axis: 'x' | 'z'; y0: number; y1: number };
}

export function floorAt(boxes: WalkBox[], x: number, z: number, currentY: number): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    let y = b.y;
    if (b.ramp) {
      const t = b.ramp.axis === 'z'
        ? (z - b.minZ) / (b.maxZ - b.minZ)
        : (x - b.minX) / (b.maxX - b.minX);
      y = b.ramp.y0 + (b.ramp.y1 - b.ramp.y0) * Math.max(0, Math.min(1, t));
    }
    // accept floors within a step up (0.55) or a hop down (0.9); prefer the highest.
    // The drop limit stops players walking off mezzanine edges into stairwells.
    if (y <= currentY + 0.55 && y >= currentY - 0.9 && (best === null || y > best)) best = y;
  }
  return best;
}
