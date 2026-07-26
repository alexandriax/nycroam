'use client';

import { useEffect } from 'react';

/**
 * Replaces the framework's own crash page.
 *
 * Next's default is white text on black saying a client-side exception
 * occurred, and "see the browser console for more information" -- which on a
 * phone is not information at all: there is no console to open, so a crash
 * arrives as an unreadable dead end for the player and an unreportable one for
 * us. This shows the same failure with the message and the top of the stack
 * visible, and a way back into the world.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[nycroam] client exception:', error);
  }, [error]);

  const frames = (error.stack || '')
    .split('\n')
    .slice(1, 5)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

  return (
    <div className="crash-wrap">
      <div className="crash-card">
        <img src="/mark.png" alt="" width={44} height={44} draggable={false} />
        <h1>NYC Roam hit a snag</h1>
        <p className="crash-msg">{error.message || 'An unexpected error occurred.'}</p>
        {frames && <pre className="crash-stack">{frames}</pre>}
        {error.digest && <p className="crash-digest">ref {error.digest}</p>}
        <div className="crash-actions">
          <button onClick={reset}>Try again</button>
          <button className="ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
        <p className="crash-hint">
          If this keeps happening, a screenshot of this screen has everything needed to fix it.
        </p>
      </div>
    </div>
  );
}
