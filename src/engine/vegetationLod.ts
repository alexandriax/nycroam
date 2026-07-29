export const TREE_NEAR_DISTANCE = 190;
export const TREE_MID_DISTANCE = 470;
export const TREE_SILHOUETTE_FAMILIES = 4;

/** At any distance bucket, one tile stays within this vegetation draw budget. */
export const TREE_LOD_DRAW_CEILINGS = {
  near: 5, // four actual crown silhouettes + one shared trunk draw
  mid: 1, // low-poly clustered crown
  far: 1, // solid geometric impostor; no mobile alpha overdraw
} as const;

export type TreeLod = 0 | 1 | 2;

export function treeLodForDistanceSq(distanceSq: number): TreeLod {
  if (distanceSq < TREE_NEAR_DISTANCE * TREE_NEAR_DISTANCE) return 0;
  if (distanceSq < TREE_MID_DISTANCE * TREE_MID_DISTANCE) return 1;
  return 2;
}

/** Exact vegetation draw count for a populated tile at one active LOD. */
export function treeDrawCount(lod: TreeLod, populatedNearFamilies = TREE_SILHOUETTE_FAMILIES): number {
  if (lod === 0) {
    const families = Math.max(0, Math.min(TREE_SILHOUETTE_FAMILIES, Math.floor(populatedNearFamilies)));
    return families + 1; // one shared trunk draw
  }
  return 1;
}
