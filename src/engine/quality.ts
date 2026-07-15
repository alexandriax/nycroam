// One-time device quality detection. Desktop gets the full treatment;
// mobile keeps the lean path that already runs well.

export interface QualityTier {
  shadows: boolean;
  shadowMapSize: number;
  stationShadowMapSize: number;
  pixelRatioCap: number;
  anisotropy: number;
  clouds: number; // billboard count
}

let tier: QualityTier | null = null;

export function quality(): QualityTier {
  if (tier) return tier;
  const isMobile =
    typeof navigator !== 'undefined' &&
    (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1);
  tier = isMobile
    ? { shadows: false, shadowMapSize: 1024, stationShadowMapSize: 1024, pixelRatioCap: 1.5, anisotropy: 4, clouds: 6 }
    : { shadows: true, shadowMapSize: 4096, stationShadowMapSize: 2048, pixelRatioCap: 2, anisotropy: 8, clouds: 10 };
  return tier;
}
