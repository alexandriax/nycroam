/**
 * The app's typeface, for the 2D canvases we bake into textures.
 *
 * Questrial is self-hosted (public/fonts, @font-face in app/globals.css) and
 * ships a single 400 weight — `bold ...px SANS` in a canvas is the browser's
 * synthetic bold, which is what the signs and route bullets want.
 */
export const SANS = `'Questrial', 'Helvetica Neue', Arial, sans-serif`;

/**
 * Archivo Black: a genuine heavy face (self-hosted, public/fonts) for the bold
 * MTA-style signage — line bullets, direction plates, EXIT, roll-signs. Its own
 * weight beats Questrial's synthetic bold, which smears at texture scale. Draw
 * it WITHOUT the `bold` keyword: the face is already black, and a synthetic bold
 * on top of it only fuzzes the edges.
 */
export const BLACK = `'Archivo Black', 'Helvetica Neue', Arial, sans-serif`;

/** Mosaic name tablets stay serif: they copy the real 1900s IRT tablets. */
export const SERIF = `'Georgia', 'Times New Roman', serif`;

/**
 * Canvas text does NOT wait for webfonts — ctx.fillText with an unloaded face
 * silently draws the next font in the stack. Every sign here is baked once into
 * a CanvasTexture and cached for the session, so a texture drawn a beat too
 * early keeps Helvetica until reload. Await this before baking anything.
 */
export async function loadSans(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`400 100px 'Questrial'`),
      document.fonts.load(`bold 100px 'Questrial'`),
      document.fonts.load(`400 100px 'Archivo Black'`),
    ]);
  } catch {
    /* face unavailable: the fallback stack renders, nothing else breaks */
  }
}
