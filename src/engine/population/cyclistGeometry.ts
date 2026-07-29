import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);

export const CYCLIST_GEOMETRY_TRIANGLES = 474;

export const CYCLIST_PART_COLORS = {
  bicycle: 0x20282a,
  metal: 0xa9b2b5,
  clothing: 0xf0f3f1,
  trousers: 0x26313d,
  skin: 0xb87957,
} as const;

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3;
}

function colorPart(
  geometry: THREE.BufferGeometry,
  color: number,
  tintWeight = 0,
): THREE.BufferGeometry {
  const partColor = new THREE.Color(color);
  const vertexCount = geometry.getAttribute('position').count;
  const colors = new Float32Array(vertexCount * 3);
  const weights = new Float32Array(vertexCount).fill(tintWeight);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = partColor.r;
    colors[i + 1] = partColor.g;
    colors[i + 2] = partColor.b;
  }
  geometry.setAttribute('cyclistBaseColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('cyclistTintWeight', new THREE.BufferAttribute(weights, 1));
  return geometry;
}

function tubeBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  color: number,
  tintWeight = 0,
): THREE.BufferGeometry {
  const direction = new THREE.Vector3().subVectors(end, start);
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    direction.length(),
    6,
    1,
    true,
  );
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()));
  geometry.translate(
    (start.x + end.x) * 0.5,
    (start.y + end.y) * 0.5,
    (start.z + end.z) * 0.5,
  );
  return colorPart(geometry, color, tintWeight);
}

function torusWheel(x: number): THREE.BufferGeometry {
  const geometry = new THREE.TorusGeometry(0.34, 0.032, 4, 12);
  geometry.translate(x, 0.38, 0);
  return colorPart(geometry, CYCLIST_PART_COLORS.bicycle);
}

function torso(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.2, 0.25, 0.55, 6);
  geometry.rotateZ(-0.42);
  geometry.translate(0.02, 1.25, 0);
  return colorPart(geometry, CYCLIST_PART_COLORS.clothing, 0.92);
}

function head(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(0.16, 6, 4);
  geometry.translate(0.23, 1.61, 0);
  return colorPart(geometry, CYCLIST_PART_COLORS.skin);
}

function helmet(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(
    0.175,
    6,
    2,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.52,
  );
  geometry.translate(0.23, 1.62, 0);
  return colorPart(geometry, CYCLIST_PART_COLORS.clothing, 0.72);
}

/**
 * Builds one pooled, vertex-colored cyclist. The mesh stays a single draw:
 * its part attributes let the shared material tint only jersey/helmet pieces
 * while keeping skin, tyres, metal, and trousers physically legible.
 *
 * +x is travel-forward, +z spans the rider's shoulders.
 */
export function buildCyclistGeometry(): THREE.BufferGeometry {
  const dark = CYCLIST_PART_COLORS.bicycle;
  const clothing = CYCLIST_PART_COLORS.clothing;
  const trousers = CYCLIST_PART_COLORS.trousers;
  const skin = CYCLIST_PART_COLORS.skin;
  const metal = CYCLIST_PART_COLORS.metal;

  const rearAxle = new THREE.Vector3(-0.67, 0.38, 0);
  const frontAxle = new THREE.Vector3(0.67, 0.38, 0);
  const crank = new THREE.Vector3(-0.06, 0.45, 0);
  const seatJoint = new THREE.Vector3(-0.24, 0.79, 0);
  const headJoint = new THREE.Vector3(0.45, 0.69, 0);
  const handle = new THREE.Vector3(0.5, 0.91, 0);

  const parts: THREE.BufferGeometry[] = [
    torusWheel(rearAxle.x),
    torusWheel(frontAxle.x),
    tubeBetween(rearAxle, crank, 0.025, dark),
    tubeBetween(crank, seatJoint, 0.025, dark),
    tubeBetween(seatJoint, rearAxle, 0.025, dark),
    tubeBetween(seatJoint, headJoint, 0.025, dark),
    tubeBetween(headJoint, frontAxle, 0.025, dark),
    tubeBetween(headJoint, handle, 0.025, metal),
    tubeBetween(
      new THREE.Vector3(handle.x, handle.y, -0.2),
      new THREE.Vector3(handle.x, handle.y, 0.2),
      0.022,
      dark,
    ),
  ];

  const saddle = new THREE.BoxGeometry(0.24, 0.055, 0.19);
  saddle.rotateZ(-0.08);
  saddle.translate(-0.27, 0.84, 0);
  parts.push(colorPart(saddle, dark));

  parts.push(torso(), head(), helmet());

  const shoulder = new THREE.Vector3(0.11, 1.39, 0);
  for (const side of [-1, 1]) {
    const z = side * 0.13;
    const elbow = new THREE.Vector3(0.33, 1.18, side * 0.18);
    const hand = new THREE.Vector3(handle.x, handle.y + 0.015, side * 0.2);
    const hip = new THREE.Vector3(-0.17, 1.04, z);
    const knee = new THREE.Vector3(0.15, 0.72, side * 0.12);
    const pedal = new THREE.Vector3(
      crank.x + side * 0.1,
      crank.y - side * 0.055,
      side * 0.11,
    );
    parts.push(
      tubeBetween(
        new THREE.Vector3(shoulder.x, shoulder.y, z),
        elbow,
        0.057,
        clothing,
        0.92,
      ),
      tubeBetween(elbow, hand, 0.047, skin),
      tubeBetween(hip, knee, 0.082, trousers),
      tubeBetween(knee, pedal, 0.067, trousers),
    );
  }

  const neck = tubeBetween(
    new THREE.Vector3(0.17, 1.47, 0),
    new THREE.Vector3(0.2, 1.53, 0),
    0.08,
    skin,
  );
  parts.push(neck);

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Could not merge pooled cyclist geometry');
  merged.computeBoundingSphere();

  const triangles = triangleCount(merged);
  if (triangles !== CYCLIST_GEOMETRY_TRIANGLES) {
    throw new Error(
      `Cyclist geometry broke its triangle contract: expected `
      + `${CYCLIST_GEOMETRY_TRIANGLES}, received ${triangles}`,
    );
  }
  return merged;
}
