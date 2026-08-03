import 'server-only';

import type { Database } from '@meridian/core/database';
import type { ExecutionStep, StepStatus } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'step_execution_id, execution_id, node_id, step_key, step_instance_key, sequence_no, attempt_no, status, input_summary_json, output_summary_json, error_json, started_at, completed_at';

type Row = Database['public']['Tables']['execution_steps']['Row'];

function toStep(row: Row): ExecutionStep {
  return {
    stepExecutionId: row.step_execution_id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    stepKey: row.step_key,
    stepInstanceKey: row.step_instance_key,
    sequenceNo: row.sequence_no,
    attemptNo: row.attempt_no,
    status: row.status as StepStatus,
    inputSummaryJson: (row.input_summary_json ?? {}) as Record<string, unknown>,
    outputSummaryJson: (row.output_summary_json ?? {}) as Record<string, unknown>,
    errorJson: (row.error_json ?? null) as Record<string, unknown> | null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Ordered by `sequence_no` because that column exists for display only. Logical identity is
 * `step_instance_key`; a retry reuses the key and takes a new `attempt_no`, and parallel siblings
 * legitimately share a `sequence_no`.
 */
export async function listSteps(
  client: Client,
  executionId: string,
  limit = 200,
): Promise<ExecutionStep[]> {
  const { data, error } = await client
    .from('execution_steps')
    .select(COLUMNS)
    .eq('execution_id', executionId)
    .order('sequence_no', { ascending: true })
    .order('step_instance_key', { ascending: true })
    .order('attempt_no', { ascending: true })
    .limit(limit);
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toStep(row));
}
