import 'server-only';

import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

/**
 * Four comment actions, four RPCs, one transaction each. There is deliberately no "resolve"
 * action: a root becomes `resolved` only when a later review round stops reporting the issue.
 */

async function rpc<Name extends keyof Database['public']['Functions']>(
  client: Client,
  name: Name,
  args: Database['public']['Functions'][Name]['Args'],
): Promise<Record<string, unknown>> {
  const { data, error } = (await client.rpc(name, args)) as unknown as {
    data: unknown;
    error: { message: string } | null;
  };
  if (error !== null) throw new Error(error.message);
  return (data ?? {}) as Record<string, unknown>;
}

export async function replyToComment(client: Client, commentId: string, body: string) {
  return rpc(client, 'reply_to_comment', { p_comment_id: commentId, p_body: body });
}

export async function rejectComment(client: Client, commentId: string, reason: string) {
  return rpc(client, 'reject_comment', { p_comment_id: commentId, p_reason: reason });
}

export async function applyCommentPatch(
  client: Client,
  commentId: string,
  expectedRevisionNo: number,
) {
  return rpc(client, 'apply_comment_patch', {
    p_comment_id: commentId,
    p_expected_revision_no: expectedRevisionNo,
  });
}

export async function recordAssumption(client: Client, rootCommentId: string, text: string) {
  return rpc(client, 'record_explicit_assumption', {
    p_root_comment_id: rootCommentId,
    p_text: text,
  });
}
