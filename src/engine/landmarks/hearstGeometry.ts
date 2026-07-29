export type HearstPlanPoint = [number, number];

/** The published perimeter node spacing: 40 feet. */
export const HEARST_GRID_MODULE = 12.192;

/** The published 160-by-120-foot upper-tower node rectangle. */
export const HEARST_TOWER_WIDTH = HEARST_GRID_MODULE * 4;
export const HEARST_TOWER_DEPTH = HEARST_GRID_MODULE * 3;

/** Nine four-storey structural intervals run from floor 10 to the roof row. */
export const HEARST_DIAGRID_MODULES = 9;

/**
 * Rows 1, 3, 5 and 7 are internal half-module rows bracketed by sharp rows.
 * Row 9 retains the same phase at the roof but is terminal, so it is not a
 * fifth bird's mouth.
 */
export const HEARST_BIRD_MOUTH_BOUNDARIES: readonly number[] = [1, 3, 5, 7];

/** Four long-face modules plus three short-face modules around the perimeter. */
export const HEARST_FACE_BAYS: readonly number[] = [4, 4, 3, 3];
export const HEARST_PERIMETER_NODE_COUNT =
  HEARST_FACE_BAYS[0] + HEARST_FACE_BAYS[2]
  + HEARST_FACE_BAYS[1] + HEARST_FACE_BAYS[3];

/** Each node joins the two adjacent nodes in the next phase-shifted row. */
export const HEARST_DIAGONALS_PER_MODULE = HEARST_PERIMETER_NODE_COUNT * 2;
export const HEARST_DIAGONAL_SEGMENT_COUNT =
  HEARST_DIAGONALS_PER_MODULE * HEARST_DIAGRID_MODULES;

/** One closed 14-segment node ring at every structural boundary. */
export const HEARST_RING_SEGMENT_COUNT =
  HEARST_PERIMETER_NODE_COUNT * (HEARST_DIAGRID_MODULES + 1);

/** Total merged structural pieces; the landmark still submits one steel draw. */
export const HEARST_DIAGRID_BEAM_COUNT =
  HEARST_DIAGONAL_SEGMENT_COUNT + HEARST_RING_SEGMENT_COUNT;

/** Half a 40-foot module forms each leg of the real bird-mouth chamfer. */
export const HEARST_BIRD_MOUTH_CUT = HEARST_GRID_MODULE / 2;

/**
 * A tiny physical cut keeps the sharp glass rows non-degenerate and catches a
 * restrained highlight at the arris. It is visually sharp at city scale.
 */
export const HEARST_SHARP_CORNER_CUT = 0.12;

const HALF_WIDTH = HEARST_TOWER_WIDTH / 2;
const HALF_DEPTH = HEARST_TOWER_DEPTH / 2;
const PERIMETER = (HEARST_TOWER_WIDTH + HEARST_TOWER_DEPTH) * 2;

export interface HearstRingNode {
  index: number;
  perimeterDistance: number;
  point: HearstPlanPoint;
}

export interface HearstDiagonalSegment {
  module: number;
  lowerIndex: number;
  upperIndex: number;
  lower: HearstPlanPoint;
  upper: HearstPlanPoint;
  corner: boolean;
}

export function hearstBoundaryIsChamfered(boundary: number): boolean {
  return boundary % 2 === 1;
}

export function hearstBoundaryIsBirdMouth(boundary: number): boolean {
  return HEARST_BIRD_MOUTH_BOUNDARIES.includes(boundary);
}

/**
 * Sample the uncut 160-by-120-foot rectangle by arc length. Odd structural
 * rows shift by half a module; joining their adjacent points creates the
 * 20-foot-by-20-foot corner chord without changing the perimeter phase.
 */
function pointAtRectanglePerimeter(distance: number): HearstPlanPoint {
  let s = ((distance % PERIMETER) + PERIMETER) % PERIMETER;
  if (s <= HEARST_TOWER_WIDTH) return [-HALF_WIDTH + s, -HALF_DEPTH];
  s -= HEARST_TOWER_WIDTH;
  if (s <= HEARST_TOWER_DEPTH) return [HALF_WIDTH, -HALF_DEPTH + s];
  s -= HEARST_TOWER_DEPTH;
  if (s <= HEARST_TOWER_WIDTH) return [HALF_WIDTH - s, HALF_DEPTH];
  s -= HEARST_TOWER_WIDTH;
  return [-HALF_WIDTH, HALF_DEPTH - s];
}

export function hearstPerimeterRing(boundary: number): HearstRingNode[] {
  const phase = hearstBoundaryIsChamfered(boundary)
    ? HEARST_GRID_MODULE / 2
    : 0;
  return Array.from({ length: HEARST_PERIMETER_NODE_COUNT }, (_, index) => {
    const perimeterDistance = phase + index * HEARST_GRID_MODULE;
    return {
      index,
      perimeterDistance,
      point: pointAtRectanglePerimeter(perimeterDistance),
    };
  });
}

export function hearstRingPerimeter(boundary: number): number {
  const ring = hearstPerimeterRing(boundary);
  let length = 0;
  for (let index = 0; index < ring.length; index++) {
    const [ax, az] = ring[index].point;
    const [bx, bz] = ring[(index + 1) % ring.length].point;
    length += Math.hypot(bx - ax, bz - az);
  }
  return length;
}

function isSharpCorner([x, z]: HearstPlanPoint): boolean {
  return Math.abs(Math.abs(x) - HALF_WIDTH) < 1e-9
    && Math.abs(Math.abs(z) - HALF_DEPTH) < 1e-9;
}

/**
 * Build the continuous four-face triangulated tube.
 *
 * Full -> offset: p_i joins q_(i-1) and q_i.
 * Offset -> full: q_i joins p_i and p_(i+1).
 *
 * Those mappings keep every member in one facade plane. At a full corner the
 * two diagonals split onto its adjacent faces instead of cutting through the
 * chamfered glass.
 */
export function hearstDiagridSegments(): HearstDiagonalSegment[] {
  const segments: HearstDiagonalSegment[] = [];
  for (let module = 0; module < HEARST_DIAGRID_MODULES; module++) {
    const lower = hearstPerimeterRing(module);
    const upper = hearstPerimeterRing(module + 1);
    const lowerIsFull = !hearstBoundaryIsChamfered(module);
    for (let lowerIndex = 0; lowerIndex < HEARST_PERIMETER_NODE_COUNT; lowerIndex++) {
      const upperIndices = lowerIsFull
        ? [
          (lowerIndex - 1 + HEARST_PERIMETER_NODE_COUNT) % HEARST_PERIMETER_NODE_COUNT,
          lowerIndex,
        ]
        : [
          lowerIndex,
          (lowerIndex + 1) % HEARST_PERIMETER_NODE_COUNT,
        ];
      for (const upperIndex of upperIndices) {
        const lowerPoint = lower[lowerIndex].point;
        const upperPoint = upper[upperIndex].point;
        segments.push({
          module,
          lowerIndex,
          upperIndex,
          lower: lowerPoint,
          upper: upperPoint,
          corner: isSharpCorner(lowerPoint) || isSharpCorner(upperPoint),
        });
      }
    }
  }
  return segments;
}

/**
 * Eight facade endpoints preserve four planar broad faces and four explicit
 * corner facets. Even rows use a 12cm micro-chamfer; odd rows use the real
 * half-module bird-mouth cut, including the terminal roof row.
 */
export function hearstCurtainProfile(
  boundary: number,
  halfWidth = HALF_WIDTH,
  halfDepth = HALF_DEPTH,
  mouthCut = HEARST_BIRD_MOUTH_CUT,
  sharpCut = HEARST_SHARP_CORNER_CUT,
): HearstPlanPoint[] {
  const cut = hearstBoundaryIsChamfered(boundary) ? mouthCut : sharpCut;
  return [
    [-halfWidth + cut, -halfDepth],
    [halfWidth - cut, -halfDepth],
    [halfWidth, -halfDepth + cut],
    [halfWidth, halfDepth - cut],
    [halfWidth - cut, halfDepth],
    [-halfWidth + cut, halfDepth],
    [-halfWidth, halfDepth - cut],
    [-halfWidth, -halfDepth + cut],
  ];
}

export function hearstCurtainLevels(
  y0: number,
  y1: number,
  halfWidth = HALF_WIDTH,
  halfDepth = HALF_DEPTH,
  mouthCut = HEARST_BIRD_MOUTH_CUT,
  sharpCut = HEARST_SHARP_CORNER_CUT,
): { y: number; points: HearstPlanPoint[] }[] {
  const moduleH = (y1 - y0) / HEARST_DIAGRID_MODULES;
  return Array.from({ length: HEARST_DIAGRID_MODULES + 1 }, (_, boundary) => ({
    y: y0 + boundary * moduleH,
    points: hearstCurtainProfile(
      boundary, halfWidth, halfDepth, mouthCut, sharpCut,
    ),
  }));
}

export function hearstProjectedDiagonalAngle(moduleHeight: number): number {
  return Math.atan2(moduleHeight, HEARST_GRID_MODULE / 2) * 180 / Math.PI;
}
