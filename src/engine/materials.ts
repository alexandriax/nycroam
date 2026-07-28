import * as THREE from 'three';
import {
  makeAsphaltTexture, makeSidewalkTexture, makeBrickTexture, makeRoofTexture,
  makeGrassDetailTexture, makeBarkTexture,
} from './textures';
import { quality } from './quality';

/**
 * Facade material: Lambert + injected procedural window grid on vertical faces.
 * Windows are carved in the fragment shader from world position; brick/roof
 * normals are world-projected so close surfaces carry real light relief without
 * extra geometry. Screen-space filtering keeps the grid stable in motion, and
 * expensive detail fades before it becomes sub-pixel. Still one material and
 * one draw call per tile.
 */
export function makeFacadeMaterial(): THREE.MeshLambertMaterial {
  // DoubleSide + front-facing test: if imperfect OSM data leaves any opening,
  // the inside of the far wall renders as a dark interior instead of void.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const brick = makeBrickTexture('red');
  const roof = makeRoofTexture();
  // Normal-map relief is the premium desktop close-up path. Mobile keeps the
  // anti-aliased windows/reflections but avoids a second texture sample before
  // lighting; its lower resolution makes the micro-relief imperceptible anyway.
  const premiumSurfaceNormals = quality().shadows;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBrick = { value: brick.map };
    shader.uniforms.uBrickNormal = { value: brick.normal };
    shader.uniforms.uRoof = { value: roof.map };
    shader.uniforms.uRoofNormal = { value: roof.normal };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aStyle;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vStyle;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
        vStyle = aStyle;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vStyle;
        uniform sampler2D uBrick;
        uniform sampler2D uBrickNormal;
        uniform sampler2D uRoof;
        uniform sampler2D uRoofNormal;
        float bhash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }
        float aaBand(float x, float lo, float hi) {
          float w = max(fwidth(x) * 1.15, 0.0015);
          return smoothstep(lo - w, lo + w, x)
               * (1.0 - smoothstep(hi - w, hi + w, x));
        }
        float aaRect(vec2 p, vec2 lo, vec2 hi) {
          return aaBand(p.x, lo.x, hi.x) * aaBand(p.y, lo.y, hi.y);
        }`
      )
      .replace(
        '#include <normal_fragment_maps>',
        premiumSurfaceNormals
          ? `#include <normal_fragment_maps>
        {
          // MeshLambert has no useful UV layout across merged OSM footprints.
          // Reconstruct facade tangent space from the world normal, then project
          // the cached procedural normal maps in metres. Relief is limited to
          // opaque wall/roof pixels and fades before it can sparkle at distance.
          vec3 faceN = normalize(vWNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          float verticalN = 1.0 - abs(faceN.y);
          float detailN = 1.0 - smoothstep(80.0, 260.0, distance(cameraPosition, vWPos));
          if (verticalN > 0.55 && vWPos.y > 0.5 && vStyle < 0.5 && detailN > 0.001) {
            float uN = vWPos.x * faceN.z - vWPos.z * faceN.x;
            float floorHN = vWPos.y < 4.6 ? 4.6 : 3.1;
            float winWN = vWPos.y < 4.6 ? 4.2 : 2.5;
            vec2 fN = vec2(fract(uN / winWN), fract(vWPos.y / floorHN));
            vec2 loN = vWPos.y < 4.6 ? vec2(0.08, 0.05) : vec2(0.18, 0.25);
            vec2 hiN = vWPos.y < 4.6 ? vec2(0.92, 0.75) : vec2(0.85, 0.80);
            float windowN = aaRect(fN, loN, hiN);
            vec3 mapN = texture2D(uBrickNormal, vec2(uN, vWPos.y) / 1.2).xyz * 2.0 - 1.0;
            mapN.xy *= 0.72;
            vec3 tangentN = normalize(vec3(faceN.z, 0.0, -faceN.x));
            vec3 reliefN = normalize(
              tangentN * mapN.x + vec3(0.0, 1.0, 0.0) * mapN.y + faceN * max(mapN.z, 0.25)
            );
            vec3 worldN = normalize(mix(faceN, reliefN, (1.0 - windowN) * detailN * 0.58));
            normal = normalize(mat3(viewMatrix) * worldN);
          } else if (faceN.y > 0.55 && detailN > 0.001) {
            vec3 mapN = texture2D(uRoofNormal, vWPos.xz / 4.0).xyz * 2.0 - 1.0;
            mapN.xy *= 0.64;
            vec3 worldN = normalize(vec3(mapN.x, max(mapN.z, 0.3), mapN.y));
            normal = normalize(mat3(viewMatrix) * normalize(mix(faceN, worldN, detailN * 0.62)));
          }
        }`
          : '#include <normal_fragment_maps>'
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Double-sided: reversed-winding footprints (self-intersecting OSM
          // rings) render as normal facades either way, and any true opening
          // shows the far wall as a wall instead of a see-through void.
          vec3 wn = normalize(vWNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          float vertical = 1.0 - abs(wn.y);
          float detail = 1.0 - smoothstep(420.0, 1050.0, distance(cameraPosition, vWPos));
          if (vertical > 0.55 && vWPos.y > 0.5) {
            vec3 facadeBase = diffuseColor.rgb;
            if (detail > 0.001) {
            float u = vWPos.x * wn.z - vWPos.z * wn.x;
            float v = vWPos.y;
            bool glassTower = vStyle > 0.5;
            float floorH = glassTower ? 3.4 : 3.1;
            float winW = glassTower ? 1.7 : 2.5;
            bool storefront = v < 4.6;
            if (storefront) { floorH = 4.6; winW = 4.2; }
            vec2 cellId = vec2(floor(u / winW), floor(v / floorH));
            vec2 f = vec2(fract(u / winW), fract(v / floorH));
            float rnd = bhash(cellId + floor(diffuseColor.rg * 61.0));
            vec3 V = normalize(cameraPosition - vWPos);
            float fresnel = pow(1.0 - max(dot(V, wn), 0.0), 3.0);
            vec3 reflected = reflect(-V, wn);
            float skyLift = clamp(reflected.y * 0.55 + 0.55, 0.0, 1.0);
            vec3 skyGlass = mix(vec3(0.20, 0.27, 0.36), vec3(0.67, 0.76, 0.86), skyLift);
            vec3 sunDir = normalize(vec3(-0.48, 0.64, -0.40));
            float glint = pow(max(dot(reflect(-sunDir, wn), V), 0.0), 96.0);

            if (glassTower && !storefront) {
              // Curtain wall: anti-aliased mullions and spandrels stay stable
              // during fast flight instead of crawling as a hard step grid.
              float pane = aaRect(f, vec2(0.055, 0.06), vec2(0.945, 0.72));
              float spandrel = aaBand(f.y, 0.78, 0.97);
              // Sky reflection, grazing-angle fresnel and a tight sun glint make
              // the pane read as glass without an environment-map lookup.
              vec3 glass = mix(vec3(0.30, 0.37, 0.46), vec3(0.55, 0.63, 0.72), f.y * 0.8 + rnd * 0.25);
              glass = mix(glass, skyGlass, 0.34 + fresnel * 0.48);
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, pane * 0.94);
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, spandrel * 0.8);
              diffuseColor.rgb += vec3(1.0, 0.94, 0.80) * glint * pane * 0.22;
            } else {
              vec2 lo = storefront ? vec2(0.08, 0.05) : vec2(0.18, 0.25);
              vec2 hi = storefront ? vec2(0.92, 0.75) : vec2(0.85, 0.80);
              float inX = aaBand(f.x, lo.x, hi.x);
              float inY = aaBand(f.y, lo.y, hi.y);
              float win = inX * inY;
              // masonry surface detail between the windows (brightness only,
              // so each building keeps its palette color)
              vec3 bt = texture2D(uBrick, vec2(u, v) / 1.2).rgb;
              float bl = dot(bt, vec3(0.333)) * 1.75;
              diffuseColor.rgb *= mix(1.0, bl, 0.34 * (1.0 - win));
              vec3 glass = mix(vec3(0.13, 0.16, 0.2), vec3(0.38, 0.44, 0.52), rnd * rnd);
              if (storefront) glass = mix(vec3(0.1, 0.11, 0.13), vec3(0.3, 0.28, 0.24), rnd);
              glass = mix(glass, skyGlass, (storefront ? 0.18 : 0.27) + fresnel * 0.35);
              // window inset: lintel shadow at the top of the opening, darker jambs
              float lintel = 1.0 - 0.5 * smoothstep(0.68, 0.8, f.y) * win;
              float jambs = aaBand(f.x, lo.x, lo.x + 0.055)
                           + aaBand(f.x, hi.x - 0.055, hi.x);
              float jamb = 1.0 - 0.25 * jambs * inY;
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.88);
              diffuseColor.rgb *= lintel * jamb;
              diffuseColor.rgb += vec3(1.0, 0.94, 0.82) * glint * win * (storefront ? 0.07 : 0.11);
              // Real storefronts are divided into narrow display bays and a
              // transom; upper punched windows get a slim sash. These are only
              // shader masks, so the close-up read improves with no geometry.
              float frame = storefront
                ? (aaBand(f.x, 0.335, 0.355) + aaBand(f.x, 0.645, 0.665)) * inY
                  + aaBand(f.y, 0.54, 0.565) * inX
                : aaBand(f.y, 0.505, 0.525) * inX;
              diffuseColor.rgb = mix(diffuseColor.rgb, facadeBase * 0.36, clamp(frame, 0.0, 1.0) * 0.92);
              // sill highlight under the window
              float sill = aaBand(f.y, lo.y - 0.055, lo.y) * inX;
              diffuseColor.rgb += vec3(0.05) * sill * (storefront ? 0.0 : 1.0);
            }
            // Beyond the useful angular size, blend back to the cheap massing
            // color. This removes distant grid moiré and avoids visible LOD pops.
            diffuseColor.rgb = mix(facadeBase, diffuseColor.rgb, detail);
            }
            // grounding gradient: subtle darkening near street
            diffuseColor.rgb *= 0.86 + 0.14 * clamp(vWPos.y / 7.0, 0.0, 1.0);
          } else if (wn.y > 0.55) {
            // roofs: ballast gravel, worldspace projected
            vec3 rt = texture2D(uRoof, vWPos.xz / 4.0).rgb;
            diffuseColor.rgb *= mix(vec3(1.0), rt * 1.9, 0.55);
          }
        }`
      );
  };
  return mat;
}

/** Flat layer (areas/ground): vertex colors modulated by worldspace mottle. */
export function makeFlatMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const detail = makeGrassDetailTexture();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGXZ;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vGXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGXZ;\nuniform sampler2D uDetail;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 d1 = texture2D(uDetail, vGXZ / 6.0).rgb;
          vec3 d2 = texture2D(uDetail, vGXZ / 41.0).rgb; // second octave breaks tiling
          diffuseColor.rgb *= mix(vec3(1.0), d1 * d2 * 1.85, 0.6);
        }`
      );
  };
  return mat;
}

/** Asphalt roadbed with aggregate normal detail (UVs from the worker). */
export function makeRoadMaterial(): THREE.MeshLambertMaterial {
  const t = makeAsphaltTexture();
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    color: 0x8a8d92, // texture carries most of the tone; vertex colors tint per class
    map: t.map,
    normalMap: t.normal,
  });
  mat.normalScale = new THREE.Vector2(0.7, 0.7);
  return mat;
}

/** Poured-concrete walks with score joints. */
export function makeWalkMaterial(): THREE.MeshLambertMaterial {
  const t = makeSidewalkTexture();
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    color: 0xb8b6af,
    map: t.map,
    normalMap: t.normal,
  });
  mat.normalScale = new THREE.Vector2(0.8, 0.8);
  return mat;
}

/**
 * Lambert with a worldspace-projected detail map (for floors/slabs that share
 * one material across many differently-sized boxes, where per-face UVs stretch).
 */
export function makeWorldDetailMaterial(
  color: THREE.ColorRepresentation,
  detail: THREE.Texture,
  metersPerRepeat: number,
  amount = 0.75,
): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uScale = { value: 1 / metersPerRepeat };
    shader.uniforms.uAmt = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDXZ;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vDXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDXZ;\nuniform sampler2D uDetail;\nuniform float uScale;\nuniform float uAmt;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), texture2D(uDetail, vDXZ * uScale).rgb * 1.28, uAmt);`
      );
  };
  return mat;
}

export const barkTexture = makeBarkTexture;

/** Painted lane lines / crosswalk bars: slightly emissive so they pop in shade. */
export function makeMarkingsMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    emissive: 0xffffff,
    emissiveIntensity: 0.08,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return mat;
}

/** Distant skyline: unlit-ish, exempt from fog, hazes toward sky color with distance. */
export function makeSkylineMaterial(skyColor: THREE.Color): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0x6a7280, fog: false });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSky = { value: skyColor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vDist;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vDist = length((modelViewMatrix * vec4(transformed, 1.0)).xyz);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDist;\nuniform vec3 uSky;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        // wash quickly to ~0.85 near the tile-fog boundary (continuity with fogged
        // tiles), then drift toward sky slowly so far towers stay soft silhouettes
        float haze = 0.85 * smoothstep(500.0, 1500.0, vDist)
                   + 0.11 * smoothstep(1500.0, 6500.0, vDist);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, clamp(haze, 0.0, 0.96));`
      );
  };
  return mat;
}

export const treeTrunkMaterial = () => {
  const t = makeBarkTexture();
  const mat = new THREE.MeshLambertMaterial({ color: 0xcbb59a, map: t.map, normalMap: t.normal });
  mat.normalScale = new THREE.Vector2(0.9, 0.9);
  return mat;
};
export const treeCanopyMaterial = () => new THREE.MeshLambertMaterial({ color: 0x4d7a45 });

/**
 * Animated river water: worldspace wave normals, fresnel toward the sky at
 * grazing angles, and a tight sun glint. Call the returned update(dt) per frame.
 */
export function makeWaterMaterial(skyColor: THREE.Color): { mat: THREE.MeshLambertMaterial; update: (dt: number) => void } {
  const mat = new THREE.MeshLambertMaterial({ color: 0x1d3542 });
  const uTime = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uSky = { value: skyColor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWaterPos;
        uniform float uTime;
        uniform vec3 uSky;
        vec3 waveNormal(vec2 p, float t) {
          float nx = sin(p.x * 0.35 + t * 1.1) * 0.10
                   + sin((p.x + p.y) * 0.09 + t * 0.45) * 0.14
                   + sin(p.x * 0.045 - t * 0.22) * 0.20;
          float nz = cos(p.y * 0.31 + t * 0.9) * 0.10
                   + cos((p.y - p.x) * 0.075 + t * 0.35) * 0.14
                   + cos(p.y * 0.05 + t * 0.18) * 0.20;
          return normalize(vec3(nx, 1.0, nz));
        }`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = waveNormal(vWaterPos.xz, uTime);`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          vec3 V = normalize(cameraPosition - vWaterPos);
          vec3 N = waveNormal(vWaterPos.xz, uTime);
          float fres = pow(1.0 - max(dot(V, N), 0.0), 3.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, clamp(fres * 0.7, 0.0, 0.7));
          vec3 sunDir = normalize(vec3(-0.5, 0.62, -0.42));
          float glint = pow(max(dot(reflect(-sunDir, N), V), 0.0), 120.0);
          gl_FragColor.rgb += vec3(1.0, 0.95, 0.82) * glint * 0.55;
        }`
      );
  };
  return { mat, update: (dt: number) => { uTime.value += dt; } };
}
