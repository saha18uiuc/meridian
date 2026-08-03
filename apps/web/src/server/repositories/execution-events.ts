import 'server-only';

import type { Database } from '@meridian/core/database';
import type { EventType, ExecutionEvent } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'event_id, execution_id, step_execution_id, execution_action_id, event_type, event_key, payload_json, storage_path, idempotency_key, created_at';

type Row = Database['public']['Tables']['execution_events']['Row'];

function toEvent(row: Row): ExecutionEvent {
  return {
    eventId: row.event_id,
    executionId: row.execution_id,
    stepExecutionId: row.step_execution_id,
    executionActionId: row.execution_action_id,
    eventType: row.event_type as EventType,
    eventKey: row.event_key,
    payloadJson: (row.payload_json ?? {}) as Record<string, unknown>,
    storagePath: row.storage_path,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Events are append-only and can be numerous, so this read is always bounded and always
 * cursored. There is deliberately no "give me the whole history" mode.
 */
export async function listEvents(
  client: Client,
  executionId: string,
  options: { afterEventId?: number; limit?: number } = {},
): Promise<{ events: ExecutionEvent[]; nextCursor: number | null }> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  let builder = client
    .from('execution_events')
    .select(COLUMNS)
    .eq('execution_id', executionId)
    .order('event_id', { ascending: true })
    .limit(limit + 1);
  if (options.afterEventId !== undefined) builder = builder.gt('event_id', options.afterEventId);

  const { data, error } = await builder;
  if (error !== null) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const page = rows.slice(0, limit).map(toEvent);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.eventId ?? null) : null;
  return { events: page, nextCursor };
}

/** Signed URLs are minted per request; a stored path on its own is not a capability. */
export async function signEventArtifacts(
  client: Client,
  events: ExecutionEvent[],
  expiresInSeconds = 300,
): Promise<Record<string, string>> {
  const byBucket = new Map<string, string[]>();
  for (const event of events) {
    if (event.storagePath === null) continue;
    const [bucket, ...rest] = event.storagePath.split('/');
    if (bucket === undefined || rest.length === 0) continue;
    const list = byBucket.get(bucket) ?? [];
    list.push(rest.join('/'));
    byBucket.set(bucket, list);
  }

  const urls: Record<string, string> = {};
  for (const [bucket, paths] of byBucket) {
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrls(paths, expiresInSeconds);
    if (error !== null) continue;
    for (const entry of data ?? []) {
      if (entry.path !== null && entry.signedUrl !== null) {
        urls[`${bucket}/${entry.path}`] = entry.signedUrl;
      }
    }
  }
  return urls;
}
