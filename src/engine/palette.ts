// Building color selection. Deterministic per building via hash.
import type { BuildingArchetype } from './tileTypes';

export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

type Rgb = [number, number, number];

// Manhattan-ish material palettes [r,g,b] 0..1. Every archetype has a small
// stable family rather than a unique material, preserving the merged façade
// draw while giving the shader a semantically meaningful aStyle.
const BRICK_PREWAR: Rgb[] = [
  [0.62, 0.45, 0.36], // brick red-brown
  [0.71, 0.55, 0.44], // warm brick
  [0.55, 0.38, 0.31], // dark brick
  [0.68, 0.52, 0.42], // weathered brick
  [0.58, 0.5, 0.44],  // painted masonry
];

const GLASS_CURTAIN: Rgb[] = [
  [0.62, 0.68, 0.74], // glass blue-gray
  [0.68, 0.72, 0.75], // silver glass
  [0.58, 0.62, 0.66], // dark glass
  [0.55, 0.6, 0.68],  // blue curtain wall
];

const STONE: Rgb[] = [
  [0.76, 0.7, 0.58],
  [0.8, 0.76, 0.68],
  [0.72, 0.69, 0.63],
  [0.67, 0.64, 0.59],
];

const CONCRETE_POSTWAR: Rgb[] = [
  [0.63, 0.64, 0.63],
  [0.69, 0.68, 0.64],
  [0.57, 0.59, 0.61],
  [0.73, 0.71, 0.66],
];

const INDUSTRIAL_LOFT: Rgb[] = [
  [0.53, 0.38, 0.31],
  [0.58, 0.45, 0.37],
  [0.48, 0.46, 0.43],
  [0.63, 0.57, 0.49],
];

const BROWNSTONE: Rgb[] = [
  [0.5, 0.36, 0.29],
  [0.57, 0.42, 0.34],
  [0.62, 0.48, 0.39],
  [0.53, 0.44, 0.39],
];

const METAL_COMMERCIAL: Rgb[] = [
  [0.54, 0.58, 0.61],
  [0.62, 0.64, 0.64],
  [0.46, 0.5, 0.54],
  [0.67, 0.65, 0.59],
];

const MIXED_STOREFRONT: Rgb[] = [
  [0.64, 0.49, 0.39],
  [0.7, 0.61, 0.5],
  [0.59, 0.56, 0.52],
  [0.67, 0.57, 0.46],
];

const CAST_IRON_LOFT: Rgb[] = [
  [0.64, 0.63, 0.59],
  [0.49, 0.53, 0.54],
  [0.72, 0.69, 0.61],
  [0.42, 0.47, 0.48],
];

const RESIDENTIAL_TOWER: Rgb[] = [
  [0.66, 0.67, 0.66],
  [0.72, 0.7, 0.65],
  [0.57, 0.61, 0.64],
  [0.77, 0.75, 0.7],
];

const ART_DECO: Rgb[] = [
  [0.73, 0.68, 0.57],
  [0.68, 0.65, 0.58],
  [0.78, 0.73, 0.63],
  [0.62, 0.59, 0.53],
];

const MODERN_MASONRY: Rgb[] = [
  [0.61, 0.52, 0.45],
  [0.7, 0.62, 0.53],
  [0.55, 0.54, 0.52],
  [0.67, 0.59, 0.51],
];

const INSTITUTIONAL: Rgb[] = [
  [0.72, 0.69, 0.62],
  [0.65, 0.61, 0.54],
  [0.76, 0.72, 0.64],
  [0.59, 0.58, 0.55],
];

const WAREHOUSE_CONCRETE: Rgb[] = [
  [0.52, 0.52, 0.49],
  [0.58, 0.55, 0.49],
  [0.46, 0.49, 0.5],
  [0.62, 0.59, 0.54],
];

const WOOD_VERNACULAR: Rgb[] = [
  [0.66, 0.59, 0.49],
  [0.72, 0.69, 0.61],
  [0.53, 0.47, 0.4],
  [0.63, 0.65, 0.62],
];

const HOTEL_MIDCENTURY: Rgb[] = [
  [0.63, 0.62, 0.59],
  [0.69, 0.65, 0.57],
  [0.55, 0.58, 0.6],
  [0.71, 0.7, 0.66],
];

const ARCHETYPE_PALETTES: readonly Rgb[][] = [
  BRICK_PREWAR,
  GLASS_CURTAIN,
  STONE,
  CONCRETE_POSTWAR,
  INDUSTRIAL_LOFT,
  BROWNSTONE,
  METAL_COMMERCIAL,
  MIXED_STOREFRONT,
  CAST_IRON_LOFT,
  RESIDENTIAL_TOWER,
  ART_DECO,
  MODERN_MASONRY,
  INSTITUTIONAL,
  WAREHOUSE_CONCRETE,
  WOOD_VERNACULAR,
  HOTEL_MIDCENTURY,
];

const NAMED_COLORS: Record<string, Rgb> = {
  black: [0.06, 0.065, 0.07],
  white: [0.88, 0.87, 0.83],
  gray: [0.5, 0.5, 0.49],
  grey: [0.5, 0.5, 0.49],
  lightgray: [0.72, 0.72, 0.7],
  lightgrey: [0.72, 0.72, 0.7],
  darkgray: [0.31, 0.32, 0.32],
  darkgrey: [0.31, 0.32, 0.32],
  silver: [0.68, 0.69, 0.68],
  beige: [0.72, 0.65, 0.53],
  tan: [0.66, 0.54, 0.4],
  brown: [0.43, 0.3, 0.23],
  red: [0.56, 0.25, 0.2],
  orange: [0.68, 0.39, 0.19],
  yellow: [0.72, 0.62, 0.28],
  green: [0.27, 0.43, 0.3],
  blue: [0.3, 0.42, 0.55],
};

/** Parse the common OSM colour spellings without relying on DOM/CSS in a worker. */
export function parseOsmColor(raw?: string): Rgb | null {
  if (!raw) return null;
  const value = raw.split(';')[0].trim().toLowerCase().replace(/\s+/g, '');
  const named = NAMED_COLORS[value];
  if (named) return [...named] as Rgb;
  const short = value.match(/^#([0-9a-f]{3})$/i);
  const long = value.match(/^#?([0-9a-f]{6})$/i);
  const hex = short
    ? short[1].split('').map((c) => c + c).join('')
    : long?.[1];
  if (!hex) return null;
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/** Compatibility inference for already-deployed tiles that have no `a` field. */
export function legacyBuildingArchetype(seed: number, height: number, kind?: string): BuildingArchetype {
  const k = (kind ?? '').toLowerCase();
  if (/warehouse|garage|hangar/.test(k)) return 13;
  if (/industrial|manufactur|factory/.test(k)) return 4;
  if (/cabin|shed|farm|wood/.test(k)) return 14;
  if (/house|terrace|detached|bungalow/.test(k)) return 5;
  if (/church|cathedral|civic|government|museum|university|college|school|hospital/.test(k)) return 12;
  if (/hotel|motel/.test(k)) return height > 75 ? 1 : 15;
  if (/apartments|residential|dormitory/.test(k) && height >= 55) return 9;
  if (/retail|shop|commercial|supermarket/.test(k) && height < 45) return 7;
  if (/office|commercial/.test(k) && height >= 45) return hash01(seed + 23) < 0.7 ? 1 : 6;
  const r = hash01(seed);
  if (height >= 120) return r < 0.52 ? 1 : r < 0.72 ? 9 : r < 0.88 ? 10 : 3;
  if (height >= 55) return r < 0.28 ? 1 : r < 0.48 ? 9 : r < 0.66 ? 3 : r < 0.82 ? 10 : 0;
  if (height <= 18 && r < 0.24) return 5;
  if (height <= 35 && r > 0.92) return 7;
  if (height <= 35 && r > 0.84) return 11;
  return 0;
}

export function buildingColor(
  seed: number,
  height: number,
  archetype = legacyBuildingArchetype(seed, height),
  taggedColor?: string,
): { col: Rgb; glass: boolean; archetype: BuildingArchetype } {
  const safeArchetype = (
    Number.isInteger(archetype) && archetype >= 0 && archetype <= 15
      ? archetype
      : legacyBuildingArchetype(seed, height)
  ) as BuildingArchetype;
  const pool = ARCHETYPE_PALETTES[safeArchetype];
  const c = pool[Math.floor(hash01(seed + 7) * pool.length) % pool.length];
  const tagged = parseOsmColor(taggedColor);
  // Tagged colours are valuable identity signals, but a small palette blend
  // avoids pitch-black/fully saturated OSM values that collapse under lighting.
  const base: Rgb = tagged
    ? [
        tagged[0] * 0.82 + c[0] * 0.18,
        tagged[1] * 0.82 + c[1] * 0.18,
        tagged[2] * 0.82 + c[2] * 0.18,
      ]
    : c;
  // slight per-building jitter (also feeds the window shader's per-building randomness)
  const j = (hash01(seed + 13) - 0.5) * (tagged ? 0.025 : 0.07);
  return {
    col: [
      Math.min(0.92, Math.max(0.08, base[0] + j)),
      Math.min(0.92, Math.max(0.08, base[1] + j)),
      Math.min(0.92, Math.max(0.08, base[2] + j * 0.8)),
    ],
    glass: safeArchetype === 1,
    archetype: safeArchetype,
  };
}

export function roofColor(
  seed: number,
  material: string | undefined,
  taggedColor: string | undefined,
  facade: Rgb,
): Rgb {
  const explicit = parseOsmColor(taggedColor);
  if (explicit) return explicit;
  const m = (material ?? '').toLowerCase();
  let base: Rgb;
  if (/copper/.test(m)) base = hash01(seed + 41) < 0.68 ? [0.25, 0.43, 0.39] : [0.48, 0.31, 0.2];
  else if (/glass/.test(m)) base = [0.48, 0.57, 0.63];
  else if (/metal|steel|aluminium|tin/.test(m)) base = [0.48, 0.5, 0.49];
  else if (/tile|brick/.test(m)) base = [0.47, 0.29, 0.22];
  else if (/grass|green/.test(m)) base = [0.3, 0.43, 0.27];
  else if (/slate/.test(m)) base = [0.25, 0.29, 0.31];
  else if (/stone/.test(m)) base = [0.52, 0.51, 0.47];
  else base = [facade[0] * 0.72, facade[1] * 0.72, facade[2] * 0.72];
  const j = (hash01(seed + 43) - 0.5) * 0.035;
  return [
    Math.min(0.85, Math.max(0.08, base[0] + j)),
    Math.min(0.85, Math.max(0.08, base[1] + j)),
    Math.min(0.85, Math.max(0.08, base[2] + j)),
  ];
}
