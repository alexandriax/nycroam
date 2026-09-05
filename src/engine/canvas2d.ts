/**
 * Canvas allocation that cannot take the app down.
 *
 * Every procedural texture in this world is painted on a 2D canvas: each street
 * sign atlas, each plaque atlas, each LED panel, each surface. iOS enforces a
 * hard budget on total canvas backing store across a page, and when a page is
 * over it `getContext('2d')` does not throw -- it quietly returns null. Twenty
 * call sites then dereferenced that with a `!`, so the first allocation past the
 * budget became `null is not an object (evaluating 'ctx.fillRect')`: an uncaught
 * TypeError, on a phone, with no console to read it in.
 *
 * That budget is reached by BREADTH, not by any one texture, so the failure
 * lands on whatever happens to allocate next -- typically a mode change like
 * boarding a train, which builds a strip map and an LED panel at the moment the
 * streamed world is already at its widest.
 *
 * So: ask for the size wanted, accept a smaller one, and in the worst case hand
 * back a 1x1 stub. A texture that is blurry or blank is a bad frame; a null
 * context is a dead app.
 */

export interface Canvas2D {
  cv: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** True when the allocation was downgraded, so callers can skip fine detail. */
  degraded: boolean;
}

let warned = false;

/**
 * A canvas and its 2D context, guaranteed non-null.
 *
 * On failure the size is halved and retried (twice), then falls back to 1x1.
 * `degraded` reports whether the caller got what it asked for.
 */
export function canvas2d(width: number, height: number): Canvas2D {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  for (let attempt = 0; attempt < 3; attempt++) {
    const scale = 1 / (1 << attempt);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    try {
      const cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      const ctx = cv.getContext('2d');
      if (ctx) {
        const degraded = cw !== w || ch !== h;
        if (degraded && !warned) {
          warned = true;
          console.warn(`[canvas2d] ${w}x${h} refused, using ${cw}x${ch} — the page is at its canvas budget`);
        }
        return { cv, ctx, degraded };
      }
    } catch {
      /* fall through to the next, smaller attempt */
    }
  }
  // Nothing allocatable at any size. Hand back a 1x1 so the caller paints into
  // the void rather than dereferencing null; if even this has no context the
  // device has no 2D canvas at all and there is nothing to salvage.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  if (!warned) {
    warned = true;
    console.warn('[canvas2d] no canvas could be allocated — textures will be blank');
  }
  return { cv, ctx, degraded: true };
}
