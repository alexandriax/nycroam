/** Shared facade shader/material handoff contract. */
export const FACADE_DETAIL_HYSTERESIS_METERS = 140;
export const FACADE_DETAIL_FADE_GUARD_METERS = 24;

export interface FacadeDetailLod {
  detailIn: number;
  detailOut: number;
  fadeStart: number;
  fadeEnd: number;
}

/**
 * The detailed shader must be fully neutral before either material boundary.
 * Keeping this math shared prevents a quality-tier radius change from turning
 * into a whole-tile reflection/exposure pop.
 */
export function facadeDetailLod(loadRadius: number): FacadeDetailLod {
  const detailOut = Math.min(900, loadRadius * 0.78);
  const detailIn = detailOut - FACADE_DETAIL_HYSTERESIS_METERS;
  const fadeEnd = Math.max(136, detailIn - FACADE_DETAIL_FADE_GUARD_METERS);
  const fadeSpan = Math.min(320, Math.max(176, loadRadius * 0.28));
  return {
    detailIn,
    detailOut,
    fadeStart: Math.max(112, fadeEnd - fadeSpan),
    fadeEnd,
  };
}
