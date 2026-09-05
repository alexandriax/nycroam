import { BUS } from './types';

/** Centers remain 15cm inside the authored 1.3m/1.5m door openings. */
export function atBusDoorBay(x: number): boolean {
  return Math.abs(x - BUS.doorX.front) <= .50 || Math.abs(x - BUS.doorX.rear) <= .60;
}

/** The aisle leads around the cab divider to the curb-side front vestibule.
 * Stop at its door center, before the farebox and driver's controls. */
export function clampBusCabinPosition(x: number, z: number, doorsOpen: boolean): { x: number; z: number } {
  let px = Math.max(BUS.interior.minX, Math.min(BUS.doorX.front, x));
  if (px > BUS.interior.maxX && z < .36) px = BUS.interior.maxX;
  const minZ = px > BUS.interior.maxX ? .36 : BUS.interior.minZ;
  const maxZ = atBusDoorBay(px) ? BUS.width / 2 + (doorsOpen ? .08 : -.15) : BUS.interior.maxZ;
  return { x: px, z: Math.max(minZ, Math.min(maxZ, z)) };
}

export function atOpenBusDoor(x: number, z: number, doorsOpen: boolean): boolean {
  return doorsOpen && atBusDoorBay(x) && z > BUS.width / 2 - .18;
}
