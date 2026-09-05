import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Side-panel strips follow real curved wheel openings instead of masking
 * wheels with black rectangles laid over an uncut bus body. */
export function busSidePanel(a: number, b: number, y0: number, y1: number, depth: number): THREE.BufferGeometry {
  const radius = .55, wheelY = .48, axles = [3.2, -3.6];
  const cuts = [a, b];
  for (const axle of axles) {
    for (let i = 0; i <= 16; i++) cuts.push(axle - radius + i * radius / 8);
    for (const y of [y0, y1]) if (y > wheelY && y < wheelY + radius) {
      const dx = Math.sqrt(radius * radius - (y - wheelY) ** 2);
      cuts.push(axle - dx, axle + dx);
    }
  }
  const xs = [...new Set(cuts.filter(x => x >= a && x <= b))].sort((x,y) => x-y);
  const lower = (x: number) => {
    let y = y0;
    for (const axle of axles) if (Math.abs(x - axle) < radius) y = Math.max(y, wheelY + Math.sqrt(radius * radius - (x - axle) ** 2));
    return Math.min(y1, y);
  };
  const parts = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i], x1 = xs[i+1];
    if (lower((x0+x1)/2) >= y1 - 1e-6) continue;
    const shape = new THREE.Shape();
    shape.moveTo(x0, lower(x0)); shape.lineTo(x1, lower(x1));
    shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.closePath();
    parts.push(new THREE.ExtrudeGeometry(shape, {depth, bevelEnabled:false, steps:1}).translate(0,0,-depth/2));
  }
  const geometry = parts.length ? mergeGeometries(parts, false)! : new THREE.BufferGeometry();
  parts.forEach(p => p.dispose());
  return geometry;
}
