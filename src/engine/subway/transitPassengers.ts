import * as THREE from 'three';
import { buildPedestrianGeometry, buildPedestrianSkinGeometry } from '../population/pedestrianGeometry';

const COATS = [0x38434b, 0x625b54, 0x2b384b, 0x83796a, 0x785345, 0x626d61, 0xb3a591, 0x4a4245, 0x354e61, 0x7a7353];
const SKIN = [0xd4a181, 0x815c45, 0xb78160, 0x674732, 0xe1b79a, 0xa87554, 0xc39879];
export function passengerRandom(seed: number): () => number {
  let n = seed | 0;
  return () => { n += 0x6d2b79f5; let t = Math.imul(n ^ (n >>> 15), 1 | n); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function passengerSeed(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
export interface PassengerPose {
  x: number; y: number; z: number; yaw: number;
  scale?: number; walk?: number; seated?: boolean; identity?: number; driving?: boolean;
}

/** Articulated commuters share the street models, with a fixed pair of instance
 * buffers. There are no Object3Ds, skeletons or draw calls per passenger. */
export class TransitPassengerBatch {
  readonly group = new THREE.Group();
  readonly body: THREE.InstancedMesh;
  readonly skin: THREE.InstancedMesh;
  readonly capacity: number;
  private readonly pose: THREE.InstancedBufferAttribute;
  private readonly clock = { value: 0 };
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly identities: { coat: number; skin: number; scale: number; phase: number }[];
  private dirty = false;
  private disposed = false;

  constructor(parent: THREE.Object3D, capacity: number, seed: number) {
    this.capacity = capacity;
    const rng = passengerRandom(seed);
    this.identities = Array.from({ length: capacity }, () => ({
      coat: COATS[Math.floor(rng() * COATS.length)], skin: SKIN[Math.floor(rng() * SKIN.length)],
      scale: .92 + rng() * .12, phase: rng() * Math.PI * 2,
    }));
    this.pose = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const build = (geometry: THREE.BufferGeometry, name: string) => {
      geometry.setAttribute('transitPose', this.pose);
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .8 });
      material.onBeforeCompile = shader => {
        shader.uniforms.transitTime = this.clock;
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
attribute float skinPart;
attribute float crowdJoint;
attribute vec3 crowdColor;
attribute float crowdTint;
attribute vec4 transitPose;
varying vec3 vTransitColor;
varying vec3 vTransitFabric;
uniform float transitTime;
float transitAngle() {
  if (skinPart < .5) return 0.0;
  float side = (skinPart < 1.5 || skinPart > 3.5) ? 1.0 : -1.0;
  return sin(transitTime * 7.4 + transitPose.x) * (skinPart > 2.5 ? -.31 : .38) * side * transitPose.y;
}`)
          .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
float angleN = transitAngle();
if (transitPose.z > .5 && crowdJoint > .5 && crowdJoint < 1.5) angleN = 1.5707963;
if (transitPose.z > .5 && crowdJoint > 1.5 && crowdJoint < 2.5) objectNormal.y /= 1.25;
if (transitPose.w > .5 && crowdJoint > 2.5) angleN = crowdJoint < 3.5 ? .610865 : 2.094395;
objectNormal.xy = mat2(cos(angleN), sin(angleN), -sin(angleN), cos(angleN)) * objectNormal.xy;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
vTransitColor = crowdColor;
#ifdef USE_INSTANCING_COLOR
  vTransitColor *= mix(vec3(1.0), instanceColor, crowdTint);
#endif
vTransitFabric = position;
if (transitPose.z > .5) {
  if (crowdJoint > .5 && crowdJoint < 1.5) {
    // Rotate the whole thigh around the hip. The knee meets the translated
    // shin; no triangle spans two independent deformation branches.
    transformed.x = .878 - position.y;
    transformed.y = .60 + position.x - .008;
  } else if (crowdJoint > 1.5 && crowdJoint < 2.5) {
    transformed.x += .40;
    transformed.y = .07 + (position.y - .07) * 1.25;
  } else transformed.y -= .27;
  if (transitPose.w > .5 && crowdJoint > 2.5) {
    if (crowdJoint < 3.5) {
      vec2 arm = vec2(position.x, position.y - 1.445);
      transformed.xy = mat2(.819152, .573576, -.573576, .819152) * arm + vec2(0.0, 1.175);
    } else {
      vec2 arm = vec2(position.x - .022, (position.y - 1.155) * .78);
      transformed.xy = mat2(-.5, .8660254, -.8660254, -.5) * arm + vec2(.172073, .929254);
    }
    transformed.z *= .78;
  }
} else {
  if (skinPart > .5) {
    float pivotY = skinPart > 2.5 ? 1.43 : .82;
    float angle = transitAngle();
    vec2 limb = vec2(transformed.x, transformed.y - pivotY);
    transformed.x = limb.x * cos(angle) - limb.y * sin(angle);
    transformed.y = limb.x * sin(angle) + limb.y * cos(angle) + pivotY;
  } else transformed.y += sin(transitTime * 7.4 + transitPose.x) * .008 * transitPose.y
  + sin(transitTime * 1.7 + transitPose.x) * .0025 * (1.0 - transitPose.y);
}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vTransitColor;\nvarying vec3 vTransitFabric;')
          .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = vTransitColor;
float fabric = 1.0 - smoothstep(.012, .04, length(fwidth(vTransitFabric)));
diffuseColor.rgb *= 1.0 + sin(vTransitFabric.y * 850.0) * sin(vTransitFabric.z * 850.0) * fabric * .025;`);
      };
      material.customProgramCacheKey = () => 'transit-commuter-v2';
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = name;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Analytic bounds cover pose deformation. Recomputed from instances after
      // packing; no expensive per-person shadow submissions.
      geometry.computeBoundingSphere();
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    this.body = build(buildPedestrianGeometry(), 'transit-passenger-clothing');
    this.skin = build(buildPedestrianSkinGeometry(), 'transit-passenger-skin');
    this.group.name = 'transit-passengers';
    parent.add(this.group);
  }

  set(index: number, p: PassengerPose): void {
    if (index >= this.capacity || index < 0) return;
    const identity = this.identities[(p.identity ?? index) % this.capacity];
    // Seated adults retain the authored .51m seat height across body varieties.
    const size = p.scale ?? (p.seated ? 1 : identity.scale);
    this.position.set(p.x, p.y, p.z);
    this.rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.yaw);
    this.scale.setScalar(size);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.body.setMatrixAt(index, this.matrix);
    this.skin.setMatrixAt(index, this.matrix);
    this.body.setColorAt(index, this.color.setHex(identity.coat));
    this.skin.setColorAt(index, this.color.setHex(identity.skin));
    this.pose.setXYZW(index, identity.phase, p.walk ?? 0, p.seated ? 1 : 0, p.driving ? 1 : 0);
    this.dirty = true;
  }

  update(timeSeconds: number): void { this.clock.value = timeSeconds; }
  commit(count: number): void {
    this.body.count = this.skin.count = Math.min(this.capacity, count);
    this.group.visible = count > 0;
    if (!this.dirty) return;
    for (const mesh of [this.body, this.skin]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.pose.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const mesh of [this.body, this.skin]) {
      mesh.dispose(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
    }
    this.group.clear();
  }
}
