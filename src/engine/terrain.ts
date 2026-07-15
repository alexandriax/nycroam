// Runtime elevation sampler over the DEM grid produced by scripts/fetch-terrain.mjs.
// Gracefully absent: heightAt() returns 0 until/unless terrain.json loads.

interface TerrainGrid {
  originX: number;
  originZ: number;
  step: number;
  nx: number;
  nz: number;
  h: Int16Array; // decimeters
}

let grid: TerrainGrid | null = null;

export async function loadTerrain(): Promise<boolean> {
  try {
    const res = await fetch('/geo/terrain.json');
    if (!res.ok) return false;
    const j = await res.json();
    grid = {
      originX: j.originX,
      originZ: j.originZ,
      step: j.step,
      nx: j.nx,
      nz: j.nz,
      h: Int16Array.from(j.h as number[]),
    };
    return true;
  } catch {
    return false;
  }
}

export function hasTerrain(): boolean {
  return grid !== null;
}

/** Ground elevation in meters at world (x, z). Bilinear; 0 when no terrain data. */
export function heightAt(x: number, z: number): number {
  if (!grid) return 0;
  const g = grid;
  const fx = (x - g.originX) / g.step;
  const fz = (z - g.originZ) / g.step;
  const ix = Math.max(0, Math.min(g.nx - 2, Math.floor(fx)));
  const iz = Math.max(0, Math.min(g.nz - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - ix));
  const tz = Math.max(0, Math.min(1, fz - iz));
  const i00 = iz * g.nx + ix;
  const h00 = g.h[i00], h10 = g.h[i00 + 1];
  const h01 = g.h[i00 + g.nx], h11 = g.h[i00 + g.nx + 1];
  const top = h00 + (h10 - h00) * tx;
  const bot = h01 + (h11 - h01) * tx;
  return (top + (bot - top) * tz) / 10;
}
