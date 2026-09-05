import { carDims } from './trainGeometry';

export interface PlatformSpan { zMin: number; zMax: number }
/** The body shell ends at half the car width. Keep an 8cm nominal threshold
 * clearance without moving the track centers or the authored station layout. */
export const PLATFORM_TRAIN_CLEARANCE = .08;
const AUTHORING_HALF_TRACK_WIDTH = 2.2;

export function trackBesidePlatformEdge(trackZ: number, edgeZ: number, side: 1 | -1): boolean {
  const distance = (trackZ - edgeZ) * side;
  return distance > 0 && distance <= AUTHORING_HALF_TRACK_WIDTH + .01;
}

/** The full slab, its tactile edge, walkable footprint and passenger paths must
 * all consume these bounds. Extend only track-facing edges; outside walls and
 * every track/stair coordinate keep their authored positions. Idempotent. */
export function fitPlatformEdges<T extends PlatformSpan>(
  platforms: readonly T[], tracks: readonly number[], division: string,
): T[] {
  const distance = carDims(division).width / 2 + PLATFORM_TRAIN_CLEARANCE;
  return platforms.map(platform => {
    let { zMin, zMax } = platform;
    for (const trackZ of tracks) {
      if (trackBesidePlatformEdge(trackZ, platform.zMin, -1)) zMin = Math.min(zMin, trackZ + distance);
      if (trackBesidePlatformEdge(trackZ, platform.zMax, 1)) zMax = Math.max(zMax, trackZ - distance);
    }
    return { ...platform, zMin, zMax };
  });
}
