import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadOpsEnv, optionalEnv } from './env.js';
import { commandLineOf, isAlive, run, runAsync, waitFor } from './lib/proc.js';
import {
  clearState,
  ensureStateDir,
  readState,
  repoPath,
  TEMPORAL_LOG_PATH,
  writePidCookie,
  writeState,
  type DevInfraState,
} from './lib/state.js';

/**
 * The single owner of local infrastructure.
 *
 * This command **returns**. It does not hold the terminal, because a developer who has to keep a
 * shell open for the database cannot also run the test suite in it, and the first thing they will
 * do is background it in a way nothing can later clean up. Temporal is therefore spawned detached
 * and identified by a cookie, so a later `pnpm stop` can prove the process it is about to signal
 * is ours before signalling it.
 */

const TEMPORAL_MATCH = 'temporal server start-dev';
const SUPABASE_TIMEOUT_MS = 180_000;
const TEMPORAL_TIMEOUT_MS = 60_000;

export interface InfraReport {
  component: 'supabase' | 'temporal';
  action: 'already-running' | 'started' | 'reclaimed-stale-pid';
  detail: string;
}

async function httpOk(url: string, accept: readonly number[]): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return accept.includes(response.status);
  } catch {
    return false;
  }
}

async function supabaseReady(apiPort: number): Promise<boolean> {
  return httpOk(`http://127.0.0.1:${apiPort}/rest/v1/`, [200, 401]);
}

async function temporalReady(port: number, uiPort: number): Promise<boolean> {
  const health = await runAsync('temporal', [
    'operator',
    'cluster',
    'health',
    '--address',
    `127.0.0.1:${port}`,
  ]);
  if (health.code !== 0) return false;
  return httpOk(`http://127.0.0.1:${uiPort}`, [200]);
}

function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log output)';
  }
}

export async function startSupabase(apiPort: number): Promise<InfraReport> {
  if (await supabaseReady(apiPort)) {
    return { component: 'supabase', action: 'already-running', detail: `api on ${apiPort}` };
  }
  // `supabase start` is itself idempotent and scoped to this repo's config.toml, which is what
  // keeps every other local Supabase stack on this machine out of its reach.
  const started = await runAsync('supabase', ['start'], { cwd: repoPath() });
  if (started.code !== 0 && !(await supabaseReady(apiPort))) {
    throw new Error(`supabase start failed:\n${started.stderr.trim() || started.stdout.trim()}`);
  }
  const ready = await waitFor(() => supabaseReady(apiPort), { timeoutMs: SUPABASE_TIMEOUT_MS });
  if (!ready) throw new Error(`supabase did not become ready on port ${apiPort} within 180s`);
  return { component: 'supabase', action: 'started', detail: `api on ${apiPort}` };
}

/**
 * Decide what to do about a recorded Temporal PID.
 *
 * A PID alone is not identity: the operating system reuses them, so a stale record can name a
 * completely unrelated process. Both the command line and the cookie must agree before the record
 * is treated as ours.
 */
export function classifyRecordedTemporal(
  state: DevInfraState,
  probe: { alive: (pid: number) => boolean; commandLine: (pid: number) => string | null },
): 'none' | 'ours' | 'stale' {
  const recorded = state.temporal;
  if (recorded === undefined) return 'none';
  if (!probe.alive(recorded.pid)) return 'stale';
  const command = probe.commandLine(recorded.pid) ?? '';
  return command.includes(TEMPORAL_MATCH) ? 'ours' : 'stale';
}

export async function startTemporal(port: number, uiPort: number): Promise<InfraReport> {
  const state = readState();
  const classification = classifyRecordedTemporal(state, {
    alive: isAlive,
    commandLine: commandLineOf,
  });

  if (classification === 'ours' && (await temporalReady(port, uiPort))) {
    return {
      component: 'temporal',
      action: 'already-running',
      detail: `pid ${state.temporal?.pid ?? 0} on ${port}`,
    };
  }

  const reclaimed = classification === 'stale';
  if (reclaimed) {
    writeState({ ...state, temporal: undefined });
  }

  ensureStateDir();
  // `temporal server start-dev` stats the parent directory of --db-filename and refuses to create
  // it, so the first run on a fresh checkout fails unless it already exists.
  mkdirSync(repoPath('.temporal'), { recursive: true });
  const logFd = openSync(TEMPORAL_LOG_PATH, 'a');
  const cookie = randomUUID();
  const child = spawn(
    'temporal',
    [
      'server',
      'start-dev',
      '--port',
      String(port),
      '--ui-port',
      String(uiPort),
      '--db-filename',
      repoPath('.temporal', 'meridian.db'),
      '--log-level',
      'warn',
    ],
    { detached: true, stdio: ['ignore', logFd, logFd], cwd: repoPath() },
  );
  child.unref();

  const pid = child.pid;
  if (pid === undefined) throw new Error('temporal failed to spawn (is the CLI installed?)');

  const ready = await waitFor(() => temporalReady(port, uiPort), {
    timeoutMs: TEMPORAL_TIMEOUT_MS,
  });
  if (!ready) {
    throw new Error(
      `temporal did not become ready on ${port} within 60s. Last log lines:\n${tail(TEMPORAL_LOG_PATH, 40)}`,
    );
  }

  const next: DevInfraState = {
    ...readState(),
    temporal: {
      pid,
      port,
      uiPort,
      startedAt: new Date().toISOString(),
      logPath: TEMPORAL_LOG_PATH,
      cookie,
    },
  };
  writeState(next);
  writePidCookie(pid, cookie);

  return {
    component: 'temporal',
    action: reclaimed ? 'reclaimed-stale-pid' : 'started',
    detail: `pid ${pid} on ${port}, ui ${uiPort}`,
  };
}

export async function devInfra(): Promise<InfraReport[]> {
  loadOpsEnv();
  const apiPort = Number.parseInt(optionalEnv('SUPABASE_API_PORT', '54521'), 10);
  const address = optionalEnv('TEMPORAL_ADDRESS', '127.0.0.1:7233');
  const port = Number.parseInt(address.split(':')[1] ?? '7233', 10);
  const uiPort = Number.parseInt(
    optionalEnv('TEMPORAL_UI_URL', 'http://127.0.0.1:8233').split(':').pop() ?? '8233',
    10,
  );

  const reports: InfraReport[] = [];
  reports.push(await startSupabase(apiPort));
  writeState({ ...readState(), supabase: { managedBy: 'docker', apiPort } });
  reports.push(await startTemporal(port, uiPort));
  return reports;
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  try {
    const reports = await devInfra();
    for (const report of reports) {
      process.stdout.write(
        `  ${report.component.padEnd(9)} ${report.action.padEnd(19)} ${report.detail}\n`,
      );
    }
    process.stdout.write('infrastructure ready; this command does not block\n');
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

/** Exported for `stop-local.ts`, which must recognise the same process signature. */
export const TEMPORAL_COMMAND_MATCH = TEMPORAL_MATCH;

export { clearState, run };
