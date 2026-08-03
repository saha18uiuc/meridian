import 'server-only';

import { isUnresolvedRoot } from '@meridian/core';
import type { Database } from '@meridian/core/database';
import type { Comment, CommentThread, RootCommentStatus, Severity } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'comment_id, whiteboard_id, review_session_id, thread_id, parent_comment_id, author_type, author_user_id, body, anchor_type, anchor_id, anchor_field_path, status, severity, issue_key, metadata_json, suggested_patch_json, created_at, resolved_at';

type Row = Database['public']['Tables']['comments']['Row'];

function toComment(row: Row): Comment {
  return {
    commentId: row.comment_id,
    whiteboardId: row.whiteboard_id,
    reviewSessionId: row.review_session_id,
    threadId: row.thread_id,
    parentCommentId: row.parent_comment_id,
    authorType: row.author_type as Comment['authorType'],
    authorUserId: row.author_user_id,
    body: row.body,
    anchorType: row.anchor_type as Comment['anchorType'],
    anchorId: row.anchor_id,
    anchorFieldPath: row.anchor_field_path,
    status: row.status as RootCommentStatus | null,
    severity: row.severity as Severity | null,
    issueKey: row.issue_key,
    metadataJson: (row.metadata_json ?? {}) as Comment['metadataJson'],
    suggestedPatchJson: (row.suggested_patch_json ?? null) as Record<string, unknown> | null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function listBoardComments(client: Client, whiteboardId: string): Promise<Comment[]> {
  const { data, error } = await client
    .from('comments')
    .select(COLUMNS)
    .eq('whiteboard_id', whiteboardId)
    .order('created_at', { ascending: true });
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toComment(row));
}

/** Threads for one round: roots created anywhere on the board plus every reply in their thread. */
export async function listSessionThreads(
  client: Client,
  reviewSessionId: string,
): Promise<CommentThread[]> {
  const { data: sessionRows, error: sessionError } = await client
    .from('comments')
    .select('whiteboard_id')
    .eq('review_session_id', reviewSessionId)
    .limit(1);
  if (sessionError !== null) throw new Error(sessionError.message);
  const whiteboardId = (sessionRows ?? [])[0]?.whiteboard_id;
  if (whiteboardId === undefined) return [];

  const comments = await listBoardComments(client, whiteboardId);
  const roots = comments.filter((c) => c.parentCommentId === null);
  return roots.map((root) => ({
    root,
    replies: comments.filter((c) => c.parentCommentId !== null && c.threadId === root.threadId),
  }));
}

/**
 * The one predicate. Nothing else in the app re-derives "unresolved", because the negative form
 * (`status !== 'resolved'`) silently counts deliberately rejected findings as outstanding.
 */
export function unresolvedRoots(comments: Comment[]): Comment[] {
  return comments.filter((c) => isUnresolvedRoot(c.parentCommentId, c.status));
}

export function dismissedRoots(comments: Comment[]): Comment[] {
  return comments.filter((c) => c.parentCommentId === null && c.status === 'rejected');
}

export interface LiveAssumption {
  commentId: string;
  assumptionText: string;
  sourceRootCommentId: string;
}

/**
 * Live assumptions are the ones nothing supersedes. Superseded rows stay for history, which is
 * why this is a set difference rather than a "latest wins" sort.
 */
export async function listLiveAssumptions(
  client: Client,
  whiteboardId: string,
): Promise<LiveAssumption[]> {
  const comments = await listBoardComments(client, whiteboardId);
  const assumptions = comments.filter(
    (c) => (c.metadataJson as { kind?: string }).kind === 'assumption',
  );
  const superseded = new Set(
    assumptions
      .map((c) => (c.metadataJson as { supersedesCommentId?: string | null }).supersedesCommentId)
      .filter((id): id is string => typeof id === 'string'),
  );
  return assumptions
    .filter((c) => !superseded.has(c.commentId))
    .map((c) => {
      const metadata = c.metadataJson as { assumptionText?: string; sourceRootCommentId?: string };
      return {
        commentId: c.commentId,
        assumptionText: metadata.assumptionText ?? c.body,
        sourceRootCommentId: metadata.sourceRootCommentId ?? c.threadId,
      };
    })
    .sort((a, b) => a.sourceRootCommentId.localeCompare(b.sourceRootCommentId));
}
