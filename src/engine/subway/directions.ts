// Realistic platform direction labels.
//
// Convention: dirSign +1 = toward each route's northern/"last" terminal (the
// pipeline orders network stops south->north, and the scheduler + RideWorld use
// the same sign), -1 = toward the southern/"first" terminal. The old code slapped
// a single hardcoded "Uptown & The Bronx" / "Downtown & Brooklyn" on EVERY track,
// which is wrong for crosstown service — most glaringly the 42nd St Shuttle, which
// only runs Times Sq <-> Grand Central and never goes uptown, downtown, to the
// Bronx, or to Brooklyn.
//
// Per route: [ label heading toward the +1 (north/last) end, label toward -1 ].
// Numbered IRT lines are genuinely north-south. The lettered lines read
// uptown/downtown at their Manhattan platforms (MTA labels them that way too).
// Genuine crosstown routes get their real termini instead of a compass word.
const ROUTE_DIRS: Record<string, readonly [string, string]> = {
  '1': ['Uptown & The Bronx', 'Downtown & South Ferry'],
  '2': ['Uptown & The Bronx', 'Downtown & Brooklyn'],
  '3': ['Uptown & Harlem', 'Downtown & Brooklyn'],
  '4': ['Uptown & The Bronx', 'Downtown & Brooklyn'],
  '5': ['Uptown & The Bronx', 'Downtown & Brooklyn'],
  '6': ['Uptown & The Bronx', 'Downtown & Brooklyn Bridge'],
  // 7: Flushing line — crosstown. Verified against stop order: +1 (network
  // "last") rides toward 34 St–Hudson Yards (Manhattan west end); -1 rides toward
  // Grand Central and out to Queens/Flushing.
  '7': ['Manhattan & Hudson Yards', 'Queens & Flushing'],
  'A': ['Uptown & Inwood', 'Downtown & Brooklyn'],
  'B': ['Uptown & The Bronx', 'Downtown & Brooklyn'],
  'C': ['Uptown & 168 St', 'Downtown & Brooklyn'],
  'D': ['Uptown & The Bronx', 'Downtown & Brooklyn'],
  'E': ['Uptown & Queens', 'Downtown & World Trade Center'],
  'F': ['Uptown & Queens', 'Downtown & Brooklyn'],
  'M': ['Uptown & Queens', 'Downtown & Brooklyn'],
  'N': ['Uptown & Astoria', 'Downtown & Brooklyn'],
  'Q': ['Uptown & 96 St', 'Downtown & Brooklyn'],
  'R': ['Uptown & Queens', 'Downtown & Brooklyn'],
  'W': ['Uptown & Astoria', 'Downtown & Whitehall'],
  // J/Z: Broad St (Manhattan) out over the Williamsburg Bridge to Brooklyn/Jamaica.
  'J': ['Brooklyn & Jamaica', 'Manhattan & Broad St'],
  'Z': ['Brooklyn & Jamaica', 'Manhattan & Broad St'],
  // L: 14th St–Canarsie — crosstown, then Brooklyn. +1 (north) is Manhattan/8 Av;
  // -1 is Brooklyn/Canarsie.
  'L': ['Manhattan & 8 Av', 'Brooklyn & Canarsie'],
};

// Classic mixed-IRT sign, used when routes on a track disagree on a specific
// terminal (e.g. the 1's South Ferry vs the 2/3's Brooklyn).
const GENERIC: readonly [string, string] = ['Uptown & The Bronx', 'Downtown & Brooklyn'];

/** True when every route serving this platform is the 42nd St shuttle. */
export function isShuttle(routes: string[]): boolean {
  return routes.length > 0 && routes.every((r) => r === 'S');
}

/**
 * Full platform-sign direction label for a track (given the direction it serves
 * and the station it's in). The shuttle points at its single opposite terminal;
 * everything else uses the per-route table, falling back to the generic mixed
 * label when routes on the same track head to different places.
 */
export function directionLabel(routes: string[], dirSign: 1 | -1, stationName: string): string {
  if (isShuttle(routes)) {
    // 2-stop shuttle: both platforms point at the ONE opposite terminal, so
    // dirSign is irrelevant — pick by which end we're standing at.
    return /grand\s*central/i.test(stationName) ? 'Times Sq–42 St' : 'Grand Central–42 St';
  }
  const idx = dirSign === 1 ? 0 : 1;
  const labels = routes.map((r) => ROUTE_DIRS[r]?.[idx]).filter((s): s is string => !!s);
  if (labels.length === 0) return GENERIC[idx];
  const uniq = [...new Set(labels)];
  return uniq.length === 1 ? uniq[0] : GENERIC[idx];
}

/**
 * Combined label for a mezzanine stair-head that reaches BOTH directions of a
 * platform ("Uptown & Downtown" on a normal line; the shuttle's single
 * destination when it's the shuttle).
 */
export function bothDirectionsLabel(routes: string[], stationName: string): string {
  if (isShuttle(routes)) return directionLabel(routes, 1, stationName);
  return 'Uptown & Downtown';
}

/** Compact label for the board prompt ("Uptown", "Queens", "Grand Central–42 St"). */
export function boardLabel(routes: string[], dirSign: 1 | -1, stationName: string): string {
  return directionLabel(routes, dirSign, stationName).split(' & ')[0];
}
