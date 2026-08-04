import { loadOpsEnv } from './env.js';
import { closeOpsTemporalClient, opsTemporalClient } from './lib/temporal.js';

/**
 * Terminate everything still running, which is the Temporal half of `pnpm db:reset`.
 *
 * It exists as an entry point rather than as a `temporal workflow terminate` call in the script
 * because the CLI takes its address, namespace and credential as flags, and a bare invocation
 * silently means the dev server on loopback. That was fine while the dev server was the only target
 * this repository had; against Temporal Cloud it made a documented setup step fail outright —
 * `supabase db reset && temporal workflow terminate` dialled `[::1]:7233`, got `connection refused`,
 * and took the whole command's exit code down with it. Going through `temporalTarget()` is what
 * makes this follow the configured Temporal like the other five call sites already do.
 *
 * Reset wipes the executions table, so any workflow still running afterwards is an orphan: it holds
 * a task queue slot and writes activity results into rows that no longer exist. Terminating them is
 * the point, and a namespace with nothing running is the normal case rather than an error.
 */
export async function terminateRunningWorkflows(reason: string): Promise<string[]> {
  const client = await opsTemporalClient();
  const terminated: string[] = [];
  try {
    for await (const execution of client.workflow.list({ query: "ExecutionStatus='Running'" })) {
      await client.workflow.getHandle(execution.workflowId, execution.runId).terminate(reason);
      terminated.push(execution.workflowId);
    }
  } finally {
    await closeOpsTemporalClient();
  }
  return terminated;
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  loadOpsEnv();
  const reason = 'local database reset';
  try {
    const terminated = await terminateRunningWorkflows(reason);
    process.stdout.write(
      terminated.length === 0
        ? 'no running workflows to terminate\n'
        : `terminated ${String(terminated.length)}: ${terminated.join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(`could not terminate running workflows: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
