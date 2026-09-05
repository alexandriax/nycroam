/** Conservative startup budgets; runtime timing, rather than touch support,
 * determines whether the renderer needs to shed work. */
export interface QualityTier {
  shadows: boolean;
  shadowMapSize: number;
  stationShadowMapSize: number;
  pixelRatioCap: number;
  anisotropy: number;
  clouds: number;
  population: number;
  minPixelRatio: number;
}
export function detectQuality(nav: { userAgent: string; maxTouchPoints: number; hardwareConcurrency?: number; deviceMemory?: number }): QualityTier {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent) ||
    (/Macintosh/i.test(nav.userAgent) && nav.maxTouchPoints > 1);
  const constrained = (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) ||
    (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4);
  return mobile || constrained
    ? { shadows: false, shadowMapSize: 1024, stationShadowMapSize: 1024, pixelRatioCap: 1.5, anisotropy: 4, clouds: 6, population: 28, minPixelRatio: 0.7 }
    : { shadows: true, shadowMapSize: 2048, stationShadowMapSize: 1024, pixelRatioCap: 2, anisotropy: 8, clouds: 10, population: 72, minPixelRatio: 0.75 };
}
let tier: QualityTier | null = null;
export function quality(): QualityTier {
  return tier ??= detectQuality(typeof navigator === 'undefined'
    ? { userAgent: '', maxTouchPoints: 0 } : navigator);
}
/** Cap actual pixel count as well as DPR: a 4K screen must not allocate 8K. */
export function pixelBudgetRatio(width: number, height: number, dpr: number, cap: number): number {
  return Math.min(dpr || 1, cap, Math.sqrt(3_200_000 / Math.max(1, width * height)));
}
