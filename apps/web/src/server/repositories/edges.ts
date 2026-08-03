import 'server-only';

import type { WhiteboardEdge } from '@meridian/core/schemas';
import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

export async function listEdges(client: Client, whiteboardId: string): Promise<WhiteboardEdge[]> {
  const { data, error } = await client
    .from('whiteboard_edges')
    .select('edge_id, source_node_id, target_node_id, label, condition_json, priority, row_version')
    .eq('whiteboard_id', whiteboardId);
  if (error !== null) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    edgeId: row.edge_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    label: row.label,
    condition: (row.condition_json ?? null) as Record<string, unknown> | null,
    priority: row.priority,
    rowVersion: row.row_version,
  }));
}
