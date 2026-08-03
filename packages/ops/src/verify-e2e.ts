import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadOpsEnv, optionalEnv } from './env.js';
import { runAsync, sleep, waitFor } from './lib/proc.js';
import { repoPath } from './lib/state.js';
import { devInfra } from './dev-infra.js';
import { formatSummary, runSteps, type StepResult, type VerifyStep } from './verify.js';

/**
 * The half of verification that needs a live stack.
 *
 * It is separated from `verify` for one reason: `verify` must be runnable on a laptop with no
 * Docker and no Temporal binary and still be meaningful, while this command is meaningless without
 * both. Splitting them keeps the fast path fast and keeps the slow path honest instead of
 * silently skipping.
 */

const WEB_PORT = Number.parseInt(optionalEnv('WEB_PORT', '3000'), 10);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;

async function webUp(): Promise<boolean> {
  try {
    const response = await fetch(WEB_URL, { signal: AbortSignal.timeout(2000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Node's `NO_COLOR`/`FORCE_COLOR` warning is emitted once per child process.
 *
 * A step that spawns a dozen of them ends with forty lines of identical warning, and taking "the
 * last forty lines" as the failure detail then reports the noise and discards the reason. Dropping
 * it here is not cosmetic: it is the difference between a summary that says why a step failed and
 * one that says nothing at all.
 */
const NODE_NOISE = /^\(node:\d+\)|^\(Use `node --trace-warnings/;

function meaningfulTail(output: string, lines: number): string {
  const kept = output
    .split('\n')
    .filter((line) => !NODE_NOISE.test(line.trim()))
    .filter((line, index, all) => line.trim() !== '' || all[index + 1]?.trim() !== '');
  return kept.slice(-lines).join('\n').trim();
}

function step(name: string, argv: string[]): VerifyStep {
  return {
    name,
    required: true,
    run: async () => {
      const result = await runAsync(argv[0] as string, argv.slice(1), { cwd: repoPath() });
      if (result.unavailable) return { ok: false, detail: `${argv[0] ?? name} is not installed` };
      const output = `${result.stdout}\n${result.stderr}`.trim();
      return {
        ok: result.code === 0,
        detail: result.code === 0 ? 'ok' : meaningfulTail(output, 40),
      };
    },
  };
}

export function e2eSteps(): VerifyStep[] {
  return [
    {
      name: 'infrastructure',
      required: true,
      run: async () => {
        const reports = await devInfra();
        return { ok: true, detail: reports.map((r) => `${r.component}: ${r.action}`).join(', ') };
      },
    },
    step('db reset', ['pnpm', 'db:reset']),
    step('seed', ['pnpm', 'seed']),
    step('test:service', ['pnpm', 'test:service']),
    step('test:component', ['pnpm', 'test:component']),
    step('demo (mock)', ['pnpm', 'demo']),
    step('e2e', ['pnpm', 'test:e2e']),
    step('health', ['pnpm', 'health']),
  ];
}

/**
 * Start `next start` for the Playwright run and return a stopper.
 *
 * Playwright's own `webServer` option is not used because the same server must also serve the demo
 * step above it, and starting two servers on one port fails in a way that reads like a test failure.
 */
export interface WebServer {
  stop: () => Promise<void>;
  /** How the server ended, if it is no longer running. */
  epitaph: () => string | null;
}

const WEB_LOG = '.meridian/web-e2e.log';

async function startWeb(): Promise<WebServer> {
  if (await webUp()) return { stop: async () => undefined, epitaph: () => null };
  const build = await runAsync('pnpm', ['build:web'], { cwd: repoPath() });
  if (build.code !== 0) throw new Error(`build:web failed:\n${build.stderr.trim()}`);

  // The server's own output goes to a file rather than to `ignore`. A server that starts, answers
  // the readiness probe and then dies mid-suite is indistinguishable, from the outside, from a
  // suite of tests that all fail — and with its output discarded there is nothing to tell them
  // apart. This log is the only place the reason can survive.
  const logPath = repoPath(WEB_LOG);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w');

  const child = spawn('pnpm', ['--filter', '@meridian/web', 'start', '--port', String(WEB_PORT)], {
    cwd: repoPath(),
    stdio: ['ignore', log, log],
    detached: true,
  });

  let ended: string | null = null;
  child.on('exit', (code, signal) => {
    ended = `the web server exited (code ${String(code)}, signal ${String(signal)}); see ${WEB_LOG}`;
  });
  child.unref();

  const ready = await waitFor(webUp, { timeoutMs: 90_000 });
  if (!ready) {
    throw new Error(`web server did not answer on ${WEB_URL} within 90s; see ${WEB_LOG}`);
  }

  return {
    epitaph: () => ended,
    stop: async () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
      closeSync(log);
      await sleep(250);
    },
  };
}

/** Steps up to and including the seed run before the web server exists; the rest need it up. */
const STEPS_BEFORE_WEB = 3;

/**
 * Say so when the steps failed because the thing they talk to went away.
 *
 * Twenty-three tests reporting `ERR_CONNECTION_REFUSED` is a true statement about each test and a
 * useless one about the run. The interesting fact is one level up, and it is only knowable here.
 */
function explainWebLoss(results: readonly StepResult[], web: WebServer): string | null {
  const epitaph = web.epitaph();
  if (epitaph === null) return null;
  if (results.every((result) => result.ok)) return null;

  let tail: string;
  try {
    tail = meaningfulTail(readFileSync(repoPath(WEB_LOG), 'utf8'), 20);
  } catch {
    tail = '(no output was captured)';
  }
  return ['', epitaph, tail].join('\n');
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  loadOpsEnv();
  const steps = e2eSteps();
  let results: StepResult[];
  let web: WebServer | undefined;
  try {
    results = await runSteps(steps.slice(0, STEPS_BEFORE_WEB));
    if (results.every((result) => result.ok)) {
      web = await startWeb();
      results = [...results, ...(await runSteps(steps.slice(STEPS_BEFORE_WEB)))];
      const lost = explainWebLoss(results, web);
      if (lost !== null) process.stdout.write(`${lost}\n`);
    }
  } finally {
    if (web !== undefined) await web.stop();
  }
  process.stdout.write(`${formatSummary(results)}\n`);
  process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
}
