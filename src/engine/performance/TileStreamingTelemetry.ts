import type { TileWorkerTiming } from '../tileTypes';

export interface TimingDistribution {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  recentMax: number;
  mean: number;
}

export interface TileStreamingReport {
  worker: {
    fetch: TimingDistribution;
    decode: TimingDistribution;
    build: TimingDistribution;
    total: TimingDistribution;
  };
  integration: TimingDistribution;
  bytes: {
    source: number;
    transferred: number;
    sourcePerTile: number;
    transferredPerTile: number;
  };
  pressure: {
    queue: number;
    inFlight: number;
    awaitingIntegration: number;
    prefetch: number;
    peakQueue: number;
    peakInFlight: number;
    peakAwaitingIntegration: number;
  };
  detail: {
    base: number;
    mid: number;
    near: number;
    upgrades: number;
  };
  requests: number;
  completed: number;
  staleResponses: number;
  errors: number;
}

class RollingMetric {
  private readonly values: Float64Array;
  private cursor = 0;
  private count = 0;
  private sum = 0;

  constructor(capacity = 96) {
    this.values = new Float64Array(capacity);
  }

  add(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    if (this.count === this.values.length) this.sum -= this.values[this.cursor];
    else this.count++;
    this.values[this.cursor] = value;
    this.sum += value;
    this.cursor = (this.cursor + 1) % this.values.length;
  }

  report(): TimingDistribution {
    if (!this.count) return { samples: 0, p50: 0, p95: 0, p99: 0, recentMax: 0, mean: 0 };
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
    return {
      samples: this.count,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      recentMax: sorted[sorted.length - 1],
      mean: this.sum / this.count,
    };
  }
}

/**
 * Fixed-memory tile stream instrumentation. Recording performs no allocation;
 * sorting/allocation happens only when a consumer explicitly asks for a report.
 */
export class TileStreamingTelemetry {
  private fetch = new RollingMetric();
  private decode = new RollingMetric();
  private build = new RollingMetric();
  private total = new RollingMetric();
  private integration = new RollingMetric();
  private sourceBytes = 0;
  private transferBytes = 0;
  private peakQueue = 0;
  private peakInFlight = 0;
  private peakAwaiting = 0;
  private queue = 0;
  private inFlight = 0;
  private awaiting = 0;
  private prefetch = 0;
  private detailCounts: [number, number, number] = [0, 0, 0];
  requests = 0;
  completed = 0;
  upgrades = 0;
  staleResponses = 0;
  errors = 0;

  requested(upgrade: boolean) {
    this.requests++;
    if (upgrade) this.upgrades++;
  }

  workerCompleted(timing?: TileWorkerTiming) {
    this.completed++;
    if (!timing) return;
    this.fetch.add(timing.fetchMs);
    this.decode.add(timing.decodeMs);
    this.build.add(timing.buildMs);
    this.total.add(timing.totalMs);
    this.sourceBytes += timing.sourceBytes;
    this.transferBytes += timing.transferBytes;
  }

  integrated(durationMs: number) {
    this.integration.add(durationMs);
  }

  pressure(queue: number, inFlight: number, awaiting: number, prefetch: number) {
    this.queue = queue;
    this.inFlight = inFlight;
    this.awaiting = awaiting;
    this.prefetch = prefetch;
    this.peakQueue = Math.max(this.peakQueue, queue);
    this.peakInFlight = Math.max(this.peakInFlight, inFlight);
    this.peakAwaiting = Math.max(this.peakAwaiting, awaiting);
  }

  setDetailCounts(counts: [number, number, number]) {
    this.detailCounts = counts;
  }

  report(): TileStreamingReport {
    const measured = this.total.report().samples;
    return {
      worker: {
        fetch: this.fetch.report(),
        decode: this.decode.report(),
        build: this.build.report(),
        total: this.total.report(),
      },
      integration: this.integration.report(),
      bytes: {
        source: this.sourceBytes,
        transferred: this.transferBytes,
        sourcePerTile: measured ? this.sourceBytes / measured : 0,
        transferredPerTile: measured ? this.transferBytes / measured : 0,
      },
      pressure: {
        queue: this.queue,
        inFlight: this.inFlight,
        awaitingIntegration: this.awaiting,
        prefetch: this.prefetch,
        peakQueue: this.peakQueue,
        peakInFlight: this.peakInFlight,
        peakAwaitingIntegration: this.peakAwaiting,
      },
      detail: {
        base: this.detailCounts[0],
        mid: this.detailCounts[1],
        near: this.detailCounts[2],
        upgrades: this.upgrades,
      },
      requests: this.requests,
      completed: this.completed,
      staleResponses: this.staleResponses,
      errors: this.errors,
    };
  }
}
