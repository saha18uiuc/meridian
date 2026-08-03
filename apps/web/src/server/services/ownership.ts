import 'server-only';

import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

/**
 * Every service-role call in this system is preceded by an ownership re-derivation performed
 * with the **user** client. The service client bypasses RLS by design, so the only thing keeping
 * a privileged statement honest is proving, first, that the caller can already see the row.
 *
 * Ownership always resolves back to `whiteboards.owner_id`: agents, versions, and executions
 * carry lineage columns rather than a duplicated owner, so there is exactly one place a change
 * of ownership would have to be made.
 */

export async function ownerOfBoard(client: Client, whiteboardId: string): Promise<string> {
  const { data, error } = await client
    .from('whiteboards')
    .select('owner_id')
    .eq('whiteboard_id', whiteboardId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('WHITEBOARD');
  return data.owner_id;
}

export async function ownerOfAgent(
  client: Client,
  agentId: string,
): Promise<{ ownerId: string; whiteboardId: string }> {
  const { data, error } = await client
    .from('agents')
    .select('whiteboard_id')
    .eq('agent_id', agentId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('AGENT');
  return {
    ownerId: await ownerOfBoard(client, data.whiteboard_id),
    whiteboardId: data.whiteboard_id,
  };
}

export async function ownerOfAgentVersion(
  client: Client,
  agentVersionId: string,
): Promise<{ ownerId: string; agentId: string; whiteboardId: string }> {
  const { data, error } = await client
    .from('agent_versions')
    .select('agent_id, whiteboard_id')
    .eq('agent_version_id', agentVersionId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('AGENT_VERSION');
  return {
    ownerId: await ownerOfBoard(client, data.whiteboard_id),
    agentId: data.agent_id,
    whiteboardId: data.whiteboard_id,
  };
}

export async function ownerOfExecution(
  client: Client,
  executionId: string,
): Promise<{ ownerId: string; agentId: string; agentVersionId: string; whiteboardId: string }> {
  const { data, error } = await client
    .from('executions')
    .select('agent_id, agent_version_id')
    .eq('execution_id', executionId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('EXECUTION');
  const agent = await ownerOfAgent(client, data.agent_id);
  return {
    ownerId: agent.ownerId,
    agentId: data.agent_id,
    agentVersionId: data.agent_version_id,
    whiteboardId: agent.whiteboardId,
  };
}

export async function ownerOfComment(
  client: Client,
  commentId: string,
): Promise<{ ownerId: string; whiteboardId: string }> {
  const { data, error } = await client
    .from('comments')
    .select('whiteboard_id')
    .eq('comment_id', commentId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('COMMENT');
  return {
    ownerId: await ownerOfBoard(client, data.whiteboard_id),
    whiteboardId: data.whiteboard_id,
  };
}

/** Compare the re-derived owner against the authenticated user before anything privileged runs. */
export function assertOwner(ownerId: string, userId: string, what: string): void {
  if (ownerId !== userId) throw new NotFoundError(what);
}
