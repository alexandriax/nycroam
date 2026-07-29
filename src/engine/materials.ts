import * as THREE from 'three';
import {
  makeAsphaltTexture, makeSidewalkTexture, makeBrickTexture, makeRoofTexture,
  makeGrassDetailTexture, makeBarkTexture,
} from './textures';
import { quality } from './quality';

/**
 * Facade material: Lambert + procedural window grid on vertical faces.
 * Windows are carved in the fragment shader from world position; brick/roof
 * normals are world-projected so close surfaces carry real light relief without
 * extra geometry. Screen-space filtering keeps the grid stable in motion, and
 * expensive detail fades before it becomes sub-pixel. Still one material and
 * one draw call per tile.
 */
export function makeFacadeMaterial(): THREE.MeshLambertMaterial {
  // DoubleSide + front-facing test: if imperfect OSM data leaves any opening,
  // the inside of the far wall renders as a dark interior instead of void.
  const q = quality();
  // Keep the city-scale facade batch on Lambert: the procedural window shader
  // supplies the reflection cues, while applying the full Standard BRDF to
  // every visible building is a poor mobile/desktop trade at this scale.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.dithering = true;
  const brick = makeBrickTexture('red');
  const roof = makeRoofTexture();
  // Normal-map relief is the premium desktop close-up path. Mobile keeps the
  // anti-aliased windows/reflections but avoids a second texture sample before
  // lighting; its lower resolution makes the micro-relief imperceptible anyway.
  const premiumSurfaceNormals = q.level === 'high' || q.level === 'ultra';
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
        }
        // Analytically filtered [a,b] band: a step() pair widened to the pixel
        // footprint w, so window edges resolve instead of aliasing.
        float band(float x, float a, float b, float w) {
          return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x));
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
          float styleN = floor(vStyle + 0.5);
          bool texturedMasonry = styleN < 0.5
            || abs(styleN - 4.0) < 0.5
            || abs(styleN - 5.0) < 0.5
            || abs(styleN - 7.0) < 0.5;
          if (verticalN > 0.55 && vWPos.y > 0.5 && texturedMasonry && detailN > 0.001) {
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
            // Eight stable archetypes. Styles 0/1 intentionally retain the old
            // masonry/glass behavior, so tiles produced before the semantic
            // pipeline upgrade render identically.
            float styleId = clamp(floor(vStyle + 0.5), 0.0, 7.0);
            bool glassTower = abs(styleId - 1.0) < 0.5 || abs(styleId - 6.0) < 0.5;
            bool industrial = abs(styleId - 4.0) < 0.5;
            bool brownstone = abs(styleId - 5.0) < 0.5;
            bool concrete = abs(styleId - 3.0) < 0.5;
            bool stone = abs(styleId - 2.0) < 0.5;
            float floorH = glassTower ? 3.4 : industrial ? 4.15 : brownstone ? 3.25 : 3.1;
            float winW = abs(styleId - 6.0) < 0.5 ? 1.45
              : glassTower ? 1.7 : industrial ? 3.2 : concrete ? 3.35
              : brownstone ? 2.8 : stone ? 2.6 : 2.5;
            bool storefront = v < 4.6;
            if (storefront) { floorH = 4.6; winW = 4.2; }
            // Cell coordinates BEFORE the fract(), so their screen-space
            // derivatives are continuous (fwidth of a fract() spikes at every
            // cell seam and would draw a bright line there).
            float cu = u / winW, cv = v / floorH;
            vec2 cellId = vec2(floor(cu), floor(cv));
            vec2 f = vec2(fract(cu), fract(cv));
            // Half a pixel in cell units, per axis. This is what turns a hard
            // step() into a properly filtered edge -- without it every window
            // mullion is a 1-bit test that crawls and sparkles as soon as a cell
            // is near pixel-sized, which is exactly the shimmer you fly through
            // in the helicopter.
            float wx = max(fwidth(cu), 1e-5) * 0.5;
            float wy = max(fwidth(cv), 1e-5) * 0.5;
            // Past ~1 cell per pixel no amount of filtering can resolve the
            // pattern, so cross-fade the whole grid to its own AREA AVERAGE.
            // Same mean tone, zero temporal noise.
            float lod = 1.0 - smoothstep(0.22, 0.62, max(wx, wy));
            float rnd = mix(0.45, bhash(cellId + floor(diffuseColor.rg * 61.0)), lod);
            vec3 V = normalize(cameraPosition - vWPos);
            float fresnel = pow(1.0 - max(dot(V, wn), 0.0), 3.0);
            vec3 reflected = reflect(-V, wn);
            float skyLift = clamp(reflected.y * 0.55 + 0.55, 0.0, 1.0);
            vec3 skyGlass = mix(vec3(0.20, 0.27, 0.36), vec3(0.67, 0.76, 0.86), skyLift);
            vec3 sunDir = normalize(vec3(-0.48, 0.64, -0.40));
            float glint = pow(max(dot(reflect(-sunDir, wn), V), 0.0), 96.0) * lod;

            if (glassTower && !storefront) {
              // curtain wall: thin mullions + spandrel band each floor
              float mull = mix(0.890, band(f.x, 0.055, 0.945, wx), lod);
              float pane = mix(0.660, band(f.y, 0.06, 0.72, wy), lod);
              float spandrel = mix(0.190, band(f.y, 0.78, 0.97, wy), lod);
              // sky gradient down the pane + per-pane tint
              vec3 glass = mix(vec3(0.30, 0.37, 0.46), vec3(0.55, 0.63, 0.72), mix(0.4, f.y * 0.8 + rnd * 0.25, lod));
              glass = mix(glass, skyGlass, mix(0.18, 0.34 + fresnel * 0.48, lod));
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, mull * pane * 0.94);
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, spandrel * 0.8);
              diffuseColor.rgb += vec3(1.0, 0.94, 0.80) * glint * pane * 0.22;
            } else {
              float inX = mix(0.670, band(f.x, 0.18, 0.85, wx), lod);
              float inY = mix(0.550, band(f.y, 0.25, 0.8, wy), lod);
              if (storefront) {
                inX = mix(0.840, band(f.x, 0.08, 0.92, wx), lod);
                inY = mix(0.700, band(f.y, 0.05, 0.75, wy), lod);
              }
              float win = inX * inY;
              // masonry surface detail between the windows (brightness only,
              // so each building keeps its palette color)
              vec3 bt = texture2D(uBrick, vec2(u, v) / 1.2).rgb;
              float bl = dot(bt, vec3(0.333)) * 1.75;
              float masonryRelief = industrial ? 0.3 : brownstone ? 0.24
                : (stone || concrete) ? 0.08 : 0.34;
              diffuseColor.rgb *= mix(1.0, bl, masonryRelief * (1.0 - win));
              vec3 glass = mix(vec3(0.13, 0.16, 0.2), vec3(0.38, 0.44, 0.52), rnd * rnd);
              if (storefront) glass = mix(vec3(0.1, 0.11, 0.13), vec3(0.3, 0.28, 0.24), rnd);
              glass = mix(glass, skyGlass, (storefront ? 0.18 : 0.27) + fresnel * 0.35);
              // window inset: lintel shadow at the top of the opening, darker jambs
              float lintel = 1.0 - 0.5 * mix(0.26, smoothstep(0.68, 0.8, f.y), lod) * win;
              float jamb = 1.0 - 0.28 * lod * (band(f.x, 0.18, 0.24, wx) + band(f.x, 0.79, 0.85, wx)) * inY;
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.88);
              diffuseColor.rgb *= lintel * jamb;
              diffuseColor.rgb += vec3(1.0, 0.94, 0.82) * glint * win * (storefront ? 0.07 : 0.11);
              // Real storefronts are divided into narrow display bays and a
              // transom; upper punched windows get a slim sash. These are only
              // shader masks, so the close-up read improves with no geometry.
              float frame = storefront
                ? lod * ((band(f.x, 0.335, 0.355, wx) + band(f.x, 0.645, 0.665, wx)) * inY
                  + band(f.y, 0.54, 0.565, wy) * inX)
                : lod * band(f.y, 0.505, 0.525, wy) * inX;
              diffuseColor.rgb = mix(diffuseColor.rgb, facadeBase * 0.36, clamp(frame, 0.0, 1.0) * 0.92);
              // sill highlight under the window
              float sill = lod * band(f.y, 0.225, 0.275, max(wy, 0.025)) * inX;
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
export function makeRoadMaterial(): THREE.MeshLambertMaterial | THREE.MeshStandardMaterial {
  const t = makeAsphaltTexture();
  const q = quality();
  // Full roughness response is reserved for desktop; the mobile Lambert path
  // keeps the exact same albedo/normal read without paying for IBL per pixel.
  const common = {
    vertexColors: true,
    color: 0xffffff, // preserve the authored asphalt albedo; vertex colors still tint per class
    map: t.map,
    normalMap: t.normal,
  };
  const mat = q.level === 'high' || q.level === 'ultra'
    ? new THREE.MeshStandardMaterial({ ...common, roughness: 0.91, metalness: 0.015 })
    : new THREE.MeshLambertMaterial(common);
  mat.normalScale = new THREE.Vector2(0.7, 0.7);
  mat.dithering = true;
  return mat;
}

/** Poured-concrete walks with score joints. */
export function makeWalkMaterial(): THREE.MeshLambertMaterial | THREE.MeshStandardMaterial {
  const t = makeSidewalkTexture();
  const common = {
    vertexColors: true,
    color: 0xffffff,
    map: t.map,
    normalMap: t.normal,
  };
  const q = quality();
  const mat = q.level === 'high' || q.level === 'ultra'
    ? new THREE.MeshStandardMaterial({ ...common, roughness: 0.94, metalness: 0 })
    : new THREE.MeshLambertMaterial(common);
  mat.normalScale = new THREE.Vector2(0.8, 0.8);
  mat.dithering = true;
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
  const q = quality();
  // Low avoids both bark samples; at the tier's 1x cap the five-sided trunk is
  // primarily a silhouette. Medium keeps the existing Lambert texture path,
  // while desktop tiers gain a rough, non-metallic bark response from the
  // outdoor environment without changing draw count.
  if (q.level === 'low') {
    return new THREE.MeshLambertMaterial({ color: 0x806a56 });
  }
  const t = makeBarkTexture();
  const mat = q.level === 'high' || q.level === 'ultra'
    ? new THREE.MeshStandardMaterial({
      color: 0xffffff, map: t.map, normalMap: t.normal, roughness: 0.96, metalness: 0,
    })
    : new THREE.MeshLambertMaterial({ color: 0xffffff, map: t.map, normalMap: t.normal });
  mat.normalScale = new THREE.Vector2(0.72, 0.72);
  mat.dithering = true;
  return mat;
};

export interface TreeCanopyMaterialKit {
  mat: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;
  /** Advance one shared wind phase for every instanced canopy in the city. */
  update: (dt: number) => void;
}

/**
 * Opaque instanced foliage with a cheap shared wind/translucency cue.
 *
 * The canopy remains a closed low-poly mesh: no alpha cards, sorting or
 * overdraw. Wind runs in the shared vertex program and uses each instance's
 * world translation as its phase, so an entire tile is still one draw.
 */
export function treeCanopyMaterial(): TreeCanopyMaterialKit {
  const q = quality();
  const premium = q.level === 'high' || q.level === 'ultra';
  const animated = q.level !== 'low';
  const mat = premium
    ? new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.9, metalness: 0,
    })
    : new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.dithering = true;
  const uTime = { value: 0 };

  if (animated) {
    const windAmp = premium ? 0.075 : 0.04;
    const transmit = premium ? 0.12 : 0.055;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTreeTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTreeTime;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            // Lower vertices stay tied to the trunk; upper crown vertices move
            // a few centimetres. World-position phase prevents tiled lockstep.
            float treeCrown = smoothstep(1.25, 4.8, position.y);
            float treePhase = instanceMatrix[3].x * 0.031 + instanceMatrix[3].z * 0.023;
            float treeGust = sin(uTreeTime * 0.82 + treePhase)
              + 0.38 * sin(uTreeTime * 1.71 + treePhase * 1.83);
            transformed.x += treeGust * treeCrown * ${windAmp.toFixed(3)};
            transformed.z += sin(uTreeTime * 0.67 + treePhase * 1.27)
              * treeCrown * ${(windAmp * 0.58).toFixed(3)};
          #endif`
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // A restrained thin-leaf cue on the sun-opposed side of the closed
          // crown. This is lighting only—there is no transparent overdraw.
          vec3 treeSunView = normalize((viewMatrix * vec4(-0.5566, 0.6875, -0.4665, 0.0)).xyz);
          float treeBack = max(dot(-normal, treeSunView), 0.0);
          treeBack *= treeBack;
          reflectedLight.indirectDiffuse += diffuseColor.rgb
            * vec3(0.55, 0.82, 0.28) * treeBack * ${transmit.toFixed(3)};
        }`
      );
    };
    mat.customProgramCacheKey = () => `nycroam-tree-canopy-${q.level}`;
  }

  return {
    mat,
    update: animated
      ? (dt: number) => { uTime.value += Math.min(0.1, Math.max(0, dt)); }
      : () => {},
  };
}

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
        // Waves are three octaves of sine, wavelengths roughly 18 m / 70 m /
        // 140 m. The plane is 60 km across, so at the horizon a single pixel
        // spans hundreds of metres and every one of those octaves aliases into
        // a crawling moire -- the hatched band that used to sit across the
        // skyline. Each octave is faded out once the pixel footprint approaches
        // its own wavelength, which is the analytic version of a mip chain.
        vec3 waveNormal(vec2 p, float t, float px) {
          float f1 = 1.0 - smoothstep(2.5, 11.0, px);
          float f2 = 1.0 - smoothstep(9.0, 42.0, px);
          float f3 = 1.0 - smoothstep(22.0, 105.0, px);
          float nx = sin(p.x * 0.35 + t * 1.1) * 0.10 * f1
                   + sin((p.x + p.y) * 0.09 + t * 0.45) * 0.14 * f2
                   + sin(p.x * 0.045 - t * 0.22) * 0.20 * f3;
          float nz = cos(p.y * 0.31 + t * 0.9) * 0.10 * f1
                   + cos((p.y - p.x) * 0.075 + t * 0.35) * 0.14 * f2
                   + cos(p.y * 0.05 + t * 0.18) * 0.20 * f3;
          return normalize(vec3(nx, 1.0, nz));
        }
        float waterPixelSpan() {
          return max(length(vec2(dFdx(vWaterPos.x), dFdy(vWaterPos.x))),
                     length(vec2(dFdx(vWaterPos.z), dFdy(vWaterPos.z))));
        }`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = waveNormal(vWaterPos.xz, uTime, waterPixelSpan());`
      )
      // Ahead of the fog, not after it: fresnel and glint are surface response,
      // so the haze has to sit on top of them. Injected at <dithering_fragment>
      // they were added AFTER <fog_fragment> and the glint stayed at full
      // strength through kilometres of air.
      .replace(
        '#include <fog_fragment>',
        `{
          float px = waterPixelSpan();
          vec3 V = normalize(cameraPosition - vWaterPos);
          vec3 N = waveNormal(vWaterPos.xz, uTime, px);
          float fres = pow(1.0 - max(dot(V, N), 0.0), 3.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, clamp(fres * 0.7, 0.0, 0.7));
          // A pow(.,120) lobe is a sub-pixel feature almost everywhere on a
          // 60 km plane; keep it only where the surface is actually resolved.
          float sharp = 1.0 - smoothstep(1.5, 7.0, px);
          vec3 sunDir = vec3(-0.5566, 0.6875, -0.4665);
          float glint = pow(max(dot(reflect(-sunDir, N), V), 0.0), 120.0);
          gl_FragColor.rgb += vec3(1.0, 0.95, 0.82) * glint * 0.55 * sharp;
        }
        #include <fog_fragment>`
      );
  };
  return { mat, update: (dt: number) => { uTime.value += dt; } };
}
