import 'server-only';

import type { Database } from '@meridian/core/database';
import type { Execution, ExecutionStatus, RunType } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'execution_id, agent_id, agent_version_id, run_type, case_key, business_key, temporal_workflow_id, temporal_run_id, idempotency_key, status, input_ref_json, expected_summary_json, output_summary_json, diff_summary_json, error_json, created_at, started_at, completed_at';

type Row = Database['public']['Tables']['executions']['Row'];

function toExecution(row: Row): Execution {
  return {
    executionId: row.execution_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    runType: row.run_type as RunType,
    caseKey: row.case_key,
    businessKey: row.business_key,
    temporalWorkflowId: row.temporal_workflow_id,
    temporalRunId: row.temporal_run_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as ExecutionStatus,
    inputRefJson: (row.input_ref_json ?? {}) as Record<string, unknown>,
    expectedSummaryJson: (row.expected_summary_json ?? null) as Record<string, unknown> | null,
    outputSummaryJson: (row.output_summary_json ?? null) as Record<string, unknown> | null,
    diffSummaryJson: (row.diff_summary_json ?? null) as Record<string, unknown> | null,
    errorJson: (row.error_json ?? null) as Record<string, unknown> | null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface ExecutionQuery {
  agentId?: string | undefined;
  agentVersionId?: string | undefined;
  runType?: RunType | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export async function listExecutions(
  client: Client,
  query: ExecutionQuery = {},
): Promise<{ executions: Execution[]; nextCursor: string | null }> {
  const limit = Math.min(query.limit ?? 50, 200);
  let builder = client
    .from('executions')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (query.agentId !== undefined) builder = builder.eq('agent_id', query.agentId);
  if (query.agentVersionId !== undefined) {
    builder = builder.eq('agent_version_id', query.agentVersionId);
  }
  if (query.runType !== undefined) builder = builder.eq('run_type', query.runType);
  if (query.cursor !== undefined) builder = builder.lt('created_at', query.cursor);

  const { data, error } = await builder;
  if (error !== null) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const page = rows.slice(0, limit).map(toExecution);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.createdAt ?? null) : null;
  return { executions: page, nextCursor };
}

export async function getExecution(client: Client, executionId: string): Promise<Execution> {
  const { data, error } = await client
    .from('executions')
    .select(COLUMNS)
    .eq('execution_id', executionId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('EXECUTION');
  return toExecution(data);
}
