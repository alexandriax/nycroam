import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';

/**
 * Centered 8-sample Halton(2,3) sequence. Values are in pixel units, not NDC.
 * It has zero-ish mean and no repeated two-sample diagonal pattern.
 */
export const TEMPORAL_JITTER_8: ReadonlyArray<readonly [number, number]> = [
  [7 / 128, -1 / 6],
  [-25 / 128, 1 / 6],
  [39 / 128, -7 / 18],
  [-41 / 128, -1 / 18],
  [23 / 128, 5 / 18],
  [-9 / 128, -5 / 18],
  [55 / 128, 1 / 18],
  [-49 / 128, 7 / 18],
];

/**
 * CPU mirror of the resolve confidence equation. Exported so the most
 * important ghost-rejection policy can be regression-tested without WebGL.
 */
export function temporalHistoryWeight(
  colorDelta: number,
  depthSpan: number,
  maxHistoryWeight = 0.88,
): number {
  const smoothstep = (a: number, b: number, x: number) => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const moving = smoothstep(0.025, 0.22, colorDelta);
  const edge = smoothstep(0.006, 0.08, depthSpan);
  return maxHistoryWeight * (1 - 0.84 * moving) * (1 - 0.65 * edge);
}

const temporalResolveShader = {
  uniforms: {
    tCurrent: { value: null as THREE.Texture | null },
    tHistory: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    currentInvViewProjection: { value: new THREE.Matrix4() },
    previousViewProjection: { value: new THREE.Matrix4() },
    texelSize: { value: new THREE.Vector2(1, 1) },
    historyValid: { value: 0 },
    maxHistoryWeight: { value: 0.88 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform sampler2D tDepth;
    uniform mat4 currentInvViewProjection;
    uniform mat4 previousViewProjection;
    uniform vec2 texelSize;
    uniform float historyValid;
    uniform float maxHistoryWeight;
    varying vec2 vUv;

    vec3 rgbToYCoCg(vec3 rgb) {
      return vec3(
        dot(rgb, vec3(0.25, 0.5, 0.25)),
        dot(rgb, vec3(0.5, 0.0, -0.5)),
        dot(rgb, vec3(-0.25, 0.5, -0.25))
      );
    }

    vec3 yCoCgToRgb(vec3 c) {
      return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
    }

    void main() {
      vec4 current = texture2D(tCurrent, vUv);
      if (historyValid < 0.5) {
        gl_FragColor = current;
        return;
      }

      float depth = texture2D(tDepth, vUv).x;
      vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 world = currentInvViewProjection * clip;
      world /= max(abs(world.w), 1e-6);
      vec4 previousClip = previousViewProjection * world;
      vec2 previousUv = previousClip.xy / max(previousClip.w, 1e-6) * 0.5 + 0.5;
      bool validUv = previousClip.w > 0.0
        && all(greaterThan(previousUv, vec2(0.001)))
        && all(lessThan(previousUv, vec2(0.999)));
      if (!validUv) {
        gl_FragColor = current;
        return;
      }

      // Clip history to the current 3x3 neighborhood in YCoCg space. This is
      // the critical moving-actor rejection: old car/person pixels cannot
      // remain outside colors that exist around the current surface.
      vec3 neighborhoodMin = vec3(1e6);
      vec3 neighborhoodMax = vec3(-1e6);
      float depthMin = 1.0;
      float depthMax = 0.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 uv = vUv + vec2(float(x), float(y)) * texelSize;
          vec3 sampleColor = rgbToYCoCg(texture2D(tCurrent, uv).rgb);
          neighborhoodMin = min(neighborhoodMin, sampleColor);
          neighborhoodMax = max(neighborhoodMax, sampleColor);
          float sampleDepth = texture2D(tDepth, uv).x;
          depthMin = min(depthMin, sampleDepth);
          depthMax = max(depthMax, sampleDepth);
        }
      }
      vec3 rawHistory = texture2D(tHistory, previousUv).rgb;
      vec3 historyYCoCg = clamp(
        rgbToYCoCg(rawHistory),
        neighborhoodMin - vec3(0.008, 0.004, 0.004),
        neighborhoodMax + vec3(0.008, 0.004, 0.004)
      );
      vec3 clippedHistory = yCoCgToRgb(historyYCoCg);

      float currentLuma = dot(current.rgb, vec3(0.2126, 0.7152, 0.0722));
      float historyLuma = dot(rawHistory, vec3(0.2126, 0.7152, 0.0722));
      float colorDelta = abs(currentLuma - historyLuma)
        + length(current.rgb - rawHistory) * 0.32;
      float movingReject = smoothstep(0.025, 0.22, colorDelta);
      float edgeReject = smoothstep(0.006, 0.08, depthMax - depthMin);
      float weight = maxHistoryWeight
        * (1.0 - 0.84 * movingReject)
        * (1.0 - 0.65 * edgeReject);
      gl_FragColor = vec4(mix(current.rgb, clippedHistory, weight), current.a);
    }
  `,
};

export interface TemporalAAStats {
  historyValid: boolean;
  jitterIndex: number;
  historyBytes: number;
  maxHistoryWeight: number;
}

/**
 * Camera-reprojected temporal resolve for Ultra.
 *
 * Unlike Three's stock TAARenderPass, this pass does not blindly accumulate
 * screen pixels. It reprojects static surfaces through depth, resets on camera
 * cuts, clips history to the current 3x3 color neighborhood, and lowers history
 * weight at depth edges and on large color changes. That combination keeps
 * moving pedestrians and vehicles from leaving visible trails.
 */
export class TemporalAAPass extends Pass {
  private readonly camera: THREE.Camera;
  private readonly resolveMaterial: THREE.ShaderMaterial;
  private readonly resolveQuad: FullScreenQuad;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly copyQuad: FullScreenQuad;
  private readonly history: THREE.WebGLRenderTarget;
  private readonly currentViewProjection = new THREE.Matrix4();
  private readonly currentInvViewProjection = new THREE.Matrix4();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly savedProjection = new THREE.Matrix4();
  private readonly savedProjectionInverse = new THREE.Matrix4();
  private readonly previousPosition = new THREE.Vector3();
  private readonly currentPosition = new THREE.Vector3();
  private readonly previousQuaternion = new THREE.Quaternion();
  private readonly currentQuaternion = new THREE.Quaternion();
  private historyValid = false;
  private hasPreviousPose = false;
  private jitterIndex = 0;
  private width = 1;
  private height = 1;
  private jitterApplied = false;
  private readonly bytesPerPixel: number;
  private readonly maxHistoryWeight: number;

  constructor(
    camera: THREE.Camera,
    textureType: THREE.TextureDataType,
    maxHistoryWeight = 0.88,
  ) {
    super();
    this.camera = camera;
    this.maxHistoryWeight = maxHistoryWeight;
    this.bytesPerPixel = textureType === THREE.HalfFloatType ? 8 : 4;
    this.resolveMaterial = new THREE.ShaderMaterial({
      ...temporalResolveShader,
      uniforms: THREE.UniformsUtils.clone(temporalResolveShader.uniforms),
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.resolveMaterial.uniforms.maxHistoryWeight.value = maxHistoryWeight;
    this.resolveQuad = new FullScreenQuad(this.resolveMaterial);
    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'NYCRoam.TemporalHistoryCopy',
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
    this.history = new THREE.WebGLRenderTarget(1, 1, {
      type: textureType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.history.texture.name = 'NYCRoam.TemporalHistory';
  }

  setSize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.history.setSize(nextWidth, nextHeight);
    this.resolveMaterial.uniforms.texelSize.value.set(1 / nextWidth, 1 / nextHeight);
    this.reset();
  }

  /**
   * Apply one sub-pixel camera sample before RenderPass. The caller must pair
   * every successful call with endFrameJitter(), even if composer.render throws.
   */
  beginFrameJitter(): boolean {
    if (!this.enabled || this.jitterApplied || this.width < 2 || this.height < 2) return false;
    if (!(this.camera instanceof THREE.PerspectiveCamera)) return false;
    this.savedProjection.copy(this.camera.projectionMatrix);
    this.savedProjectionInverse.copy(this.camera.projectionMatrixInverse);
    const jitter = TEMPORAL_JITTER_8[this.jitterIndex % TEMPORAL_JITTER_8.length];
    this.camera.projectionMatrix.elements[8] += jitter[0] * 2 / this.width;
    this.camera.projectionMatrix.elements[9] += jitter[1] * 2 / this.height;
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.jitterApplied = true;
    this.jitterIndex = (this.jitterIndex + 1) % TEMPORAL_JITTER_8.length;
    return true;
  }

  endFrameJitter(): void {
    if (!this.jitterApplied) return;
    this.camera.projectionMatrix.copy(this.savedProjection);
    this.camera.projectionMatrixInverse.copy(this.savedProjectionInverse);
    this.jitterApplied = false;
  }

  reset(): void {
    this.historyValid = false;
    this.hasPreviousPose = false;
    this.jitterIndex = 0;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.camera.getWorldPosition(this.currentPosition);
    this.camera.getWorldQuaternion(this.currentQuaternion);
    if (this.hasPreviousPose) {
      const translation = this.currentPosition.distanceTo(this.previousPosition);
      const rotation = 2 * Math.acos(
        THREE.MathUtils.clamp(
          Math.abs(this.currentQuaternion.dot(this.previousQuaternion)),
          -1,
          1,
        ),
      );
      // Reprojection handles ordinary walking/driving. Teleports, mode changes
      // and fast camera cuts intentionally discard the old image.
      if (translation > 5 || rotation > THREE.MathUtils.degToRad(22)) {
        this.historyValid = false;
      }
    }

    this.currentViewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this.currentInvViewProjection.copy(this.currentViewProjection).invert();
    const uniforms = this.resolveMaterial.uniforms;
    uniforms.tCurrent.value = readBuffer.texture;
    uniforms.tHistory.value = this.history.texture;
    uniforms.tDepth.value = readBuffer.depthTexture;
    uniforms.currentInvViewProjection.value.copy(this.currentInvViewProjection);
    uniforms.previousViewProjection.value.copy(this.previousViewProjection);
    uniforms.historyValid.value = this.historyValid && readBuffer.depthTexture ? 1 : 0;

    renderer.setRenderTarget(writeBuffer);
    if (this.clear) renderer.clear();
    this.resolveQuad.render(renderer);

    // Keep history before AO/bloom/grade. The next frame therefore resolves
    // scene color, not already-filtered pixels, avoiding post-effect feedback.
    this.copyMaterial.uniforms.tDiffuse.value = writeBuffer.texture;
    renderer.setRenderTarget(this.history);
    this.copyQuad.render(renderer);

    this.previousViewProjection.copy(this.currentViewProjection);
    this.previousPosition.copy(this.currentPosition);
    this.previousQuaternion.copy(this.currentQuaternion);
    this.hasPreviousPose = true;
    this.historyValid = true;
  }

  stats(): TemporalAAStats {
    return {
      historyValid: this.historyValid,
      jitterIndex: this.jitterIndex,
      historyBytes: this.width * this.height * this.bytesPerPixel,
      maxHistoryWeight: this.maxHistoryWeight,
    };
  }

  override dispose(): void {
    this.history.dispose();
    this.resolveMaterial.dispose();
    this.copyMaterial.dispose();
    this.resolveQuad.dispose();
    this.copyQuad.dispose();
  }
}
