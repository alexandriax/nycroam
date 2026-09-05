import * as THREE from 'three';

/** Meter-scaled, object-space architectural finishes. No per-mesh textures or
 * UV stretching; one program shared by every finish and merged landmark. */
export function architecturalMaterial(color: THREE.ColorRepresentation, finish: 'stone' | 'brick' | 'metal' | 'patina' = 'stone', roughness = 0.78): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color, roughness,
    metalness: finish === 'metal' ? 0.82 : finish === 'patina' ? 0.22 : 0,
    envMapIntensity: finish === 'metal' ? 1.0 : 0.55,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFinish = { value: { stone: 0, brick: 1, metal: 2, patina: 3 }[finish] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfacePos;\nvarying vec3 vSurfaceNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfacePos = position;\nvSurfaceNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSurfacePos;
        varying vec3 vSurfaceNormal;
        uniform float uFinish;
        float surfaceHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float surfaceNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(surfaceHash(i), surfaceHash(i+vec3(1,0,0)), f.x),
            mix(surfaceHash(i+vec3(0,1,0)), surfaceHash(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(surfaceHash(i+vec3(0,0,1)), surfaceHash(i+vec3(1,0,1)), f.x),
            mix(surfaceHash(i+vec3(0,1,1)), surfaceHash(i+vec3(1,1,1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 p = vSurfacePos;
        float grain = surfaceNoise(p * 7.0);
        float weather = surfaceNoise(p * 0.45);
        diffuseColor.rgb *= 0.88 + 0.12 * grain + 0.09 * weather;
        if (uFinish < 1.5) {
          vec3 n = abs(normalize(vSurfaceNormal));
          vec2 uv = n.y > 0.7 ? p.xz : n.x > n.z ? p.zy : p.xy;
          vec2 size = uFinish > 0.5 ? vec2(0.24, 0.08) : vec2(1.2, 0.55);
          uv.x += mod(floor(uv.y / size.y), 2.0) * size.x * 0.5;
          vec2 f = fract(uv / size);
          vec2 edge = min(f, 1.0-f) * size;
          vec2 aa = max(fwidth(uv), vec2(0.001));
          float joint = 1.0 - smoothstep(0.003, 0.003 + max(aa.x, aa.y), min(edge.x, edge.y));
          float detail = 1.0 - smoothstep(0.025, 0.15, max(aa.x, aa.y));
          diffuseColor.rgb *= 1.0 - joint * detail * 0.22;
        } else if (uFinish > 2.5) {
          diffuseColor.rgb *= mix(vec3(0.64,0.8,0.73), vec3(1.1,1.03,0.92), weather);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (grain - 0.5) * 0.12, 0.15, 1.0);
        if (uFinish > 1.5 && uFinish < 2.5) {
          float brushed = sin(vSurfacePos.y * 260.0) * (1.0 - smoothstep(.004,.025,fwidth(vSurfacePos.y)));
          roughnessFactor = clamp(roughnessFactor + brushed*.045, .15, 1.0);
        }`);
  };
  mat.customProgramCacheKey = () => 'nyc-architectural-v1';
  return mat;
}
