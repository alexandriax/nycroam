// Shared types for the subway system. public/subway/subway.json conforms to SubwayData.

export type PlatformType = 'side' | 'island' | 'dual-island';

export interface StationLayout {
  type: PlatformType;
  tracks: 2 | 3 | 4;
  /** Center tracks with no platform (express pass-through) — only for type 'side'. */
  passTracks: 0 | 1 | 2;
  /** Platform length, meters. IRT (numbered division) ≈ 156, BMT/IND ≈ 183. */
  platformLength: number;
  /** Depth of platform floor below street, meters (positive number). */
  depth: number;
  /** Hex color of the tile band / trim, derived from the trunk line color. */
  bandColor: string;
}

export interface StationSpec {
  id: string; // GTFS stop id
  complexId: string;
  name: string;
  routes: string[]; // e.g. ["N","Q","R","W"]
  structure: string; // "Subway" | "Elevated" | ...
  division: string; // "IRT" | "BMT" | "IND"
  pos: [number, number]; // local meters [x, z]
  layout: StationLayout;
}

export interface EntranceSpec {
  pos: [number, number];
  stationId: string; // GTFS stop id of the linked station
  kind: string; // "stair" | "elevator" | ...
}

export interface SubwayData {
  stations: StationSpec[];
  entrances: EntranceSpec[];
}

// ---- network (rideable routes) ----

export interface NetworkRoute {
  stops: string[]; // GTFS parent ids, ordered SOUTH -> NORTH
  t: number[]; // seconds between consecutive stops (length = stops.length - 1)
  color: string;
}

export interface NetworkData {
  v: number;
  routes: Record<string, NetworkRoute>;
}

/** Geometry a station world exposes so the scheduler can attach trains. */
export interface TrackInfo {
  trackZs: number[];
  /** Direction each stopping track serves, aligned with trackZs (+1 = uptown). */
  trackDirs?: (1 | -1)[]; // stopping tracks (z centers, station-local)
  /** Which z-side the platform sits on for each stopping track, aligned with
   *  trackZs (+1 = platform toward +z, -1 = toward -z). Doors/windows on a
   *  platform train open on this side only; the far side stays solid. */
  platformSides?: (1 | -1)[];
  /** Route rotation per stopping track, aligned with trackZs. When present it
   *  overrides the scheduler's local/express split heuristic — this is how
   *  complex specs pin each service to its REAL track. */
  trackRoutes?: string[][];
  /** Per stopping track: trains physically travel opposite to dirSign-along-+x
   *  (see TrackSpec.flip). Aligned with trackZs. */
  trackFlips?: boolean[];
  passTrackZs?: number[]; // express pass-through tracks (no platform)
  /** Routes blasting through each pass track, aligned with passTrackZs
   *  (fallback: the express partner of the station's first route). */
  passTrackRoutes?: string[][];
  /** Direction of each pass track, aligned with passTrackZs. */
  passTrackDirs?: (1 | -1)[];
  /** Terminal group: tracks end (bumpers) at this local x sign; trains arrive
   *  from the opposite portal, dwell, and reverse back out the way they came. */
  stubEnd?: 1 | -1;
  railY: number; // rail-top y (train group y)
  half: number; // platformLength / 2
  portal: number; // |x| where tunnel/viaduct swallows trains
}

/** One platform countdown-clock reading: soonest next train per direction. */
export interface Arrival {
  dirSign: 1 | -1;
  routes: string[]; // routes that can serve this direction here
  seconds: number; // estimated seconds until it's at the platform (0 = now)
}

/** Official MTA trunk-line colors. */
export const ROUTE_COLORS: Record<string, string> = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
  '4': '#00933C', '5': '#00933C', '6': '#00933C', '6X': '#00933C',
  '7': '#B933AD', '7X': '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  S: '#808183', GS: '#808183', FS: '#808183', H: '#808183',
};

/** Bullet text color: black on the yellow (Broadway) bullets, white elsewhere. */
export function bulletTextColor(route: string): string {
  return 'NQRW'.includes(route.charAt(0)) ? '#111111' : '#FFFFFF';
}

export function routeColor(route: string): string {
  return ROUTE_COLORS[route] ?? '#808183';
}
