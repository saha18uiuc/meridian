import { readFileSync, writeFileSync } from 'node:fs';
import { loadOpsEnv, optionalEnv } from './env.js';
import { runAsync } from './lib/proc.js';
import { repoPath } from './lib/state.js';

/**
 * Regenerate `packages/core/src/database.types.ts` from the running local database.
 *
 * Generated types are only trustworthy if the generator can fail loudly. Writing the file only
 * after a successful, non-empty generation means a Supabase stack that is down produces an error
 * rather than a truncated type file that then produces a hundred confusing type errors.
 */

export const TYPES_PATH = 'packages/core/src/database.types.ts';

const HEADER = `/**
 * GENERATED FILE — regenerate with \`pnpm db:types\`.
 *
 * These types mirror the local database exactly, which is why the write path can be typed at all.
 * Edit the migrations, never this file.
 */
`;

/**
 * Prettier is invoked through the repository's own binary and configuration rather than imported,
 * so this file cannot drift from what `pnpm format:check` enforces.
 */
async function format(source: string): Promise<string> {
  const result = await runAsync('pnpm', ['exec', 'prettier', '--stdin-filepath', TYPES_PATH], {
    cwd: repoPath(),
    stdin: source,
  });
  if (result.code !== 0) {
    throw new Error(`prettier could not format the generated types:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function generateTypes(): Promise<{ path: string; bytes: number; changed: boolean }> {
  loadOpsEnv();
  const dbUrl = optionalEnv(
    'SUPABASE_DB_URL',
    'postgresql://postgres:postgres@127.0.0.1:54522/postgres',
  );
  const result = await runAsync(
    'supabase',
    ['gen', 'types', 'typescript', '--db-url', dbUrl, '--schema', 'public'],
    { cwd: repoPath() },
  );
  if (result.unavailable) throw new Error('the supabase CLI is not installed');
  if (result.code !== 0) {
    throw new Error(`supabase gen types failed:\n${result.stderr.trim() || result.stdout.trim()}`);
  }
  const body = result.stdout.trim();
  if (!body.includes('export type Database')) {
    throw new Error('supabase gen types produced no Database type; is the local stack running?');
  }

  // Formatted before it is written, not after someone notices. `supabase gen types` has its own
  // opinion about line breaks, so an unformatted write left `pnpm format:check` — and therefore
  // `pnpm verify` — failing on a file the operator was told to regenerate.
  const contents = await format(`${HEADER}\n${body}\n`);
  const absolute = repoPath(TYPES_PATH);
  let previous: string;
  try {
    previous = readFileSync(absolute, 'utf8');
  } catch {
    previous = '';
  }
  const changed = previous !== contents;
  if (changed) writeFileSync(absolute, contents, 'utf8');
  return { path: TYPES_PATH, bytes: contents.length, changed };
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  try {
    const result = await generateTypes();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
