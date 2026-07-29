export interface PopulationDensitySample {
  pedestrian: number;
  commerce: number;
  cycling: number;
  park: number;
  transit: number;
}

/** Stable half-metre identity used to deduplicate streamed context anchors. */
export function populationAnchorKey(kind: string, x: number, z: number): string {
  return `${kind}:${Math.round(x * 2)}:${Math.round(z * 2)}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function smoothDensityFalloff(distance: number, radius: number): number {
  const t = clamp01(1 - distance / radius);
  return t * t * (3 - 2 * t);
}

/**
 * Compose normalized anchor influences. Kept pure so contextual behavior is
 * deterministic and independently testable from asynchronous dataset loading.
 */
export function composePopulationDensity(
  station: number,
  landmark: number,
  park: number,
  bike: number,
): PopulationDensitySample {
  return {
    pedestrian: Math.min(1.35, 0.18 + station * 0.75 + landmark * 0.52 + park * 0.46),
    commerce: clamp01(station * 0.68 + landmark * 0.62 + park * 0.2),
    cycling: clamp01(0.12 + bike * 0.9 + park * 0.34),
    park: clamp01(park),
    transit: clamp01(station),
  };
}
