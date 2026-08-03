import type { Database } from '@meridian/core/database';
import type { ExecutionStep, StepStatus } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;
type Row = Database['public']['Tables']['execution_steps']['Row'];
type Json = Row['input_summary_json'];

export function toStep(row: Row): ExecutionStep {
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
 * Inserts a step row using the `sequenceNo` the caller computed.
 *
 * The recorder never allocates the ordinal itself and never reads `max(sequence_no)`. The
 * deterministic workflow assigns every ordinal up front from sorted business keys, which is what
 * removes the coordination point that a runtime allocator would reintroduce under parallelism.
 *
 * A duplicate `(execution_id, step_instance_key, attempt_no)` means the activity is being replayed
 * after a crash, so the existing row is returned rather than treated as an error.
 */
export async function insertStep(
  client: Client,
  input: {
    executionId: string;
    nodeId: string | null;
    stepKey: string;
    stepInstanceKey: string;
    sequenceNo: number;
    attemptNo: number;
    inputSummary: Record<string, unknown>;
  },
): Promise<ExecutionStep> {
  const { data, error } = await client
    .from('execution_steps')
    .insert({
      execution_id: input.executionId,
      node_id: input.nodeId,
      step_key: input.stepKey,
      step_instance_key: input.stepInstanceKey,
      sequence_no: input.sequenceNo,
      attempt_no: input.attemptNo,
      status: 'running',
      input_summary_json: input.inputSummary as Json,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .maybeSingle();

  if (error === null && data !== null) return toStep(data);
  if (error !== null && error.code !== '23505') {
    throw new Error(`startStep failed: ${error.message}`);
  }

  const existing = await client
    .from('execution_steps')
    .select('*')
    .eq('execution_id', input.executionId)
    .eq('step_instance_key', input.stepInstanceKey)
    .eq('attempt_no', input.attemptNo)
    .maybeSingle();
  if (existing.error !== null)
    throw new Error(`startStep replay read failed: ${existing.error.message}`);
  if (existing.data === null) throw new Error('startStep: conflicting insert vanished.');
  return toStep(existing.data);
}

export async function finishStep(
  client: Client,
  stepExecutionId: string,
  patch: {
    status: Extract<StepStatus, 'succeeded' | 'failed' | 'skipped'>;
    output?: Record<string, unknown>;
    error?: Record<string, unknown>;
  },
): Promise<ExecutionStep> {
  const { data, error } = await client
    .from('execution_steps')
    .update({
      status: patch.status,
      output_summary_json: (patch.output ?? {}) as Json,
      error_json: (patch.error ?? null) as Json,
      completed_at: new Date().toISOString(),
    })
    .eq('step_execution_id', stepExecutionId)
    .select('*')
    .maybeSingle();
  if (error !== null) throw new Error(`finishStep failed: ${error.message}`);
  if (data === null) throw new Error(`finishStep: step ${stepExecutionId} not found.`);
  return toStep(data);
}
