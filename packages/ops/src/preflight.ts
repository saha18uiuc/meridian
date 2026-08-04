import { readFileSync } from 'node:fs';
import { checkPorts, formatReports } from './check-ports.js';
import { credentialPresence, loadOpsEnv } from './env.js';
import { output, run } from './lib/proc.js';
import { repoPath } from './lib/state.js';
import { resolveAndWrite, VersionResolutionError } from './resolve-versions.js';

/**
 * One command that answers "can this machine build and run Meridian?"
 *
 * Two rules govern the output. First, no secret value is ever printed — not the value, not a
 * prefix, not a length; only `present` or `absent`. Second, a failure says what to do about it,
 * because a preflight that reports `docker: fail` and stops has told the operator something they
 * already knew.
 */

export interface PreflightResult {
  check: string;
  ok: boolean;
  detail: string;
  /** A soft result is reported but does not fail the run. */
  soft?: boolean;
  remedy?: string;
}

const NODE_MAJOR_MINOR = /^v(\d+)\.(\d+)\./;

function expectedNodeVersion(): string {
  try {
    return readFileSync(repoPath('.nvmrc'), 'utf8').trim();
  } catch {
    return '22.16.0';
  }
}

export function checkNode(actual: string, expected: string): PreflightResult {
  const actualMatch = NODE_MAJOR_MINOR.exec(actual);
  const [expMajor, expMinor] = expected.split('.');
  const ok = actualMatch !== null && actualMatch[1] === expMajor && actualMatch[2] === expMinor;
  return {
    check: 'node',
    ok,
    detail: `${actual} (expected ${expMajor}.${expMinor}.x from .nvmrc)`,
    remedy: 'nvm install && nvm use',
  };
}

export function checkPnpm(actual: string | null): PreflightResult {
  return {
    check: 'pnpm',
    ok: actual === '10.32.1',
    detail: actual ?? 'not found',
    remedy: 'corepack enable && corepack prepare pnpm@10.32.1 --activate',
  };
}

/**
 * `GMAIL_LIVE_MODE` is the single switch, so turning it on also sends *documents* down the live
 * path, and live field extraction has no answer without a real model behind it. Left on `mock`, the
 * pair is unsatisfiable in a way that hides: intake succeeds, attachments download, and the run only
 * dies at the first field extraction, several minutes and one consumed inbox message later. Naming
 * it here turns that into a line of configuration.
 */
export function checkLiveModeCoherence(
  gmailLiveMode: string | undefined,
  aiMode: string | undefined,
): PreflightResult {
  const live = ['true', '1'].includes((gmailLiveMode ?? 'false').trim());
  const mode = (aiMode ?? 'mock').trim();
  const ok = !live || mode === 'live';
  return {
    check: 'live mode coherence',
    ok,
    detail: ok
      ? `GMAIL_LIVE_MODE=${String(live)}, AI_MODE=${mode}`
      : `GMAIL_LIVE_MODE is on but AI_MODE is '${mode}'; live documents cannot extract fields without a model`,
    remedy:
      'set AI_MODE=live to run against the real inbox, or GMAIL_LIVE_MODE=false to use fixtures',
  };
}

function checkTool(name: string, args: readonly string[], remedy: string): PreflightResult {
  const result = run(name, args);
  if (result.unavailable || result.code !== 0) {
    return { check: name, ok: false, detail: 'not found', remedy };
  }
  const first = `${result.stdout}${result.stderr}`.trim().split('\n')[0] ?? '';
  return { check: name, ok: true, detail: first };
}

export async function runPreflight(): Promise<PreflightResult[]> {
  loadOpsEnv();
  const results: PreflightResult[] = [];

  results.push(checkNode(process.version, expectedNodeVersion()));
  results.push(checkPnpm(output('pnpm', ['--version'])));

  const docker = run('docker', ['info']);
  results.push({
    check: 'docker',
    ok: !docker.unavailable && docker.code === 0,
    detail: docker.code === 0 ? 'daemon reachable' : 'daemon unreachable',
    remedy: 'start Docker Desktop, then re-run',
  });

  results.push(checkTool('supabase', ['--version'], 'brew install supabase/tap/supabase'));
  results.push(checkTool('temporal', ['--version'], 'brew install temporal'));
  results.push(checkTool('git', ['--version'], 'xcode-select --install'));

  const ports = checkPorts();
  const foreign = ports.filter((report) => report.state === 'foreign');
  results.push({
    check: 'ports',
    ok: foreign.length === 0,
    detail: formatReports(ports).split('\n')[0] ?? '',
    ...(foreign.length === 0
      ? {}
      : {
          remedy: `free ${foreign.map((r) => r.port).join(', ')} yourself; preflight never kills a process it does not own`,
        }),
  });

  results.push(checkLiveModeCoherence(process.env.GMAIL_LIVE_MODE, process.env.AI_MODE));

  for (const credential of credentialPresence()) {
    results.push({
      check: credential.name,
      ok: credential.present,
      detail: credential.present ? 'present' : 'absent',
      soft: true,
    });
  }

  try {
    const resolved = await resolveAndWrite();
    results.push({
      check: 'composio gmail toolkit',
      ok: true,
      detail: `${resolved.composioGmailToolkit} (via ${resolved.resolvedFrom})`,
    });
  } catch (error) {
    results.push({
      check: 'composio gmail toolkit',
      ok: false,
      detail: error instanceof VersionResolutionError ? error.message : (error as Error).message,
      remedy: 'set COMPOSIO_GMAIL_TOOLKIT_VERSION to a concrete version, or unset COMPOSIO_API_KEY',
    });
  }

  return results;
}

export function formatResults(results: readonly PreflightResult[]): string {
  const width = Math.max(...results.map((r) => r.check.length));
  return results
    .map((r) => {
      const mark = r.ok ? 'ok  ' : r.soft === true ? 'skip' : 'FAIL';
      const remedy =
        !r.ok && r.soft !== true && r.remedy !== undefined ? `\n       -> ${r.remedy}` : '';
      return `  ${mark} ${r.check.padEnd(width)}  ${r.detail}${remedy}`;
    })
    .join('\n');
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const results = await runPreflight();
  process.stdout.write(`Meridian preflight\n${formatResults(results)}\n`);
  const hardFailures = results.filter((r) => !r.ok && r.soft !== true);
  if (hardFailures.length > 0) {
    process.stderr.write(`\n${hardFailures.length} hard check(s) failed.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\npreflight passed\n');
}
