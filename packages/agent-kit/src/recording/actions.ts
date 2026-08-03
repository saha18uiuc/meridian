import type { Database } from '@meridian/core/database';
import type {
  ActionStatus,
  ActionType,
  ExecutionAction,
  ReconciliationEvidence,
} from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;
type Row = Database['public']['Tables']['execution_actions']['Row'];
type Json = Database['public']['Tables']['execution_actions']['Row']['request_payload_json'];

export function toAction(row: Row): ExecutionAction {
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

async function readAction(client: Client, executionActionId: string): Promise<ExecutionAction> {
  const { data, error } = await client
    .from('execution_actions')
    .select('*')
    .eq('execution_action_id', executionActionId)
    .maybeSingle();
  if (error !== null) throw new Error(`Action read failed: ${error.message}`);
  if (data === null) throw new Error(`Action ${executionActionId} not found after its RPC.`);
  return toAction(data);
}

function actionIdOf(result: unknown): string {
  const id = (result as { executionActionId?: unknown } | null)?.executionActionId;
  if (typeof id !== 'string') throw new Error('Action RPC returned no executionActionId.');
  return id;
}

/**
 * Every method here is exactly one RPC call plus one read-back.
 *
 * None of them performs its own status arithmetic. The action state machine — including the fact
 * that `dispatched → reserved` does not exist — is defined once, in the database, so a bug in this
 * file cannot invent a transition that would allow a blind resend.
 */

export async function reserveAction(
  client: Client,
  input: {
    executionId: string;
    stepExecutionId: string | null;
    actionType: ActionType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<ExecutionAction> {
  const { data, error } = await client.rpc('reserve_execution_action', {
    p_execution_id: input.executionId,
    p_step_execution_id: input.stepExecutionId as string,
    p_action_type: input.actionType,
    p_request_payload: input.payload as Json,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error !== null) throw new Error(error.message);
  return readAction(client, actionIdOf(data));
}

/** The only method that increments `attempt_count`, and it always runs before the provider call. */
export async function dispatchAction(
  client: Client,
  executionActionId: string,
): Promise<ExecutionAction> {
  const { error } = await client.rpc('dispatch_execution_action', {
    p_execution_action_id: executionActionId,
  });
  if (error !== null) throw new Error(error.message);
  return readAction(client, executionActionId);
}

export async function completeAction(
  client: Client,
  executionActionId: string,
  result: {
    status: 'succeeded' | 'failed';
    providerActionId?: string | null;
    response?: Record<string, unknown>;
  },
): Promise<ExecutionAction> {
  const { error } = await client.rpc('complete_execution_action', {
    p_execution_action_id: executionActionId,
    p_status: result.status,
    p_provider_action_id: (result.providerActionId ?? null) as string,
    p_provider_response: (result.response ?? {}) as Json,
  });
  if (error !== null) throw new Error(error.message);
  return readAction(client, executionActionId);
}

/** Leaves `completed_at` null: `needs_reconciliation` is an open question, not an outcome. */
export async function markActionForReconciliation(
  client: Client,
  executionActionId: string,
  reason: Record<string, unknown>,
): Promise<ExecutionAction> {
  const { error } = await client.rpc('mark_execution_action_for_reconciliation', {
    p_execution_action_id: executionActionId,
    p_reason: reason as Json,
  });
  if (error !== null) throw new Error(error.message);
  return readAction(client, executionActionId);
}

/**
 * Returning an action to `reserved` requires `provenNotDelivered: true` in the evidence; the RPC
 * rejects anything weaker. An inconclusive reconciliation must abandon instead, because a resend
 * that turns out to be a duplicate is worse than a message that never went out.
 */
export async function reconcileAction(
  client: Client,
  executionActionId: string,
  outcome: 'succeeded' | 'reserved',
  providerActionId: string | null,
  evidence: ReconciliationEvidence,
): Promise<ExecutionAction> {
  const { error } = await client.rpc('reconcile_execution_action', {
    p_execution_action_id: executionActionId,
    p_status: outcome,
    p_provider_action_id: providerActionId as string,
    p_reconciliation: evidence as unknown as Json,
  });
  if (error !== null) throw new Error(error.message);
  return readAction(client, executionActionId);
}

export async function abandonAction(
  client: Client,
  executionActionId: string,
  reason: Record<string, unknown>,
): Promise<ExecutionAction> {
  const { error } = await client.rpc('abandon_execution_action', {
    p_execution_action_id: executionActionId,
    p_reconciliation: reason as Json,
  });
  if (error !== null) throw new Error(error.message);
  return readAction(client, executionActionId);
}
