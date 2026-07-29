export type HearstPlanPoint = [number, number];

/** Hearst's diagrid runs from roughly floor 10 through floor 46. */
export const HEARST_DIAGRID_MODULES = 9;

/**
 * The four recessed corner nodes occur at floors 14, 22, 30 and 38: every
 * other four-floor module boundary, rather than in the middle of every module.
 */
export const HEARST_BIRD_MOUTH_BOUNDARIES: readonly number[] = [1, 3, 5, 7];

/**
 * The 160-by-120-foot tower loses roughly one 20-foot corner wing at either
 * end of each face. That leaves three 40-foot modules on the broad faces and
 * two on the short faces, matching the real structural grid.
 */
export const HEARST_FACE_BAYS: readonly number[] = [3, 3, 2, 2];

/** One diagonal (not a decorative X) crosses each four-storey facade bay. */
export const HEARST_FACE_DIAGONAL_COUNT =
  HEARST_FACE_BAYS.reduce((sum, bays) => sum + bays, 0)
  * HEARST_DIAGRID_MODULES;

/** One subdued horizontal node rail crosses each face at every module tier. */
export const HEARST_FACE_TIER_RAIL_COUNT =
  HEARST_FACE_BAYS.length * (HEARST_DIAGRID_MODULES + 1);

/** A single throat member outlines each of the four genuine bird's mouths. */
export const HEARST_BIRD_MOUTH_THROAT_COUNT =
  HEARST_BIRD_MOUTH_BOUNDARIES.length * 4;

/** Total prominent steel members after omitting the former corner weave. */
export const HEARST_DIAGRID_BEAM_COUNT =
  HEARST_FACE_DIAGONAL_COUNT
  + HEARST_FACE_TIER_RAIL_COUNT
  + HEARST_BIRD_MOUTH_THROAT_COUNT;

export function hearstBoundaryCut(
  boundary: number,
  nodeCut: number,
  biteCut: number,
): number {
  return HEARST_BIRD_MOUTH_BOUNDARIES.includes(boundary) ? biteCut : nodeCut;
}

export interface HearstFaceDiagonal {
  module: number;
  bay: number;
  lowerAlong: number;
  upperAlong: number;
}

/**
 * Return one structural grid coordinate at a module boundary. The real flat
 * facade does not squeeze toward a bird's mouth: its interior 40-foot nodes
 * remain fixed while only the two outer wing nodes follow the corner cut.
 */
export function hearstFaceGridAlong(
  boundary: number,
  index: number,
  halfExtent: number,
  bays: number,
  nodeCut = 1.7,
  biteCut = 6.2,
): number {
  if (index === 0 || index === bays) {
    const edgeHalf = halfExtent
      - hearstBoundaryCut(boundary, nodeCut, biteCut);
    return index === 0 ? -edgeHalf : edgeHalf;
  }
  const fixedHalf = halfExtent - biteCut;
  return -fixedHalf + index * ((fixedHalf * 2) / bays);
}

/**
 * Builds a pure alternating-triangle elevation for one face.
 *
 * Adjacent bays and tiers reverse slope, so two four-storey triangles resolve
 * into the tower's recognizable large diamonds. Interior grid nodes remain
 * fixed while the first/last points use the actual lower and upper corner
 * cuts. As a result, only the outer members bend into the four recessed levels
 * instead of accordion-folding the entire facade or laying a second
 * mini-diagrid over the chamfered glass.
 */
export function hearstFaceDiagonals(
  halfExtent: number,
  bays: number,
  nodeCut = 1.7,
  biteCut = 6.2,
): HearstFaceDiagonal[] {
  const result: HearstFaceDiagonal[] = [];
  for (let module = 0; module < HEARST_DIAGRID_MODULES; module++) {
    for (let bay = 0; bay < bays; bay++) {
      const slopesTowardLowerAlong = (module + bay) % 2 === 0;
      const lowerIndex = slopesTowardLowerAlong ? bay + 1 : bay;
      const upperIndex = slopesTowardLowerAlong ? bay : bay + 1;
      result.push({
        module,
        bay,
        lowerAlong: hearstFaceGridAlong(
          module, lowerIndex, halfExtent, bays, nodeCut, biteCut,
        ),
        upperAlong: hearstFaceGridAlong(
          module + 1, upperIndex, halfExtent, bays, nodeCut, biteCut,
        ),
      });
    }
  }
  return result;
}

/**
 * Sixteen points keep the broad middle of each curtain-wall face unchanged.
 * Only the short wings beside a corner and the chamfer itself move inward at a
 * bird's-mouth node, avoiding a diagonal fold across the main glass planes.
 */
function hearstCurtainPlan(
  cut: number,
  halfWidth: number,
  halfDepth: number,
  biteCut: number,
): HearstPlanPoint[] {
  return [
    [-halfWidth + cut, -halfDepth],
    [-halfWidth + biteCut, -halfDepth],
    [halfWidth - biteCut, -halfDepth],
    [halfWidth - cut, -halfDepth],
    [halfWidth, -halfDepth + cut],
    [halfWidth, -halfDepth + biteCut],
    [halfWidth, halfDepth - biteCut],
    [halfWidth, halfDepth - cut],
    [halfWidth - cut, halfDepth],
    [halfWidth - biteCut, halfDepth],
    [-halfWidth + biteCut, halfDepth],
    [-halfWidth + cut, halfDepth],
    [-halfWidth, halfDepth - cut],
    [-halfWidth, halfDepth - biteCut],
    [-halfWidth, -halfDepth + biteCut],
    [-halfWidth, -halfDepth + cut],
  ];
}

export function hearstBirdMouthLevels(
  y0: number,
  y1: number,
  halfWidth = 24,
  halfDepth = 18.5,
  nodeCut = 1.7,
  biteCut = 6.2,
): { y: number; points: HearstPlanPoint[] }[] {
  const moduleH = (y1 - y0) / HEARST_DIAGRID_MODULES;
  return Array.from({ length: HEARST_DIAGRID_MODULES + 1 }, (_, boundary) => ({
    y: y0 + boundary * moduleH,
    points: hearstCurtainPlan(
      hearstBoundaryCut(boundary, nodeCut, biteCut),
      halfWidth,
      halfDepth,
      biteCut,
    ),
  }));
}
