import type { Database } from '@meridian/core/database';
import type { Client } from '@temporalio/client';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The compensation sweep for the one unavoidable gap in the intake path (§5.11 step 8).
 *
 * The `executions` row is written *before* the Temporal call, so the only way the two can disagree
 * is a failure between a successful `signalWithStart` and the `start_execution` that records the
 * run ID. That leaves a durable, queryable row in `queued` — never a lost workflow — and this
 * sweep closes it by asking Temporal what actually happened.
 *
 * It never starts a workflow and never cancels one. `start_execution` is idempotent, so replaying
 * it is free, and the receiving workflow is idempotent on `executionId`, so no compensating
 * "undo the workflow" step is ever required.
 */

/** Rows younger than this are still plausibly mid-intake, so touching them would be a race. */
export const RECONCILE_MIN_AGE_MS = 60_000;

export interface ReconcileOutcome {
  executionId: string;
  action: 'started' | 'already_started' | 'failed_missing_workflow' | 'skipped';
  workflowId: string;
  detail?: string;
}

export interface ReconcileDeps {
  supabase: SupabaseClient<Database>;
  temporal: Client;
  now?: () => number;
  logger?: { info(fields: Record<string, unknown>, message: string): void };
}

export async function reconcileQueuedExecutions(deps: ReconcileDeps): Promise<ReconcileOutcome[]> {
  const now = deps.now ?? Date.now;
  const cutoff = new Date(now() - RECONCILE_MIN_AGE_MS).toISOString();

  const { data, error } = await deps.supabase
    .from('executions')
    .select('execution_id, temporal_workflow_id, created_at')
    .eq('status', 'queued')
    .not('temporal_workflow_id', 'is', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true });

  if (error !== null) throw new Error(`Could not list queued executions: ${error.message}`);

  const outcomes: ReconcileOutcome[] = [];

  for (const row of data ?? []) {
    const workflowId = row.temporal_workflow_id;
    if (workflowId === null) continue;

    const handle = deps.temporal.workflow.getHandle(workflowId);
    let runId: string;
    try {
      runId = (await handle.describe()).runId;
    } catch (describeError) {
      // A queued row whose workflow does not exist means the Temporal call itself failed. That is
      // the reverse failure, and the honest resolution is to fail the execution rather than to
      // start a second workflow behind the operator's back.
      const detail = describeError instanceof Error ? describeError.message : String(describeError);
      await deps.supabase.rpc('fail_execution', {
        p_execution_id: row.execution_id,
        p_error: { code: 'WORKFLOW_START_FAILED', detail },
      });
      outcomes.push({
        executionId: row.execution_id,
        action: 'failed_missing_workflow',
        workflowId,
        detail,
      });
      continue;
    }

    const { data: started, error: startError } = await deps.supabase.rpc('start_execution', {
      p_execution_id: row.execution_id,
      p_temporal_workflow_id: workflowId,
      p_temporal_run_id: runId,
    });
    if (startError !== null) {
      throw new Error(`Could not replay start_execution: ${startError.message}`);
    }

    const wasAlreadyStarted =
      typeof started === 'object' &&
      started !== null &&
      (started as { wasAlreadyStarted?: boolean }).wasAlreadyStarted === true;

    outcomes.push({
      executionId: row.execution_id,
      action: wasAlreadyStarted ? 'already_started' : 'started',
      workflowId,
    });
  }

  deps.logger?.info({ reconciled: outcomes.length }, 'queued-execution sweep finished');
  return outcomes;
}
