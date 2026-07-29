/** Append flat [x,y,z,category] anchors within radius, reusing caller storage. */
export function appendRetailAnchorsWithin(
  anchors: Float32Array,
  x: number,
  z: number,
  radiusSq: number,
  out: number[],
  maxAnchors = 4096,
): boolean {
  for (let i = 0; i < anchors.length; i += 4) {
    if ((anchors[i] - x) ** 2 + (anchors[i + 2] - z) ** 2 > radiusSq) continue;
    out.push(anchors[i], anchors[i + 1], anchors[i + 2], anchors[i + 3]);
    if (out.length / 4 >= maxAnchors) return true;
  }
  return false;
}
