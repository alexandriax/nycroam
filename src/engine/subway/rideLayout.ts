import type { PlatformType, StationSpec } from './types';
import type { TrackSpec } from './complextypes';
import { complexFor } from './complexes';
import { fitPlatformEdges } from './platformEdges';

export interface RideStationLayout {
  stationId: string;
  name: string;
  bandColor: string;
  type: PlatformType;
  elevated: boolean;
  length: number;
  /** Cross section in car coordinates: +x forward; selected track z=0. */
  platforms: { zMin: number; zMax: number }[];
  tracks: number[];
  walls: [number, number];
  platformSide: 1 | -1;
}

/** Uses the same segment order, widths and route/flip selection as station worlds
 * and TrainScheduler. A side is never inferred merely from uptown/downtown. */
export function rideStationLayout(station: StationSpec, route: string, direction: 1 | -1): RideStationLayout {
  const group = complexFor(station.id)?.groups.find(g => g.id === station.id && g.tracks.some(t => !t.pass && t.dir === direction && t.routes.includes(route)))
    ?? complexFor(station.id)?.groups.find(g => g.id === station.id);
  const type = group?.type ?? station.layout.type;
  const platformWidth = type === 'island' ? 7 : type === 'dual-island' ? 5.5 : 4.5;
  const count = group?.tracks.length ?? (type === 'island' ? 2 : type === 'dual-island' ? 4 : Math.max(2, station.layout.tracks));
  const sequence: ('p' | number)[] = type === 'side'
    ? ['p', ...Array.from({ length: count }, (_, i) => i), ...(count > 1 ? ['p' as const] : [])]
    : type === 'island'
      ? [0, 'p', ...Array.from({ length: count - 1 }, (_, i) => i + 1)]
      : count === 3 ? [0, 'p', 1, 'p', 2] : [0, 'p', 1, ...Array.from({ length: count - 3 }, (_, i) => i + 2), 'p', count - 1];
  const width = sequence.reduce<number>((sum, part) => sum + (part === 'p' ? platformWidth : 4.4), 1);
  const tracks: { z: number; spec: TrackSpec }[] = [];
  const platforms: { zMin: number; zMax: number }[] = [];
  let z = -width / 2 + .5;
  for (const part of sequence) {
    if (part === 'p') { platforms.push({ zMin: z, zMax: z + platformWidth }); z += platformWidth; continue; }
    const stopping = type === 'dual-island' || part === 0 || part === count - 1;
    const routes = type === 'dual-island'
      ? ((part === 0 || part === count - 1) ? [station.routes[0]] : station.routes.slice(1)) : station.routes;
    tracks.push({
z: z + 2.2, spec: group?.tracks[part] ?? {
        routes: routes.length ? routes : station.routes,
        dir: type === 'dual-island' ? (part < 2 ? 1 : -1) : (part === 0 ? 1 : -1),
        pass: !stopping,
      }
}); z += 4.4;
  }
  const selected = tracks.find(t => !t.spec.pass && t.spec.dir === direction && t.spec.routes.includes(route))
    ?? tracks.find(t => !t.spec.pass && t.spec.dir === direction) ?? tracks[0];
  const travel = group?.stubEnd ?? (selected.spec.flip ? -direction : direction);
  const relative = fitPlatformEdges(platforms, tracks.map(t => t.z), group?.division ?? station.division).map(p => {
    const a = (p.zMin - selected.z) * travel, b = (p.zMax - selected.z) * travel;
    return { zMin: Math.min(a, b), zMax: Math.max(a, b) };
  });
  const nearest = relative.reduce((best, p) => Math.abs((p.zMin + p.zMax) / 2) < Math.abs((best.zMin + best.zMax) / 2) ? p : best);
  const wa = (-width / 2 - selected.z) * travel, wb = (width / 2 - selected.z) * travel;
  return {
    stationId: station.id, name: group?.name ?? station.name, bandColor: group?.bandColor ?? station.layout.bandColor, type,
    elevated: !group && /elevated|viaduct|embankment|open cut/i.test(station.structure),
    length: group?.length ?? station.layout.platformLength, platforms: relative,
    tracks: tracks.map(t => (t.z - selected.z) * travel), walls: [Math.min(wa, wb), Math.max(wa, wb)],
    platformSide: (Math.sign((nearest.zMin + nearest.zMax) / 2) || 1) as 1 | -1,
  };
}

export const RIDE_CEILING_Y = 2.15;
export const RIDE_RAIL_Y = 1.96;
export const RIDE_SIGN_X = 0;
export const RIDE_SIGN_HALF_THICKNESS = .085;
/** Every longitudinal rail ends before the transverse sign casing. */
export function cabinRailSegments(length: number): [number, number][] {
  const clearance = RIDE_SIGN_HALF_THICKNESS + .14;
  return [[-length / 2 + .4, -clearance], [clearance, length / 2 - .4]];
}
export function rideTravelDistance(progress: number, total: number): number {
  const p = Math.max(0, Math.min(1, progress));
  return total * (.5 - .5 * Math.cos(Math.PI * p));
}
export function rideLegDistance(seconds: number, fromLength: number, toLength: number): number {
  // Allow both full platforms to clear the car even on compressed short hops.
  return Math.max(fromLength / 2 + toLength / 2 + 55, 24 * seconds * 2 / Math.PI);
}
