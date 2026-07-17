// Declarative multi-group station-complex specs. A ComplexSpec describes one
// real station complex (e.g. Times Sq–42 St) as several track GROUPS — each a
// self-contained platform/track cross-section with its own axis, level and
// train service — plus the mezzanines, corridors and stairs that connect them.
// ComplexStationWorld builds a walkable world from one of these; the specs
// themselves live in complexes.ts and are authored from the Project Subway NYC
// axonometric drawings so the in-game layouts reflect the real stations.
import type { PlatformType } from './types';

/** One track of a group, ordered local -z → +z across the cross-section. */
export interface TrackSpec {
  /** Routes that STOP on this track (rotation), or blast through if `pass`. */
  routes: string[];
  /** Network direction served: +1 = toward each route's stops[last] (north). */
  dir: 1 | -1;
  /** Express pass-through: no platform service, trains never stop. */
  pass?: boolean;
  /** Trains on this track physically travel OPPOSITE to `dir`-along-+x. Real
   *  case: 7 Av (53 St) pairs both DOWNTOWN services on one level — the E and
   *  the B/D head the same network direction but opposite compass ways. */
  flip?: boolean;
}

/**
 * One platform/track group of a complex — a single line's station within the
 * complex, e.g. the [4,5,6] platforms inside Grand Central. Local frame: +x is
 * the direction dir:+1 trains travel, tracks/platforms span z per `type`,
 * y=0 is the platform floor (node sits at world `y`).
 */
export interface GroupSpec {
  /** GTFS stop id — must match subway.json + network.json (ride/boards key). */
  id: string;
  /** Signed name of this group's platforms (usually the complex name; "51 St"
   *  style where a member keeps its own identity). */
  name: string;
  /** Display route set for mosaics/column signs (union of track routes). */
  routes: string[];
  division: string; // IRT | BMT | IND — car dimensions
  bandColor: string; // tile trim color
  type: PlatformType; // platform arrangement (side / island / dual-island)
  length: number; // platform length, m
  y: number; // platform-floor level in complex frame (0 = shallowest)
  /** World heading of local +x (dir:+1 travel): 0=+x, 90=+z, 180=-x, 270=-z. */
  rot: 0 | 90 | 180 | 270;
  at: [number, number]; // world (x,z) of the group's center
  tracks: TrackSpec[]; // ordered local -z → +z
  /** Terminal: tracks END (bumper blocks) at this local x sign. Trains arrive
   *  from the open end, dwell, and reverse back out. */
  stubEnd?: 1 | -1;
}

/** Fare line crossing a mezzanine. `cross`='x' means you cross it walking
 *  along x at x=`at` (the line itself spans z, wall to wall). */
export interface FareSpec {
  cross: 'x' | 'z';
  at: number;
  /** Which side of the line is PAID (toward the platforms): +1 = the
   *  greater-coordinate side along the crossing axis. */
  paidSign: 1 | -1;
}

/** Street exit stair rising from a mezzanine. `dir` = direction of ASCENT. */
export interface ExitSpec {
  at: [number, number]; // bottom center, on the mezz floor
  dir: 'x+' | 'x-' | 'z+' | 'z-';
}

/** A flat walkable area: fare mezzanine or connecting corridor/passageway. */
export interface MezzSpec {
  rect: [number, number, number, number]; // world minX, minZ, maxX, maxZ
  y: number;
  fare?: FareSpec;
  exits?: ExitSpec[];
  /** Suppress the auto ceiling (e.g. under another floor that covers it). */
  openTop?: boolean;
}

/** Straight stair/escalator run between two levels. Authored from the TOP:
 *  walking DOWN heads along `dir`; the run lands `drop` lower. The builder
 *  carves the top floor, subdivides long drops with landings, and validates
 *  that the bottom lands on real floor. */
export interface StairSpec {
  top: [number, number]; // top-landing center (world)
  topY: number;
  drop: number;
  dir: 'x+' | 'x-' | 'z+' | 'z-';
  width?: number; // default 2.6
  kind?: 'stair' | 'escalator';
}

export interface ComplexSpec {
  complexId: string;
  name: string;
  /** GTFS ids resolved to this complex (all members of subway.json complex). */
  members: string[];
  groups: GroupSpec[];
  mezzes: MezzSpec[];
  stairs: StairSpec[];
}

// ---- frame helpers (quarter-turn local<->world transforms) ----------------

/** Unit vectors of a group's local axes in world space. */
export function groupAxes(rot: GroupSpec['rot']): { xa: [number, number]; za: [number, number] } {
  switch (rot) {
    case 0: return { xa: [1, 0], za: [0, 1] };
    case 90: return { xa: [0, 1], za: [-1, 0] };
    case 180: return { xa: [-1, 0], za: [0, -1] };
    default: return { xa: [0, -1], za: [1, 0] }; // 270
  }
}

export function groupToWorld(g: GroupSpec, lx: number, lz: number): [number, number] {
  const { xa, za } = groupAxes(g.rot);
  return [g.at[0] + lx * xa[0] + lz * za[0], g.at[1] + lx * xa[1] + lz * za[1]];
}

export function worldToGroup(g: GroupSpec, wx: number, wz: number): [number, number] {
  const dx = wx - g.at[0], dz = wz - g.at[1];
  const { xa, za } = groupAxes(g.rot);
  // axes are orthonormal: project onto them
  return [dx * xa[0] + dz * xa[1], dx * za[0] + dz * za[1]];
}

/** Axis-aligned world rect of a local rect (quarter turns keep AABBs exact). */
export function groupRectToWorld(
  g: GroupSpec, r: { minX: number; maxX: number; minZ: number; maxZ: number },
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const a = groupToWorld(g, r.minX, r.minZ);
  const b = groupToWorld(g, r.maxX, r.maxZ);
  return {
    minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]),
    minZ: Math.min(a[1], b[1]), maxZ: Math.max(a[1], b[1]),
  };
}
