import * as THREE from 'three';

/**
 * Atmosphere: aerial perspective + sun inscattering, installed by rewriting
 * three's SHARED fog shader chunks.
 *
 * Doing it at the chunk level rather than per material is deliberate. Every
 * material in the street scene already opts into fog, and there are dozens of
 * them across tiles, landmarks, kits, props and vehicles -- most created in
 * modules that know nothing about lighting. Patching the chunk gives all of
 * them the same air for free, with no plumbing and no risk of one material
 * drifting out of sync with the rest of the scene.
 *
 * The sun is fixed in this world (see SUN_OFFSET in sky.ts), so its direction
 * and scatter colour are compiled in as constants. That keeps the extra cost to
 * a handful of ALU ops per fragment and avoids the uniform problem entirely:
 * three CLONES UniformsLib.fog into every material, so a shared uniform added
 * there could not be updated from one place anyway.
 */

/** Unit vector toward the sun. Must stay in step with SUN_OFFSET in sky.ts. */
const SUN = new THREE.Vector3(-340, 420, -285).normalize();

let installed = false;

export function installAtmosphere() {
  if (installed) return;
  installed = true;

  // vFogMV carries the view-space position, which is enough to recover both the
  // fragment's world height and the world-space view ray (the view matrix is a
  // rigid transform, so `v * mat3(viewMatrix)` is its inverse rotation).
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogMV;
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogMV = mvPosition.xyz;
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogMV;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif

  // camera -> fragment, rotated back into world space
  vec3 wOffs = vFogMV * mat3( viewMatrix );
  float wy = cameraPosition.y + wOffs.y;
  vec3 wdir = normalize( wOffs );

  // Aerial perspective. Haze is thick in the street canyons and thins with
  // height, which is what gives distance a read at all from the air. This term
  // only ever ADDS to the fog: the linear near/far curve is what guarantees
  // tiles are fully washed out by the load radius, so streaming pop stays
  // hidden no matter how the air is tuned.
  float ground = exp( - max( wy - 4.0, 0.0 ) / 210.0 );
  float haze = ( 1.0 - fogFactor ) * ground * smoothstep( 40.0, 900.0, vFogDepth ) * 0.42;
  fogFactor = clamp( fogFactor + haze, 0.0, 1.0 );

  // Inscattering: air looked at THROUGH the sun glows warm, air away from it
  // stays cool and blue. This is the whole reason haze reads as light rather
  // than as a grey veil.
  float sunDot = max( dot( wdir, vec3( -0.5566, 0.6875, -0.4665 ) ), 0.0 );
  vec3 fogCol = mix( fogColor, vec3( 1.0, 0.947, 0.86 ), pow( sunDot, 3.5 ) * 0.6 );
  fogCol = mix( fogCol * vec3( 0.94, 0.965, 1.03 ), fogCol, ground );

  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
#endif`;
}

export { SUN as SUN_UNIT };
