/**
 * Non-blocking WebGL2 disjoint timer-query wrapper.
 *
 * A query result is consumed only after WebGL reports it available; no sync
 * readback is introduced into the render loop. `poll()` therefore returns the
 * most recently completed frame, not necessarily the frame just submitted.
 */
export class WebGLGpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private readonly maxPending: number;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext, maxPending = 6) {
    this.gl = gl as WebGL2RenderingContext;
    this.ext = typeof this.gl.createQuery === 'function'
      ? this.gl.getExtension('EXT_disjoint_timer_query_webgl2')
      : null;
    this.maxPending = Math.max(2, maxPending);
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  beginFrame(): boolean {
    if (!this.ext || this.active || this.pending.length >= this.maxPending) return false;
    const query = this.gl.createQuery();
    if (!query) return false;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
    return true;
  }

  endFrame(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Completed GPU time in milliseconds, or null while no result is ready. */
  poll(): number | null {
    if (!this.ext || this.pending.length === 0) return null;
    if (this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.clearPending();
      return null;
    }
    const query = this.pending[0];
    if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) return null;
    const nanoseconds = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
    this.pending.shift();
    this.gl.deleteQuery(query);
    return Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : null;
  }

  dispose(): void {
    if (this.active) {
      // There is no legal way to delete an active query. Close it first.
      this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    this.clearPending();
  }

  private clearPending(): void {
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
  }
}
