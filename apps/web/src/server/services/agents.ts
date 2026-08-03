import 'server-only';

import type { Database } from '@meridian/core/database';
import type { Agent, AgentStatus, CreateAgentRequest } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAgent, listAgents } from '@/server/repositories/agents';
import { createServiceClient } from '@/server/supabase/service-client';
import { assertOwner, ownerOfAgent, ownerOfBoard } from '@/server/services/ownership';

type Client = SupabaseClient<Database>;

export async function listAgentsForUser(client: Client, whiteboardId?: string): Promise<Agent[]> {
  return listAgents(client, whiteboardId);
}

export async function createAgent(client: Client, request: CreateAgentRequest) {
  const { data, error } = await client.rpc('create_agent', {
    p_whiteboard_id: request.whiteboardId,
    p_deployment_key: request.deploymentKey,
    p_name: request.name,
  });
  if (error !== null) throw new Error(error.message);
  return (data ?? {}) as Record<string, unknown>;
}

/**
 * Status is a guarded UPDATE rather than an RPC, because the lifecycle trigger already owns the
 * legal transition set. Ownership is re-derived with the user client before the service client
 * touches anything, and `active → paused → active` is deliberately allowed.
 */
export async function setAgentStatus(
  userClient: Client,
  userId: string,
  agentId: string,
  status: AgentStatus,
): Promise<{ agentId: string; status: AgentStatus }> {
  assertOwner((await ownerOfAgent(userClient, agentId)).ownerId, userId, 'AGENT');
  const service = createServiceClient();
  // An archived agent may not name a release — `ck_agents_archived_has_no_pointer` — so retiring
  // one has to retire its pointer in the same statement. Doing it in two would leave a window in
  // which the agent is archived and still resolvable, and would fail outright as written.
  const { error } = await service
    .from('agents')
    .update(status === 'archived' ? { status, active_agent_version_id: null } : { status })
    .eq('agent_id', agentId);
  if (error !== null) throw new Error(error.message);
  const agent = await getAgent(userClient, agentId);
  return { agentId: agent.agentId, status: agent.status };
}

export async function requireOwnedBoardForAgent(
  client: Client,
  userId: string,
  whiteboardId: string,
): Promise<void> {
  assertOwner(await ownerOfBoard(client, whiteboardId), userId, 'WHITEBOARD');
}
