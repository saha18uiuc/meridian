import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `@meridian/*` ship TypeScript-built ESM from the workspace; Next must not treat them as
  // pre-bundled externals or the server build resolves stale `dist` output inconsistently.
  transpilePackages: ['@meridian/core', '@meridian/agent-kit'],
  typedRoutes: false,
  // Lint runs as its own repo-wide command; type errors must still fail the production build.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
