import { spawn } from 'node:child_process';
import { loadOpsEnv, optionalEnv } from './env.js';
import { flag, optionalArg, parseArgs } from './lib/args.js';
import { runAsync, sleep, waitFor } from './lib/proc.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';
import { closeOpsTemporalClient } from './lib/temporal.js';
import { processInbox } from './process-inbox.js';

/**
 * The demo, run as a check rather than a script to read along with.
 *
 * A demo that only prints is a demo that can quietly stop working. This one drives the real path —
 * mock inbox, real intake correlation, real Temporal workflows, real database writes — and then
 * asserts the properties the demo is supposed to show: that a complete shipment finishes, that an
 * incomplete one asks for what is missing, that a duplicate does not act twice, and that every
 * external action carries a distinct idempotency key with no orphaned reservation left behind.
 *
 * It is deliberately not a Vitest test. It needs the whole stack running and takes tens of seconds,
 * which is the wrong shape for a suite that must stay fast enough to run on every change.
 */

const DEFAULT_DEPLOYMENT_KEY = 'inbound-import-receiving';
const FIXTURE_ROOT = 'examples/inbound-import-receiving/fixtures';
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'error']);
const SETTLE_TIMEOUT_MS = 120_000;

export interface DemoAssertion {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ExecutionSummary {
  executionId: string;
  caseKey: string;
  businessKey: string | null;
  status: string;
  outcome: string | null;
  steps: number;
  actions: { status: string; idempotencyKey: string; type: string }[];
  events: number;
}

interface OutputSummary {
  /** Written by a workflow or eval completion: the agent's typed decision kind. */
  resultKind?: unknown;
  /** Written only by `create_manual_review_intake_execution`, which has no workflow. */
  outcome?: unknown;
}

function outcomeOf(summary: unknown): string | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const { resultKind, outcome } = summary as OutputSummary;
  if (typeof resultKind === 'string') return resultKind;
  return typeof outcome === 'string' ? outcome : null;
}

/**
 * Wait until no execution created during this run is still pending.
 *
 * Polling the database rather than Temporal is intentional: the demo's claim is about what a person
 * can see in the UI, and the UI reads the database. A workflow that has closed but whose completion
 * write has not landed is not yet done for the purposes of this check.
 */
export async function waitForSettled(
  executionIds: readonly string[],
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  if (executionIds.length === 0) return true;
  const client = opsClient();
  return waitFor(
    async () => {
      const { data, error } = await client
        .from('executions')
        .select('execution_id, status')
        .in('execution_id', [...executionIds]);
      if (error !== null) return false;
      return (data ?? []).every((row) => TERMINAL_STATUSES.has(row.status));
    },
    { timeoutMs, intervalMs: 1000 },
  );
}

export async function summarize(executionIds: readonly string[]): Promise<ExecutionSummary[]> {
  const client = opsClient();
  const { data, error } = await client
    .from('executions')
    // One string literal, not a concatenation: PostgREST's typings parse the select at the type
    // level, and a concatenated string widens to `string` and loses every column type.
    .select(
      'execution_id, case_key, business_key, status, output_summary_json, execution_steps(step_execution_id), execution_actions(status, idempotency_key, action_type), execution_events(event_id)',
    )
    .in('execution_id', [...executionIds])
    .order('created_at', { ascending: true });
  if (error !== null) throw new Error(`could not read executions: ${error.message}`);

  return (data ?? []).map((row) => ({
    executionId: row.execution_id,
    caseKey: row.case_key,
    businessKey: row.business_key,
    status: row.status,
    outcome: outcomeOf(row.output_summary_json),
    steps: row.execution_steps.length,
    actions: row.execution_actions.map((action) => ({
      status: action.status,
      idempotencyKey: action.idempotency_key,
      type: action.action_type,
    })),
    events: row.execution_events.length,
  }));
}

export function assertDemo(summaries: readonly ExecutionSummary[]): DemoAssertion[] {
  const assertions: DemoAssertion[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    assertions.push({ name, ok, detail });
  };

  add(
    'every execution reached a terminal status',
    summaries.every((summary) => TERMINAL_STATUSES.has(summary.status)),
    summaries.map((summary) => `${summary.caseKey}=${summary.status}`).join(', '),
  );

  const completed = summaries.filter((summary) => summary.outcome === 'completed');
  add(
    'at least one shipment completed',
    completed.length > 0,
    `${String(completed.length)} completed`,
  );

  const asked = summaries.filter((summary) => summary.outcome === 'needs_information');
  add(
    'at least one shipment asked for missing information',
    asked.length > 0,
    `${String(asked.length)} needs_information`,
  );

  const escalated = summaries.filter((summary) => summary.outcome === 'manual_review');
  add(
    'at least one shipment escalated to a human',
    escalated.length > 0,
    `${String(escalated.length)} manual_review`,
  );

  add(
    'every execution recorded at least one step',
    summaries.every((summary) => summary.steps > 0),
    summaries.map((summary) => `${summary.caseKey}=${String(summary.steps)}`).join(', '),
  );

  const actions = summaries.flatMap((summary) => summary.actions);
  const keys = actions.map((action) => action.idempotencyKey);
  add(
    'external action idempotency keys are distinct',
    new Set(keys).size === keys.length,
    `${String(keys.length)} action(s), ${String(new Set(keys).size)} distinct key(s)`,
  );

  // `reserved` is the one status that means the process died between reserving and dispatching.
  // Anything else is a legitimate resting place for an action, including `abandoned`.
  const stranded = actions.filter((action) => action.status === 'reserved');
  add(
    'no external action left stranded in reserved',
    stranded.length === 0,
    stranded.length === 0
      ? 'none'
      : stranded.map((action) => `${action.type}:${action.idempotencyKey}`).join(', '),
  );

  add(
    'every dispatched action settled',
    actions.every((action) => action.status !== 'dispatched'),
    actions.map((action) => `${action.type}=${action.status}`).join(', ') || 'no actions',
  );

  return assertions;
}

async function workerUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the Temporal worker if it is not already answering, and return how to stop it again. */
async function ensureWorker(port: number): Promise<() => Promise<void>> {
  if (await workerUp(port)) return async () => undefined;
  const build = await runAsync('pnpm', ['build:ts'], { cwd: repoPath() });
  if (build.code !== 0) throw new Error(`build:ts failed:\n${build.stderr.trim()}`);
  const child = spawn('pnpm', ['--filter', '@meridian/backend', 'start'], {
    cwd: repoPath(),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const ready = await waitFor(() => workerUp(port), { timeoutMs: 60_000 });
  if (!ready) throw new Error(`worker did not answer on port ${String(port)} within 60s`);
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

export interface DemoReport {
  considered: number;
  reconciled: number;
  summaries: ExecutionSummary[];
  assertions: DemoAssertion[];
  ok: boolean;
}

export async function demoRun(options: { deploymentKey: string }): Promise<DemoReport> {
  const inbox = await processInbox({
    deploymentKey: options.deploymentKey,
    fixtureRoot: repoPath(FIXTURE_ROOT),
  });

  const executionIds = inbox.results.map((result) => result.executionId);

  const settled = await waitForSettled(executionIds);
  const summaries = await summarize(executionIds);
  const assertions = settled
    ? assertDemo(summaries)
    : [
        {
          name: 'every execution reached a terminal status',
          ok: false,
          detail: `timed out after ${String(SETTLE_TIMEOUT_MS)}ms waiting for ${String(executionIds.length)} execution(s)`,
        },
      ];

  return {
    considered: inbox.considered,
    reconciled: inbox.reconciled,
    summaries,
    assertions,
    ok: assertions.every((assertion) => assertion.ok),
  };
}

function render(report: DemoReport): string {
  const lines = [
    `inbox: ${String(report.considered)} message(s) considered, ${String(report.reconciled)} reconciled`,
    '',
  ];
  for (const summary of report.summaries) {
    lines.push(
      `  ${summary.businessKey ?? '(no business key)'}  ${summary.status.padEnd(12)} ${
        summary.outcome ?? '-'
      }`,
      `      steps ${String(summary.steps)}  events ${String(summary.events)}  actions ${
        summary.actions.map((action) => `${action.type}:${action.status}`).join(', ') || 'none'
      }`,
    );
  }
  lines.push('');
  for (const assertion of report.assertions) {
    lines.push(`  ${assertion.ok ? 'PASS' : 'FAIL'}  ${assertion.name}: ${assertion.detail}`);
  }
  return lines.join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  const workerPort = Number.parseInt(optionalEnv('WORKER_HEALTH_PORT', '9464'), 10);
  let stopWorker: (() => Promise<void>) | undefined;
  try {
    if (!flag(args, 'no-worker')) stopWorker = await ensureWorker(workerPort);
    const report = await demoRun({
      deploymentKey: optionalArg(args, 'agent') ?? DEFAULT_DEPLOYMENT_KEY,
    });
    process.stdout.write(`${render(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    if (stopWorker !== undefined) await stopWorker();
    await closeOpsTemporalClient();
  }
}
