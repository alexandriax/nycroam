import type * as THREE from 'three';

// Shared types for the bus system.
//
// public/geo/buses.json conforms to BusData — baked by scripts/fetch-buses.mjs
// from the MTA borough GTFS feeds (real routes, real stop locations, real
// street-following shape polylines), clipped to Manhattan.
//
// The runtime is split into compile-independent modules that meet here:
//   model.ts   — BusModel (the vehicle mesh) implements BusModelLike
//   stops.ts   — buildBusStop (pole/shelter kit) implements BusStopKitFactory
//   BusSystem.ts — simulation + culling; consumes both via injected factories
// World.ts wires the factories so BusSystem never imports the visual modules.

/** One stop along a direction's shape: which stop, and where along the line. */
export interface BusStopRef {
  id: string; // key into BusData.stops
  s: number;  // meters along the direction's shape polyline
}

export interface BusDir {
  /** Headsign for the destination signs, e.g. "SOUTH FERRY". */
  dest: string;
  /** Flat [x0,z0, x1,z1, ...] polyline, world meters (0.1 m precision). */
  shape: number[];
  /** Ordered by s ascending; first entry is the origin terminal. */
  stops: BusStopRef[];
}

export interface BusRoute {
  id: string;    // display short name, e.g. "M15", "M15-SBS", "Bx7"
  name: string;  // long name, e.g. "East Harlem - South Ferry"
  color: string; // '#rrggbb' (GTFS route_color; BUS_DEFAULT_COLOR when unset)
  sbs: boolean;  // Select Bus Service
  dirs: BusDir[]; // 1 or 2 directions
}

export interface BusStopInfo {
  n: string;           // stop name, e.g. "1 AV/E 14 ST"
  p: [number, number]; // world [x, z] — the real curbside MTA stop location
  r: string[];         // route ids serving this stop (for the pole sign)
}

export interface BusData {
  v: 1;
  routes: BusRoute[];
  stops: Record<string, BusStopInfo>;
}

export const BUS_DEFAULT_COLOR = '#1d59b3';

// ---- vehicle geometry contract (model.ts implements, BusSystem consumes) ----

/**
 * Bus local frame: +x forward, +y up, doors on +z (curb side).
 * Group origin is at GROUND level under the bus center.
 */
export const BUS = {
  length: 12.2,
  width: 2.6,
  height: 3.15,
  floorY: 0.38, // interior floor above ground (low-floor bus)
  /** Local x of the door centers (front door ahead of the front axle). */
  doorX: { front: 4.1, rear: -1.15 },
  /** Walkable interior box, local coords (aisle + seat rows, cab excluded). */
  interior: { minX: -5.25, maxX: 3.3, minZ: -0.95, maxZ: 0.95 },
  /** Seated/standing eye height above the interior FLOOR while riding. */
  eye: 1.58,
} as const;

export interface BusModelOpts {
  route: string; // "M15"
  dest: string;  // "SOUTH FERRY"
  color: string; // route color (chips/accents; body livery is fixed MTA)
  sbs: boolean;
}

/** What BusSystem needs from the vehicle mesh (implemented by model.ts). */
export interface BusModelLike {
  readonly group: THREE.Group;
  /** 0 closed .. 1 open; drives both doors. */
  setDoors(t: number): void;
  /** Ground speed (m/s) for wheel spin + subtle body motion. */
  setSpeed(v: number, dt: number): void;
  /** Interior LED: next-stop text (null blanks the sign). */
  setNextStop(text: string | null): void;
  /** Interior "STOP REQUESTED" indicator. */
  setStopRequested(on: boolean): void;
  /** Optional exterior LOD hook; ridden buses always retain the full cabin. */
  setViewerDistanceSq?(distanceSq: number, forceFull?: boolean): void;
  dispose(): void;
}

export type BusModelFactory = (opts: BusModelOpts) => BusModelLike;

// ---- stop kit contract (stops.ts implements, BusSystem consumes) ----

export interface BusRouteBadge { id: string; color: string; sbs: boolean; }

/**
 * Builds one curbside stop kit (pole + sign, optionally a shelter), merged for
 * draw calls. Origin at ground under the POLE; the sign faces +z; the kit runs
 * along local x (BusSystem orients local +x to the street direction).
 */
export type BusStopKitFactory = (routes: BusRouteBadge[], seed: number, shelter: boolean) => THREE.Group;

// ---- HUD ----

/** HUD panel state while riding a bus (mirrors the subway RideHud shape). */
export interface BusHud {
  route: string;
  color: string;
  sbs: boolean;
  dest: string; // terminal headsign, e.g. "SOUTH FERRY"
  state: 'moving' | 'dwell' | 'closing';
  /** dwell/closing: the current stop; moving: the stop being approached. */
  thisStop: string;
  /** The stop after thisStop (interior LED preview); null at the end. */
  nextStop: string | null;
  atEnd: boolean; // thisStop is the last stop of the run
}

/** One entry on a stop's arrivals readout (Guide-A-Ride style). */
export interface BusArrival {
  route: string;
  color: string;
  dest: string;
  seconds: number;
}
