/** Shared gameplay clock: one displayed service minute is one gameplay second. */
export const GAMEPLAY_SECONDS_PER_SERVICE_MINUTE = 1;
export const TRAIN_TIME_SCALE = 1.35;
export const TRAIN_PHASE_SECONDS = { hidden: 12, approach: 7, dwell: 14, depart: 7 } as const;
export type TrainPhase = keyof typeof TRAIN_PHASE_SECONDS;
export const DOOR_OPEN_START = 0.7;
export const DOOR_SLIDE_SECONDS = 0.8;
export const DOOR_CLOSE_LEAD = 1.2;
export const SPAWN_TO_BOARDING = TRAIN_PHASE_SECONDS.hidden + TRAIN_PHASE_SECONDS.approach
  + DOOR_OPEN_START + DOOR_SLIDE_SECONDS;
export const TRAIN_CYCLE_SECONDS = Object.values(TRAIN_PHASE_SECONDS).reduce((sum, n) => sum + n, 0);
const ORDER: TrainPhase[] = ['hidden', 'approach', 'dwell', 'depart'];

export function arrivalReadout(seconds: number): { big: string; unit: string } {
  if (!Number.isFinite(seconds)) return { big: '–', unit: '' };
  if (seconds <= 1e-6) return { big: 'Now', unit: '' };
  return { big: String(Math.ceil(seconds / GAMEPLAY_SECONDS_PER_SERVICE_MINUTE)), unit: 'MIN' };
}

/** Deterministic phases, shared by the moving model and its arrival forecasts. */
export class TrainTimeline {
  phase: TrainPhase = 'hidden';
  elapsed = 0;
  duration: number = TRAIN_PHASE_SECONDS.hidden;
  get remaining(): number { return Math.max(0, this.duration - this.elapsed); }
  get closeStart(): number { return this.duration - DOOR_CLOSE_LEAD; }
  get doorFraction(): number {
    if (this.phase !== 'dwell') return 0;
    const t = this.elapsed < this.closeStart
      ? (this.elapsed - DOOR_OPEN_START) / DOOR_SLIDE_SECONDS
      : 1 - (this.elapsed - this.closeStart) / DOOR_SLIDE_SECONDS;
    const clamped = Math.max(0, Math.min(1, t));
    return clamped * clamped * (3 - 2 * clamped);
  }
  get acceptingPassengers(): boolean {
    return this.phase === 'dwell' && this.elapsed + 1e-8 >= DOOR_OPEN_START + DOOR_SLIDE_SECONDS
      && this.elapsed < this.closeStart;
  }
  get secondsToDoors(): number {
    const slide = DOOR_OPEN_START + DOOR_SLIDE_SECONDS;
    if (this.phase === 'hidden') return this.remaining + TRAIN_PHASE_SECONDS.approach + slide;
    if (this.phase === 'approach') return this.remaining + slide;
    if (this.phase === 'dwell' && this.elapsed < this.closeStart) return Math.max(0, slide - this.elapsed - 1e-8);
    return Infinity;
  }
  get secondsToCycleEnd(): number {
    let total = this.remaining;
    for (let i = ORDER.indexOf(this.phase) + 1; i < ORDER.length; i++) total += TRAIN_PHASE_SECONDS[ORDER[i]];
    return total;
  }
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += dt;
    while (this.elapsed + 1e-9 >= this.duration) {
      this.elapsed = Math.max(0, this.elapsed - this.duration);
      this.phase = ORDER[(ORDER.indexOf(this.phase) + 1) % ORDER.length];
      this.duration = TRAIN_PHASE_SECONDS[this.phase];
    }
  }
  forceDwell(openSeconds: number): void {
    this.phase = 'dwell';
    this.elapsed = DOOR_OPEN_START + DOOR_SLIDE_SECONDS;
    this.duration = this.elapsed + Math.max(2, openSeconds) + DOOR_CLOSE_LEAD;
  }
}
