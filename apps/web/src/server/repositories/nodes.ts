import 'server-only';

import type { WhiteboardNode } from '@meridian/core/schemas';
import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

export async function listNodes(client: Client, whiteboardId: string): Promise<WhiteboardNode[]> {
  const { data, error } = await client
    .from('whiteboard_nodes')
    .select('node_id, primitive_type, title, node_data_json, position_x, position_y, row_version')
    .eq('whiteboard_id', whiteboardId);
  if (error !== null) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    nodeId: row.node_id,
    primitiveType: row.primitive_type as WhiteboardNode['primitiveType'],
    title: row.title,
    data: (row.node_data_json ?? {}) as Record<string, unknown>,
    position: { x: row.position_x, y: row.position_y },
    rowVersion: row.row_version,
  }));
}
