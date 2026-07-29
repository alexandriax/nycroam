import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const aoShader = {
  uniforms: {
    tDepth: { value: null as THREE.Texture | null },
    texelSize: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 7000 },
    sampleRadius: { value: 3.5 },
    sampleCount: { value: 8 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDepth;
    uniform vec2 texelSize;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float sampleRadius;
    uniform int sampleCount;
    varying vec2 vUv;

    float linearDepth(vec2 uv) {
      float depth = texture2D(tDepth, uv).x;
      return -perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
    }

    float contactAt(vec2 direction, float center, vec2 stepUv) {
      float nearby = linearDepth(vUv + direction * stepUv);
      float delta = center - nearby;
      return smoothstep(0.035, 0.42, delta)
        * (1.0 - smoothstep(1.8, 7.5, delta));
    }

    void main() {
      float center = linearDepth(vUv);
      if (center >= cameraFar * 0.995) {
        gl_FragColor = vec4(1.0);
        return;
      }

      vec2 stepUv = texelSize * sampleRadius;
      float occlusion = 0.0;
      // Only a nearer neighbor can occlude this surface. Fade very shallow
      // depth noise and large discontinuities to avoid curb/building halos.
      occlusion += contactAt(vec2(1.0, 0.0), center, stepUv);
      occlusion += contactAt(vec2(-1.0, 0.0), center, stepUv);
      occlusion += contactAt(vec2(0.0, 1.0), center, stepUv);
      occlusion += contactAt(vec2(0.0, -1.0), center, stepUv);
      if (sampleCount > 4) {
        occlusion += contactAt(vec2(0.7071, 0.7071), center, stepUv);
        occlusion += contactAt(vec2(-0.7071, 0.7071), center, stepUv);
      }
      if (sampleCount > 6) {
        occlusion += contactAt(vec2(0.7071, -0.7071), center, stepUv);
        occlusion += contactAt(vec2(-0.7071, -0.7071), center, stepUv);
      }
      float ao = 1.0 - (occlusion / float(sampleCount)) * 0.42;
      gl_FragColor = vec4(vec3(clamp(ao, 0.58, 1.0)), 1.0);
    }
  `,
};

const compositeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tAo: { value: null as THREE.Texture | null },
    intensity: { value: 0.7 },
  },
  vertexShader: aoShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tAo;
    uniform float intensity;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float ao = texture2D(tAo, vUv).r;
      color.rgb *= mix(1.0, ao, intensity);
      gl_FragColor = color;
    }
  `,
};

/**
 * Low-resolution depth-contact AO without a second geometry/normal pass.
 *
 * Three's GTAOPass redraws every visible mesh to a normal target, doubling
 * Times Square's submissions. This pass reuses the primary scene depth,
 * estimates only tight contact occlusion, then bilinearly reconstructs the
 * broad signal while compositing. Baked vertex/material AO continues to carry
 * large-scale creases; this pass supplies the missing curb, wheel and façade
 * grounding at two fullscreen submissions.
 */
export class DepthContactAOPass extends Pass {
  blendIntensity = 0.7;
  private readonly camera: THREE.Camera;
  private readonly depthProvider: (() => THREE.Texture | null) | null;
  private readonly aoTarget: THREE.WebGLRenderTarget;
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly aoQuad: FullScreenQuad;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly compositeQuad: FullScreenQuad;
  private width = 1;
  private height = 1;

  constructor(
    camera: THREE.Camera,
    samples: number,
    depthProvider: (() => THREE.Texture | null) | null = null,
  ) {
    super();
    this.camera = camera;
    this.depthProvider = depthProvider;
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.aoTarget.texture.name = 'NYCRoam.DepthContactAO';
    this.aoMaterial = new THREE.ShaderMaterial({
      ...aoShader,
      uniforms: THREE.UniformsUtils.clone(aoShader.uniforms),
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.aoMaterial.uniforms.sampleCount.value = Math.max(4, Math.min(8, Math.round(samples)));
    this.aoQuad = new FullScreenQuad(this.aoMaterial);
    this.compositeMaterial = new THREE.ShaderMaterial({
      ...compositeShader,
      uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms),
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.aoTarget.setSize(this.width, this.height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const depth = this.depthProvider?.() ?? readBuffer.depthTexture;
    if (!depth) {
      // Every production composer target owns depth. If a custom embed omits
      // it, copy color unchanged instead of swapping in an unwritten buffer.
      this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
      this.compositeMaterial.uniforms.tAo.value = readBuffer.texture;
      this.compositeMaterial.uniforms.intensity.value = 0;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.compositeQuad.render(renderer);
      return;
    }
    const perspective = this.camera as THREE.PerspectiveCamera;
    this.aoMaterial.uniforms.tDepth.value = depth;
    this.aoMaterial.uniforms.texelSize.value.set(
      1 / Math.max(1, depth.image?.width ?? this.width),
      1 / Math.max(1, depth.image?.height ?? this.height),
    );
    this.aoMaterial.uniforms.cameraNear.value = perspective.near ?? 0.1;
    this.aoMaterial.uniforms.cameraFar.value = perspective.far ?? 7000;
    renderer.setRenderTarget(this.aoTarget);
    renderer.clear();
    this.aoQuad.render(renderer);

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tAo.value = this.aoTarget.texture;
    this.compositeMaterial.uniforms.intensity.value = this.blendIntensity;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.compositeQuad.render(renderer);
  }

  override dispose(): void {
    this.aoTarget.dispose();
    this.aoMaterial.dispose();
    this.compositeMaterial.dispose();
    this.aoQuad.dispose();
    this.compositeQuad.dispose();
  }
}
