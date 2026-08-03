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
        detail: result.code === 0 ? 'ok' : output.split('\n').slice(-40).join('\n'),
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
async function startWeb(): Promise<() => Promise<void>> {
  if (await webUp()) return async () => undefined;
  const build = await runAsync('pnpm', ['build:web'], { cwd: repoPath() });
  if (build.code !== 0) throw new Error(`build:web failed:\n${build.stderr.trim()}`);
  const child = (await import('node:child_process')).spawn(
    'pnpm',
    ['--filter', '@meridian/web', 'start', '--port', String(WEB_PORT)],
    { cwd: repoPath(), stdio: 'ignore', detached: true },
  );
  child.unref();
  const ready = await waitFor(webUp, { timeoutMs: 90_000 });
  if (!ready) throw new Error(`web server did not answer on ${WEB_URL} within 90s`);
  return async () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await sleep(250);
  };
}

/** Steps up to and including the seed run before the web server exists; the rest need it up. */
const STEPS_BEFORE_WEB = 3;

export async function main(_argv: readonly string[] = []): Promise<void> {
  loadOpsEnv();
  const steps = e2eSteps();
  let results: StepResult[];
  let stopWeb: (() => Promise<void>) | undefined;
  try {
    results = await runSteps(steps.slice(0, STEPS_BEFORE_WEB));
    if (results.every((result) => result.ok)) {
      stopWeb = await startWeb();
      results = [...results, ...(await runSteps(steps.slice(STEPS_BEFORE_WEB)))];
    }
  } finally {
    if (stopWeb !== undefined) await stopWeb();
  }
  process.stdout.write(`${formatSummary(results)}\n`);
  process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
}
