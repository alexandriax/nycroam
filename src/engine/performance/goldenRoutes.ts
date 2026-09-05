export interface StreetBenchmarkPoint {
  label: string;
  lat: number;
  lon: number;
  seconds: number;
}

export interface StreetBenchmarkRoute {
  kind: 'street';
  label: string;
  points: StreetBenchmarkPoint[];
}

export interface StationBenchmarkRoute {
  kind: 'station';
  label: string;
  stationSearch: string;
  seconds: number;
}

export interface RideBenchmarkRoute {
  kind: 'ride';
  label: string;
  stationSearch: string;
  route: string;
  seconds: number;
}

export type BenchmarkRoute = StreetBenchmarkRoute | StationBenchmarkRoute | RideBenchmarkRoute;

/**
 * Stable, OSM-aligned captures for before/after comparisons. They intentionally
 * cover the hardest distinct content types rather than four similar avenues.
 */
export const GOLDEN_ROUTES = {
  'times-square': {
    kind: 'street',
    label: 'Times Square / Broadway',
    points: [
      { label: 'Herald Square', lat: 40.7507, lon: -73.9882, seconds: 3 },
      { label: 'Times Square south', lat: 40.7554, lon: -73.9867, seconds: 4 },
      { label: 'Times Square north', lat: 40.7597, lon: -73.9847, seconds: 4 },
      { label: 'Columbus Circle', lat: 40.7678, lon: -73.9818, seconds: 5 },
    ],
  },
  'central-park': {
    kind: 'street',
    label: 'Central Park transverse',
    points: [
      { label: 'Columbus Circle', lat: 40.7684, lon: -73.9816, seconds: 3 },
      { label: 'The Mall', lat: 40.7725, lon: -73.9748, seconds: 4 },
      { label: 'Bethesda Terrace', lat: 40.7740, lon: -73.9709, seconds: 4 },
      { label: 'East Drive', lat: 40.7766, lon: -73.9668, seconds: 4 },
    ],
  },
  waterfront: {
    kind: 'street',
    label: 'Hudson waterfront',
    points: [
      { label: 'Battery Park', lat: 40.7034, lon: -74.0170, seconds: 3 },
      { label: 'Brookfield Place', lat: 40.7127, lon: -74.0169, seconds: 5 },
      { label: 'Pier 25', lat: 40.7203, lon: -74.0139, seconds: 4 },
      { label: 'Hudson River Park', lat: 40.7292, lon: -74.0115, seconds: 4 },
    ],
  },
  'times-square-station': {
    kind: 'station',
    label: 'Times Square–42 St complex',
    // Match the checked-in MTA/OSM station spelling exactly. "Times Square"
    // does not occur in subway.json; the source uses the standard "Sq" label.
    stationSearch: 'Times Sq-42 St',
    seconds: 36,
  },
  'subway-ride': {
    kind: 'ride',
    label: 'Occupied 1 train / Times Square to 50 St',
    stationSearch: 'Times Sq-42 St',
    route: '1',
    seconds: 32,
  },
} as const satisfies Record<string, BenchmarkRoute>;

export type GoldenRouteId = keyof typeof GOLDEN_ROUTES;

export function goldenRouteIds(): GoldenRouteId[] {
  return Object.keys(GOLDEN_ROUTES) as GoldenRouteId[];
}
