// Shared geographic constants. The data pipeline scripts (scripts/*.mjs)
// duplicate these EXACT numbers — keep them in sync.
export const ORIGIN = { lat: 40.758, lon: -73.9855 }; // Times Square
export const M_PER_DEG_LAT = 111132;
export const M_PER_DEG_LON = 84327;
export const TILE_SIZE = 256; // meters

// World frame: +x = east, +z = south, +y = up. Looking toward -z faces north.
export function lonLatToXZ(lon: number, lat: number): [number, number] {
  return [
    (lon - ORIGIN.lon) * M_PER_DEG_LON,
    -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
  ];
}

export function tileKey(tx: number, tz: number): string {
  return `${tx}_${tz}`;
}

export function worldToTile(x: number, z: number): [number, number] {
  return [Math.floor(x / TILE_SIZE), Math.floor(z / TILE_SIZE)];
}
