import { TEMPORAL_COMMAND_MATCH } from './dev-infra.js';
import { loadOpsEnv } from './env.js';
import { commandLineOf, isAlive, runAsync, sleep } from './lib/proc.js';
import { clearState, readPidCookie, readState, repoPath } from './lib/state.js';

/**
 * Shutdown.
 *
 * The only process this may ever signal is one that satisfies three independent conditions: the
 * state file names its PID, that PID is still running a `temporal server start-dev` command line,
 * and the cookie written beside the PID matches the one in the state file. Any single check could
 * be defeated by PID reuse or by a developer starting Temporal by hand; together they are the
 * reason this command cannot reach the other local stacks on this machine.
 *
 * Supabase is stopped through its own CLI, which scopes itself to this repository's
 * `config.toml` — so foreign Supabase containers are not merely spared, they are never enumerated.
 */

export interface StopReport {
  component: 'temporal' | 'supabase';
  action: 'stopped' | 'nothing-to-stop' | 'refused';
  detail: string;
}

export async function stopTemporal(): Promise<StopReport> {
  const state = readState();
  const recorded = state.temporal;
  if (recorded === undefined) {
    return {
      component: 'temporal',
      action: 'nothing-to-stop',
      detail: 'no managed process recorded',
    };
  }
  if (!isAlive(recorded.pid)) {
    return {
      component: 'temporal',
      action: 'nothing-to-stop',
      detail: `pid ${recorded.pid} is gone`,
    };
  }

  const command = commandLineOf(recorded.pid) ?? '';
  if (!command.includes(TEMPORAL_COMMAND_MATCH)) {
    return {
      component: 'temporal',
      action: 'refused',
      detail: `pid ${recorded.pid} is now running something else (${command.slice(0, 80)}); not signalling it`,
    };
  }

  const cookie = readPidCookie();
  if (cookie === null || cookie.pid !== recorded.pid || cookie.cookie !== recorded.cookie) {
    return {
      component: 'temporal',
      action: 'refused',
      detail: `ownership cookie for pid ${recorded.pid} does not match; not signalling it`,
    };
  }

  process.kill(recorded.pid, 'SIGTERM');
  for (let waited = 0; waited < 10_000 && isAlive(recorded.pid); waited += 250) {
    await sleep(250);
  }
  if (isAlive(recorded.pid)) {
    process.kill(recorded.pid, 'SIGKILL');
    return { component: 'temporal', action: 'stopped', detail: `pid ${recorded.pid} (SIGKILL)` };
  }
  return { component: 'temporal', action: 'stopped', detail: `pid ${recorded.pid} (SIGTERM)` };
}

export async function stopSupabase(): Promise<StopReport> {
  const result = await runAsync('supabase', ['stop', '--no-backup'], { cwd: repoPath() });
  if (result.unavailable) {
    return {
      component: 'supabase',
      action: 'nothing-to-stop',
      detail: 'supabase CLI not installed',
    };
  }
  if (result.code !== 0) {
    return {
      component: 'supabase',
      action: 'nothing-to-stop',
      detail: result.stderr.trim().split('\n')[0] ?? 'already stopped',
    };
  }
  return { component: 'supabase', action: 'stopped', detail: 'this project only' };
}

export async function stopLocal(): Promise<StopReport[]> {
  loadOpsEnv();
  const reports = [await stopTemporal(), await stopSupabase()];
  clearState();
  return reports;
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const reports = await stopLocal();
  for (const report of reports) {
    process.stdout.write(
      `  ${report.component.padEnd(9)} ${report.action.padEnd(16)} ${report.detail}\n`,
    );
  }
  if (reports.every((report) => report.action === 'nothing-to-stop')) {
    process.stdout.write('nothing to stop\n');
  }
}
