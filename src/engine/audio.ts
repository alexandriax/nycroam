/**
 * A small Web Audio layer for the world's diegetic sounds: looping ambiences
 * (bike hum, bus engine, train rumble, helicopter rotor) whose gain and pitch
 * are steered every frame, plus fire-and-forget one-shots (footstep, bus door
 * hiss, train pulling in).
 *
 * Design notes:
 *  - Browsers start an AudioContext suspended until a user gesture. We create
 *    it eagerly (so buffers can decode) and resume on the first pointer/key/
 *    touch, and also expose unlock() for the intro "Explore" click.
 *  - Loop sources can only be started once, so each loop keeps ONE source
 *    running for the session and we only modulate its gain (0 = silent) and
 *    playbackRate. update() eases the live gain/rate toward the targets set by
 *    loop(), so starting and stopping a sound is a smooth fade, never a click.
 *  - Everything degrades quietly: a missing/undecodable file just never plays,
 *    and every call is a no-op until its buffer is ready. The app must run with
 *    the whole /audio folder absent.
 */

export type LoopName = 'bike' | 'bus' | 'train' | 'helicopter';
export type OneShotName = 'footstep' | 'busDoors' | 'trainArrive';

interface SoundDef { file: string; loop: boolean; gain: number; }

// Base per-sound gains bake in the relative loudness so callers pass a clean
// 0..1 intensity. Files live in public/audio/.
// Loops are gapless WAV (MP3 encoder padding ticks on every Web Audio loop);
// one-shots stay MP3. All files are loudness/peak-normalized, so these gains
// are the deliberate mix, not level correction.
const MANIFEST: Record<LoopName | OneShotName, SoundDef> = {
  bike: { file: 'bike.wav', loop: true, gain: 0.6 },
  bus: { file: 'bus.wav', loop: true, gain: 0.5 },
  train: { file: 'train.wav', loop: true, gain: 0.6 },
  helicopter: { file: 'helicopter.wav', loop: true, gain: 0.7 },
  footstep: { file: 'footstep.mp3', loop: false, gain: 0.45 },
  busDoors: { file: 'bus-doors.mp3', loop: false, gain: 0.7 },
  trainArrive: { file: 'train-arrive.mp3', loop: false, gain: 0.75 },
};

const MUTE_KEY = 'nycroam-muted';

interface LoopState {
  gainNode: GainNode;
  source: AudioBufferSourceNode | null;
  curVol: number;
  targetVol: number;
  curRate: number;
  targetRate: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loops = new Map<LoopName, LoopState>();
  private muted = false;
  private disposed = false;
  private gestureBound = false;

  constructor(private base = '/audio/') {
    if (typeof window === 'undefined') return;
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch { /* private mode */ }
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no Web Audio — run silent
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.bindGesture();
    this.preload();
  }

  /** Resume the context — call from any real user gesture. */
  unlock = () => {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  };

  private bindGesture() {
    if (this.gestureBound || typeof window === 'undefined') return;
    this.gestureBound = true;
    const on = () => {
      this.unlock();
      window.removeEventListener('pointerdown', on);
      window.removeEventListener('keydown', on);
      window.removeEventListener('touchstart', on);
    };
    window.addEventListener('pointerdown', on);
    window.addEventListener('keydown', on);
    window.addEventListener('touchstart', on);
  }

  private async preload() {
    const ctx = this.ctx;
    if (!ctx) return;
    const files = [...new Set(Object.values(MANIFEST).map((s) => s.file))];
    await Promise.all(files.map(async (file) => {
      try {
        const res = await fetch(this.base + file);
        if (!res.ok) return;
        const data = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(data);
        if (!this.disposed) this.buffers.set(file, buf);
      } catch { /* file absent or undecodable — that sound stays silent */ }
    }));
  }

  get isMuted() { return this.muted; }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* ignore */ }
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(m ? 0 : 1, t, 0.05);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    if (!this.muted) this.unlock();
    return this.muted;
  }

  /**
   * Set a looping sound's target intensity (0..1) and playback rate. Cheap to
   * call every frame with the current value — update() does the smoothing.
   */
  loop(name: LoopName, volume: number, rate = 1) {
    const st = this.ensureLoop(name);
    if (!st) return;
    st.targetVol = Math.max(0, Math.min(1, volume));
    st.targetRate = rate;
  }

  private ensureLoop(name: LoopName): LoopState | null {
    if (!this.ctx || !this.master) return null;
    let st = this.loops.get(name);
    if (!st) {
      const gainNode = this.ctx.createGain();
      gainNode.gain.value = 0;
      gainNode.connect(this.master);
      st = { gainNode, source: null, curVol: 0, targetVol: 0, curRate: 1, targetRate: 1 };
      this.loops.set(name, st);
    }
    return st;
  }

  /** Fire a one-shot. `volume` scales the manifest gain; `rate` pitches it. */
  play(name: OneShotName, opts: { volume?: number; rate?: number } = {}) {
    if (!this.ctx || !this.master || this.muted || this.ctx.state !== 'running') return;
    const def = MANIFEST[name];
    const buf = this.buffers.get(def.file);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = def.gain * (opts.volume ?? 1);
    src.connect(g);
    g.connect(this.master);
    src.onended = () => { src.disconnect(); g.disconnect(); };
    src.start();
  }

  /** Ease every loop's live gain/rate toward its target. Call once per frame. */
  update(dt: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const k = Math.min(1, dt * 6);
    for (const [name, st] of this.loops) {
      const def = MANIFEST[name];
      // start the persistent source lazily, once its buffer has decoded
      if (!st.source && st.targetVol > 0) {
        const buf = this.buffers.get(def.file);
        if (buf) {
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(st.gainNode);
          src.start();
          st.source = src;
        }
      }
      st.curVol += (st.targetVol - st.curVol) * k;
      st.curRate += (st.targetRate - st.curRate) * k;
      // square the fader for a more natural taper
      st.gainNode.gain.value = def.gain * st.curVol * st.curVol;
      if (st.source) st.source.playbackRate.value = st.curRate;
    }
  }

  dispose() {
    this.disposed = true;
    for (const st of this.loops.values()) {
      try { st.source?.stop(); } catch { /* already stopped */ }
      st.source?.disconnect();
      st.gainNode.disconnect();
    }
    this.loops.clear();
    this.master?.disconnect();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
