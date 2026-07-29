function pointInRing([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pointInFootprint(point, footprint) {
  if (!pointInRing(point, footprint.outer)) return false;
  return !(footprint.holes ?? []).some((hole) => pointInRing(point, hole));
}

function bboxOf(ring) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/**
 * Measures the union of parts that actually reach the building's lowest
 * occupied storey. Area sums are deliberately avoided: vertically stacked or
 * overlapping parts must not count the same square metre more than once.
 */
export function groundPartCoverage(
  building,
  parts,
  { maxGroundBase = 4.5, coarseGrid = 12, fineGrid = 36, minSamples = 16 } = {},
) {
  const groundParts = parts
    .filter((part) => (part.minHeight ?? 0) <= maxGroundBase)
    .map((part) => ({ ...part, bbox: bboxOf(part.outer) }));
  if (!groundParts.length) return 0;

  const [x0, z0, x1, z1] = bboxOf(building.outer);
  if (!(x1 > x0 && z1 > z0)) return 0;

  let inside = 0;
  let covered = 0;
  for (const gridSize of [coarseGrid, fineGrid]) {
    inside = 0;
    covered = 0;
    for (let ix = 0; ix < gridSize; ix++) {
      const x = x0 + ((ix + 0.5) / gridSize) * (x1 - x0);
      for (let iz = 0; iz < gridSize; iz++) {
        const z = z0 + ((iz + 0.5) / gridSize) * (z1 - z0);
        const point = [x, z];
        if (!pointInFootprint(point, building)) continue;
        inside++;
        for (const part of groundParts) {
          const [px0, pz0, px1, pz1] = part.bbox;
          if (x < px0 || x > px1 || z < pz0 || z > pz1) continue;
          if (pointInFootprint(point, part)) {
            covered++;
            break;
          }
        }
      }
    }
    if (inside >= minSamples) break;
  }
  return inside >= minSamples ? covered / inside : 0;
}

/**
 * Preserves the established outline suppression for normal stepped buildings,
 * but refuses to erase the only solid mass beneath an implausibly broad,
 * very-high tier. The latter pattern usually means incomplete part mapping,
 * not an intentional hundred-metre-tall open frame.
 */
export function shouldSuppressBuildingOutline(building, parts) {
  if (!(building.area > 0)) return false;
  const stackedAreaCoverage = parts.reduce((sum, part) => sum + part.area, 0) / building.area;
  if (stackedAreaCoverage <= 0.85) return false;

  const groundCoverage = groundPartCoverage(building, parts);
  const hasBroadVeryHighTier = parts.some(
    (part) => (part.minHeight ?? 0) >= 80 && part.area / building.area >= 0.5,
  );
  const unsupportedUpperMass = groundCoverage < 0.6 && hasBroadVeryHighTier;
  return !unsupportedUpperMass;
}
