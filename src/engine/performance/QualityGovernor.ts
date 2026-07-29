export type PerformanceBottleneck = 'gpu' | 'cpu' | 'streaming' | 'mixed' | 'none';

export type QualityKnob =
  | 'effectsLevel'
  | 'shadowLevel'
  | 'renderScale'
  | 'populationScale'
  | 'detailDistanceScale'
  | 'streamingScale';

export interface RuntimeQualitySettings {
  /** Multiplier applied to the quality tier's pixel-ratio cap. */
  renderScale: number;
  /** 2 = authored tier, 1 = reduced/half-resolution, 0 = disabled. */
  shadowLevel: 0 | 1 | 2;
  /** 2 = authored post effects, 1 = reduced/half-resolution, 0 = disabled. */
  effectsLevel: 0 | 1 | 2;
  /** Density multiplier for pedestrians, traffic, and other simulated actors. */
  populationScale: number;
  /** Multiplier for near-detail and tile load distances. */
  detailDistanceScale: number;
  /** Multiplier for speculative/prefetch distance and upload work. */
  streamingScale: number;
}

export interface PerformanceSample {
  /** Monotonic timestamp, normally performance.now(). */
  nowMs: number;
  /** RequestAnimationFrame interval. This includes CPU, GPU, and scheduling stalls. */
  frameMs: number;
  /** Main-thread time spent updating and submitting this frame. */
  cpuMs: number;
  /** Most recently completed disjoint-timer result. Omit when unsupported. */
  gpuMs?: number | null;
  /** 0..1 indication that tile decode/upload queues are under pressure. */
  streamingPressure?: number;
  /** Loading fades, tab restore, and transitions must not train the governor. */
  ignore?: boolean;
}

export interface QualityGovernorConfig {
  targetFrameMs: number;
  evaluationIntervalMs: number;
  historyMs: number;
  minSamples: number;
  overloadWindows: number;
  recoveryWindows: number;
  actionCooldownMs: number;
  minRenderScale: number;
  renderScaleStep: number;
  minPopulationScale: number;
  populationScaleStep: number;
  minDetailDistanceScale: number;
  detailDistanceScaleStep: number;
  minStreamingScale: number;
  streamingScaleStep: number;
}

export interface PerformanceSnapshot {
  sampleCount: number;
  targetFrameMs: number;
  frameP50: number;
  frameP95: number;
  frameP99: number;
  cpuP95: number;
  gpuP95: number | null;
  droppedFrameRatio: number;
  streamingPressure: number;
  bottleneck: PerformanceBottleneck;
  overloaded: boolean;
  hasHeadroom: boolean;
}

export interface QualityDecision {
  direction: 'degrade' | 'recover';
  knob: QualityKnob;
  previous: number;
  value: number;
  reason: string;
  settings: RuntimeQualitySettings;
  snapshot: PerformanceSnapshot;
}

const DEFAULT_SETTINGS: RuntimeQualitySettings = {
  renderScale: 1,
  shadowLevel: 2,
  effectsLevel: 2,
  populationScale: 1,
  detailDistanceScale: 1,
  streamingScale: 1,
};

const DEFAULT_CONFIG: QualityGovernorConfig = {
  targetFrameMs: 1000 / 60,
  evaluationIntervalMs: 1000,
  historyMs: 4000,
  minSamples: 24,
  overloadWindows: 2,
  recoveryWindows: 8,
  actionCooldownMs: 1500,
  minRenderScale: 0.55,
  renderScaleStep: 0.1,
  minPopulationScale: 0.4,
  populationScaleStep: 0.2,
  minDetailDistanceScale: 0.65,
  detailDistanceScaleStep: 0.1,
  minStreamingScale: 0.6,
  streamingScaleStep: 0.1,
};

interface HistorySample {
  nowMs: number;
  frameMs: number;
  cpuMs: number;
  gpuMs: number | null;
  streamingPressure: number;
}

interface Degradation {
  knob: QualityKnob;
  previous: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const t = index - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}

function settingsCopy(settings: RuntimeQualitySettings): RuntimeQualitySettings {
  return { ...settings };
}

/**
 * Percentile- and hysteresis-based runtime quality governor.
 *
 * It deliberately owns only a small serialisable settings object: World maps
 * decisions onto renderer/shadow/tile/crowd systems. Keeping policy separate
 * makes the behaviour deterministic in tests and avoids letting a transient
 * loading spike permanently mutate a scene.
 */
export class QualityGovernor {
  readonly config: QualityGovernorConfig;
  private current: RuntimeQualitySettings;
  private history: HistorySample[] = [];
  private degradationStack: Degradation[] = [];
  private lastEvaluationMs = Number.NEGATIVE_INFINITY;
  private lastActionMs = Number.NEGATIVE_INFINITY;
  private overloadCount = 0;
  private headroomCount = 0;
  private latestSnapshot: PerformanceSnapshot | null = null;

  constructor(
    config: Partial<QualityGovernorConfig> = {},
    initial: Partial<RuntimeQualitySettings> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.current = { ...DEFAULT_SETTINGS, ...initial };
  }

  get settings(): RuntimeQualitySettings {
    return settingsCopy(this.current);
  }

  get snapshot(): PerformanceSnapshot | null {
    return this.latestSnapshot ? { ...this.latestSnapshot } : null;
  }

  /**
   * Add one frame. At most one decision is returned per evaluation interval.
   * Ignored/invalid frames are not retained, so tab restores and scene
   * transitions cannot poison the rolling percentile window.
   */
  sample(sample: PerformanceSample): QualityDecision | null {
    if (sample.ignore) return null;
    if (
      !Number.isFinite(sample.nowMs)
      || !Number.isFinite(sample.frameMs)
      || !Number.isFinite(sample.cpuMs)
      || sample.frameMs <= 0
      || sample.cpuMs < 0
    ) return null;

    this.history.push({
      nowMs: sample.nowMs,
      frameMs: clamp(sample.frameMs, 0.1, 250),
      cpuMs: clamp(sample.cpuMs, 0, 250),
      gpuMs: typeof sample.gpuMs === 'number' && Number.isFinite(sample.gpuMs)
        ? clamp(sample.gpuMs, 0, 250)
        : null,
      streamingPressure: clamp(finiteOr(sample.streamingPressure, 0), 0, 1),
    });
    const cutoff = sample.nowMs - this.config.historyMs;
    while (this.history.length && this.history[0].nowMs < cutoff) this.history.shift();

    if (
      this.history.length < this.config.minSamples
      || sample.nowMs - this.lastEvaluationMs < this.config.evaluationIntervalMs
    ) return null;
    this.lastEvaluationMs = sample.nowMs;

    const snapshot = this.makeSnapshot();
    this.latestSnapshot = snapshot;
    if (snapshot.overloaded) {
      this.overloadCount++;
      this.headroomCount = 0;
    } else if (snapshot.hasHeadroom) {
      this.headroomCount++;
      this.overloadCount = 0;
    } else {
      // A neutral window breaks consecutive hysteresis; it does not count
      // toward either a downgrade or an upgrade.
      this.overloadCount = 0;
      this.headroomCount = 0;
    }

    if (sample.nowMs - this.lastActionMs < this.config.actionCooldownMs) return null;

    // A catastrophic p99 can react after one window; normal pressure must be
    // sustained. This catches a genuinely unusable tier without responding to
    // an isolated shader compilation or tile upload.
    const severe = snapshot.frameP99 > this.config.targetFrameMs * 2.15
      && snapshot.droppedFrameRatio > 0.25;
    if (snapshot.overloaded && (severe || this.overloadCount >= this.config.overloadWindows)) {
      const decision = this.degrade(snapshot, sample.nowMs);
      this.overloadCount = 0;
      this.headroomCount = 0;
      return decision;
    }

    if (
      snapshot.hasHeadroom
      && this.headroomCount >= this.config.recoveryWindows
      && this.degradationStack.length
    ) {
      const decision = this.recover(snapshot, sample.nowMs);
      this.overloadCount = 0;
      this.headroomCount = 0;
      return decision;
    }
    return null;
  }

  /** Clear measurements after a scene transition while retaining quality. */
  clearHistory(): void {
    this.history = [];
    this.lastEvaluationMs = Number.NEGATIVE_INFINITY;
    this.overloadCount = 0;
    this.headroomCount = 0;
    this.latestSnapshot = null;
  }

  private makeSnapshot(): PerformanceSnapshot {
    const target = this.config.targetFrameMs;
    const frames = this.history.map((s) => s.frameMs);
    const cpus = this.history.map((s) => s.cpuMs);
    const gpus = this.history.flatMap((s) => s.gpuMs === null ? [] : [s.gpuMs]);
    const frameP50 = percentile(frames, 0.5);
    const frameP95 = percentile(frames, 0.95);
    const frameP99 = percentile(frames, 0.99);
    const cpuP95 = percentile(cpus, 0.95);
    const gpuP95 = gpus.length >= Math.max(4, this.history.length * 0.2)
      ? percentile(gpus, 0.95)
      : null;
    const droppedFrameRatio = frames.filter((ms) => ms > target * 1.35).length / frames.length;
    const streamingPressure = this.history.reduce((sum, s) => sum + s.streamingPressure, 0)
      / this.history.length;

    const gpuHot = gpuP95 !== null && gpuP95 > target * 0.84;
    const cpuHot = cpuP95 > target * 0.64;
    const streamHot = streamingPressure > 0.35;
    let bottleneck: PerformanceBottleneck = 'none';
    if (streamHot && !gpuHot && !cpuHot) bottleneck = 'streaming';
    else if (gpuHot && cpuHot) bottleneck = 'mixed';
    else if (gpuHot) bottleneck = 'gpu';
    else if (cpuHot) bottleneck = 'cpu';
    else if (streamHot) bottleneck = 'streaming';
    else if (frameP95 > target * 1.18 || droppedFrameRatio > 0.14) bottleneck = 'mixed';

    const overloaded = bottleneck !== 'none'
      && (
        frameP95 > target * 1.18
        || droppedFrameRatio > 0.14
        || gpuHot
        || cpuHot
        || streamingPressure > 0.52
      );
    const hasHeadroom = frameP95 < target * 0.78
      && frameP99 < target * 0.92
      && cpuP95 < target * 0.48
      && (gpuP95 === null || gpuP95 < target * 0.62)
      && streamingPressure < 0.12;

    return {
      sampleCount: this.history.length,
      targetFrameMs: target,
      frameP50,
      frameP95,
      frameP99,
      cpuP95,
      gpuP95,
      droppedFrameRatio,
      streamingPressure,
      bottleneck,
      overloaded,
      hasHeadroom,
    };
  }

  private degrade(snapshot: PerformanceSnapshot, nowMs: number): QualityDecision | null {
    const byBottleneck: Record<Exclude<PerformanceBottleneck, 'none'>, QualityKnob[]> = {
      gpu: ['effectsLevel', 'shadowLevel', 'renderScale', 'detailDistanceScale'],
      cpu: ['populationScale', 'detailDistanceScale', 'streamingScale', 'shadowLevel'],
      streaming: ['streamingScale', 'detailDistanceScale', 'populationScale'],
      mixed: ['effectsLevel', 'shadowLevel', 'populationScale', 'renderScale', 'detailDistanceScale', 'streamingScale'],
    };
    const order = snapshot.bottleneck === 'none' ? byBottleneck.mixed : byBottleneck[snapshot.bottleneck];
    for (const knob of order) {
      const previous = this.current[knob];
      const value = this.stepDown(knob);
      if (value === previous) continue;
      this.degradationStack.push({ knob, previous });
      return this.finishDecision(
        'degrade',
        knob,
        previous,
        value,
        `${snapshot.bottleneck} pressure: p95 ${snapshot.frameP95.toFixed(1)}ms, p99 ${snapshot.frameP99.toFixed(1)}ms`,
        snapshot,
        nowMs,
      );
    }
    return null;
  }

  private recover(snapshot: PerformanceSnapshot, nowMs: number): QualityDecision | null {
    const last = this.degradationStack.pop();
    if (!last) return null;
    const previous = this.current[last.knob];
    this.current[last.knob] = last.previous as never;
    return this.finishDecision(
      'recover',
      last.knob,
      previous,
      last.previous,
      `sustained headroom: p95 ${snapshot.frameP95.toFixed(1)}ms`,
      snapshot,
      nowMs,
      false,
    );
  }

  private stepDown(knob: QualityKnob): number {
    switch (knob) {
      case 'effectsLevel':
        if (this.current.effectsLevel === 0) return 0;
        this.current.effectsLevel = (this.current.effectsLevel - 1) as 0 | 1;
        return this.current.effectsLevel;
      case 'shadowLevel':
        if (this.current.shadowLevel === 0) return 0;
        this.current.shadowLevel = (this.current.shadowLevel - 1) as 0 | 1;
        return this.current.shadowLevel;
      case 'renderScale':
        this.current.renderScale = Math.max(
          this.config.minRenderScale,
          Math.round((this.current.renderScale - this.config.renderScaleStep) * 100) / 100,
        );
        return this.current.renderScale;
      case 'populationScale':
        this.current.populationScale = Math.max(
          this.config.minPopulationScale,
          Math.round((this.current.populationScale - this.config.populationScaleStep) * 100) / 100,
        );
        return this.current.populationScale;
      case 'detailDistanceScale':
        this.current.detailDistanceScale = Math.max(
          this.config.minDetailDistanceScale,
          Math.round((this.current.detailDistanceScale - this.config.detailDistanceScaleStep) * 100) / 100,
        );
        return this.current.detailDistanceScale;
      case 'streamingScale':
        this.current.streamingScale = Math.max(
          this.config.minStreamingScale,
          Math.round((this.current.streamingScale - this.config.streamingScaleStep) * 100) / 100,
        );
        return this.current.streamingScale;
    }
  }

  private finishDecision(
    direction: QualityDecision['direction'],
    knob: QualityKnob,
    previous: number,
    value: number,
    reason: string,
    snapshot: PerformanceSnapshot,
    nowMs: number,
    updateCurrent = true,
  ): QualityDecision {
    if (updateCurrent) this.current[knob] = value as never;
    this.lastActionMs = nowMs;
    // Measure the new rung from a fresh window; otherwise old overloaded
    // samples can force several downgrades before the first change is visible.
    this.history = [];
    this.lastEvaluationMs = nowMs;
    return {
      direction,
      knob,
      previous,
      value,
      reason,
      settings: settingsCopy(this.current),
      snapshot,
    };
  }
}

export const DEFAULT_RUNTIME_QUALITY_SETTINGS = DEFAULT_SETTINGS;
export const DEFAULT_QUALITY_GOVERNOR_CONFIG = DEFAULT_CONFIG;
export const performancePercentile = percentile;
