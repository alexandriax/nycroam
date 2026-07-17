// Deploy-stamped version tag for the static world data (/tiles, /geo,
// /subway). Those files are served with a 1-year immutable Cache-Control at
// STABLE urls — so when a deploy changes their content, returning browsers
// would keep the old bytes forever (production looked stale while every
// preview deploy, on a fresh origin with a cold cache, looked right).
// Appending ?v=<build> makes each deploy a new cache key while keeping the
// long-lived caching between deploys.
//
// NEXT_PUBLIC_DATA_V is inlined at build time (see next.config.mjs): the git
// commit sha on Vercel, a timestamp for local production builds, 'dev' in
// next dev.
export const DATA_V: string = process.env.NEXT_PUBLIC_DATA_V ?? 'dev';

/** Versioned URL for a static world-data file ("/tiles/0_0.json?v=abc123"). */
export function dataUrl(path: string): string {
  return `${path}?v=${DATA_V}`;
}
