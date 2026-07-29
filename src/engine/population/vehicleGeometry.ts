import * as THREE from 'three';

/**
 * Closed, outward-wound passenger-car body shell.
 *
 * +x is travel-forward and +z spans the vehicle. Keeping this as one indexed
 * geometry preserves the single pooled body draw while the closed topology
 * makes every exterior panel visible with the default FrontSide material.
 */
export function buildVehicleBodyGeometry(): THREE.BufferGeometry {
  const sections = [
    { x: -2.28, width: 0.72, lower: 0.68, shoulder: 0.62, top: 0.65 },
    { x: -1.78, width: 0.89, lower: 0.76, shoulder: 0.76, top: 0.86 },
    { x: -1.12, width: 0.94, lower: 0.8, shoulder: 0.79, top: 0.91 },
    { x: 0.78, width: 0.94, lower: 0.8, shoulder: 0.8, top: 0.91 },
    { x: 1.58, width: 0.9, lower: 0.76, shoulder: 0.75, top: 0.82 },
    { x: 2.28, width: 0.7, lower: 0.65, shoulder: 0.58, top: 0.61 },
  ] as const;
  const positions: number[] = [];
  for (const section of sections) {
    const belt = Math.max(0.53, section.top - 0.1);
    positions.push(
      section.x, 0.27, -section.lower,
      section.x, 0.39, -section.width,
      section.x, belt, -section.width * 0.98,
      section.x, section.top, -section.shoulder,
      section.x, section.top, section.shoulder,
      section.x, belt, section.width * 0.98,
      section.x, 0.39, section.width,
      section.x, 0.27, section.lower,
    );
  }

  const indices: number[] = [];
  for (let section = 0; section < sections.length - 1; section++) {
    const a = section * 8;
    const b = a + 8;
    for (let edge = 0; edge < 8; edge++) {
      const next = (edge + 1) % 8;
      // Cross-sections run counter-clockwise in yz. Side faces therefore run
      // from the current section around its perimeter before advancing in +x.
      // Reversing that order points normals into the shell and makes exterior
      // panels disappear under WebGL's normal back-face culling.
      indices.push(
        a + edge, a + next, b + next,
        a + edge, b + next, b + edge,
      );
    }
  }

  // End caps follow the matching outward winding: -x at the rear, +x ahead.
  for (let edge = 1; edge < 7; edge++) indices.push(0, edge + 1, edge);
  const end = (sections.length - 1) * 8;
  for (let edge = 1; edge < 7; edge++) indices.push(end, end + edge, end + edge + 1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
