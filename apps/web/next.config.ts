import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import type { NextConfig } from 'next';

/**
 * The repository keeps one `.env` at its root, and Next only looks in its own directory.
 *
 * Without this, `pnpm dev` started a web server with no Supabase URL and no service role key, and
 * the failure surfaced much later as `INTERNAL_ERROR` from an API route rather than as anything
 * that named the cause. Every other entry point already reads the root file — the worker through
 * its own runtime, the scripts through `loadOpsEnv()` — so this is the web app joining them rather
 * than a new convention.
 *
 * `next.config.ts` is evaluated in Node before the server starts and before compilation, so both
 * server-side reads and `NEXT_PUBLIC_*` inlining see these values. `override: false` matches
 * `loadOpsEnv`: a variable already exported in the shell is the operator being deliberate, and a
 * file should not quietly countermand it.
 */
const rootEnv = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(rootEnv)) loadDotenv({ path: rootEnv, override: false, quiet: true });

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
