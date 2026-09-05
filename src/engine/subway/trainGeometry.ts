import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export const TRAIN_FLOOR_ABOVE_RAIL = 1.1;
export const TRAIN_DOOR_HALF_WIDTH = .65;
export interface CarDims { length: number; width: number; height: number; doors: number[] }
export function carDims(division: string): CarDims {
  const length = division === 'IRT' ? 15.5 : 18.3;
  return { length, width: division === 'IRT' ? 2.7 : 3.0, height: division === 'IRT' ? 2.5 : 2.55,
    doors: (division === 'IRT' ? [-.27, 0, .27] : [-.34, -.34/3, .34/3, .34]).map(x => x * length) };
}
export function wallSegments(dims: CarDims): { cx: number; w: number; mid: boolean }[] {
  const result = [];
  let start = -dims.length / 2;
  for (let i = 0; i <= dims.doors.length; i++) {
    const end = i < dims.doors.length ? dims.doors[i] - TRAIN_DOOR_HALF_WIDTH : dims.length / 2;
    result.push({ cx: (start + end) / 2, w: end - start, mid: i > 0 && i < dims.doors.length });
    start = end + TRAIN_DOOR_HALF_WIDTH * 2;
  }
  return result;
}
/** A complete leaf: steel below/above the window and continuous side stiles.
 * Closed pairs meet at the center and cover the complete 1.30m opening. */
export function trainDoorFrame(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(.65, .80, .05).translate(0, .40, 0),
    new THREE.BoxGeometry(.65, .28, .05).translate(0, 1.76, 0),
    new THREE.BoxGeometry(.075, .82, .05).translate(-.2875, 1.21, 0),
    new THREE.BoxGeometry(.075, .82, .05).translate(.2875, 1.21, 0),
  ];
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach(p => p.dispose());
  return geometry;
}
