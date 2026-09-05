import * as THREE from 'three';
import { quality } from './quality';
import { makeCloudTexture } from './textures';
import { LANDMARK_SHADOW_LAYER } from './landmarks/layers.js';

export const SKY = {
  zenith: new THREE.Color('#6ea3d8'),
  horizon: new THREE.Color('#d7e2ec'),
  fog: new THREE.Color('#cfdbe6'),
  ground: new THREE.Color('#9aa0a6'),
  water: new THREE.Color('#1d3542'),
};

/**
 * Build a small HDR-capable reflection probe that matches the visible sky.
 *
 * This deliberately does not use RoomEnvironment: that probe is excellent for
 * subway cars and turnstiles, but its studio softboxes make outdoor glass and
 * metal look as though they are inside a showroom. PMREM captures this
 * procedural sky once at startup, so using it on every Standard material adds
 * no per-frame scene-render or cube-camera cost.
 */
export function makeOutdoorEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        vec3 zenith = vec3(0.157, 0.366, 0.687);
        vec3 horizon = vec3(0.680, 0.773, 0.855);
        vec3 ground = vec3(0.165, 0.155, 0.140);
        float skyT = smoothstep(-0.02, 0.72, dir.y);
        vec3 col = mix(horizon, zenith, skyT);
        // Same direction as SUN_OFFSET and the visible sky disc.
        vec3 sun = normalize(vec3(-0.5566, 0.6875, -0.4665));
        float d = max(dot(dir, sun), 0.0);
        col += vec3(1.0, 0.82, 0.58) * pow(d, 96.0) * 2.2;
        col += vec3(1.0, 0.91, 0.75) * pow(d, 900.0) * 7.0;
        // A real outdoor probe contains the ground hemisphere. Without it,
        // undersides reflect blue sky and metals glow unnaturally.
        float below = 1.0 - smoothstep(-0.18, 0.04, dir.y);
        col = mix(col, ground, below);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  envScene.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const target = pmrem.fromScene(envScene, 0.02, 0.1, 20);
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return target.texture;
}

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
        // Exactly the sun the fog scatters around (SUN_OFFSET normalized), so
        // the sky and the haze agree instead of glowing in different places.
        const vec3 sun = vec3(-0.5566, 0.6875, -0.4665);
        float d = max(dot(vDir, sun), 0.0);
        // Three layers: a broad Mie halo that warms most of that quadrant, a
        // tight aureole, and the disc itself. Without the broad term the glow
        // reads as a sticker on a flat gradient.
        col = mix(col, vec3(1.0, 0.95, 0.86), pow(d, 5.0) * 0.34);
        col += vec3(1.0, 0.94, 0.80) * pow(d, 64.0) * 0.5;
        col += vec3(1.0, 0.97, 0.90) * pow(d, 900.0) * 1.6;
        // Horizon band: the last few degrees of air are the thickest, and this
        // is what the fog colour hands off to at the load radius.
        col = mix(col, horizon * 1.02, (1.0 - smoothstep(-0.02, 0.16, vDir.y)) * 0.55);
        // Ordered dither. An 8-bit sky gradient over this many degrees bands
        // visibly, and banding crawls as the camera turns.
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        col += (dither - 0.5) / 255.0;
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
/** Unit vector from the shadow-box centre toward the sun. */
const SUN_DIR = SUN_OFFSET.clone().normalize();

/**
 * Shadow coverage half-extents (metres), indexed by altitude band. Discrete on
 * purpose: the texel-snap grid below is derived from the extent, so a
 * continuously-varying extent would re-quantise the grid every frame and
 * shimmer. Each step is sized so the box edge lands at or beyond the fog wall
 * for its band (fog.far grows with altitude in World.step), which is what keeps
 * the boundary unreadable.
 */
const SHADOW_STEPS = [300, 620, 1000, 1450, 2000];
/** Climb to step i+1 above SHADOW_UP[i] metres... */
const SHADOW_UP = [62, 120, 260, 520];
/** ...and fall back to step i below SHADOW_DOWN[i]. The gap is the hysteresis. */
const SHADOW_DOWN = [45, 95, 200, 420];

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
    // Hero landmark visuals stay on the main-camera layer but do not cast.
    // Their one-draw simplified silhouettes live on this shadow-only layer.
    // Enabling (not setting) preserves layer 0 for all ordinary city casters.
    sun.shadow.camera.layers.enable(LANDMARK_SHADOW_LAYER);
    // Extent / near / far / bias are all owned by followSun() from here on --
    // they move together with the coverage step, and a stale hand-set frustum
    // would fight it on the first frame.
    sun.shadow.autoUpdate = true;
  }
  const fill = new THREE.DirectionalLight(0xcdd9e8, q.shadows ? 0.35 : 0.5);
  fill.position.set(400, 300, 500);
  scene.add(fill);
  return { hemi, sun, fill };
}

/** Half-extent currently applied to the sun's shadow frustum (metres). */
export function shadowExtent(sun: THREE.DirectionalLight): number {
  return (sun.userData.shHalf as number | undefined) ?? SHADOW_STEPS[0];
}

/**
 * Keep the shadow frustum centered on the camera, snapped to shadow-texel
 * increments so edges don't shimmer as the player moves.
 *
 * The coverage half-extent tracks ALTITUDE. A fixed 340 m box is right on foot
 * (you are in a canyon; nothing beyond it is visible anyway) but in the
 * helicopter the view opens to ~1.8 km while the box stayed put, so buildings
 * crossed the box edge and their cast shadows switched on and off as you flew:
 * that boundary sweeping past at up to 134 m/s is the "flickering light".
 * Growing the box with altitude pushes the edge out into the fog where it
 * cannot be read, and the light is pulled far enough back that no tower is ever
 * clipped by the shadow camera's near plane.
 *
 * `fwdX/fwdZ` is the camera's horizontal forward; the box leads along it so the
 * coverage is spent on ground you are looking at rather than ground behind you.
 */
export function followSun(
  sun: THREE.DirectionalLight,
  camX: number,
  camZ: number,
  camY = 0,
  fwdX = 0,
  fwdZ = 0,
) {
  if (!sun.castShadow) {
    sun.position.set(camX + SUN_OFFSET.x, SUN_OFFSET.y, camZ + SUN_OFFSET.z);
    sun.target.position.set(camX, 0, camZ);
    sun.target.updateMatrixWorld();
    return;
  }

  // --- coverage step (hysteretic, so hovering on a threshold cannot oscillate)
  let i = (sun.userData.shStep as number | undefined) ?? 0;
  while (i < SHADOW_STEPS.length - 1 && camY > SHADOW_UP[i]) i++;
  while (i > 0 && camY < SHADOW_DOWN[i - 1]) i--;
  sun.userData.shStep = i;
  const r = SHADOW_STEPS[i];

  // Casters standing up-sun of the box still throw shadows INTO it (the sun sits
  // ~43 degrees up, so a 540 m tower reaches ~570 m along the ground). Pad the
  // ortho box rather than lose those shadows at the edge -- but keep the pad
  // small at street level, where the texel size IS the shadow's sharpness.
  const half = r + Math.min(320, Math.max(60, r * 0.3));
  const texel = (2 * half) / sun.shadow.mapSize.x;

  // Lead the box along the view direction; never so far that the player leaves it.
  const bias = Math.min(r * 0.45, Math.max(0, r - SHADOW_STEPS[0]));
  const cx = camX + fwdX * bias;
  const cz = camZ + fwdZ * bias;
  const sx = Math.round(cx / texel) * texel;
  const sz = Math.round(cz / texel) * texel;

  // Distance along the sun axis. Only the DIRECTION matters to the lighting, so
  // the light can sit arbitrarily far back; what it buys is a near plane that no
  // skyscraper roof can poke through (the old fixed y=420 sat below One WTC).
  const dist = half * 1.25 + 1200;
  sun.position.set(sx + SUN_DIR.x * dist, SUN_DIR.y * dist, sz + SUN_DIR.z * dist);
  sun.target.position.set(sx, 0, sz);
  sun.target.updateMatrixWorld();

  const cam = sun.shadow.camera;
  const near = Math.max(1, dist - 1100);
  const far = dist + half * 1.1 + 400;
  // mapSize is in the guard because the adaptive-perf path can halve it at
  // runtime, which changes the texel size (and so the bias) without the extent
  // moving at all.
  if (sun.userData.shHalf !== half || sun.userData.shMap !== sun.shadow.mapSize.x) {
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = near; cam.far = far;
    cam.updateProjectionMatrix();
    sun.userData.shHalf = half;
    sun.userData.shMap = sun.shadow.mapSize.x;
    // Depth bias has to track the texel size or the acne that a 0.17 m texel
    // hides reappears the moment the box grows. normalBias is in world units;
    // `bias` is normalised depth, so convert through the ortho depth range.
    // Keep the receiver close to the caster. The old 2.4-texel normal offset
    // lifted people, street furniture and landmark bases visibly off the
    // pavement; a sub-texel offset remains large enough for the merged city
    // geometry while preserving contact.
    sun.shadow.normalBias = Math.max(0.12, texel * 0.9);
    sun.shadow.bias = -(texel * 0.75) / (far - near);
  }
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
  // stationShadows, not shadows: a complex marks thousands of casters, which is
  // a different order of cost from the street's bounded frustum (see quality.ts)
  if (q.stationShadows && shadowHalf > 0) {
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
