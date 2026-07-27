// Device quality detection, resolved once per session.
//
// The previous version was a single boolean: a UA regex for "Android|iPhone|
// iPad|Mobile" (or any touch device) picked a mobile profile, everything else
// got the desktop one. That got two things badly wrong. A 2024 iPad or a recent
// Android flagship renders shadows comfortably and was being handed a scene with
// none at all, which is the single biggest visual gap between the two profiles.
// In the other direction, a touch-capable laptop and an integrated-GPU machine
// running a software rasteriser both scored as full desktop and dropped frames.
//
// So detection is now about the GPU and the machine, with touch as one weak
// signal among several, and the result is a LADDER rather than a binary: the
// adaptive loop can walk it down at runtime, and the player can pin it.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityTier {
  level: QualityLevel;
  shadows: boolean;
  /**
   * Whether SUBWAY INTERIORS run a shadow pass, separately from the street.
   *
   * These are not the same cost. The street's shadow frustum is bounded by the
   * altitude ladder in sky.ts and sees a handful of merged tile meshes. A
   * station complex is thousands of individual props: Times Square marks 3,818
   * casters, so switching its light to castShadow adds 3,818 draw calls to
   * every frame, on top of the ~5,700 the interior already costs. That is
   * affordable on a desktop GPU and is not affordable on a phone, where a
   * sustained overload gets the tab killed rather than merely slowed.
   */
  stationShadows: boolean;
  shadowMapSize: number;
  stationShadowMapSize: number;
  pixelRatioCap: number;
  anisotropy: number;
  clouds: number; // billboard count
  /** Tile streaming radius in metres (World widens this with altitude). */
  loadRadius: number;
  /** Camera far plane; the sky dome is sized from it. */
  farPlane: number;
  /** Tile-builder web workers. */
  tileWorkers: number;
}

const TIERS: Record<QualityLevel, Omit<QualityTier, 'level'>> = {
  // Software rasterisers and 2015-era mobile GPUs. No shadow pass at all, half
  // the draw distance, and a hard 1x pixel ratio.
  low: {
    shadows: false, stationShadows: false, shadowMapSize: 1024, stationShadowMapSize: 1024,
    pixelRatioCap: 1, anisotropy: 2, clouds: 4, loadRadius: 620, farPlane: 3400, tileWorkers: 2,
  },
  // Mainstream phones and tablets. Shadows ON -- a 1536 map over the 300 m
  // street-level box is ~0.25 m per texel, which is the whole point of the
  // altitude ladder in sky.ts: the near band stays sharp without a big map.
  medium: {
    shadows: true, stationShadows: false, shadowMapSize: 1536, stationShadowMapSize: 1024,
    pixelRatioCap: 1.5, anisotropy: 4, clouds: 6, loadRadius: 820, farPlane: 4600, tileWorkers: 2,
  },
  high: {
    shadows: true, stationShadows: true, shadowMapSize: 2048, stationShadowMapSize: 2048,
    pixelRatioCap: 2, anisotropy: 8, clouds: 8, loadRadius: 1150, farPlane: 6500, tileWorkers: 3,
  },
  ultra: {
    shadows: true, stationShadows: true, shadowMapSize: 4096, stationShadowMapSize: 2048,
    pixelRatioCap: 2, anisotropy: 16, clouds: 10, loadRadius: 1350, farPlane: 7200, tileWorkers: 4,
  },
};

const OVERRIDE_KEY = 'nycroam-quality';
const LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

let tier: QualityTier | null = null;
let detected: QualityLevel | null = null;

/** Unmasked GL renderer string, or '' when the extension is unavailable. */
function gpuString(): string {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (!gl) return '';
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    const s = ext ? (gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    // free the probe context immediately; browsers cap live GL contexts
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

function detect(): QualityLevel {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return 'high';
  const gpu = gpuString().toLowerCase();
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  const touch = navigator.maxTouchPoints > 1;
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  // No GPU at all, or a software rasteriser pretending to be one. These render
  // every pixel on the CPU; nothing above `low` is usable.
  if (/swiftshader|llvmpipe|softwarepipe|basic render|microsoft basic/.test(gpu)) return 'low';

  // Mobile GPU generations that predate usable shadow-map performance in a
  // browser. Matched on family, not model, because the model strings vary wildly
  // between vendors and browsers.
  if (/mali-4|mali-t6|mali-t7|mali-t8|adreno \(tm\) [345]|powervr (sgx|rogue g6)|videocore/.test(gpu)) return 'low';

  // Apple GPUs report as "Apple A17 GPU" / "Apple M2" / plain "Apple GPU" on
  // iOS. The M-series desktops are the fastest thing we run on.
  if (/apple m\d/.test(gpu)) return 'ultra';
  if (/apple/.test(gpu) && !uaMobile) return 'ultra';

  // HANDHELDS CAP AT MEDIUM, whatever the GPU string says.
  //
  // A flagship phone can render a 2048 shadow map and a 1150 m streaming radius
  // for a while -- and then it heats up, and a browser that has been pinned at
  // 100% GPU does not get slower, it gets its tab killed. `high` also turns on
  // the subway-interior shadow pass, which is thousands of extra draw calls
  // inside a station. None of that is worth a crash to a player who cannot see
  // the difference on a 6-inch screen; anyone who wants it can pin a level from
  // the HUD. Tablets and touch laptops (touch, but not a phone UA) keep their
  // GPU-derived tier.
  if (uaMobile) return 'medium';
  if (touch && cores <= 6) return 'medium';

  // Desktop. Discrete parts get ultra; integrated and low-core machines drop a
  // notch, since they share bandwidth with the rest of the system.
  if (/nvidia|geforce|rtx|radeon rx|arc a\d/.test(gpu)) return 'ultra';
  if (/intel|uhd graphics|iris|vega|radeon graphics/.test(gpu)) return cores >= 8 ? 'high' : 'medium';
  if (cores <= 4 || (mem && mem <= 4)) return 'medium';
  return 'high';
}

function stored(): QualityLevel | null {
  try {
    const v = localStorage.getItem(OVERRIDE_KEY);
    return v && (LEVELS as string[]).includes(v) ? (v as QualityLevel) : null;
  } catch {
    return null;
  }
}

export function quality(): QualityTier {
  if (tier) return tier;
  detected = detect();
  const level = stored() ?? detected;
  tier = { level, ...TIERS[level] };
  return tier;
}

/** The level detection picked, ignoring any saved override. */
export function detectedQuality(): QualityLevel {
  if (!detected) quality();
  return detected!;
}

/**
 * Pin the quality level (or clear the pin with null) and persist it. The scene
 * is built from these numbers at construction, so the caller reloads; that is
 * far simpler and less bug-prone than tearing down and rebuilding every
 * material, shadow map and worker pool in place.
 */
export function setQualityOverride(level: QualityLevel | null) {
  try {
    if (level) localStorage.setItem(OVERRIDE_KEY, level);
    else localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* private browsing: the choice just does not persist */
  }
  tier = null;
}

export function qualityOverride(): QualityLevel | null {
  return stored();
}

export const QUALITY_LEVELS = LEVELS;
