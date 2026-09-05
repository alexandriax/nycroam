import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A shared articulated human mesh, facing +X. Region colors preserve skin,
 * hair, denim, footwear and tailoring while instances vary jacket/skin tones. */
function part(geo: THREE.BufferGeometry, id: number, color: number, tint = 0, joint = 0): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  const c = new THREE.Color(color), colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  // Joint tags let seated poses bend complete segments without slicing triangles.
  geo.setAttribute('crowdJoint', new THREE.Float32BufferAttribute(new Float32Array(count).fill(joint), 1));
  geo.setAttribute('skinPart', new THREE.Float32BufferAttribute(new Float32Array(count).fill(id), 1));
  geo.setAttribute('crowdColor', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('crowdTint', new THREE.Float32BufferAttribute(new Float32Array(count).fill(tint), 1));
  return geo;
}
function sphere(x: number, y: number, z: number, sx: number, sy: number, sz: number, segments = 8, rows = 6) {
  const g = new THREE.SphereGeometry(1, segments, rows);
  g.scale(sx, sy, sz); g.translate(x, y, z); return g;
}
function box(x: number, y: number, z: number, w: number, h: number, d: number) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g;
}
function taper(x: number, y: number, z: number, top: number, bottom: number, h: number, sx = 1, sz = 1, segments = 8) {
  const g = new THREE.CylinderGeometry(top, bottom, h, segments);
  g.scale(sx, 1, sz); g.translate(x, y, z); return g;
}
function merge(parts: THREE.BufferGeometry[]) {
  const geometry = mergeGeometries(parts, false);
  parts.forEach(g => g.dispose());
  if (!geometry) throw new Error('Could not merge pedestrian geometry');
  return geometry;
}
export function buildPedestrianGeometry(): THREE.BufferGeometry {
  const pieces = [
    part(taper(0, 1.21, 0, .255, .19, .54, .58, .9), 0, 0xffffff, 1),
    part(taper(0, .88, 0, .19, .205, .16, .62, 1), 0, 0x454b57, .2),
    // Shirt placket, collar, waistband and a small commuter bag are geometry
    // in the same draw, so they survive oblique views and receive light.
    part(box(.148, 1.21, 0, .008, .45, .016), 0, 0xddd8cb, .3),
    part(box(.08, 1.475, 0, .15, .035, .18), 0, 0xdedbd2, .1),
    part(box(0, .975, 0, .235, .035, .4), 0, 0x242326),
    part(box(-.15, 1.20, .06, .12, .32, .25), 0, 0x35352e, .2),
  ];
  for (const side of [-1, 1]) {
    const leg = side < 0 ? 1 : 2, arm = side < 0 ? 3 : 4;
    pieces.push(
      part(taper(.008, .67, side * .105, .103, .077, .40, .84, 1), leg, 0x526073, .22, 1),
      part(taper(.005, .335, side * .11, .078, .056, .32, .9, 1), leg, 0x424c5c, .22, 2),
      part(sphere(.07, .125, side * .11, .17, .079, .079, 8, 4), leg, 0x292a2c, 0, 2),
      part(box(.07, .07, side * .11, .27, .026, .15), leg, 0xbdbcb3, 0, 2),
      part(taper(0, 1.295, side * .225, .071, .059, .30, .94, 1, 6), arm, 0xffffff, 1, 3),
      part(taper(.022, 1.03, side * .243, .059, .044, .25, 1, 1, 6), arm, 0xffffff, 1, 4),
      part(taper(.022, .917, side * .243, .046, .046, .026, 1, 1, 6), arm, 0xd5d0c5, .3, 4),
    );
  }
  return merge(pieces);
}
export function buildPedestrianSkinGeometry(): THREE.BufferGeometry {
  const hair = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI * .55);
  hair.scale(.131, .177, .137); hair.translate(-.023, 1.69, 0);
  const pieces = [
    part(taper(0, 1.52, 0, .065, .075, .12, 1, 1, 6), 0, 0xffffff, 1),
    part(sphere(0, 1.685, 0, .126, .174, .126, 10, 8), 0, 0xffffff, 1),
    part(hair, 0, 0x302b27, .18),
    part(sphere(.124, 1.675, 0, .039, .037, .027, 6, 4), 0, 0xe8d9ce, 1),
    part(box(.12, 1.618, 0, .008, .008, .048), 0, 0x87574e, .3),
  ];
  for (const side of [-1, 1]) pieces.push(
    part(sphere(-.008, 1.674, side * .124, .026, .044, .020, 6, 4), 0, 0xffffff, 1),
    part(sphere(.109, 1.716, side * .051, .016, .011, .022, 6, 4), 0, 0xcac7b9),
    part(sphere(.123, 1.716, side * .050, .004, .008, .008, 4, 3), 0, 0x252525),
    part(box(.109, 1.738, side * .05, .009, .009, .041), 0, 0x3c302a),
    part(sphere(.033, .865, side * .243, .044, .071, .037, 6, 4), side < 0 ? 3 : 4, 0xffffff, 1, 4),
  );
  return merge(pieces);
}
