import * as THREE from 'three';

export interface PerformanceFrame {
  frameMs: number;
  cpuMs: number;
  updateCpuMs: number;
  renderCpuMs: number;
  gpuMs: number | null;
  drawCalls: number;
  shadowCalls: number;
  triangles: number;
  points: number;
  lines: number;
  streamingPressure: number;
  jsHeapBytes: number | null;
}

export interface PerformanceReport {
  label: string;
  durationSeconds: number;
  samples: number;
  frameMs: { p50: number; p95: number; p99: number };
  fps: { median: number; onePercentLow: number };
  cpuMs: { p50: number; p95: number; p99: number };
  cpuBreakdown: {
    update: { p50: number; p95: number; p99: number };
    render: { p50: number; p95: number; p99: number };
  };
  gpuMs: { availableSamples: number; p50: number | null; p95: number | null; p99: number | null };
  drawCalls: { p50: number; p95: number; max: number };
  shadowCalls: { p50: number; p95: number; max: number };
  triangles: { p50: number; p95: number; max: number };
  streamingPressure: { p50: number; p95: number; max: number };
  jsHeapBytes: number | null;
}

export interface SceneResourceEstimate {
  geometryBytes: number;
  textureBytes: number;
  totalBytes: number;
  geometries: number;
  textures: number;
  materials: number;
}

const finite = (n: number) => Number.isFinite(n) ? n : 0;
const max = (values: number[]) => values.length ? Math.max(...values) : 0;
const fpsForMs = (ms: number) => ms > 0 ? 1000 / ms : 0;
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const t = index - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
};

function heapBytes(): number | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  const bytes = memory?.usedJSHeapSize;
  return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null;
}

/**
 * Bounded rolling capture used both by the runtime governor audit and automated
 * golden-route QA. It records submitted renderer counters after all composer
 * passes, rather than a half-second FPS average that conceals upload stalls.
 */
export class PerformanceRecorder {
  private frames: PerformanceFrame[] = [];
  private label = 'rolling';
  private startedAt = performance.now();
  private readonly maxFrames: number;

  constructor(maxFrames = 1200) {
    this.maxFrames = maxFrames;
  }

  reset(label = 'capture'): void {
    this.frames = [];
    this.label = label;
    this.startedAt = performance.now();
  }

  sample(
    renderer: THREE.WebGLRenderer,
    frameMs: number,
    cpuMs: number,
    updateCpuMs: number,
    renderCpuMs: number,
    gpuMs: number | null,
    streamingPressure: number,
    estimatedShadowCalls: number,
  ): void {
    const info = renderer.info;
    this.frames.push({
      frameMs: finite(frameMs),
      cpuMs: finite(cpuMs),
      updateCpuMs: finite(updateCpuMs),
      renderCpuMs: finite(renderCpuMs),
      gpuMs: typeof gpuMs === 'number' && Number.isFinite(gpuMs) ? gpuMs : null,
      drawCalls: info.render.calls,
      shadowCalls: Math.max(0, Math.round(estimatedShadowCalls)),
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      streamingPressure: Math.max(0, Math.min(1, finite(streamingPressure))),
      jsHeapBytes: heapBytes(),
    });
    if (this.frames.length > this.maxFrames) {
      this.frames.splice(0, this.frames.length - this.maxFrames);
      this.startedAt = performance.now() - this.frames.reduce((sum, f) => sum + f.frameMs, 0);
    }
  }

  report(): PerformanceReport {
    const frames = this.frames.map((f) => f.frameMs);
    const cpus = this.frames.map((f) => f.cpuMs);
    const updateCpus = this.frames.map((f) => f.updateCpuMs);
    const renderCpus = this.frames.map((f) => f.renderCpuMs);
    const gpus = this.frames.flatMap((f) => f.gpuMs === null ? [] : [f.gpuMs]);
    const draws = this.frames.map((f) => f.drawCalls);
    const shadows = this.frames.map((f) => f.shadowCalls);
    const triangles = this.frames.map((f) => f.triangles);
    const streaming = this.frames.map((f) => f.streamingPressure);
    const latestHeap = [...this.frames].reverse().find((f) => f.jsHeapBytes !== null)?.jsHeapBytes ?? null;
    const frameP50 = percentile(frames, 0.5);
    const frameP99 = percentile(frames, 0.99);
    return {
      label: this.label,
      durationSeconds: Math.max(0, (performance.now() - this.startedAt) / 1000),
      samples: this.frames.length,
      frameMs: {
        p50: frameP50,
        p95: percentile(frames, 0.95),
        p99: frameP99,
      },
      fps: {
        median: fpsForMs(frameP50),
        onePercentLow: fpsForMs(frameP99),
      },
      cpuMs: {
        p50: percentile(cpus, 0.5),
        p95: percentile(cpus, 0.95),
        p99: percentile(cpus, 0.99),
      },
      cpuBreakdown: {
        update: {
          p50: percentile(updateCpus, 0.5),
          p95: percentile(updateCpus, 0.95),
          p99: percentile(updateCpus, 0.99),
        },
        render: {
          p50: percentile(renderCpus, 0.5),
          p95: percentile(renderCpus, 0.95),
          p99: percentile(renderCpus, 0.99),
        },
      },
      gpuMs: {
        availableSamples: gpus.length,
        p50: gpus.length ? percentile(gpus, 0.5) : null,
        p95: gpus.length ? percentile(gpus, 0.95) : null,
        p99: gpus.length ? percentile(gpus, 0.99) : null,
      },
      drawCalls: {
        p50: percentile(draws, 0.5),
        p95: percentile(draws, 0.95),
        max: max(draws),
      },
      shadowCalls: {
        p50: percentile(shadows, 0.5),
        p95: percentile(shadows, 0.95),
        max: max(shadows),
      },
      triangles: {
        p50: percentile(triangles, 0.5),
        p95: percentile(triangles, 0.95),
        max: max(triangles),
      },
      streamingPressure: {
        p50: percentile(streaming, 0.5),
        p95: percentile(streaming, 0.95),
        max: max(streaming),
      },
      jsHeapBytes: latestHeap,
    };
  }
}

function textureByteEstimate(texture: THREE.Texture): number {
  const compressed = texture as THREE.CompressedTexture;
  if (compressed.isCompressedTexture && Array.isArray(compressed.mipmaps)) {
    return compressed.mipmaps.reduce((sum, mip) => {
      const data = mip.data as ArrayBufferView | undefined;
      return sum + (data?.byteLength ?? 0);
    }, 0);
  }
  const image = texture.image as {
    width?: number;
    height?: number;
    data?: ArrayBufferView;
  } | undefined;
  if (image?.data?.byteLength) return image.data.byteLength;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!width || !height) return 0;
  const mipFactor = texture.generateMipmaps ? 4 / 3 : 1;
  return Math.round(width * height * 4 * mipFactor);
}

/** On-demand resident-resource estimate. Never traversed from the frame loop. */
export function estimateSceneResources(scene: THREE.Scene): SceneResourceEstimate {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry?.isBufferGeometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
          textures.add(value as THREE.Texture);
        }
      }
    }
  });
  if (scene.environment) textures.add(scene.environment);
  const background = scene.background;
  if (background && (background as THREE.Texture).isTexture) {
    textures.add(background as THREE.Texture);
  }

  let geometryBytes = 0;
  for (const geometry of geometries) {
    for (const attribute of Object.values(geometry.attributes)) {
      geometryBytes += attribute.array.byteLength;
    }
    if (geometry.index) geometryBytes += geometry.index.array.byteLength;
  }
  let textureBytes = 0;
  for (const texture of textures) textureBytes += textureByteEstimate(texture);
  return {
    geometryBytes,
    textureBytes,
    totalBytes: geometryBytes + textureBytes,
    geometries: geometries.size,
    textures: textures.size,
    materials: materials.size,
  };
}

/**
 * Conservative shadow submission estimate. Three.js does not expose shadow
 * calls separately from renderer.info.render.calls, so this counts visible
 * casting mesh/material groups at the same low frequency as the HUD.
 */
export function estimateShadowDrawCalls(scene: THREE.Scene): number {
  // A low/mobile scene retains castShadow flags so moving to another tier does
  // not require rebuilding geometry, but Three submits no shadow pass unless a
  // visible shadow-casting light exists. Report actual potential submissions,
  // not dormant mesh metadata.
  let hasActiveShadowLight = false;
  scene.traverseVisible((object) => {
    if ((object as THREE.Light).isLight && (object as THREE.Light).castShadow) {
      hasActiveShadowLight = true;
    }
  });
  if (!hasActiveShadowLight) return 0;

  let calls = 0;
  const visit = (object: THREE.Object3D, ancestorsVisible: boolean) => {
    const visible = ancestorsVisible && object.visible;
    if (!visible) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.castShadow) {
      if (Array.isArray(mesh.material)) {
        calls += Math.max(1, mesh.geometry?.groups.length || mesh.material.length);
      } else {
        calls++;
      }
    }
    for (const child of object.children) visit(child, visible);
  };
  visit(scene, true);
  return calls;
}
