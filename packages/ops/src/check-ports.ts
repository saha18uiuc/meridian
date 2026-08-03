import { readFileSync } from 'node:fs';
import { commandLineOf, listenersOn, output, run } from './lib/proc.js';
import { readState, repoPath } from './lib/state.js';

/**
 * Port classification, three ways.
 *
 * The reason this is not a simple "is the port free" check is that a developer running Meridian
 * for the second time in a day has our own stack on most of these ports, and a preflight that
 * fails on that is a preflight nobody runs. Equally, a developer running two *other* local
 * Supabase stacks must never have one of them mistaken for ours and killed. So every occupied port
 * has to be attributed to a specific owner before anything is said about it.
 *
 * Nothing here terminates a process. Classification only.
 */

export type PortState = 'free' | 'owned' | 'foreign';

export interface PortReport {
  port: number;
  state: PortState;
  pid?: number;
  command?: string;
  detail?: string;
}

export const MERIDIAN_PORTS = [
  3000, 7233, 8233, 9464, 54521, 54522, 54523, 54524, 54525, 54526, 54527,
] as const;

const SUPABASE_PORTS = new Set([54521, 54522, 54523, 54524, 54525, 54526, 54527]);

/** The `project_id` from `supabase/config.toml`, which prefixes every container this repo starts. */
export function supabaseProjectId(): string | null {
  let toml: string;
  try {
    toml = readFileSync(repoPath('supabase', 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const match = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(toml);
  return match?.[1] ?? null;
}

export interface ClassifyDeps {
  listeners: (port: number) => number[];
  commandLine: (pid: number) => string | null;
  dockerNamesFor: (port: number) => string[];
  temporalPid: number | null;
  projectId: string | null;
  lsofAvailable: boolean;
}

export function defaultDeps(): ClassifyDeps {
  const state = readState();
  return {
    listeners: listenersOn,
    commandLine: commandLineOf,
    dockerNamesFor: (port) => {
      const names = output('docker', [
        'ps',
        '--filter',
        `publish=${port}`,
        '--format',
        '{{.Names}}',
      ]);
      return names === null
        ? []
        : names
            .split('\n')
            .map((n) => n.trim())
            .filter((n) => n.length > 0);
    },
    temporalPid: state.temporal?.pid ?? null,
    projectId: supabaseProjectId(),
    lsofAvailable: !run('lsof', ['-v']).unavailable,
  };
}

export function classifyPort(port: number, deps: ClassifyDeps): PortReport {
  if (!deps.lsofAvailable) {
    // Without `lsof` we cannot attribute a listener to an owner. Reporting `foreign` is the
    // conservative answer: it stops the run rather than letting it stamp on someone else's stack.
    const reachable = run('nc', ['-z', '127.0.0.1', String(port)]).code === 0;
    return reachable
      ? { port, state: 'foreign', detail: 'lsof unavailable; owner could not be determined' }
      : { port, state: 'free' };
  }

  const pids = deps.listeners(port);
  const pid = pids[0];
  if (pid === undefined) return { port, state: 'free' };

  const command = deps.commandLine(pid) ?? '';

  if (
    deps.temporalPid !== null &&
    pid === deps.temporalPid &&
    command.includes('temporal server start-dev')
  ) {
    return { port, state: 'owned', pid, command, detail: 'managed temporal dev server' };
  }

  if (SUPABASE_PORTS.has(port) && deps.projectId !== null) {
    const names = deps.dockerNamesFor(port);
    if (names.some((name) => name.includes(deps.projectId as string))) {
      return { port, state: 'owned', pid, command, detail: `docker ${names.join(', ')}` };
    }
  }

  return { port, state: 'foreign', pid, command };
}

export function checkPorts(deps: ClassifyDeps = defaultDeps()): PortReport[] {
  return MERIDIAN_PORTS.map((port) => classifyPort(port, deps));
}

export function formatReports(reports: readonly PortReport[]): string {
  const counts = { free: 0, owned: 0, foreign: 0 };
  for (const report of reports) counts[report.state] += 1;
  const lines = reports
    .filter((report) => report.state !== 'free')
    .map((report) =>
      `  ${String(report.port).padEnd(6)} ${report.state.padEnd(8)} pid=${report.pid ?? '-'} ${
        report.detail ?? report.command ?? ''
      }`.trimEnd(),
    );
  const summary = `${counts.free} free, ${counts.owned} owned, ${counts.foreign} foreign (of ${reports.length})`;
  return [summary, ...lines].join('\n');
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const reports = checkPorts();
  process.stdout.write(`${formatReports(reports)}\n`);
  const foreign = reports.filter((report) => report.state === 'foreign');
  if (foreign.length > 0) {
    for (const report of foreign) {
      process.stderr.write(
        `port ${report.port} is held by pid ${report.pid ?? 'unknown'} (${report.command ?? 'unknown command'}).\n` +
          `Stop that process yourself, or change the port. Meridian will not kill a process it does not own.\n`,
      );
    }
    process.exitCode = 1;
  }
}
