import 'server-only';

import type { WhiteboardDeltaRequest, WhiteboardDeltaResponse } from '@meridian/core/schemas';
import type { Database, Json } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

/**
 * A1: one RPC call, one transaction. The service deliberately does not read-then-write, and it
 * does not split the delta into several Supabase calls — a partially applied graph edit is worse
 * than a rejected one.
 */
export async function saveWhiteboardDelta(
  client: Client,
  whiteboardId: string,
  request: WhiteboardDeltaRequest,
): Promise<WhiteboardDeltaResponse> {
  const { data, error } = await client.rpc('save_whiteboard_delta', {
    p_whiteboard_id: whiteboardId,
    p_expected_revision_no: request.expectedRevisionNo,
    p_node_upserts: request.nodeUpserts as unknown as Json,
    p_node_deletes: request.nodeDeletes,
    p_edge_upserts: request.edgeUpserts as unknown as Json,
    p_edge_deletes: request.edgeDeletes,
    p_viewport: (request.viewport ?? null) as unknown as Json,
  });
  if (error !== null) throw new Error(error.message);
  return data as unknown as WhiteboardDeltaResponse;
}
