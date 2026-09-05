export const TREE_NEAR_DISTANCE = 70;
export const TREE_MID_DISTANCE = 470;
export const TREE_SILHOUETTE_FAMILIES = 4;

/** At any distance bucket, one tile stays within this vegetation draw budget. */
export const TREE_LOD_DRAW_CEILINGS = {
  near: 5, // four actual crown silhouettes + one shared trunk draw
  mid: 2, // clustered crown + shared trunks
  far: 1, // solid geometric impostor; no mobile alpha overdraw
} as const;

export type TreeLod = 0 | 1 | 2;

export function treeLodForDistanceSq(distanceSq: number, previous?: TreeLod): TreeLod {
  const hysteresis = previous === undefined ? 0 : 8;
  const near = TREE_NEAR_DISTANCE + (previous === 0 ? hysteresis : -hysteresis);
  const mid = TREE_MID_DISTANCE + (previous === 2 ? -hysteresis : hysteresis);
  if (distanceSq < near * near) return 0;
  if (distanceSq < mid * mid) return 1;
  return 2;
}

/** Exact vegetation draw count for a populated tile at one active LOD. */
export function treeDrawCount(lod: TreeLod, populatedNearFamilies = TREE_SILHOUETTE_FAMILIES): number {
  if (lod === 0) {
    const families = Math.max(0, Math.min(TREE_SILHOUETTE_FAMILIES, Math.floor(populatedNearFamilies)));
    return families + 1; // one shared trunk draw
  }
  return lod === 1 ? 2 : 1;
}
