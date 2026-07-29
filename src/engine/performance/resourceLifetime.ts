export interface DisposableResource {
  dispose(): void;
}

/**
 * Dispose an explicit ownership set exactly once.
 *
 * GPU resources are frequently shared by many meshes. Scene traversal cannot
 * distinguish a per-tile sign material from a manager-wide tree material, so
 * unload paths must dispose only resources registered to that tile.
 */
export function disposeOwnedResources(...groups: readonly DisposableResource[][]): void {
  const disposed = new Set<DisposableResource>();
  for (const group of groups) {
    for (const resource of group) {
      if (disposed.has(resource)) continue;
      disposed.add(resource);
      resource.dispose();
    }
  }
}
