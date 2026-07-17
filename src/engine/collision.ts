import type { CollisionData } from './tileTypes';

// Standing head clearance: a ring whose underside is above this never blocks.
const HEAD = 1.75;

/**
 * A ring is solid at height `y` when the player's body (feet y, head y+HEAD)
 * overlaps its [base, top] span. Above the roof (feet at/over top) or fully
 * under an elevated part, the ring is passable. `y === undefined` keeps the
 * legacy footprint-only behavior (every ring solid).
 */
function ringSolidAt(set: CollisionData, ri: number, y: number | undefined): boolean {
  if (y === undefined) return true;
  return y < set.top[ri] - 0.3 && y + HEAD > set.base[ri];
}

/**
 * Push a point (player, radius r) out of building footprints.
 * Buildings are convex-ish rings; we do point-in-polygon + nearest-edge pushout,
 * plus edge-distance pushout for grazing contact. Pass the player's feet `y`
 * so rings they stand on top of (roofs) or walk under (arcades) don't shove.
 */
export function resolveBuildingCollision(
  x: number,
  z: number,
  r: number,
  sets: CollisionData[],
  y?: number,
): [number, number] {
  let px = x, pz = z;
  for (const set of sets) {
    const ringCount = set.ringStart.length - 1;
    for (let ri = 0; ri < ringCount; ri++) {
      if (!ringSolidAt(set, ri, y)) continue;
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

/** True if (x,z) is inside any building footprint solid at height `y`. */
export function pointInBuildings(x: number, z: number, sets: CollisionData[], y?: number): boolean {
  for (const set of sets) {
    const ringCount = set.ringStart.length - 1;
    for (let ri = 0; ri < ringCount; ri++) {
      if (!ringSolidAt(set, ri, y)) continue;
      const minX = set.aabb[ri * 4], minZ = set.aabb[ri * 4 + 1];
      const maxX = set.aabb[ri * 4 + 2], maxZ = set.aabb[ri * 4 + 3];
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const start = set.ringStart[ri], end = set.ringStart[ri + 1];
      let inside = false;
      for (let i = start, j = end - 1; i < end; j = i++) {
        const xi = set.points[i * 2], zi = set.points[i * 2 + 1];
        const xj = set.points[j * 2], zj = set.points[j * 2 + 1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}

/**
 * Highest landable roof under a player at (x,z) with feet at `y`: the max
 * `top` over every ring containing the point whose top sits at or below the
 * feet (+ a small step allowance). Null when nothing is below — caller falls
 * back to terrain.
 */
export function roofBelow(x: number, z: number, y: number, sets: CollisionData[]): number | null {
  let best: number | null = null;
  for (const set of sets) {
    const ringCount = set.ringStart.length - 1;
    for (let ri = 0; ri < ringCount; ri++) {
      const top = set.top[ri];
      if (top > y + 0.45) continue; // roof above the feet — not a landing
      if (best !== null && top <= best) continue;
      const minX = set.aabb[ri * 4], minZ = set.aabb[ri * 4 + 1];
      const maxX = set.aabb[ri * 4 + 2], maxZ = set.aabb[ri * 4 + 3];
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const start = set.ringStart[ri], end = set.ringStart[ri + 1];
      let inside = false;
      for (let i = start, j = end - 1; i < end; j = i++) {
        const xi = set.points[i * 2], zi = set.points[i * 2 + 1];
        const xj = set.points[j * 2], zj = set.points[j * 2 + 1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) best = top;
    }
  }
  return best;
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

/**
 * Highest walkbox floor at (x,z) ignoring the step/drop window — used to
 * recover a player whose y has drifted away from any acceptable floor.
 */
export function floorAtAny(boxes: WalkBox[], x: number, z: number): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    let y = b.y;
    if (b.ramp) {
      const t = b.ramp.axis === 'x'
        ? (x - b.minX) / (b.maxX - b.minX)
        : (z - b.minZ) / (b.maxZ - b.minZ);
      y = b.ramp.y0 + (b.ramp.y1 - b.ramp.y0) * Math.max(0, Math.min(1, t));
    }
    if (best === null || y > best) best = y;
  }
  return best;
}

/**
 * Unit direction ALONG the nearest building wall segment within maxDist of
 * (x,z), or null. Used to align street furniture with building frontages.
 */
export function nearestWallDir(
  x: number,
  z: number,
  maxDist: number,
  sets: CollisionData[]
): [number, number] | null {
  let bestD2 = maxDist * maxDist;
  let dir: [number, number] | null = null;
  for (const set of sets) {
    const ringCount = set.ringStart.length - 1;
    for (let ri = 0; ri < ringCount; ri++) {
      const minX = set.aabb[ri * 4], minZ = set.aabb[ri * 4 + 1];
      const maxX = set.aabb[ri * 4 + 2], maxZ = set.aabb[ri * 4 + 3];
      if (x < minX - maxDist || x > maxX + maxDist || z < minZ - maxDist || z > maxZ + maxDist) continue;
      const start = set.ringStart[ri], end = set.ringStart[ri + 1];
      for (let i = start, j = end - 1; i < end; j = i++) {
        const x1 = set.points[j * 2], z1 = set.points[j * 2 + 1];
        const x2 = set.points[i * 2], z2 = set.points[i * 2 + 1];
        const dx = x2 - x1, dz = z2 - z1;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        let t = ((x - x1) * dx + (z - z1) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        const qx = x1 + t * dx, qz = z1 + t * dz;
        const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
        if (d2 < bestD2) {
          bestD2 = d2;
          const l = Math.sqrt(l2);
          dir = [dx / l, dz / l];
        }
      }
    }
  }
  return dir;
}
