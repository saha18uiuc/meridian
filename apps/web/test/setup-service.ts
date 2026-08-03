import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forgetEmptyEnvVars } from '@meridian/core';

/**
 * Service tests exercise real server modules against the local Supabase stack, so they need the
 * same environment `pnpm dev` reads. Vitest does not load `.env` on its own, and a missing service
 * role key surfaces as an opaque 401 from PostgREST rather than as a configuration error.
 *
 * Empty variables are cleared before the file is read. `loadEnvFile` will not overwrite a name that
 * is already set, so an `OPENAI_API_KEY=` exported by a CI job or an editor beats the real key in
 * `.env` — and the live model gate then reports itself as not configured while the key sits in the
 * file, which is the one failure this gate exists to make impossible.
 */

forgetEmptyEnvVars();
const ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

process.env['AI_MODE'] ??= 'mock';
process.env['GMAIL_LIVE_MODE'] ??= 'false';

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

const missing = REQUIRED.filter((name) => (process.env[name] ?? '') === '');
if (missing.length > 0) {
  throw new Error(
    `service tests need a configured .env; missing: ${missing.join(', ')}. Run \`pnpm dev:infra\` and copy .env.example to .env.`,
  );
}
