import type { BuildingArchetype, TileBuilding } from './tileTypes';

export type WindowArchetype =
  | 0 // punched / double-hung
  | 1 // curtain-wall grid
  | 2 // industrial multi-pane
  | 3 // bay / rowhouse
  | 4 // horizontal ribbon
  | 5 // arched / civic
  | 6 // balcony door
  | 7; // mixed storefront + upper windows

export type StorefrontCategory =
  | 0 // none
  | 1 // retail display
  | 2 // restaurant / hospitality
  | 3 // office / commercial lobby
  | 4 // loading / industrial
  | 5; // institutional entrance

export type ConstructionEra =
  | 0 // unknown
  | 1 // pre-1880
  | 2 // 1880–1919
  | 3 // 1920–1945
  | 4 // 1946–1974
  | 5 // 1975–1999
  | 6; // 2000+

export type RoofFamily =
  | 0 // flat
  | 1 // pyramidal / hipped
  | 2 // gabled
  | 3 // skillion / shed
  | 4 // dome / cone / onion
  | 5 // mansard
  | 6 // green / terrace
  | 7; // sawtooth / industrial

export interface BuildingSemantics {
  archetype: BuildingArchetype;
  window: WindowArchetype;
  /** Quantized façade opening ratio, 0..15. */
  windowRatio: number;
  storefront: StorefrontCategory;
  era: ConstructionEra;
  roof: RoofFamily;
  /** 0 = fallback, 1 = contextual, 2 = geometry/tag, 3 = explicit source. */
  confidence: number;
}

const ARCHETYPE_SCALE = 16;
const WINDOW_SCALE = ARCHETYPE_SCALE * 8;
const RATIO_SCALE = WINDOW_SCALE * 16;
const STOREFRONT_SCALE = RATIO_SCALE * 8;
const ERA_SCALE = STOREFRONT_SCALE * 8;
const ROOF_SCALE = ERA_SCALE * 8;

function field(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/** Pack to 23 bits, remaining exactly representable in both JS numbers and float32. */
export function packBuildingSemantics(value: BuildingSemantics): number {
  return field(value.archetype, 15)
    + field(value.window, 7) * ARCHETYPE_SCALE
    + field(value.windowRatio, 15) * WINDOW_SCALE
    + field(value.storefront, 7) * RATIO_SCALE
    + field(value.era, 7) * STOREFRONT_SCALE
    + field(value.roof, 7) * ERA_SCALE
    + field(value.confidence, 3) * ROOF_SCALE;
}

export function unpackBuildingSemantics(word: number): BuildingSemantics {
  const safe = Number.isFinite(word) ? Math.max(0, Math.round(word)) : 0;
  return {
    archetype: (safe % 16) as BuildingArchetype,
    window: (Math.floor(safe / ARCHETYPE_SCALE) % 8) as WindowArchetype,
    windowRatio: Math.floor(safe / WINDOW_SCALE) % 16,
    storefront: (Math.floor(safe / RATIO_SCALE) % 8) as StorefrontCategory,
    era: (Math.floor(safe / STOREFRONT_SCALE) % 8) as ConstructionEra,
    roof: (Math.floor(safe / ERA_SCALE) % 8) as RoofFamily,
    confidence: Math.floor(safe / ROOF_SCALE) % 4,
  };
}

const LEGACY_DEFAULTS: readonly Omit<BuildingSemantics, 'archetype' | 'roof' | 'confidence'>[] = [
  { window: 0, windowRatio: 7, storefront: 0, era: 2 },
  { window: 1, windowRatio: 13, storefront: 3, era: 5 },
  { window: 5, windowRatio: 5, storefront: 5, era: 2 },
  { window: 4, windowRatio: 8, storefront: 0, era: 4 },
  { window: 2, windowRatio: 10, storefront: 4, era: 2 },
  { window: 3, windowRatio: 6, storefront: 0, era: 2 },
  { window: 1, windowRatio: 11, storefront: 3, era: 5 },
  { window: 7, windowRatio: 9, storefront: 1, era: 3 },
  { window: 2, windowRatio: 11, storefront: 1, era: 1 },
  { window: 6, windowRatio: 10, storefront: 0, era: 6 },
  { window: 0, windowRatio: 8, storefront: 3, era: 3 },
  { window: 0, windowRatio: 7, storefront: 1, era: 6 },
  { window: 5, windowRatio: 6, storefront: 5, era: 3 },
  { window: 4, windowRatio: 6, storefront: 4, era: 4 },
  { window: 3, windowRatio: 5, storefront: 0, era: 1 },
  { window: 4, windowRatio: 9, storefront: 2, era: 4 },
];

/** Expand legacy `a`-only public tiles into the richer shader/roof contract. */
export function semanticsForBuilding(building: TileBuilding, fallback: BuildingArchetype): BuildingSemantics {
  if (building.s !== undefined) return unpackBuildingSemantics(building.s);
  const archetype = (
    Number.isInteger(building.a) && (building.a as number) >= 0 && (building.a as number) <= 15
      ? building.a
      : fallback
  ) as BuildingArchetype;
  const defaults = LEGACY_DEFAULTS[archetype];
  return {
    archetype,
    ...defaults,
    roof: roofFamilyFromTag(building.r),
    confidence: building.a === undefined ? 0 : 2,
  };
}

export function roofFamilyFromTag(raw?: string): RoofFamily {
  const tag = (raw ?? '').toLowerCase();
  if (/green|terrace/.test(tag)) return 6;
  if (/sawtooth/.test(tag)) return 7;
  if (/mansard/.test(tag)) return 5;
  if (/dome|round|cone|onion/.test(tag)) return 4;
  if (/skillion|shed|lean_to/.test(tag)) return 3;
  if (/gabled|saltbox|gambrel/.test(tag)) return 2;
  if (/pyramidal|hipped/.test(tag)) return 1;
  return 0;
}

/** Opening fraction used by the façade shader and sparse-detail placement. */
export function windowRatio01(quantized: number): number {
  return 0.22 + field(quantized, 15) * (0.58 / 15);
}
