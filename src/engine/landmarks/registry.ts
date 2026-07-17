import { lonLatToXZ } from '../geo';

/**
 * Every landmark the world gives premium treatment, keyed by a stable id.
 *
 * - `set` names the module chunk in ./sets/ that builds it; sets are
 *   dynamic-imported ONLY when the player first comes within `r` meters of
 *   one of their landmarks, so distant districts cost zero bytes and zero
 *   triangles until approached.
 * - `r` is the activation radius (build inside, dispose beyond r + 150).
 *   Tall crowns get big radii — you can see a spire from across town for
 *   the price of a few hundred triangles.
 * - `rot` orients the kit: Manhattan's grid runs ~29 degrees east of north,
 *   which is rotation.y ~= 0.507 for an avenue-facing front (+z toward the
 *   south-east avenue side). Downtown's colonial streets get bespoke values.
 * - `aliasOf` marks entries that are the same physical build as another
 *   (e.g. "Top of the Rock" is 30 Rock's crown) — listed for completeness,
 *   never built twice.
 * - `alwaysOn` places once at init and never disposes (the Statue of
 *   Liberty must hold the harbor horizon from The Battery).
 */
export interface LandmarkEntry {
  id: string;
  name: string;
  lat: number;
  lon: number;
  set: string;
  r: number;
  rot?: number;
  aliasOf?: string;
  alwaysOn?: boolean;
  needsRoads?: boolean; // defer build until road tiles load, then nudge props out of roadbeds (Times Square masts)
}

const GRID = 0.507; // Manhattan street-grid rotation (radians)

export const LANDMARKS_REG: LandmarkEntry[] = [
  // ---- financial district / battery ----
  { id: 'one-wtc', name: 'One World Trade Center', lat: 40.7127, lon: -74.0134, set: 'fidi', r: 1400 },
  { id: 'sept11-museum', name: '9/11 Memorial Museum', lat: 40.7115, lon: -74.0125, set: 'fidi', r: 450 },
  { id: 'sept11-pools', name: 'September 11 Memorial Pools', lat: 40.7118, lon: -74.0133, set: 'fidi', r: 500 },
  { id: 'oculus', name: 'Oculus', lat: 40.7115, lon: -74.0113, set: 'fidi', r: 600 },
  { id: 'nyse', name: 'New York Stock Exchange', lat: 40.7069, lon: -74.0113, set: 'fidi', r: 450, rot: 0.35 },
  { id: 'nyse-facade', name: 'NYSE Facade', lat: 40.7069, lon: -74.0113, set: 'fidi', r: 450, aliasOf: 'nyse' },
  { id: 'federal-hall', name: 'Federal Hall', lat: 40.7074, lon: -74.0102, set: 'fidi', r: 420, rot: -1.22 },
  { id: 'trinity-church', name: 'Trinity Church', lat: 40.7081, lon: -74.0121, set: 'fidi', r: 700, rot: 1.62 },
  { id: 'charging-bull', name: 'Charging Bull', lat: 40.7056, lon: -74.0134, set: 'fidi', r: 350, rot: 0.4 },
  { id: 'fearless-girl', name: 'Fearless Girl', lat: 40.7066, lon: -74.0111, set: 'fidi', r: 350, rot: -1.2 },
  { id: 'bowling-green', name: 'Bowling Green', lat: 40.7048, lon: -74.0138, set: 'fidi', r: 380 },
  { id: 'castle-clinton', name: 'Castle Clinton', lat: 40.7033, lon: -74.017, set: 'fidi', r: 450 },
  { id: 'battery-waterfront', name: 'The Battery Waterfront', lat: 40.7017, lon: -74.0158, set: 'fidi', r: 500, rot: 0.9 },
  { id: 'liberty-view', name: 'Statue of Liberty Viewpoint', lat: 40.7023, lon: -74.0154, set: 'fidi', r: 500, aliasOf: 'battery-waterfront' },
  { id: 'liberty-statue', name: 'Statue of Liberty', lat: 40.6892, lon: -74.0445, set: 'fidi', r: 99999, alwaysOn: true, rot: 0.9 },
  { id: 'whitehall-terminal', name: 'Staten Island Ferry Terminal', lat: 40.7013, lon: -74.0131, set: 'fidi', r: 450, rot: 0.25 },
  { id: 'fraunces-tavern', name: 'Fraunces Tavern', lat: 40.7034, lon: -74.0113, set: 'fidi', r: 350, rot: 0.6 },
  { id: 'seaport', name: 'South Street Seaport', lat: 40.7063, lon: -74.0035, set: 'fidi', r: 550, rot: -0.75 },

  // ---- civic center / chinatown / bridges ----
  { id: 'city-hall', name: 'New York City Hall', lat: 40.7128, lon: -74.006, set: 'civic', r: 500, rot: 0.3 },
  { id: 'woolworth', name: 'Woolworth Building', lat: 40.7124, lon: -74.0083, set: 'civic', r: 1200, rot: 0.28 },
  { id: 'municipal-building', name: 'Manhattan Municipal Building', lat: 40.7127, lon: -74.0041, set: 'civic', r: 900, rot: 0.5 },
  { id: 'foley-square', name: 'Supreme Court & Foley Square', lat: 40.7143, lon: -74.0018, set: 'civic', r: 450, rot: -1.05 },
  { id: 'african-burial-ground', name: 'African Burial Ground', lat: 40.7147, lon: -74.0043, set: 'civic', r: 350, rot: 0.3 },
  { id: 'chinatown-gate', name: 'Chinatown', lat: 40.7157, lon: -73.997, set: 'civic', r: 420, rot: -0.62 },
  { id: 'little-italy', name: 'Little Italy', lat: 40.7191, lon: -73.9973, set: 'civic', r: 380, rot: 0.05 },
  { id: 'brooklyn-bridge', name: 'Brooklyn Bridge', lat: 40.7069, lon: -73.9987, set: 'civic', r: 1700, rot: -1.12 },
  { id: 'manhattan-bridge', name: 'Manhattan Bridge', lat: 40.7095, lon: -73.991, set: 'civic', r: 1700, rot: -0.95 },
  { id: 'williamsburg-bridge', name: 'Williamsburg Bridge', lat: 40.7143, lon: -73.9745, set: 'civic', r: 1600, rot: -1.35 },

  // ---- village / chelsea / hudson yards ----
  { id: 'washington-arch', name: 'Washington Square Arch', lat: 40.7314, lon: -73.9971, set: 'village', r: 500, rot: 0.05 },
  { id: 'stonewall', name: 'Stonewall National Monument', lat: 40.7338, lon: -74.0021, set: 'village', r: 350, rot: 1.0 },
  { id: 'flatiron', name: 'Flatiron Building', lat: 40.7411, lon: -73.9897, set: 'village', r: 800, rot: GRID },
  { id: 'union-square', name: 'Union Square', lat: 40.7359, lon: -73.9906, set: 'village', r: 450, rot: GRID },
  { id: 'madison-sq-park', name: 'Madison Square Park', lat: 40.742, lon: -73.988, set: 'village', r: 400, rot: GRID },
  { id: 'high-line', name: 'The High Line', lat: 40.7391, lon: -74.008, set: 'village', r: 500, rot: GRID },
  { id: 'whitney', name: 'Whitney Museum', lat: 40.7397, lon: -74.0089, set: 'village', r: 450, rot: GRID },
  { id: 'chelsea-market', name: 'Chelsea Market', lat: 40.7425, lon: -74.0053, set: 'village', r: 400, rot: GRID },
  { id: 'little-island', name: 'Little Island', lat: 40.742, lon: -74.01, set: 'village', r: 700, rot: GRID },
  { id: 'vessel', name: 'The Vessel', lat: 40.7538, lon: -74.0022, set: 'village', r: 800, rot: GRID },
  { id: 'hudson-yards', name: 'Hudson Yards', lat: 40.7536, lon: -74.0011, set: 'village', r: 600, rot: GRID, aliasOf: 'vessel' },
  { id: 'edge-deck', name: 'Edge Observation Deck', lat: 40.7539, lon: -74.0006, set: 'village', r: 1200, rot: GRID },

  // ---- midtown south ----
  { id: 'empire-state', name: 'Empire State Building', lat: 40.7484, lon: -73.9857, set: 'midtown-south', r: 1500, rot: GRID },
  { id: 'nypl', name: 'New York Public Library', lat: 40.7531, lon: -73.9815, set: 'midtown-south', r: 500, rot: GRID },
  { id: 'bryant-park', name: 'Bryant Park', lat: 40.7536, lon: -73.9832, set: 'midtown-south', r: 450, rot: GRID },
  { id: 'msg', name: 'Madison Square Garden', lat: 40.7505, lon: -73.9934, set: 'midtown-south', r: 600, rot: GRID },
  { id: 'times-square', name: 'Times Square', lat: 40.758, lon: -73.9855, set: 'midtown-south', r: 650, rot: GRID, needsRoads: true },
  { id: 'broadway-theaters', name: 'Broadway Theater District', lat: 40.759, lon: -73.9845, set: 'midtown-south', r: 500, rot: GRID },

  // ---- midtown core (rockefeller / fifth ave) ----
  { id: 'rockefeller-plaza', name: 'Rockefeller Plaza', lat: 40.7587, lon: -73.9787, set: 'midtown-core', r: 550, rot: GRID },
  { id: 'prometheus', name: 'Prometheus Statue', lat: 40.7587, lon: -73.9787, set: 'midtown-core', r: 550, aliasOf: 'rockefeller-plaza' },
  { id: 'atlas', name: 'Atlas Statue', lat: 40.7588, lon: -73.9776, set: 'midtown-core', r: 400, rot: GRID },
  { id: 'top-of-the-rock', name: 'Top of the Rock', lat: 40.7591, lon: -73.9794, set: 'midtown-core', r: 1300, rot: GRID },
  { id: 'st-patricks', name: "St. Patrick's Cathedral", lat: 40.7585, lon: -73.976, set: 'midtown-core', r: 700, rot: GRID },
  { id: 'radio-city', name: 'Radio City Music Hall', lat: 40.7599, lon: -73.9801, set: 'midtown-core', r: 500, rot: GRID },
  { id: 'moma', name: 'Museum of Modern Art', lat: 40.7616, lon: -73.9774, set: 'midtown-core', r: 400, rot: GRID },
  { id: 'love-sculpture', name: 'LOVE Sculpture Site', lat: 40.7629, lon: -73.9779, set: 'midtown-core', r: 350, rot: GRID },
  { id: 'carnegie-hall', name: 'Carnegie Hall', lat: 40.7651, lon: -73.9799, set: 'midtown-core', r: 450, rot: GRID },
  { id: 'fifth-avenue', name: 'Fifth Avenue', lat: 40.759, lon: -73.9773, set: 'midtown-core', r: 500, rot: GRID },

  // ---- midtown east ----
  { id: 'grand-central', name: 'Grand Central Terminal', lat: 40.7519, lon: -73.9772, set: 'midtown-east', r: 600, rot: GRID },
  { id: 'chrysler', name: 'Chrysler Building', lat: 40.7516, lon: -73.9755, set: 'midtown-east', r: 1500, rot: GRID },
  { id: 'one-vanderbilt', name: 'One Vanderbilt', lat: 40.7529, lon: -73.9787, set: 'midtown-east', r: 1400, rot: GRID },
  { id: 'summit-1v', name: 'Summit One Vanderbilt', lat: 40.7529, lon: -73.9787, set: 'midtown-east', r: 1400, aliasOf: 'one-vanderbilt' },
  { id: 'united-nations', name: 'United Nations Headquarters', lat: 40.749, lon: -73.968, set: 'midtown-east', r: 800, rot: 0 },
  { id: 'roosevelt-tram', name: 'Roosevelt Island Tramway', lat: 40.7615, lon: -73.9642, set: 'midtown-east', r: 700, rot: GRID },
  { id: 'queensboro-bridge', name: 'Ed Koch Queensboro Bridge', lat: 40.7595, lon: -73.9605, set: 'midtown-east', r: 1500, rot: GRID },

  // ---- uptown west (columbus circle -> UWS) + UES museums ----
  { id: 'columbus-circle', name: 'Columbus Circle', lat: 40.768, lon: -73.9819, set: 'uptown', r: 550, rot: GRID },
  { id: 'hearst-tower', name: 'Hearst Tower', lat: 40.7666, lon: -73.9836, set: 'uptown', r: 900, rot: GRID },
  { id: 'plaza-hotel', name: 'The Plaza Hotel', lat: 40.7644, lon: -73.9745, set: 'uptown', r: 550, rot: GRID },
  { id: 'pulitzer-fountain', name: 'Pulitzer Fountain', lat: 40.764, lon: -73.9737, set: 'uptown', r: 400, rot: GRID },
  { id: 'lincoln-center', name: 'Lincoln Center', lat: 40.7727, lon: -73.9829, set: 'uptown', r: 550, rot: GRID },
  { id: 'met-opera', name: 'Metropolitan Opera House', lat: 40.7728, lon: -73.9843, set: 'uptown', r: 550, aliasOf: 'lincoln-center' },
  { id: 'dakota', name: 'The Dakota', lat: 40.7765, lon: -73.9761, set: 'uptown', r: 450, rot: GRID },
  { id: 'amnh', name: 'American Museum of Natural History', lat: 40.7808, lon: -73.973, set: 'uptown', r: 600, rot: GRID },
  { id: 'met-museum', name: 'Metropolitan Museum of Art', lat: 40.7794, lon: -73.9626, set: 'uptown', r: 600, rot: GRID },
  { id: 'guggenheim', name: 'Guggenheim Museum', lat: 40.783, lon: -73.959, set: 'uptown', r: 550, rot: GRID },
  { id: 'intrepid', name: 'Intrepid Museum', lat: 40.7648, lon: -74.0005, set: 'uptown', r: 900, rot: GRID },

  // ---- central park ----
  { id: 'central-park', name: 'Central Park (Merchants Gate)', lat: 40.7677, lon: -73.9812, set: 'park', r: 450, rot: GRID },
  { id: 'bethesda', name: 'Bethesda Terrace & Fountain', lat: 40.774, lon: -73.9708, set: 'park', r: 500, rot: GRID },
  { id: 'bow-bridge', name: 'Bow Bridge', lat: 40.7757, lon: -73.9718, set: 'park', r: 450, rot: 1.1 },
  { id: 'belvedere', name: 'Belvedere Castle', lat: 40.7794, lon: -73.9692, set: 'park', r: 600, rot: GRID },
  { id: 'strawberry-fields', name: 'Strawberry Fields', lat: 40.7756, lon: -73.9745, set: 'park', r: 380, rot: GRID },
  { id: 'cp-reservoir', name: 'Central Park Reservoir', lat: 40.785, lon: -73.966, set: 'park', r: 500, rot: GRID },
  { id: 'cp-zoo', name: 'Central Park Zoo', lat: 40.7678, lon: -73.9718, set: 'park', r: 420, rot: GRID },
  { id: 'the-mall', name: 'The Mall & Literary Walk', lat: 40.7723, lon: -73.9714, set: 'park', r: 450, rot: -0.06 },
  { id: 'tavern-green', name: 'Tavern on the Green', lat: 40.7722, lon: -73.978, set: 'park', r: 400, rot: GRID },
  { id: 'alice', name: 'Alice in Wonderland', lat: 40.775, lon: -73.9668, set: 'park', r: 380, rot: GRID },
  { id: 'conservatory-garden', name: 'Conservatory Garden', lat: 40.7937, lon: -73.9527, set: 'park', r: 450, rot: GRID },
  { id: 'harlem-meer', name: 'Harlem Meer', lat: 40.7966, lon: -73.952, set: 'park', r: 420, rot: GRID },

  // ---- heights (morningside / harlem / washington heights / inwood) ----
  { id: 'apollo', name: 'Apollo Theater', lat: 40.8101, lon: -73.9499, set: 'heights', r: 450, rot: GRID },
  { id: 'st-john-divine', name: 'Cathedral of St. John the Divine', lat: 40.8038, lon: -73.9619, set: 'heights', r: 700, rot: GRID },
  { id: 'columbia', name: 'Columbia University — Low Library', lat: 40.8081, lon: -73.9619, set: 'heights', r: 550, rot: GRID },
  { id: 'riverside-church', name: 'Riverside Church', lat: 40.8119, lon: -73.9633, set: 'heights', r: 900, rot: GRID },
  { id: 'grants-tomb', name: "Grant's Tomb", lat: 40.8134, lon: -73.963, set: 'heights', r: 550, rot: GRID },
  { id: 'grant-plaza', name: 'General Grant Memorial Plaza', lat: 40.8134, lon: -73.963, set: 'heights', r: 550, aliasOf: 'grants-tomb' },
  { id: 'riverside-park', name: 'Riverside Park', lat: 40.785, lon: -73.9838, set: 'heights', r: 400, rot: GRID },
  { id: 'hamilton-grange', name: 'Hamilton Grange', lat: 40.8214, lon: -73.9469, set: 'heights', r: 400, rot: GRID },
  { id: 'morris-jumel', name: 'Morris-Jumel Mansion', lat: 40.8345, lon: -73.9386, set: 'heights', r: 400, rot: GRID },
  { id: 'dyckman-farmhouse', name: 'Dyckman Farmhouse', lat: 40.8668, lon: -73.9229, set: 'heights', r: 380, rot: GRID },
  { id: 'cloisters', name: 'The Cloisters', lat: 40.8649, lon: -73.9317, set: 'heights', r: 700, rot: 0.2 },
  { id: 'fort-tryon', name: 'Fort Tryon Park', lat: 40.8593, lon: -73.9327, set: 'heights', r: 420, rot: 0.2 },
  { id: 'inwood-hill', name: 'Inwood Hill Park', lat: 40.8712, lon: -73.9243, set: 'heights', r: 420, rot: 0 },
  { id: 'fort-washington-park', name: 'Fort Washington Park', lat: 40.8451, lon: -73.9436, set: 'heights', r: 400, rot: 0.2 },
  { id: 'gwb', name: 'George Washington Bridge', lat: 40.8505, lon: -73.9469, set: 'heights', r: 2000, rot: 1.02 },
  { id: 'little-red-lighthouse', name: 'Little Red Lighthouse', lat: 40.8499, lon: -73.9471, set: 'heights', r: 600, rot: 0.2 },
];

export interface Landmark extends LandmarkEntry {
  x: number;
  z: number;
}

/** Registry with world coordinates baked, aliases resolved out of placement. */
export const LANDMARKS_PLACED: Landmark[] = LANDMARKS_REG
  .filter((e) => !e.aliasOf)
  .map((e) => {
    const [x, z] = lonLatToXZ(e.lon, e.lat);
    return { ...e, x, z };
  });
