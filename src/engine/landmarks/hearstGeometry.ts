export type HearstPlanPoint = [number, number];

/** Hearst's diagrid runs from roughly floor 10 through floor 46. */
export const HEARST_DIAGRID_MODULES = 9;

/**
 * The four recessed corner nodes occur at floors 14, 22, 30 and 38: every
 * other four-floor module boundary, rather than in the middle of every module.
 */
export const HEARST_BIRD_MOUTH_BOUNDARIES: readonly number[] = [1, 3, 5, 7];

/** 28 face, 16 corner and eight perimeter members at each relevant tier. */
export const HEARST_DIAGRID_BEAM_COUNT =
  (28 + 16) * HEARST_DIAGRID_MODULES + 8 * (HEARST_DIAGRID_MODULES + 1);

export function hearstBoundaryCut(
  boundary: number,
  nodeCut: number,
  biteCut: number,
): number {
  return HEARST_BIRD_MOUTH_BOUNDARIES.includes(boundary) ? biteCut : nodeCut;
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
