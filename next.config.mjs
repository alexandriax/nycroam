/** @type {import('next').NextConfig} */

// Version tag inlined into the client as NEXT_PUBLIC_DATA_V and appended to
// every static world-data request (?v=...). The data files are served
// immutable at stable paths, so this is what lets a new deploy actually reach
// returning browsers (see src/engine/dataver.ts). Vercel provides the commit
// sha; local production builds fall back to a timestamp; next dev uses 'dev'.
const dataVersion = process.env.NODE_ENV === 'development'
  ? 'dev'
  : (process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? String(Date.now()));

const nextConfig = {
  reactStrictMode: false,
  eslint: { ignoreDuringBuilds: true },
  env: { NEXT_PUBLIC_DATA_V: dataVersion },
};

export default nextConfig;
