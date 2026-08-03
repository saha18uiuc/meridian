import 'server-only';

import type { BoardListItem, BoardMetadata, Viewport } from '@meridian/core/schemas';
import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what}_NOT_FOUND_OR_FORBIDDEN`);
    this.name = 'NotFoundError';
  }
}

/** Every repository read goes through the user client, so RLS is the authorization. */
export async function listBoards(client: Client): Promise<BoardListItem[]> {
  const { data, error } = await client
    .from('whiteboards')
    .select('whiteboard_id, title, status, revision_no, last_reviewed_revision_no, updated_at')
    .order('updated_at', { ascending: false });
  if (error !== null) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    whiteboardId: row.whiteboard_id,
    title: row.title,
    status: row.status as BoardListItem['status'],
    revisionNo: row.revision_no,
    lastReviewedRevisionNo: row.last_reviewed_revision_no,
    updatedAt: row.updated_at,
  }));
}

export async function getBoardMetadata(
  client: Client,
  whiteboardId: string,
): Promise<BoardMetadata> {
  const { data, error } = await client
    .from('whiteboards')
    .select('whiteboard_id, title, status, revision_no, viewport_json')
    .eq('whiteboard_id', whiteboardId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('WHITEBOARD');

  return {
    whiteboardId: data.whiteboard_id,
    title: data.title,
    status: data.status as BoardMetadata['status'],
    revisionNo: data.revision_no,
    viewport: data.viewport_json as unknown as Viewport,
  };
}

export interface BoardOwnership {
  whiteboardId: string;
  ownerId: string;
  revisionNo: number;
  lastReviewedRevisionNo: number | null;
  status: BoardMetadata['status'];
  title: string;
}

/**
 * Read the ownership facts with the **user** client before any service-role work starts, so a
 * privileged call can never be made on behalf of a board the caller cannot see.
 */
export async function requireOwnedBoard(
  client: Client,
  whiteboardId: string,
): Promise<BoardOwnership> {
  const { data, error } = await client
    .from('whiteboards')
    .select('whiteboard_id, owner_id, revision_no, last_reviewed_revision_no, status, title')
    .eq('whiteboard_id', whiteboardId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('WHITEBOARD');

  return {
    whiteboardId: data.whiteboard_id,
    ownerId: data.owner_id,
    revisionNo: data.revision_no,
    lastReviewedRevisionNo: data.last_reviewed_revision_no,
    status: data.status as BoardMetadata['status'],
    title: data.title,
  };
}
