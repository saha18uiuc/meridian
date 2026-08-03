import 'server-only';

import { assembleCanonicalGraph, deriveCanvasHash, type CanonicalGraph } from '@meridian/core';
import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listEdges } from '@/server/repositories/edges';
import { listNodes } from '@/server/repositories/nodes';
import { requireOwnedBoard } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

export interface AssembledSnapshot {
  snapshot: CanonicalGraph;
  hash: string;
  revisionNo: number;
  lastReviewedRevisionNo: number | null;
  title: string;
  ownerId: string;
  status: CanonicalGraph['metadata']['status'];
}

/**
 * The snapshot and its hash are computed **here**, on the server, from the rows the user client
 * can see. No request schema in this system has a `sourceCanvasJson` or `sourceCanvasHash`
 * field, so there is nothing for a client to forge (A21).
 */
export async function assembleSnapshot(
  client: Client,
  whiteboardId: string,
): Promise<AssembledSnapshot> {
  const board = await requireOwnedBoard(client, whiteboardId);
  const [nodes, edges] = await Promise.all([
    listNodes(client, whiteboardId),
    listEdges(client, whiteboardId),
  ]);

  const snapshot = assembleCanonicalGraph(
    {
      whiteboardId: board.whiteboardId,
      title: board.title,
      status: board.status,
      revisionNo: board.revisionNo,
    },
    nodes,
    edges,
  );

  return {
    snapshot,
    hash: deriveCanvasHash(snapshot),
    revisionNo: board.revisionNo,
    lastReviewedRevisionNo: board.lastReviewedRevisionNo,
    title: board.title,
    ownerId: board.ownerId,
    status: board.status,
  };
}
