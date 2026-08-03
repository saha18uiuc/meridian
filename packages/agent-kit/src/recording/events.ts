import type { Database } from '@meridian/core/database';
import type { EventType } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;
type Json = Database['public']['Tables']['execution_events']['Row']['payload_json'];

/**
 * Anything larger than this is written to Storage and referenced by path. The threshold exists so
 * that paging through an execution's history stays cheap no matter how large a single OCR result
 * or provider response happened to be.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 16 * 1024;

export function isOversizePayload(payload: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(payload ?? null)).length > MAX_INLINE_PAYLOAD_BYTES
  );
}

export async function appendEvent(
  client: Client,
  input: {
    executionId: string;
    stepExecutionId: string | null;
    executionActionId?: string | null;
    eventType: EventType;
    eventKey: string | null;
    payload: Record<string, unknown>;
    storagePath?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<{ eventId: number }> {
  const { data, error } = await client
    .from('execution_events')
    .insert({
      execution_id: input.executionId,
      step_execution_id: input.stepExecutionId,
      execution_action_id: input.executionActionId ?? null,
      event_type: input.eventType,
      event_key: input.eventKey,
      payload_json: input.payload as Json,
      storage_path: input.storagePath ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('event_id')
    .maybeSingle();

  if (error !== null) {
    // A repeated `idempotency_key` means the same evidence is being appended twice after a replay.
    // The first write already recorded it, so the second is satisfied by returning the original.
    if (error.code === '23505' && input.idempotencyKey != null) {
      const existing = await client
        .from('execution_events')
        .select('event_id')
        .eq('execution_id', input.executionId)
        .eq('idempotency_key', input.idempotencyKey)
        .maybeSingle();
      if (existing.data !== null) return { eventId: existing.data.event_id };
    }
    throw new Error(`appendEvent failed: ${error.message}`);
  }
  if (data === null) throw new Error('appendEvent returned no row.');
  return { eventId: data.event_id };
}
