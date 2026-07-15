import * as THREE from 'three';
import { quality } from './quality';
import { makeCloudTexture } from './textures';

export const SKY = {
  zenith: new THREE.Color('#6ea3d8'),
  horizon: new THREE.Color('#d7e2ec'),
  fog: new THREE.Color('#cfdbe6'),
  ground: new THREE.Color('#9aa0a6'),
  water: new THREE.Color('#1d3542'),
};

export function setupSky(scene: THREE.Scene, loadRadius: number, farPlane: number) {
  scene.background = SKY.fog.clone();
  // tiles fully fog out just past the load radius so streaming pop is invisible
  scene.fog = new THREE.Fog(SKY.fog.clone(), loadRadius * 0.38, loadRadius * 1.18);

  // gradient dome (must sit inside the far plane; caller keeps it centered on the camera)
  const geo = new THREE.SphereGeometry(farPlane * 0.92, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: SKY.zenith },
      horizon: { value: SKY.horizon },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 zenith;
      uniform vec3 horizon;
      void main() {
        float t = smoothstep(-0.05, 0.45, vDir.y);
        vec3 col = mix(horizon, zenith, t);
        // sun glow
        vec3 sun = normalize(vec3(-0.5, 0.62, -0.42));
        float g = pow(max(dot(vDir, sun), 0.0), 180.0);
        col += vec3(1.0, 0.93, 0.78) * g * 0.85;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  scene.add(dome);

  // cloud billboards ride with the dome (which follows the camera)
  const rng = (n: number) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const cloudCount = quality().clouds;
  for (let i = 0; i < cloudCount; i++) {
    const tex = makeCloudTexture(i % 5);
    const w = 700 + rng(i * 3 + 1) * 900;
    const cmat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.85,
    });
    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.42), cmat);
    const ang = rng(i * 7 + 2) * Math.PI * 2;
    const dist = farPlane * (0.35 + rng(i * 11 + 3) * 0.45);
    cloud.position.set(Math.cos(ang) * dist, 550 + rng(i * 13 + 4) * 650, Math.sin(ang) * dist);
    cloud.lookAt(0, cloud.position.y * 0.35, 0);
    cloud.renderOrder = -9;
    dome.add(cloud);
  }
  return dome;
}

/** Sun direction (normalized-ish offset from its target). Shared with the dome's glow. */
export const SUN_OFFSET = new THREE.Vector3(-340, 420, -285);

export function setupLights(scene: THREE.Scene) {
  const q = quality();
  // with real shadows the ambient comes down and the sun goes up
  const hemi = new THREE.HemisphereLight(0xd6e4f5, 0x8a8478, q.shadows ? 0.8 : 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d6, q.shadows ? 2.7 : 2.0);
  sun.position.copy(SUN_OFFSET);
  scene.add(sun, sun.target);
  if (q.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    const r = 340;
    sun.shadow.camera.left = -r;
    sun.shadow.camera.right = r;
    sun.shadow.camera.top = r;
    sun.shadow.camera.bottom = -r;
    sun.shadow.camera.near = 50;
    sun.shadow.camera.far = 1600;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.9;
  }
  const fill = new THREE.DirectionalLight(0xcdd9e8, q.shadows ? 0.35 : 0.5);
  fill.position.set(400, 300, 500);
  scene.add(fill);
  return { hemi, sun, fill };
}

/**
 * Keep the shadow frustum centered on the camera, snapped to shadow-texel
 * increments so edges don't shimmer as the player moves.
 */
export function followSun(sun: THREE.DirectionalLight, camX: number, camZ: number) {
  if (!sun.castShadow) {
    sun.position.set(camX + SUN_OFFSET.x, SUN_OFFSET.y, camZ + SUN_OFFSET.z);
    sun.target.position.set(camX, 0, camZ);
    sun.target.updateMatrixWorld();
    return;
  }
  const texel = (2 * 340) / sun.shadow.mapSize.x;
  const sx = Math.round(camX / texel) * texel;
  const sz = Math.round(camZ / texel) * texel;
  sun.position.set(sx + SUN_OFFSET.x, SUN_OFFSET.y, sz + SUN_OFFSET.z);
  sun.target.position.set(sx, 0, sz);
  sun.target.updateMatrixWorld();
}

/** Underground lighting (warm fluorescent; bright floor-bounce so ceilings read). */
export function setupStationLights(scene: THREE.Scene, shadowHalf = 0) {
  const q = quality();
  const hemi = new THREE.HemisphereLight(0xfff3dc, 0x8a8478, 1.1);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xfff6e6, 0.5);
  scene.add(amb);
  const down = new THREE.DirectionalLight(0xffedc8, 0.75);
  down.position.set(6, 30, 4);
  scene.add(down, down.target);
  if (q.shadows && shadowHalf > 0) {
    down.castShadow = true;
    down.shadow.mapSize.set(q.stationShadowMapSize, q.stationShadowMapSize);
    down.shadow.camera.left = -shadowHalf;
    down.shadow.camera.right = shadowHalf;
    down.shadow.camera.top = shadowHalf;
    down.shadow.camera.bottom = -shadowHalf;
    down.shadow.camera.near = 5;
    down.shadow.camera.far = 60;
    down.shadow.bias = -0.0005;
    down.shadow.normalBias = 0.5;
  }
  const fill = new THREE.DirectionalLight(0xc8d2e0, 0.3);
  fill.position.set(-3, 6, -2);
  scene.add(fill);
  return down;
}
