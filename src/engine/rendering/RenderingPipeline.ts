import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  renderingTierContract,
  type QualityLevel,
  type RenderingTierContract,
} from '../quality';
import { TemporalAAPass, type TemporalAAStats } from './TemporalAAPass';

export type RenderMode = 'street' | 'station' | 'ride' | 'bus';

export interface RenderingPipelineStats {
  active: boolean;
  antialiasing: 'fxaa' | 'smaa' | 'temporal';
  fallbackAntialiasing: 'fxaa' | 'smaa';
  ao: boolean;
  aoScale: number;
  aoSamples: number;
  bloom: boolean;
  bloomScale: number;
  bloomStrength: number;
  bloomThreshold: number;
  grade: boolean;
  temporal: TemporalAAStats | null;
  reflections: 'sky-probe';
  selectiveScreenSpaceReflections: false;
  enabledPasses: string[];
  effectsLevel: 0 | 1 | 2;
  renderTargetBytes: number;
}

const gradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    strength: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 color = src.rgb;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));

      // A restrained daylight finish: retain neutral masonry, slightly cool
      // open shadows, and warm sunlit values. Work in the linear render target
      // before OutputPass performs ACES and the display transfer.
      float highlight = smoothstep(0.28, 1.1, luma);
      vec3 splitTone = mix(vec3(0.982, 0.994, 1.018), vec3(1.018, 1.004, 0.978), highlight);
      color *= mix(vec3(1.0), splitTone, strength);
      color = mix(vec3(luma), color, 1.0 + 0.035 * strength);
      color = (color - 0.18) * (1.0 + 0.045 * strength) + 0.18;

      // Very light lens falloff focuses the street without producing the
      // obvious black-corner vignette common to game post-processing.
      vec2 p = vUv * 2.0 - 1.0;
      float vignette = smoothstep(1.45, 0.22, dot(p, p));
      color *= mix(1.0, mix(0.965, 1.0, vignette), strength);
      gl_FragColor = vec4(max(color, vec3(0.0)), src.a);
    }
  `,
};

/**
 * Tiered post-processing with a deliberately short cost ladder.
 *
 * AA is never disabled: Low uses FXAA, Medium/High use SMAA, and Ultra uses a
 * depth-reprojected temporal resolve with SMAA as its no-history fallback. The
 * adaptive governor controls temporal/AO/bloom/grade independently, so a GPU
 * under pressure gives up finishing work before render scale. Expensive passes
 * are allocated only for the tiers that can ever use them.
 */
export class RenderingPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly aoPass: GTAOPass | null;
  private readonly bloomPass: UnrealBloomPass | null;
  private readonly gradePass: ShaderPass | null;
  private readonly fxaaPass: FXAAPass | null;
  private readonly smaaPass: SMAAPass | null;
  private readonly temporalPass: TemporalAAPass | null;
  private readonly outputPass: OutputPass;
  private readonly level: QualityLevel;
  private readonly contract: RenderingTierContract;
  private readonly bytesPerPixel: number;
  private effectsLevel: 0 | 1 | 2;
  private mode: RenderMode = 'street';
  private physicalWidth = 1;
  private physicalHeight = 1;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    level: QualityLevel,
    initialEffectsLevel: 0 | 1 | 2,
  ) {
    this.renderer = renderer;
    this.level = level;
    this.contract = renderingTierContract(level);
    this.effectsLevel = initialEffectsLevel;

    // Mobile tiers keep the two full-screen color buffers at RGBA8. Desktop
    // High/Ultra retain HDR values for emissive billboards and controlled bloom.
    const hdr = level === 'high' || level === 'ultra';
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.name = 'NYCRoam.Post.Depth';
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    });
    target.texture.name = `NYCRoam.Post.${hdr ? 'RGBA16F' : 'RGBA8'}`;
    this.bytesPerPixel = hdr ? 8 : 4;
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (this.contract.temporal) {
      this.temporalPass = new TemporalAAPass(
        camera,
        THREE.HalfFloatType,
        this.contract.temporal.maxHistoryWeight,
      );
      this.composer.addPass(this.temporalPass);
    } else {
      this.temporalPass = null;
    }

    if (this.contract.gtao) {
      this.aoPass = new GTAOPass(scene, camera, 1, 1);
      this.aoPass.blendIntensity = level === 'ultra' ? 0.72 : 0.58;
      this.aoPass.updateGtaoMaterial({
        radius: level === 'ultra' ? 2.4 : 2,
        distanceExponent: 1.7,
        thickness: 1.1,
        distanceFallOff: 1,
        scale: 0.72,
        samples: this.contract.gtao.samples,
        screenSpaceRadius: false,
      });
      this.aoPass.updatePdMaterial({
        lumaPhi: 8,
        depthPhi: 2.5,
        normalPhi: 3.5,
        radius: level === 'ultra' ? 7 : 5,
        rings: 2,
        samples: this.contract.gtao.samples,
      });
      this.composer.addPass(this.aoPass);
    } else {
      this.aoPass = null;
    }

    if (this.contract.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        this.contract.bloom.strength,
        0.32,
        this.contract.bloom.threshold,
      );
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }

    if (this.contract.grade !== 'none') {
      this.gradePass = new ShaderPass(gradeShader);
      this.composer.addPass(this.gradePass);
    } else {
      this.gradePass = null;
    }

    if (this.contract.fallbackAntialiasing === 'fxaa') {
      this.fxaaPass = new FXAAPass();
      this.smaaPass = null;
      this.composer.addPass(this.fxaaPass);
    } else {
      this.fxaaPass = null;
      this.smaaPass = new SMAAPass();
      this.composer.addPass(this.smaaPass);
    }

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    this.applyPassState();
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.physicalWidth = Math.max(1, Math.round(width * pixelRatio));
    this.physicalHeight = Math.max(1, Math.round(height * pixelRatio));
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    // GTAO and bloom intentionally work below the main color resolution. Their
    // denoise/blur stages reconstruct broad contact and glow, saving substantial
    // bandwidth at high-DPR desktop resolutions.
    const aoScale = this.contract.gtao ? this.contract.gtao.scale : 0;
    this.aoPass?.setSize(
      Math.max(1, Math.round(this.physicalWidth * aoScale)),
      Math.max(1, Math.round(this.physicalHeight * aoScale)),
    );
    this.bloomPass?.setSize(
      Math.max(1, Math.round(this.physicalWidth * (this.contract.bloom ? this.contract.bloom.scale : 0.5))),
      Math.max(1, Math.round(this.physicalHeight * (this.contract.bloom ? this.contract.bloom.scale : 0.5))),
    );
  }

  setEffectsLevel(level: 0 | 1 | 2): void {
    if (this.effectsLevel === level) return;
    this.effectsLevel = level;
    this.applyPassState();
  }

  /**
   * Compile streamed materials against the composer's linear render target.
   * Compiling only for the default framebuffer produces a tone-mapped shader
   * permutation that is not reused by RenderPass and merely moves the hitch.
   */
  async compileAsync(
    object: THREE.Object3D,
    camera: THREE.Camera,
    targetScene: THREE.Scene,
  ): Promise<void> {
    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.renderTarget1);
    try {
      await this.renderer.compileAsync(object, camera, targetScene);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
    }
  }

  render(scene: THREE.Scene, mode: RenderMode, deltaSeconds: number): void {
    const sceneChanged = scene !== this.renderPass.scene;
    if (sceneChanged) {
      this.renderPass.scene = scene;
      this.temporalPass?.reset();
    }
    if (this.aoPass && scene !== this.aoPass.scene) this.aoPass.scene = scene;
    if (mode !== this.mode) {
      this.mode = mode;
      this.temporalPass?.reset();
      this.applyPassState();
    }
    this.temporalPass?.beginFrameJitter();
    try {
      this.composer.render(deltaSeconds);
    } finally {
      this.temporalPass?.endFrameJitter();
    }
  }

  stats(): RenderingPipelineStats {
    const colorBuffers = this.physicalWidth * this.physicalHeight * this.bytesPerPixel * 2;
    const depth = this.physicalWidth * this.physicalHeight * 4 * 2;
    const aoScale = this.contract.gtao ? this.contract.gtao.scale : 0;
    const ao = this.aoPass
      ? Math.round(this.physicalWidth * this.physicalHeight * aoScale * aoScale) * (8 + 4 + 8)
      : 0;
    const bloomScale = this.contract.bloom ? this.contract.bloom.scale : 0;
    const bloom = this.bloomPass
      ? Math.round(this.physicalWidth * this.physicalHeight * bloomScale * bloomScale * 1.36)
        * this.bytesPerPixel
      : 0;
    const temporal = this.temporalPass?.stats() ?? null;
    const enabledPasses = [
      'scene',
      this.temporalPass?.enabled ? 'temporal-resolve' : null,
      this.aoPass?.enabled ? 'gtao' : null,
      this.bloomPass?.enabled ? 'bloom' : null,
      this.gradePass?.enabled ? 'grade' : null,
      this.fxaaPass?.enabled ? 'fxaa' : null,
      this.smaaPass?.enabled ? 'smaa' : null,
      'output',
    ].filter((value): value is string => value !== null);
    return {
      active: true,
      antialiasing: this.temporalPass?.enabled
        ? 'temporal'
        : this.fxaaPass
          ? 'fxaa'
          : 'smaa',
      fallbackAntialiasing: this.contract.fallbackAntialiasing,
      ao: !!this.aoPass?.enabled,
      aoScale,
      aoSamples: this.contract.gtao ? this.contract.gtao.samples : 0,
      bloom: !!this.bloomPass?.enabled,
      bloomScale,
      bloomStrength: this.contract.bloom ? this.contract.bloom.strength : 0,
      bloomThreshold: this.contract.bloom ? this.contract.bloom.threshold : 0,
      grade: !!this.gradePass?.enabled,
      temporal,
      reflections: this.contract.reflections,
      selectiveScreenSpaceReflections: false,
      enabledPasses,
      effectsLevel: this.effectsLevel,
      renderTargetBytes: colorBuffers + depth + ao + bloom + (temporal?.historyBytes ?? 0),
    };
  }

  dispose(): void {
    this.aoPass?.dispose();
    this.bloomPass?.dispose();
    this.gradePass?.dispose();
    this.fxaaPass?.dispose();
    this.smaaPass?.dispose();
    this.temporalPass?.dispose();
    this.outputPass.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
  }

  private applyPassState(): void {
    const premium = this.level === 'high' || this.level === 'ultra';
    // AO also grounds station architecture. Rides avoid the normal-buffer pass:
    // the camera and train shell move together and baked tunnel lighting carries
    // the depth cue for much less work.
    if (this.aoPass) {
      this.aoPass.enabled = premium
        && this.effectsLevel >= 1
        && this.mode !== 'ride';
      this.aoPass.blendIntensity = this.effectsLevel === 2
        ? (this.level === 'ultra' ? 0.72 : 0.58)
        : 0.42;
    }
    // Bloom is selective by luminance threshold and outdoor-only. It primarily
    // catches Times Square emissive panels and bright water highlights; station
    // signs remain crisp and mobile tiers allocate no bloom resources at all.
    if (this.bloomPass) {
      this.bloomPass.enabled = premium
        && this.effectsLevel === 2
        && (this.mode === 'street' || this.mode === 'bus');
    }
    if (this.gradePass) {
      this.gradePass.enabled = this.effectsLevel >= 1;
      const authored = this.contract.grade === 'minimal'
        ? 0.42
        : this.level === 'ultra'
          ? 1
          : 0.84;
      this.gradePass.uniforms.strength.value = authored * (this.effectsLevel === 2 ? 1 : 0.62);
    }
    const temporalEnabled = !!this.temporalPass
      && this.effectsLevel === 2
      && this.mode !== 'ride';
    if (this.temporalPass) {
      if (this.temporalPass.enabled !== temporalEnabled) this.temporalPass.reset();
      this.temporalPass.enabled = temporalEnabled;
    }
    // SMAA is the zero-history fallback during adaptive shedding, train rides,
    // camera cuts and on every non-Ultra tier. Never stack it after TAA.
    if (this.smaaPass) this.smaaPass.enabled = !temporalEnabled;
  }
}
