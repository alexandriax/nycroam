import * as THREE from 'three';
import {
  makeAsphaltTexture, makeSidewalkTexture, makeBrickTexture, makeRoofTexture,
  makeGrassDetailTexture, makeBarkTexture,
} from './textures';

/**
 * Facade material: Lambert + injected procedural window grid on vertical faces.
 * Windows are carved in the fragment shader from world position — zero textures,
 * one material, one draw call per tile.
 */
export function makeFacadeMaterial(): THREE.MeshLambertMaterial {
  // DoubleSide + front-facing test: if imperfect OSM data leaves any opening,
  // the inside of the far wall renders as a dark interior instead of void.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const brick = makeBrickTexture('red');
  const roof = makeRoofTexture();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBrick = { value: brick.map };
    shader.uniforms.uRoof = { value: roof.map };
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
        uniform sampler2D uRoof;
        float bhash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }
        // Analytically filtered [a,b] band: a step() pair widened to the pixel
        // footprint w, so window edges resolve instead of aliasing.
        float band(float x, float a, float b, float w) {
          return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x));
        }`
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
          if (vertical > 0.55 && vWPos.y > 0.5) {
            float u = vWPos.x * wn.z - vWPos.z * wn.x;
            float v = vWPos.y;
            bool glassTower = vStyle > 0.5;
            float floorH = glassTower ? 3.4 : 3.1;
            float winW = glassTower ? 1.7 : 2.5;
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

            if (glassTower && !storefront) {
              // curtain wall: thin mullions + spandrel band each floor
              float mull = mix(0.890, band(f.x, 0.055, 0.945, wx), lod);
              float pane = mix(0.660, band(f.y, 0.06, 0.72, wy), lod);
              float spandrel = mix(0.190, band(f.y, 0.78, 0.97, wy), lod);
              // sky gradient down the pane + per-pane tint
              vec3 glass = mix(vec3(0.30, 0.37, 0.46), vec3(0.55, 0.63, 0.72), mix(0.4, f.y * 0.8 + rnd * 0.25, lod));
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, mull * pane * 0.92);
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, spandrel * 0.8);
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
              vec3 bt = texture2D(uBrick, vec2(u, v) / 2.4).rgb;
              float bl = dot(bt, vec3(0.333)) * 1.75;
              diffuseColor.rgb *= mix(1.0, bl, 0.34 * (1.0 - win));
              vec3 glass = mix(vec3(0.13, 0.16, 0.2), vec3(0.38, 0.44, 0.52), rnd * rnd);
              if (storefront) glass = mix(vec3(0.1, 0.11, 0.13), vec3(0.3, 0.28, 0.24), rnd);
              // window inset: lintel shadow at the top of the opening, darker jambs
              float lintel = 1.0 - 0.5 * mix(0.26, smoothstep(0.68, 0.8, f.y), lod) * win;
              float jamb = 1.0 - 0.28 * lod * (band(f.x, 0.18, 0.24, wx) + band(f.x, 0.79, 0.85, wx)) * inY;
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.88);
              diffuseColor.rgb *= lintel * jamb;
              // sill highlight under the window
              float sill = lod * band(f.y, 0.225, 0.275, max(wy, 0.025)) * inX;
              diffuseColor.rgb += vec3(0.05) * sill * (storefront ? 0.0 : 1.0);
            }
            // grounding gradient: subtle darkening near street
            diffuseColor.rgb *= 0.86 + 0.14 * clamp(v / 7.0, 0.0, 1.0);
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
