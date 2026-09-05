import * as THREE from 'three';

/** Object-space finish survives merged transit bodies and moving instances. */
export function transitFinish<T extends THREE.MeshStandardMaterial>(material: T, finish: 'steel' | 'paint' | 'rubber'): T {
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTransit;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTransit = position;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTransit;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float grainFade = 1.0 - smoothstep(0.001, 0.008, fwidth(vTransit.y));
        float brush = sin(vTransit.y * 2100.0 + sin(vTransit.x * 3.0)) * grainFade;
        float broad = sin(vTransit.x * 11.7 + sin(vTransit.y * 4.1)) * sin(vTransit.y * 17.3);
        diffuseColor.rgb *= 1.0 + brush * ${finish === 'steel' ? '.035' : '.008'} + broad * .009;
        ${finish === 'steel' ? 'diffuseColor.rgb *= mix(.80, 1.0, smoothstep(.8, 1.4, vTransit.y));' : ''}
        ${finish === 'rubber' ? 'vec2 speckCell = floor(vTransit.xz * 450.0); float speck = fract(sin(dot(speckCell, vec2(12.9898,78.233))) * 43758.5453); diffuseColor.rgb *= 1.0 + (speck - .5) * .16 * (1.0 - smoothstep(.002,.015,length(fwidth(vTransit.xz))));' : ''}
      `);
  };
  material.customProgramCacheKey = () => `transit-finish-${finish}-v1`;
  return material;
}

/** Thin glazing preserves the interior and street view; one material batch,
 * no transmission render targets or screen-space refraction. */
export function transitGlass(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: '#587377', roughness: .2, metalness: .05,
    transparent: true, opacity: .24, depthWrite: false, side: THREE.DoubleSide,
    envMapIntensity: .8 });
  material.forceSinglePass = true;
  return material;
}

/** Physical 60mm dome spacing and panel seams, resolved only when visible. */
export function makeTactileMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: '#dfb431', roughness: .82 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTactile; varying float vTactileUp;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 tactilePosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          tactilePosition = instanceMatrix * tactilePosition;
        #endif
        vTactile = (modelMatrix * tactilePosition).xyz;
        vTactileUp = abs(normal.y);`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTactile; varying float vTactileUp;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 dome = fract(vTactile.xz / .06) - .5;
        float domeDistance = length(dome);
        float detailFade = 1.0 - smoothstep(.008, .04, length(fwidth(vTactile.xz)));
        float domeMask = 1.0 - smoothstep(.16, .26, domeDistance);
        float seam = 1.0 - smoothstep(.003, .009, abs(fract(vTactile.x / .61) - .5) * .61);
        diffuseColor.rgb *= 1.0 - seam * .16 - domeMask * detailFade * .12;
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 tactileNormal = normalize(vec3(dome.x, .45, dome.y));
        normal = normalize(mix(normal, mat3(viewMatrix) * tactileNormal,
          domeMask * detailFade * .55 * smoothstep(.65, .95, vTactileUp)));`);
  };
  material.customProgramCacheKey = () => 'station-tactile-domes-v1';
  return material;
}
