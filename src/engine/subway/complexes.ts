// Bespoke station-complex layouts, authored from the Project Subway NYC
// axonometric drawings (projectsubwaynyc.com/gallery) so the walkable interiors
// reflect the real stations: platform arrangements, per-track service
// (local/express per direction; right-hand running — a group's dir:+1 tracks
// sit on its local +z side), stacked levels, mezzanines, fare control and the
// transfer corridors between lines. Coordinates are complex-local meters.
//
// Authoring rules the builder relies on (learned the hard way):
// - A mezz/corridor slab may cross OVER a group box only when its floor sits
//   above that box's walls (g.y + 5.4), or it is that group's own over-platform
//   mezzanine (stairs bridge through the carved ceiling).
// - Island platforms are reached ONLY from above (stairs from a mezz); side
//   platforms may also be entered at grade through their outer wall (the
//   builder opens group walls where a same-level mezz rect meets them).
// - Stair/escalator runs must never cross a track at train height (top of car
//   ≈ rail + 3.65); route them through platform bands, outside boxes, or high
//   above walls.
// - Terminal groups (stubEnd) list every track with the DEPARTING direction.
//
// ComplexStationWorld builds these; complexFor() is the runtime lookup — any
// member id resolves to its complex, so entering through any entrance of e.g.
// Times Sq builds the whole multi-line complex. Stations whose drawing omits a
// leg (A/C/E at Times Sq, R/W Cortlandt at WTC) keep their generic worlds.
import type { ComplexSpec } from './complextypes';

const YELLOW = '#FCCC0A'; // Broadway (BMT)
const ORANGE = '#FF6319'; // 6th Av (IND)
const BLUE = '#0039A6'; // 8th Av (IND)
const RED = '#EE352E'; // Broadway–7th Av (IRT)
const GREEN = '#00933C'; // Lexington (IRT)
const PURPLE = '#B933AD'; // Flushing (IRT)
const LGREY = '#A7A9AC'; // Canarsie (BMT)
const BROWN = '#996633'; // Nassau (BMT)
const SLATE = '#808183'; // shuttles

export const COMPLEXES: ComplexSpec[] = [
  // ---- 47-50 Sts–Rockefeller Ctr (B D F M) --------------------------------
  // Near-full-length mezzanine over a dual-island IND station; fare banks at
  // both ends (Rockefeller concourse passages), stair pairs along both islands.
  {
    complexId: '225',
    name: '47-50 Sts-Rockefeller Ctr',
    members: ['D15'],
    groups: [
      {
        id: 'D15', name: '47-50 Sts-Rockefeller Ctr', routes: ['B', 'D', 'F', 'M'],
        division: 'IND', bandColor: ORANGE, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['F', 'M'], dir: -1 },
          { routes: ['B', 'D'], dir: -1 },
          { routes: ['B', 'D'], dir: 1 },
          { routes: ['F', 'M'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      {
        rect: [-70, -14, 0, 14], y: 6,
        fare: { cross: 'x', at: -55, paidSign: 1 },
        exits: [{ at: [-64, -8], dir: 'x-' }, { at: [-64, 8], dir: 'x-' }],
      },
      {
        rect: [0, -14, 70, 14], y: 6,
        fare: { cross: 'x', at: 55, paidSign: -1 },
        exits: [{ at: [64, -8], dir: 'x+' }, { at: [64, 8], dir: 'x+' }],
      },
    ],
    stairs: [
      { top: [-45, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [-45, 7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [-20, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-20, 7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [20, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [20, 7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [45, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [45, 7.15], topY: 6, drop: 6, dir: 'x+' },
    ],
  },

  // ---- Times Sq–42 St (1 2 3 · N Q R W · 7 · S) ---------------------------
  // The drawing omits the 8th Av (A C E) leg, so A27 keeps its generic world.
  // IRT 7th Av spine (locals out, express in), BMT Broadway a step deeper to
  // the east, the 7 crossing deepest, the shuttle stub at the north-east.
  {
    complexId: '611',
    name: 'Times Sq-42 St',
    members: ['127', '725', 'R16', '902'],
    groups: [
      {
        id: '127', name: 'Times Sq-42 St', routes: ['1', '2', '3'],
        division: 'IRT', bandColor: RED, type: 'dual-island', length: 156,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['1'], dir: -1 },
          { routes: ['2', '3'], dir: -1 },
          { routes: ['2', '3'], dir: 1 },
          { routes: ['1'], dir: 1 },
        ],
      },
      {
        id: 'R16', name: 'Times Sq-42 St', routes: ['N', 'Q', 'R', 'W'],
        division: 'BMT', bandColor: YELLOW, type: 'dual-island', length: 183,
        y: -5, rot: 0, at: [-12, 32],
        tracks: [
          { routes: ['R', 'W'], dir: -1 },
          { routes: ['N', 'Q'], dir: -1 },
          { routes: ['N', 'Q'], dir: 1 },
          { routes: ['R', 'W'], dir: 1 },
        ],
      },
      {
        id: '725', name: 'Times Sq-42 St', routes: ['7'],
        division: 'IRT', bandColor: PURPLE, type: 'island', length: 156,
        y: -13, rot: 270, at: [-35, 12],
        tracks: [{ routes: ['7'], dir: -1 }, { routes: ['7'], dir: 1 }],
      },
      {
        id: '902', name: 'Times Sq-42 St', routes: ['S'],
        division: 'IRT', bandColor: SLATE, type: 'island', length: 90,
        y: 0, rot: 270, at: [35, 50], stubEnd: 1,
        tracks: [{ routes: ['S'], dir: -1 }, { routes: ['S'], dir: -1 }],
      },
    ],
    mezzes: [
      // 42 St north mezz over the IRT head, fare toward the 7th Av stairs
      // (line sits clear south of the platform stair holes)
      {
        rect: [28, -16, 50, 8], y: 6,
        fare: { cross: 'z', at: -9.5, paidSign: 1 },
        exits: [{ at: [33, -11], dir: 'z-' }, { at: [45, -11], dir: 'z-' }],
      },
      // shuttle wing east of it, its own fare toward 42/Broadway
      {
        rect: [28, 8, 50, 60], y: 6,
        fare: { cross: 'z', at: 55, paidSign: -1 },
        exits: [{ at: [40, 57], dir: 'z+' }],
      },
      // central 41 St mezzanine over the IRT (fare at 41/Bdwy)
      {
        rect: [-25, -12, 5, 16], y: 6,
        fare: { cross: 'x', at: -20, paidSign: 1 },
        exits: [{ at: [-23, -6], dir: 'x-' }],
      },
      // lower BMT mezzanine (fare at 41/Broadway east corners), reaching west
      // over the 7's box to the head of the 7 stairs. The fare line crosses x
      // on the east flank so the BMT islands AND the 7 route stay inside fare
      // control, with an unpaid lobby under the Broadway corners.
      {
        rect: [-40, 20, 14, 54], y: 1,
        fare: { cross: 'x', at: 6, paidSign: -1 },
        exits: [{ at: [9, 30], dir: 'x+' }, { at: [9, 44], dir: 'x+' }],
      },
      // the 7's own mezzanine over its island, north of the BMT box
      { rect: [-42, 50, -28, 78], y: -7 },
    ],
    stairs: [
      // IRT islands from the three mezzanines
      { top: [40, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [40, 7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-15, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [-15, 7.15], topY: 6, drop: 6, dir: 'x-' },
      // central mezz -> BMT mezz cascade
      { top: [3, 13.5], topY: 6, drop: 5, dir: 'z+' },
      // BMT mezz -> BMT islands
      { top: [-15, 24.85], topY: 1, drop: 6, dir: 'x-' },
      { top: [-15, 39.15], topY: 1, drop: 6, dir: 'x-' },
      { top: [-5, 24.85], topY: 1, drop: 6, dir: 'x+' },
      { top: [-5, 39.15], topY: 1, drop: 6, dir: 'x+' },
      // BMT mezz -> 7 mezz: drops just past the BMT's outer track, then the
      // 7 mezz reaches the island inside its own platform band
      { top: [-35, 46.4], topY: 1, drop: 8, dir: 'z+' },
      { top: [-35, 62], topY: -7, drop: 6, dir: 'z+' },
      { top: [-35, 74], topY: -7, drop: 6, dir: 'z+' },
      // shuttle wing -> shuttle island
      { top: [35, 12], topY: 6, drop: 6, dir: 'z+' },
    ],
  },

  // ---- Grand Central–42 St (4 5 6 · 7 · S) --------------------------------
  // Lexington dual-island spine; the 7 crossing deep under 42 St; the shuttle
  // at mezzanine level on the west wing, bumpers right at the concourse.
  {
    complexId: '610',
    name: 'Grand Central-42 St',
    members: ['631', '723', '901'],
    groups: [
      {
        id: '631', name: 'Grand Central-42 St', routes: ['4', '5', '6'],
        division: 'IRT', bandColor: GREEN, type: 'dual-island', length: 156,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['6'], dir: -1 },
          { routes: ['4', '5'], dir: -1 },
          { routes: ['4', '5'], dir: 1 },
          { routes: ['6'], dir: 1 },
        ],
      },
      {
        id: '723', name: 'Grand Central-42 St', routes: ['7'],
        division: 'IRT', bandColor: PURPLE, type: 'island', length: 156,
        y: -15, rot: 270, at: [-30, 10],
        tracks: [{ routes: ['7'], dir: -1 }, { routes: ['7'], dir: 1 }],
      },
      {
        id: '901', name: 'Grand Central-42 St', routes: ['S'],
        division: 'IRT', bandColor: SLATE, type: 'side', length: 90,
        y: 6, rot: 270, at: [25, -35], stubEnd: -1,
        tracks: [{ routes: ['S'], dir: 1 }, { routes: ['S'], dir: 1 }],
      },
    ],
    mezzes: [
      // main concourse mezzanine west of the shuttle platforms (walk straight
      // onto the shuttle — it sits at concourse level; the 2cm step keeps the
      // abutting slabs from z-fighting). The fare line crosses z on the SOUTH
      // flank so the 4/5/6 stairs, the shuttle head, AND the 7 escalator all
      // sit inside fare control; exits drop off the unpaid south strip.
      {
        rect: [-35, -20, 16.4, 20], y: 5.98,
        fare: { cross: 'z', at: -14, paidSign: 1 },
        exits: [{ at: [-20, -15.4], dir: 'z-' }, { at: [10, -15.4], dir: 'z-' }],
      },
      // east concourse strip past the shuttle bumpers, gated toward its own
      // 42 St street stair (paid side faces the main concourse so the shared
      // opening connects paid-to-paid)
      {
        rect: [16.4, 9.65, 40, 20], y: 5.98,
        fare: { cross: 'x', at: 24, paidSign: -1 },
        exits: [{ at: [30, 17], dir: 'z+' }],
      },
      // deep mezzanine at the 7's east end (Lex/3rd Av escalator landing),
      // with its own fare bank at the street stair
      {
        rect: [-38, 34, -22, 78], y: -9,
        fare: { cross: 'z', at: 70, paidSign: -1 },
        exits: [{ at: [-34, 74], dir: 'z+' }],
      },
    ],
    stairs: [
      { top: [-20, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [-20, 7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [8, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [8, 7.15], topY: 6, drop: 6, dir: 'x+' },
      // long escalator run: main concourse down to the 7's mezzanine
      { top: [-30, 19], topY: 6, drop: 15, dir: 'z+', kind: 'escalator' },
      // 7 mezz -> 7 island (clear of the escalator's landing, inside fare)
      { top: [-30, 58], topY: -9, drop: 6, dir: 'z-' },
      { top: [-30, 66], topY: -9, drop: 6, dir: 'z+' },
    ],
  },

  // ---- 34 St–Herald Sq (B D F M · N Q R W) --------------------------------
  // Parallel two-level pair: BMT Broadway shallow on the east, IND 6th Av
  // deeper on the west; 34 St mezzanine + 32 St corridor tie them together.
  {
    complexId: '607',
    name: '34 St-Herald Sq',
    members: ['D17', 'R17'],
    groups: [
      {
        id: 'D17', name: '34 St-Herald Sq', routes: ['B', 'D', 'F', 'M'],
        division: 'IND', bandColor: ORANGE, type: 'dual-island', length: 183,
        y: -7, rot: 0, at: [0, -15],
        tracks: [
          { routes: ['F', 'M'], dir: -1 },
          { routes: ['B', 'D'], dir: -1 },
          { routes: ['B', 'D'], dir: 1 },
          { routes: ['F', 'M'], dir: 1 },
        ],
      },
      {
        id: 'R17', name: '34 St-Herald Sq', routes: ['N', 'Q', 'R', 'W'],
        division: 'BMT', bandColor: YELLOW, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [-10, 15],
        tracks: [
          { routes: ['R', 'W'], dir: -1 },
          { routes: ['N', 'Q'], dir: -1 },
          { routes: ['N', 'Q'], dir: 1 },
          { routes: ['R', 'W'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      // 34 St main mezzanine spanning both boxes
      {
        rect: [6, -30, 30, 30], y: 6,
        fare: { cross: 'x', at: 14, paidSign: 1 },
        exits: [{ at: [12, -25], dir: 'x-' }, { at: [12, 25], dir: 'x-' }],
      },
      // 35 St north corridor over the IND head
      {
        rect: [30, -30, 45, -2], y: 6,
        fare: { cross: 'z', at: -6, paidSign: -1 },
        exits: [{ at: [35, -4], dir: 'z+' }],
      },
      // 32 St south corridor
      {
        rect: [-45, -30, -30, 30], y: 6,
        fare: { cross: 'z', at: -26, paidSign: 1 },
        exits: [{ at: [-38, -28], dir: 'z-' }],
      },
    ],
    stairs: [
      // main mezz -> IND islands (deep wedges) and BMT islands
      { top: [20, -22.15], topY: 6, drop: 13, dir: 'x-' },
      { top: [20, -7.85], topY: 6, drop: 13, dir: 'x-' },
      { top: [20, 7.85], topY: 6, drop: 6, dir: 'x-' },
      { top: [20, 22.15], topY: 6, drop: 6, dir: 'x-' },
      // north corridor -> IND heads
      { top: [38, -22.15], topY: 6, drop: 13, dir: 'x+' },
      { top: [38, -7.85], topY: 6, drop: 13, dir: 'x+' },
      // south corridor -> both
      { top: [-38, -22.15], topY: 6, drop: 13, dir: 'x+' },
      { top: [-38, -7.85], topY: 6, drop: 13, dir: 'x+' },
      { top: [-38, 7.85], topY: 6, drop: 6, dir: 'x+' },
      { top: [-38, 22.15], topY: 6, drop: 6, dir: 'x+' },
    ],
  },

  // ---- 23 St (R W) --------------------------------------------------------
  // Side platforms on the Broadway local tracks, N/Q express roaring through
  // the center pair; the only crossover is the north-end overpass mezzanine.
  {
    complexId: '14',
    name: '23 St',
    members: ['R19'],
    groups: [
      {
        id: 'R19', name: '23 St', routes: ['R', 'W'],
        division: 'BMT', bandColor: YELLOW, type: 'side', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['R', 'W'], dir: -1 },
          { routes: ['Q'], dir: -1, pass: true },
          { routes: ['N'], dir: 1, pass: true },
          { routes: ['R', 'W'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      {
        rect: [55, -16, 78, 16], y: 6,
        fare: { cross: 'x', at: 70, paidSign: -1 },
        exits: [{ at: [72, -8], dir: 'x+' }, { at: [72, 8], dir: 'x+' }],
      },
    ],
    stairs: [
      { top: [62, -11.05], topY: 6, drop: 6, dir: 'x-' },
      { top: [62, 11.05], topY: 6, drop: 6, dir: 'x-' },
    ],
  },

  // ---- 14 St–Union Sq (4 5 6 · N Q R W · L) -------------------------------
  // BMT under the park's west edge, Lexington to the southeast, the L sliding
  // under both along 14 St; mezzanines linked by the 14 St corridor.
  {
    complexId: '602',
    name: '14 St-Union Sq',
    members: ['R20', '635', 'L03'],
    groups: [
      {
        id: 'R20', name: '14 St-Union Sq', routes: ['N', 'Q', 'R', 'W'],
        division: 'BMT', bandColor: YELLOW, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [15, -20],
        tracks: [
          { routes: ['R', 'W'], dir: -1 },
          { routes: ['N', 'Q'], dir: -1 },
          { routes: ['N', 'Q'], dir: 1 },
          { routes: ['R', 'W'], dir: 1 },
        ],
      },
      {
        id: '635', name: '14 St-Union Sq', routes: ['4', '5', '6'],
        division: 'IRT', bandColor: GREEN, type: 'dual-island', length: 156,
        y: 0, rot: 0, at: [-15, 20],
        tracks: [
          { routes: ['6'], dir: -1 },
          { routes: ['4', '5'], dir: -1 },
          { routes: ['4', '5'], dir: 1 },
          { routes: ['6'], dir: 1 },
        ],
      },
      {
        id: 'L03', name: '14 St-Union Sq', routes: ['L'],
        division: 'BMT', bandColor: LGREY, type: 'island', length: 183,
        y: -8, rot: 270, at: [-40, 0],
        tracks: [{ routes: ['L'], dir: -1 }, { routes: ['L'], dir: 1 }],
      },
    ],
    mezzes: [
      // BMT mezzanine (16 St / Union Sq West fare)
      {
        rect: [0, -34, 35, -6], y: 6,
        fare: { cross: 'x', at: 30, paidSign: -1 },
        exits: [{ at: [32, -28], dir: 'x+' }, { at: [32, -12], dir: 'x+' }],
      },
      // Lexington mezzanine (Union Sq East fare)
      {
        rect: [-30, 6, 5, 34], y: 6,
        fare: { cross: 'x', at: 0, paidSign: -1 },
        exits: [{ at: [2, 10], dir: 'x+' }, { at: [2, 30], dir: 'x+' }],
      },
      // 14 St connector between the two, with a west arm toward the L
      { rect: [-16, -6, 10, 6], y: 6 },
      { rect: [-42, -6, -16, 6], y: 6 },
      // the L's own mezzanine over its island, in the clear lane between the
      // two big boxes — its stairs duck UNDER the Lex and BMT stations
      { rect: [-46, -5, -30, 5], y: -2 },
    ],
    stairs: [
      // BMT islands (pairs descend AWAY from each other)
      { top: [15, -27.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [15, -12.85], topY: 6, drop: 6, dir: 'x+' },
      { top: [8, -27.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [8, -12.85], topY: 6, drop: 6, dir: 'x-' },
      // Lexington islands
      { top: [-15, 12.85], topY: 6, drop: 6, dir: 'x+' },
      { top: [-15, 27.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-22, 12.85], topY: 6, drop: 6, dir: 'x-' },
      { top: [-22, 27.15], topY: 6, drop: 6, dir: 'x-' },
      // west arm -> L mezzanine (stays high while over the L's tracks)
      { top: [-30.5, 0], topY: 6, drop: 8, dir: 'x-' },
      // L mezz -> island: flights passing UNDER the Lex / BMT boxes inside
      // the island's own band
      { top: [-40, 2], topY: -2, drop: 6, dir: 'z+' },
      { top: [-40, -2], topY: -2, drop: 6, dir: 'z-' },
    ],
  },

  // ---- Fulton St (4 5 · A C · J Z · 2 3) ----------------------------------
  // West-to-east descending chain: 4/5 island under Broadway (Fulton Center),
  // J/Z island, the A/C island crossing under Fulton St with its long
  // mezzanine, and the 2/3 side platforms under William St deepest.
  {
    complexId: '628',
    name: 'Fulton St',
    members: ['418', '229', 'A38', 'M22'],
    groups: [
      {
        id: '418', name: 'Fulton St', routes: ['4', '5'],
        division: 'IRT', bandColor: GREEN, type: 'island', length: 156,
        y: 0, rot: 0, at: [-15, -30],
        tracks: [{ routes: ['4', '5'], dir: -1 }, { routes: ['4', '5'], dir: 1 }],
      },
      {
        id: 'M22', name: 'Fulton St', routes: ['J', 'Z'],
        division: 'BMT', bandColor: BROWN, type: 'island', length: 183,
        y: -5, rot: 0, at: [10, 5],
        tracks: [{ routes: ['J', 'Z'], dir: -1 }, { routes: ['J', 'Z'], dir: 1 }],
      },
      {
        id: 'A38', name: 'Fulton St', routes: ['A', 'C'],
        division: 'IND', bandColor: BLUE, type: 'island', length: 183,
        y: -12, rot: 270, at: [25, -5],
        tracks: [{ routes: ['A', 'C'], dir: -1 }, { routes: ['A', 'C'], dir: 1 }],
      },
      {
        id: '229', name: 'Fulton St', routes: ['2', '3'],
        division: 'IRT', bandColor: RED, type: 'side', length: 156,
        y: -18, rot: 0, at: [40, -35],
        tracks: [{ routes: ['2', '3'], dir: -1 }, { routes: ['2', '3'], dir: 1 }],
      },
    ],
    mezzes: [
      // Fulton Center concourse over the 4/5
      {
        rect: [-30, -42, 10, -16], y: 6,
        fare: { cross: 'x', at: 6, paidSign: -1 },
        exits: [{ at: [8, -38], dir: 'x+' }, { at: [8, -24], dir: 'x+' }],
      },
      // J/Z overbridge mezz (its own fare at Fulton x Nassau)
      {
        rect: [0, -8, 15, 16], y: 1,
        fare: { cross: 'z', at: 10, paidSign: -1 },
        exits: [{ at: [7, 11.4], dir: 'z+' }],
      },
      // long A/C mezzanine south of the J/Z box
      { rect: [18, -60, 33.3, -4], y: -6 },
      // east arm toward William St over the 2/3 (fare + exit at Fulton/William)
      {
        rect: [33.5, -62, 56, -4], y: -6,
        fare: { cross: 'x', at: 48, paidSign: -1 },
        exits: [{ at: [50, -10], dir: 'x+' }],
      },
    ],
    stairs: [
      // concourse -> 4/5 island
      { top: [-12, -30], topY: 6, drop: 6, dir: 'x+' },
      { top: [-20, -30], topY: 6, drop: 6, dir: 'x-' },
      // concourse -> A/C mezzanine (escalator cascade under Fulton St, clear
      // of the 4/5 box on its north side, starting INSIDE fare control)
      { top: [4, -20], topY: 6, drop: 12, dir: 'x+', kind: 'escalator' },
      // J/Z bridge -> J/Z island; bridge -> A/C mezz link
      { top: [8, 5], topY: 1, drop: 6, dir: 'x+' },
      { top: [8, -6], topY: 1, drop: 7, dir: 'x+' },
      // A/C mezz -> A/C island (the north well descends away from the
      // concourse escalator's landing, ducking under the J/Z box)
      { top: [25, -45], topY: -6, drop: 6, dir: 'z+' },
      { top: [25, -8], topY: -6, drop: 6, dir: 'z+' },
      // east arm -> both 2/3 side platforms. The near platform is approached
      // ALONG its own band (a z-run would skim train roofs on the William St
      // tracks); the far one descends past the tracks at full depth.
      { top: [44, -28.35], topY: -6, drop: 12, dir: 'x+' },
      { top: [38, -60.4], topY: -6, drop: 12, dir: 'z+' },
    ],
  },

  // ---- W 4 St–Wash Sq (A C E over B D F M) --------------------------------
  // The stacked IND local/express boxes: A/C/E dual-island upper, B/D/F/M
  // dual-island lower extending further south; full mezzanine above, and the
  // deep south mezzanine reaching the lower level beyond the upper box.
  {
    complexId: '167',
    name: 'W 4 St-Wash Sq',
    members: ['A32', 'D20'],
    groups: [
      {
        id: 'A32', name: 'W 4 St-Wash Sq', routes: ['A', 'C', 'E'],
        division: 'IND', bandColor: BLUE, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['C', 'E'], dir: -1 },
          { routes: ['A'], dir: -1 },
          { routes: ['A'], dir: 1 },
          { routes: ['C', 'E'], dir: 1 },
        ],
      },
      {
        id: 'D20', name: 'W 4 St-Wash Sq', routes: ['B', 'D', 'F', 'M'],
        division: 'IND', bandColor: ORANGE, type: 'dual-island', length: 183,
        y: -7, rot: 0, at: [-35, 0],
        tracks: [
          { routes: ['F', 'M'], dir: -1 },
          { routes: ['B', 'D'], dir: -1 },
          { routes: ['B', 'D'], dir: 1 },
          { routes: ['F', 'M'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      // north (Waverly) fare mezzanine
      {
        rect: [-10, -14, 60, 14], y: 6,
        fare: { cross: 'x', at: 50, paidSign: -1 },
        exits: [{ at: [54, -8], dir: 'x+' }, { at: [54, 8], dir: 'x+' }],
      },
      // central mezzanine over the stack
      { rect: [-60, -14, -10, 14], y: 6 },
      // bridge over the upper box's south end wall to the deep south mezz
      { rect: [-92, -6, -60, 6], y: 6 },
      // south (W 3 St) mezzanine beyond the upper box — the lower level's way in
      {
        rect: [-128, -16, -92, 16], y: 6,
        fare: { cross: 'x', at: -96, paidSign: -1 },
        exits: [{ at: [-94, 10], dir: 'z+' }, { at: [-94, -10], dir: 'z-' }],
      },
    ],
    stairs: [
      // upper islands from north + central mezzanines
      { top: [30, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [30, 7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [8, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [8, 7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-30, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-30, 7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-50, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-50, 7.15], topY: 6, drop: 6, dir: 'x+' },
      // south mezz -> lower islands (long flights past the upper box)
      { top: [-116, -7.15], topY: 6, drop: 13, dir: 'x+' },
      { top: [-116, 7.15], topY: 6, drop: 13, dir: 'x+' },
    ],
  },

  // ---- Lexington Av/59 St (4 5 6 · N R W) ---------------------------------
  // True stacked IRT: 6 local side platforms above, 4/5 express island
  // directly below (offset south); the BMT island deepest, crossing under
  // 60 St to the 3rd Av escalator plaza.
  {
    complexId: '613',
    name: 'Lexington Av/59 St',
    members: ['629', 'R11'],
    groups: [
      {
        id: '629', name: '59 St', routes: ['6'],
        division: 'IRT', bandColor: GREEN, type: 'side', length: 156,
        y: 0, rot: 0, at: [0, 0],
        tracks: [{ routes: ['6'], dir: -1 }, { routes: ['6'], dir: 1 }],
      },
      {
        id: '629', name: '59 St', routes: ['4', '5'],
        division: 'IRT', bandColor: GREEN, type: 'island', length: 156,
        y: -7, rot: 0, at: [-30, 0],
        tracks: [{ routes: ['4', '5'], dir: -1 }, { routes: ['4', '5'], dir: 1 }],
      },
      {
        id: 'R11', name: 'Lexington Av/59 St', routes: ['N', 'R', 'W'],
        division: 'BMT', bandColor: YELLOW, type: 'island', length: 183,
        y: -14, rot: 90, at: [10, 30],
        tracks: [{ routes: ['N', 'R', 'W'], dir: -1 }, { routes: ['N', 'R', 'W'], dir: 1 }],
      },
    ],
    mezzes: [
      // main 59/60 St mezzanine over the 6
      {
        rect: [-34, -16, 30, 16], y: 6,
        fare: { cross: 'x', at: -24, paidSign: 1 },
        exits: [{ at: [-27, -10], dir: 'x-' }, { at: [-27, 10], dir: 'x-' }],
      },
      // bridge south over the 6 box + landing for the 4/5 express stairs
      { rect: [-78.4, -6, -34, 6], y: 6 },
      { rect: [-88, -6, -78.5, 6], y: 6 },
      // 3rd Av plaza mezzanine at the BMT's east end
      {
        rect: [2, 58, 20, 72], y: 6,
        fare: { cross: 'z', at: 62, paidSign: -1 },
        exits: [{ at: [15, 68], dir: 'x+' }],
      },
    ],
    stairs: [
      // 6 side platforms
      { top: [-15, -6.65], topY: 6, drop: 6, dir: 'x+' },
      { top: [-15, 6.65], topY: 6, drop: 6, dir: 'x+' },
      { top: [10, -6.65], topY: 6, drop: 6, dir: 'x-' },
      { top: [10, 6.65], topY: 6, drop: 6, dir: 'x-' },
      // landing -> 4/5 express island below (the "big X" flights)
      { top: [-80, 0], topY: 6, drop: 13, dir: 'x-' },
      // main mezz -> BMT island (long escalator under 60 St)
      { top: [10, 15.4], topY: 6, drop: 20, dir: 'z+', kind: 'escalator' },
      // 3rd Av plaza -> BMT east end (escalator bank)
      { top: [10, 60.2], topY: 6, drop: 20, dir: 'z-', kind: 'escalator' },
    ],
  },

  // ---- Canal St (R W · 6 · J Z · N Q) -------------------------------------
  // Four-part chain: R/W side platforms under Broadway (bridge express bed in
  // the middle), the 6 above Lafayette, J/Z island under Centre, and the N/Q
  // bridge-branch island deepest, sliding under Broadway.
  {
    complexId: '623',
    name: 'Canal St',
    members: ['R23', '639', 'M20', 'Q01'],
    groups: [
      {
        id: 'R23', name: 'Canal St', routes: ['R', 'W'],
        division: 'BMT', bandColor: YELLOW, type: 'side', length: 183,
        y: 0, rot: 0, at: [-20, -30],
        tracks: [
          { routes: ['R', 'W'], dir: -1 },
          { routes: ['N'], dir: -1, pass: true },
          { routes: ['Q'], dir: 1, pass: true },
          { routes: ['R', 'W'], dir: 1 },
        ],
      },
      {
        id: '639', name: 'Canal St', routes: ['6'],
        division: 'IRT', bandColor: GREEN, type: 'side', length: 156,
        y: 0, rot: 0, at: [10, 10],
        tracks: [
          { routes: ['6'], dir: -1 },
          { routes: ['4'], dir: -1, pass: true },
          { routes: ['5'], dir: 1, pass: true },
          { routes: ['6'], dir: 1 },
        ],
      },
      {
        id: 'M20', name: 'Canal St', routes: ['J', 'Z'],
        division: 'BMT', bandColor: BROWN, type: 'island', length: 183,
        y: -6, rot: 0, at: [25, 40],
        tracks: [{ routes: ['J', 'Z'], dir: -1 }, { routes: ['J', 'Z'], dir: 1 }],
      },
      {
        id: 'Q01', name: 'Canal St', routes: ['N', 'Q'],
        division: 'BMT', bandColor: YELLOW, type: 'island', length: 183,
        y: -12, rot: 270, at: [-45, 10],
        tracks: [{ routes: ['N', 'Q'], dir: -1 }, { routes: ['N', 'Q'], dir: 1 }],
      },
    ],
    mezzes: [
      // Canal x Broadway mezzanine over the R/W (also the N/Q escalator head)
      {
        rect: [-52, -44, -6, -16], y: 6,
        fare: { cross: 'x', at: -10, paidSign: -1 },
        exits: [{ at: [-8, -40], dir: 'x+' }, { at: [-8, -20], dir: 'x+' }],
      },
      // zig-zag corridor east under Canal St
      { rect: [-6, -20, 0, 12], y: 6 },
      // Canal x Lafayette mezzanine over the 6
      {
        rect: [0, 2, 24, 34], y: 6,
        fare: { cross: 'x', at: 20, paidSign: -1 },
        exits: [{ at: [22, 6], dir: 'x+' }, { at: [22, 28], dir: 'x+' }],
      },
      // J/Z bridge mezz at Centre St
      {
        rect: [16, 36, 34, 52], y: 0,
        fare: { cross: 'z', at: 46, paidSign: -1 },
        exits: [{ at: [25, 47.4], dir: 'z+' }],
      },
    ],
    stairs: [
      // Broadway mezz -> R/W side platforms
      { top: [-30, -41.05], topY: 6, drop: 6, dir: 'x+' },
      { top: [-30, -18.95], topY: 6, drop: 6, dir: 'x+' },
      { top: [-14, -41.05], topY: 6, drop: 6, dir: 'x-' },
      { top: [-14, -18.95], topY: 6, drop: 6, dir: 'x-' },
      // Broadway mezz -> N/Q island (long escalator diving under the R/W)
      { top: [-45, -18], topY: 6, drop: 18, dir: 'z+', kind: 'escalator' },
      // Lafayette mezz -> 6 side platforms
      { top: [8, -1.05], topY: 6, drop: 6, dir: 'x-' },
      { top: [8, 21.05], topY: 6, drop: 6, dir: 'x-' },
      // Lafayette mezz -> J/Z bridge mezz -> J/Z island
      { top: [18, 32], topY: 6, drop: 6, dir: 'z+' },
      { top: [25, 38], topY: 0, drop: 6, dir: 'x+' },
    ],
  },

  // ---- Chambers St / WTC / Park Pl (A C · E · 2 3) ------------------------
  // The drawing has no R/W leg (Cortlandt St stays generic). A/C dual-island
  // spine under Church St; the E terminal with wrap-around side platforms and
  // bumpers hanging off its south end; the 2/3 island crossing deepest.
  {
    complexId: '624',
    name: 'Chambers St-WTC-Park Pl',
    members: ['A36', 'E01', '228'],
    groups: [
      {
        id: 'A36', name: 'Chambers St', routes: ['A', 'C'],
        division: 'IND', bandColor: BLUE, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['C'], dir: -1 },
          { routes: ['A'], dir: -1 },
          { routes: ['A'], dir: 1 },
          { routes: ['C'], dir: 1 },
        ],
      },
      {
        id: 'E01', name: 'World Trade Center', routes: ['E'],
        division: 'IND', bandColor: BLUE, type: 'side', length: 183,
        y: 0, rot: 0, at: [-140, 26], stubEnd: -1,
        tracks: [{ routes: ['E'], dir: 1 }, { routes: ['E'], dir: 1 }],
      },
      {
        id: '228', name: 'Park Place', routes: ['2', '3'],
        division: 'IRT', bandColor: RED, type: 'island', length: 156,
        y: -8, rot: 270, at: [-60, -40],
        tracks: [{ routes: ['2', '3'], dir: -1 }, { routes: ['2', '3'], dir: 1 }],
      },
    ],
    mezzes: [
      // Chambers-end fare deck over the A/C
      {
        rect: [40, -14, 68, 14], y: 6,
        fare: { cross: 'x', at: 60, paidSign: -1 },
        exits: [{ at: [62, -8], dir: 'x+' }, { at: [62, 8], dir: 'x+' }],
      },
      // Park Pl fare deck over the A/C south half (reaches south past the box
      // for the 2/3 link stair head)
      {
        rect: [-76, -18, -46, 14], y: 6,
        fare: { cross: 'x', at: -66, paidSign: 1 },
        exits: [{ at: [-70, -8], dir: 'x-' }, { at: [-70, 8], dir: 'x-' }],
      },
      // corridor over the E terminal throat to its own fare deck
      { rect: [-134, 8, -76, 24], y: 6 },
      {
        rect: [-160, 18, -134, 34], y: 6,
        fare: { cross: 'x', at: -142, paidSign: -1 },
        exits: [{ at: [-140, 26], dir: 'x+' }],
      },
      // 2/3 mezzanine over the Park Pl island
      { rect: [-70, -66, -50, -20], y: -2 },
    ],
    stairs: [
      { top: [48, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [48, 7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [-58, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-58, 7.15], topY: 6, drop: 6, dir: 'x+' },
      // E terminal side platforms from its fare deck
      { top: [-150, 19.35], topY: 6, drop: 6, dir: 'x+' },
      { top: [-150, 32.65], topY: 6, drop: 6, dir: 'x+' },
      // Park Pl deck -> 2/3 mezzanine -> island
      { top: [-58, -16], topY: 6, drop: 8, dir: 'z-' },
      { top: [-60, -26], topY: -2, drop: 6, dir: 'z-' },
      { top: [-60, -44], topY: -2, drop: 6, dir: 'z-' },
    ],
  },

  // ---- Delancey St / Essex St (F · J M Z) ---------------------------------
  // J/M/Z on two islands around three tracks (center track dark), the F's side
  // platforms diving under them; the crossing mezzanine threads long stairs
  // down to each F platform beside the BMT box.
  {
    complexId: '625',
    name: 'Delancey St-Essex St',
    members: ['F15', 'M18'],
    groups: [
      {
        id: 'M18', name: 'Delancey St-Essex St', routes: ['J', 'M', 'Z'],
        division: 'BMT', bandColor: BROWN, type: 'dual-island', length: 183,
        y: 0, rot: 90, at: [0, 0],
        tracks: [
          { routes: ['J', 'M', 'Z'], dir: -1 },
          { routes: ['J'], dir: -1, pass: true },
          { routes: ['J', 'M', 'Z'], dir: 1 },
        ],
      },
      {
        id: 'F15', name: 'Delancey St-Essex St', routes: ['F'],
        division: 'IND', bandColor: ORANGE, type: 'side', length: 183,
        y: -8, rot: 0, at: [-20, -25],
        tracks: [{ routes: ['F'], dir: -1 }, { routes: ['F'], dir: 1 }],
      },
    ],
    mezzes: [
      // crossing mezzanine at Delancey x Essex
      {
        rect: [-16, -12, 16, 16], y: 6,
        fare: { cross: 'z', at: 8, paidSign: -1 },
        exits: [{ at: [-8, 10.5], dir: 'z+' }, { at: [8, 10.5], dir: 'z+' }],
      },
      // east mezzanine at Delancey x Norfolk
      {
        rect: [-16, 40, 16, 60], y: 6,
        fare: { cross: 'z', at: 56, paidSign: -1 },
        exits: [{ at: [-8, 57.5], dir: 'z+' }, { at: [8, 57.5], dir: 'z+' }],
      },
      // the F's own landing east of the J/M/Z box, above its platforms
      { rect: [13, -34, 27, -16], y: -2 },
    ],
    stairs: [
      // crossing mezz -> J/M/Z islands
      { top: [4.95, -6], topY: 6, drop: 6, dir: 'z-' },
      { top: [-4.95, -6], topY: 6, drop: 6, dir: 'z-' },
      // Norfolk mezz -> islands
      { top: [4.95, 46], topY: 6, drop: 6, dir: 'z-' },
      { top: [-4.95, 46], topY: 6, drop: 6, dir: 'z-' },
      // F access: crossing mezz -> the F landing (stays above the F's trains),
      // then down each side platform's own band; the west flight descends
      // beside the BMT box directly to the far platform
      { top: [14, -11.5], topY: 6, drop: 8, dir: 'z-' },
      { top: [18, -31.65], topY: -2, drop: 6, dir: 'x+' },
      { top: [18, -18.35], topY: -2, drop: 6, dir: 'x+' },
      { top: [-14.2, 4.4], topY: 6, drop: 14, dir: 'z-' },
    ],
  },

  // ---- Lexington Av/53 St + 51 St (E F · 6) -------------------------------
  // The deep E/M island under 53rd with its long escalator bank, the 6's side
  // platforms shallow under Lexington, linked by the 51 St corridor.
  {
    complexId: '612',
    name: 'Lexington Av/53 St',
    members: ['F11', '630'],
    groups: [
      {
        id: 'F11', name: 'Lexington Av/53 St', routes: ['E', 'F'],
        division: 'IND', bandColor: BLUE, type: 'island', length: 183,
        y: -14, rot: 90, at: [15, 10],
        tracks: [{ routes: ['E', 'F'], dir: -1 }, { routes: ['E', 'F'], dir: 1 }],
      },
      {
        id: '630', name: '51 St', routes: ['6'],
        division: 'IRT', bandColor: GREEN, type: 'side', length: 156,
        y: 0, rot: 0, at: [-20, -30],
        tracks: [
          { routes: ['6'], dir: -1 },
          { routes: ['4'], dir: -1, pass: true },
          { routes: ['5'], dir: 1, pass: true },
          { routes: ['6'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      // 53/Lex headhouse over the escalator bank
      {
        rect: [-6, -16, 22, 8], y: 6,
        fare: { cross: 'z', at: -6, paidSign: 1 },
        exits: [{ at: [-2, -11], dir: 'z-' }],
      },
      // 51 St mezzanine over the 6
      {
        rect: [-38, -44, -6, -18], y: 6,
        fare: { cross: 'x', at: -28, paidSign: 1 },
        exits: [{ at: [-33, -40], dir: 'x-' }, { at: [-33, -22], dir: 'x-' }],
      },
      // short corridor linking the two fare areas (in-system transfer)
      { rect: [-10, -18, -2, -16], y: 6 },
    ],
    stairs: [
      // headhouse -> E/M island (the big escalator bank)
      { top: [15, 2], topY: 6, drop: 20, dir: 'z+', kind: 'escalator' },
      // 51 St mezz -> 6 side platforms
      { top: [-20, -41.05], topY: 6, drop: 6, dir: 'x+' },
      { top: [-20, -18.95], topY: 6, drop: 6, dir: 'x+' },
    ],
  },

  // ---- 34 St–Hudson Yards (7) ---------------------------------------------
  // Deep 7 terminal: island platform, full-length intermediate mezzanine, and
  // the long inclined escalator banks up to the entrance concourse.
  {
    complexId: '471',
    name: '34 St-Hudson Yards',
    members: ['726'],
    groups: [
      {
        id: '726', name: '34 St-Hudson Yards', routes: ['7'],
        division: 'IRT', bandColor: PURPLE, type: 'island', length: 156,
        y: -16, rot: 0, at: [0, 0], stubEnd: 1,
        tracks: [{ routes: ['7'], dir: -1 }, { routes: ['7'], dir: -1 }],
      },
    ],
    mezzes: [
      // intermediate mezzanine directly over the platform
      { rect: [-70, -10, 70, 10], y: -10 },
      // entrance concourse (rotunda), fare + street
      {
        rect: [50, 14, 80, 40], y: 6,
        fare: { cross: 'z', at: 26, paidSign: -1 },
        exits: [{ at: [70, 30], dir: 'z+' }, { at: [58, 30], dir: 'z+' }],
      },
    ],
    stairs: [
      { top: [-40, 0], topY: -10, drop: 6, dir: 'x+' },
      { top: [0, 0], topY: -10, drop: 6, dir: 'x+' },
      { top: [40, 0], topY: -10, drop: 6, dir: 'x-' },
      // the long inclined bank: concourse down to the mezzanine
      { top: [55, 20], topY: 6, drop: 16, dir: 'z-', kind: 'escalator' },
    ],
  },

  // ---- 7 Av (E · B D) -----------------------------------------------------
  // Two stacked islands pairing services by direction: downtown E + B/D above,
  // Queens/uptown below (cross-platform by direction, opposite travel ways).
  {
    complexId: '277',
    name: '7 Av',
    members: ['D14'],
    groups: [
      {
        id: 'D14', name: '7 Av', routes: ['E', 'B', 'D'],
        division: 'IND', bandColor: BLUE, type: 'island', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['E'], dir: -1 },
          { routes: ['B', 'D'], dir: -1, flip: true },
        ],
      },
      {
        id: 'D14', name: '7 Av', routes: ['E', 'B', 'D'],
        division: 'IND', bandColor: BLUE, type: 'island', length: 183,
        y: -7, rot: 0, at: [30, 0],
        tracks: [
          { routes: ['E'], dir: 1 },
          { routes: ['B', 'D'], dir: 1, flip: true },
        ],
      },
    ],
    mezzes: [
      // 53/Broadway mezzanine (west end)
      {
        rect: [-92, -10, -60, 10], y: 6,
        fare: { cross: 'x', at: -84, paidSign: 1 },
        exits: [{ at: [-87, -6], dir: 'x-' }, { at: [-87, 6], dir: 'x-' }],
      },
      // 53/7 Av mezzanine
      {
        rect: [-20, -10, 14, 10], y: 6,
        fare: { cross: 'x', at: 6, paidSign: -1 },
        exits: [{ at: [9, -6], dir: 'x+' }, { at: [9, 6], dir: 'x+' }],
      },
      // bridge east over the upper box to the lower level's stair landing
      { rect: [14, -8, 94, 8], y: 6 },
      { rect: [94, -8, 112, 8], y: 6 },
    ],
    stairs: [
      // upper island (both wells fully inside fare control — a well crossing
      // the fare line would put turnstiles over the stair opening)
      { top: [-70, 0], topY: 6, drop: 6, dir: 'x+' },
      { top: [-8, 0], topY: 6, drop: 6, dir: 'x-' },
      { top: [-4, 0], topY: 6, drop: 6, dir: 'x+' },
      // far-east landing -> lower island (past the upper box)
      { top: [96, 0], topY: 6, drop: 13, dir: 'x+' },
    ],
  },

  // ---- 5 Av/53 St (E F) ---------------------------------------------------
  // Two stacked single-side levels: Manhattan-bound upper, Queens-bound lower
  // (offset east), reached past the upper box's east end.
  {
    complexId: '276',
    name: '5 Av/53 St',
    members: ['F12'],
    groups: [
      {
        id: 'F12', name: '5 Av/53 St', routes: ['E', 'F'],
        division: 'IND', bandColor: BLUE, type: 'side', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [{ routes: ['E', 'F'], dir: -1 }],
      },
      {
        id: 'F12', name: '5 Av/53 St', routes: ['E', 'F'],
        division: 'IND', bandColor: BLUE, type: 'side', length: 183,
        y: -6, rot: 0, at: [30, 0],
        tracks: [{ routes: ['E', 'F'], dir: 1 }],
      },
    ],
    mezzes: [
      // 5 Av mezzanine (west)
      {
        rect: [-88, -10, -64, 10], y: 6,
        fare: { cross: 'x', at: -82, paidSign: 1 },
        exits: [{ at: [-85, -6], dir: 'x-' }, { at: [-85, 6], dir: 'x-' }],
      },
      // Madison mezzanine (east) + bridge + far landing for the lower level
      {
        rect: [64, -10, 88, 10], y: 6,
        fare: { cross: 'x', at: 82, paidSign: -1 },
        exits: [{ at: [85, -6], dir: 'x+' }, { at: [85, 6], dir: 'x+' }],
      },
      { rect: [88, -8, 96, 8], y: 6 },
      { rect: [96, -8, 114, 8], y: 6 },
    ],
    stairs: [
      { top: [-70, -2.2], topY: 6, drop: 6, dir: 'x-' },
      { top: [70, -2.2], topY: 6, drop: 6, dir: 'x+' },
      // far landing -> lower platform (past the upper box's east end)
      { top: [98, -2.2], topY: 6, drop: 12, dir: 'x+' },
    ],
  },

  // ---- 42 St–Bryant Pk / 5 Av (B D F M · 7) -------------------------------
  // IND dual-island under 6th Av; the 7's side platforms under 42 St to the
  // east, reached by the corridor from the 42/6 mezzanine.
  {
    complexId: '609',
    name: '42 St-Bryant Pk',
    members: ['D16', '724'],
    groups: [
      {
        id: 'D16', name: '42 St-Bryant Pk', routes: ['B', 'D', 'F', 'M'],
        division: 'IND', bandColor: ORANGE, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [0, -15],
        tracks: [
          { routes: ['F', 'M'], dir: -1 },
          { routes: ['B', 'D'], dir: -1 },
          { routes: ['B', 'D'], dir: 1 },
          { routes: ['F', 'M'], dir: 1 },
        ],
      },
      {
        id: '724', name: '5 Av', routes: ['7'],
        division: 'IRT', bandColor: PURPLE, type: 'side', length: 156,
        y: -10, rot: 270, at: [35, 30],
        tracks: [{ routes: ['7'], dir: -1 }, { routes: ['7'], dir: 1 }],
      },
    ],
    mezzes: [
      // 42/6 mezzanine
      {
        rect: [30, -28, 62, -2], y: 6,
        fare: { cross: 'x', at: 52, paidSign: -1 },
        exits: [{ at: [55, -22], dir: 'x+' }, { at: [55, -8], dir: 'x+' }],
      },
      // corridor toward the 7 (over both boxes, high)
      { rect: [30, -2, 44, 26], y: 6 },
      // 7 mezzanine above its platforms
      { rect: [28, 34, 42, 52], y: -4 },
      // 42/5 mezzanine at the 7's east end
      {
        rect: [28, 84, 42, 104], y: -4,
        fare: { cross: 'z', at: 96, paidSign: -1 },
        exits: [{ at: [32, 99], dir: 'z+' }],
      },
      // 40 St south deck
      {
        rect: [-64, -28, -35, -2], y: 6,
        fare: { cross: 'x', at: -55, paidSign: 1 },
        exits: [{ at: [-58, -20], dir: 'x-' }, { at: [-58, -8], dir: 'x-' }],
      },
    ],
    stairs: [
      { top: [38, -22.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [38, -7.85], topY: 6, drop: 6, dir: 'x-' },
      { top: [-48, -22.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-48, -7.85], topY: 6, drop: 6, dir: 'x+' },
      // corridor -> 7 mezz -> both 7 side platforms
      { top: [37, 20], topY: 6, drop: 10, dir: 'z+' },
      { top: [28.35, 40], topY: -4, drop: 6, dir: 'z+' },
      { top: [41.65, 40], topY: -4, drop: 6, dir: 'z+' },
      { top: [28.35, 90], topY: -4, drop: 6, dir: 'z-' },
      { top: [41.65, 90], topY: -4, drop: 6, dir: 'z-' },
    ],
  },

  // ---- 14 St / 8 Av (A C E · L) -------------------------------------------
  // IND dual-island under 8th Av; the L terminal island under 14 St deepest,
  // bumpers under the avenue; reached south of the IND box.
  {
    complexId: '618',
    name: '14 St-8 Av',
    members: ['A31', 'L01'],
    groups: [
      {
        id: 'A31', name: '14 St', routes: ['A', 'C', 'E'],
        division: 'IND', bandColor: BLUE, type: 'dual-island', length: 183,
        y: 0, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['C', 'E'], dir: -1 },
          { routes: ['A'], dir: -1 },
          { routes: ['A'], dir: 1 },
          { routes: ['C', 'E'], dir: 1 },
        ],
      },
      {
        id: 'L01', name: '8 Av', routes: ['L'],
        division: 'BMT', bandColor: LGREY, type: 'island', length: 183,
        y: -8, rot: 270, at: [-35, 55], stubEnd: 1,
        tracks: [{ routes: ['L'], dir: -1 }, { routes: ['L'], dir: -1 }],
      },
    ],
    mezzes: [
      // 14 St mezzanine (south) + its east extension past the IND box
      {
        rect: [-64, -14, -35, 14.7], y: 6,
        fare: { cross: 'x', at: -56, paidSign: 1 },
        exits: [{ at: [-58, -8], dir: 'x-' }, { at: [-58, 8], dir: 'x-' }],
      },
      { rect: [-64, 14.9, -30, 30], y: 6 },
      // 16 St mezzanine (north)
      {
        rect: [30, -14, 60, 14], y: 6,
        fare: { cross: 'x', at: 50, paidSign: -1 },
        exits: [{ at: [53, -8], dir: 'x+' }, { at: [53, 8], dir: 'x+' }],
      },
    ],
    stairs: [
      { top: [-52, -7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-52, 7.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [38, -7.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [38, 7.15], topY: 6, drop: 6, dir: 'x-' },
      // south extension -> L island (long flights clear of the IND box)
      { top: [-35, 18], topY: 6, drop: 14, dir: 'z+' },
    ],
  },

  // ---- 14 St / 6-7 Av (1 2 3 · F M · L) -----------------------------------
  // Three groups: 1/2/3 dual-island under 7th Av, F/M island under 6th Av
  // (deepest), L side platforms under 14 St; the 14 St corridor ties the
  // 1/2/3 to the F/M island, and the 14/6 deck serves the L.
  {
    complexId: '601',
    name: '14 St',
    members: ['132', 'D19', 'L02'],
    groups: [
      {
        id: '132', name: '14 St', routes: ['1', '2', '3'],
        division: 'IRT', bandColor: RED, type: 'dual-island', length: 156,
        y: 0, rot: 0, at: [-45, -40],
        tracks: [
          { routes: ['1'], dir: -1 },
          { routes: ['2', '3'], dir: -1 },
          { routes: ['2', '3'], dir: 1 },
          { routes: ['1'], dir: 1 },
        ],
      },
      {
        id: 'D19', name: '14 St', routes: ['F', 'M'],
        division: 'IND', bandColor: ORANGE, type: 'island', length: 183,
        y: -9, rot: 0, at: [20, 40],
        tracks: [{ routes: ['F', 'M'], dir: -1 }, { routes: ['F', 'M'], dir: 1 }],
      },
      {
        id: 'L02', name: '6 Av', routes: ['L'],
        division: 'BMT', bandColor: LGREY, type: 'side', length: 183,
        y: -3, rot: 270, at: [-15, 70],
        tracks: [{ routes: ['L'], dir: -1 }, { routes: ['L'], dir: 1 }],
      },
    ],
    mezzes: [
      // 1/2/3 mezzanine at 14/7
      {
        rect: [-20, -54, 5, -26], y: 6,
        fare: { cross: 'x', at: 0, paidSign: -1 },
        exits: [{ at: [2, -48], dir: 'x+' }, { at: [2, -32], dir: 'x+' }],
      },
      // 14 St corridor east toward 6th Av (the long in-system passage)
      { rect: [-20, -26, -4, 26], y: 6 },
      // 14/6 deck above the L and the F/M island's north end
      {
        rect: [-26, 26, 32, 52], y: 6,
        fare: { cross: 'z', at: 48, paidSign: -1 },
        exits: [{ at: [8, 50], dir: 'z+' }, { at: [24, 50], dir: 'z+' }],
      },
      // 16 St deck over the F/M's north platform end
      {
        rect: [70, 30, 92, 52], y: 6,
        fare: { cross: 'x', at: 86, paidSign: -1 },
        exits: [{ at: [87, 34], dir: 'x+' }, { at: [87, 48], dir: 'x+' }],
      },
    ],
    stairs: [
      // 1/2/3 islands
      { top: [-12, -47.15], topY: 6, drop: 6, dir: 'x-' },
      { top: [-12, -32.85], topY: 6, drop: 6, dir: 'x-' },
      { top: [-6, -47.15], topY: 6, drop: 6, dir: 'x+' },
      { top: [-6, -32.85], topY: 6, drop: 6, dir: 'x+' },
      // 14/6 deck -> L side platforms (down each platform's own band)
      { top: [-8.35, 32], topY: 6, drop: 9, dir: 'z+' },
      { top: [-21.65, 32], topY: 6, drop: 9, dir: 'z+' },
      // 14/6 deck -> F/M island (long flight along the island)
      { top: [4, 40], topY: 6, drop: 15, dir: 'x+' },
      // 16 St deck -> F/M island
      { top: [78, 40], topY: 6, drop: 15, dir: 'x+' },
    ],
  },

  // ---- Broadway–Lafayette St / Bleecker St (B D F M · 6) ------------------
  // IND dual-island deep under Houston; the 6's offset side platforms above
  // Lafayette. The uptown 6 platform meets the fare deck at grade; a mezzanine
  // slides under the 6 to reach the IND islands.
  {
    complexId: '619',
    name: 'Broadway-Lafayette St',
    members: ['D21', '637'],
    groups: [
      {
        id: 'D21', name: 'Broadway-Lafayette St', routes: ['B', 'D', 'F', 'M'],
        division: 'IND', bandColor: ORANGE, type: 'dual-island', length: 183,
        y: -8, rot: 0, at: [0, 0],
        tracks: [
          { routes: ['F', 'M'], dir: -1 },
          { routes: ['B', 'D'], dir: -1 },
          { routes: ['B', 'D'], dir: 1 },
          { routes: ['F', 'M'], dir: 1 },
        ],
      },
      {
        id: '637', name: 'Bleecker St', routes: ['6'],
        division: 'IRT', bandColor: GREEN, type: 'side', length: 156,
        y: 0, rot: 90, at: [-30, 10],
        tracks: [
          { routes: ['6'], dir: -1 },
          { routes: ['4'], dir: -1, pass: true },
          { routes: ['5'], dir: 1, pass: true },
          { routes: ['6'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      // Houston/Lafayette fare deck at the uptown 6 platform's grade
      {
        rect: [-56, -34, -43, -12], y: 0.02,
        fare: { cross: 'x', at: -46, paidSign: 1 },
        exits: [{ at: [-50, -20], dir: 'x-' }],
      },
      // its continuation north along the 6's flank (over the IND box, high
      // enough to clear the walls)
      { rect: [-52, -12, -43, 6], y: 0.02 },
      // IND mezzanine sliding UNDER the 6 station, over the B/D/F/M
      { rect: [-44, -14, -20, 14], y: -2 },
      // east fare deck at the downtown 6 platform
      {
        rect: [-17, -30, -2, -12], y: 0.02,
        fare: { cross: 'x', at: -12, paidSign: -1 },
        exits: [{ at: [-8, -20], dir: 'x+' }],
      },
      // Broadway (west) mezzanine over the IND's west half
      {
        rect: [-70, -14, -52, 14], y: -2,
        exits: [],
      },
    ],
    stairs: [
      // deck -> IND mezz (short hop), then IND mezz -> both islands
      { top: [-44.5, 0], topY: 0.02, drop: 2.02, dir: 'x+' },
      { top: [-30, -7.15], topY: -2, drop: 6, dir: 'x+' },
      { top: [-30, 7.15], topY: -2, drop: 6, dir: 'x+' },
      { top: [-62, -7.15], topY: -2, drop: 6, dir: 'x+' },
      { top: [-62, 7.15], topY: -2, drop: 6, dir: 'x+' },
    ],
  },

  // ---- Brooklyn Bridge–City Hall / Chambers St (4 5 6 · J Z) --------------
  // IRT dual-island under Centre St; the wide BMT Chambers St box beside it,
  // J/Z on the center tracks between two islands, under the Municipal
  // Building concourse.
  {
    complexId: '622',
    name: 'Brooklyn Bridge-City Hall',
    members: ['640', 'M21'],
    groups: [
      {
        id: '640', name: 'Brooklyn Bridge-City Hall', routes: ['4', '5', '6'],
        division: 'IRT', bandColor: GREEN, type: 'dual-island', length: 156,
        y: -8, rot: 0, at: [0, -10],
        tracks: [
          { routes: ['6'], dir: -1 },
          { routes: ['4', '5'], dir: -1 },
          { routes: ['4', '5'], dir: 1 },
          { routes: ['6'], dir: 1 },
        ],
      },
      {
        id: 'M21', name: 'Chambers St', routes: ['J', 'Z'],
        division: 'BMT', bandColor: BROWN, type: 'dual-island', length: 183,
        y: -4, rot: 0, at: [10, 22],
        tracks: [
          { routes: ['J', 'Z'], dir: -1 },
          { routes: ['J'], dir: -1, pass: true },
          { routes: ['J', 'Z'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      // north (Duane/Reade) mezzanine over the IRT
      {
        rect: [40, -24, 68, 4], y: -2,
        fare: { cross: 'x', at: 60, paidSign: -1 },
        exits: [{ at: [62, -18], dir: 'x+' }, { at: [62, -2], dir: 'x+' }],
      },
      // central IRT mezzanine
      { rect: [-20, -24, 20, 4], y: -2 },
      // Municipal Building concourse over the BMT
      {
        rect: [0, 8, 30, 40], y: 2,
        fare: { cross: 'z', at: 32, paidSign: -1 },
        exits: [{ at: [8, 34], dir: 'z+' }, { at: [22, 34], dir: 'z+' }],
      },
      // south mezzanine at the Brooklyn Bridge approach
      {
        rect: [-68, -24, -40, 4], y: -2,
        fare: { cross: 'x', at: -60, paidSign: 1 },
        exits: [{ at: [-62, -18], dir: 'x-' }, { at: [-62, -2], dir: 'x-' }],
      },
    ],
    stairs: [
      { top: [48, -17.15], topY: -2, drop: 6, dir: 'x-' },
      { top: [48, -2.85], topY: -2, drop: 6, dir: 'x-' },
      { top: [-8, -17.15], topY: -2, drop: 6, dir: 'x+' },
      { top: [-8, -2.85], topY: -2, drop: 6, dir: 'x+' },
      { top: [-52, -17.15], topY: -2, drop: 6, dir: 'x+' },
      { top: [-52, -2.85], topY: -2, drop: 6, dir: 'x+' },
      // concourse -> J/Z islands + link down to the central IRT mezz
      { top: [10, 17.05], topY: 2, drop: 6, dir: 'x+' },
      { top: [10, 26.95], topY: 2, drop: 6, dir: 'x+' },
      { top: [4, 9.6], topY: 2, drop: 4, dir: 'z-' },
    ],
  },

  // ---- 59 St–Columbus Circle (1 · A B C D) --------------------------------
  // The 1's island under Broadway crossing above the IND's dual-island box
  // under 8th Av/CPW; rotunda mezzanine with the curved stair, transfers
  // through the southeast quadrant.
  {
    complexId: '614',
    name: '59 St-Columbus Circle',
    members: ['125', 'A24'],
    groups: [
      // the 1's island sits clear south of the IND box — its track bed must
      // never share plan with the IND mezzanine level (rails through a
      // concourse is exactly the bug this arrangement prevents)
      {
        id: '125', name: '59 St-Columbus Circle', routes: ['1'],
        division: 'IRT', bandColor: RED, type: 'island', length: 156,
        y: 0, rot: 0, at: [15, -30],
        tracks: [{ routes: ['1'], dir: -1 }, { routes: ['1'], dir: 1 }],
      },
      {
        id: 'A24', name: '59 St-Columbus Circle', routes: ['A', 'C', 'B', 'D'],
        division: 'IND', bandColor: BLUE, type: 'dual-island', length: 183,
        y: -7, rot: 0, at: [-15, 6],
        tracks: [
          { routes: ['B', 'C'], dir: -1 },
          { routes: ['A', 'D'], dir: -1 },
          { routes: ['A', 'D'], dir: 1 },
          { routes: ['B', 'C'], dir: 1 },
        ],
      },
    ],
    mezzes: [
      // rotunda mezzanine under the Circle, spanning both lines high above;
      // generous unpaid hall before the fare line
      {
        rect: [0, -38, 35, 10], y: 6,
        fare: { cross: 'x', at: 24, paidSign: -1 },
        exits: [{ at: [28, -12], dir: 'x+' }, { at: [28, 4], dir: 'x+' }],
      },
      // 58 St mezzanine over the IND
      {
        rect: [-34, -6, -2, 20], y: -1,
        fare: { cross: 'x', at: -28, paidSign: 1 },
        exits: [{ at: [-31, 15.4], dir: 'z+' }],
      },
    ],
    stairs: [
      // rotunda -> 1 island (both wells fully inside fare control)
      { top: [8, -30], topY: 6, drop: 6, dir: 'x-' },
      { top: [12, -30], topY: 6, drop: 6, dir: 'x+' },
      // rotunda -> IND mezzanine (the transfer bank)
      { top: [2, 2], topY: 6, drop: 7, dir: 'x-' },
      // IND mezzanine -> its islands (pairs descend away from each other)
      { top: [-20, -1.15], topY: -1, drop: 6, dir: 'x-' },
      { top: [-20, 13.15], topY: -1, drop: 6, dir: 'x-' },
      { top: [-8, -1.15], topY: -1, drop: 6, dir: 'x+' },
      { top: [-8, 13.15], topY: -1, drop: 6, dir: 'x+' },
    ],
  },
];

const byMember = new Map<string, ComplexSpec>();
for (const c of COMPLEXES) {
  for (const id of c.members) byMember.set(id, c);
}

/** The bespoke complex a station id belongs to, if it has one. */
export function complexFor(stationId: string): ComplexSpec | null {
  return byMember.get(stationId) ?? null;
}
