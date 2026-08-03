import 'server-only';

import type { Database } from '@meridian/core/database';
import type { ActionStatus, ActionType, ExecutionAction } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'execution_action_id, execution_id, step_execution_id, action_type, status, idempotency_key, marker_token, provider_action_id, request_payload_json, provider_response_json, reconciliation_json, attempt_count, created_at, dispatched_at, completed_at';

type Row = Database['public']['Tables']['execution_actions']['Row'];

function toAction(row: Row): ExecutionAction {
  return {
    executionActionId: row.execution_action_id,
    executionId: row.execution_id,
    stepExecutionId: row.step_execution_id,
    actionType: row.action_type as ActionType,
    status: row.status as ActionStatus,
    idempotencyKey: row.idempotency_key,
    markerToken: row.marker_token,
    providerActionId: row.provider_action_id,
    requestPayloadJson: (row.request_payload_json ?? {}) as Record<string, unknown>,
    providerResponseJson: (row.provider_response_json ?? null) as Record<string, unknown> | null,
    reconciliationJson: (row.reconciliation_json ?? null) as Record<string, unknown> | null,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
  };
}

/**
 * `completedAt` is null for `reserved`, `dispatched`, and `needs_reconciliation`, so the UI can
 * say "in flight" straight from the data instead of inferring it from a status list (A22).
 */
export async function listActions(client: Client, executionId: string): Promise<ExecutionAction[]> {
  const { data, error } = await client
    .from('execution_actions')
    .select(COLUMNS)
    .eq('execution_id', executionId)
    .order('created_at', { ascending: true });
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toAction(row));
}
