import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { REPO_ROOT } from './lib/state.js';

/**
 * Environment loading for the operational scripts.
 *
 * The web app and the worker get their configuration from their own runtimes; a script invoked as
 * `pnpm preflight` gets nothing, so it reads `.env` explicitly. `override: false` matters: a value
 * already exported in the shell is the operator being deliberate, and a file should not quietly
 * countermand it.
 */

let loaded = false;

export function loadOpsEnv(): void {
  if (loaded) return;
  loaded = true;
  const envPath = join(REPO_ROOT, '.env');
  if (existsSync(envPath)) loadDotenv({ path: envPath, override: false, quiet: true });
}

/**
 * Credential names the preflight reports on.
 *
 * It reports presence only — never the value, never a prefix, never a length. A length is enough
 * to identify which key of a known family is configured, and a prefix is worse.
 */
export const CREDENTIAL_NAMES = [
  'OPENAI_API_KEY',
  'COMPOSIO_API_KEY',
  'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  'COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
] as const;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export function credentialPresence(
  source: Record<string, string | undefined> = process.env,
): Array<{ name: CredentialName; present: boolean }> {
  return CREDENTIAL_NAMES.map((name) => ({
    name,
    present: typeof source[name] === 'string' && source[name].trim().length > 0,
  }));
}

/** A required value, read after `loadOpsEnv()`. Throws naming the variable, never its value. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value;
}
