import 'server-only';

import type { Database } from '@meridian/core/database';
import type { Agent, AgentStatus } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'agent_id, whiteboard_id, deployment_key, name, status, active_agent_version_id, created_at';

type Row = {
  agent_id: string;
  whiteboard_id: string;
  deployment_key: string;
  name: string;
  status: string;
  active_agent_version_id: string | null;
  created_at: string;
};

function toAgent(row: Row): Agent {
  return {
    agentId: row.agent_id,
    whiteboardId: row.whiteboard_id,
    deploymentKey: row.deployment_key,
    name: row.name,
    status: row.status as AgentStatus,
    activeAgentVersionId: row.active_agent_version_id,
    createdAt: row.created_at,
  };
}

export async function listAgents(client: Client, whiteboardId?: string): Promise<Agent[]> {
  let query = client.from('agents').select(COLUMNS).order('created_at', { ascending: false });
  if (whiteboardId !== undefined) query = query.eq('whiteboard_id', whiteboardId);
  const { data, error } = await query;
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toAgent(row));
}

export async function getAgent(client: Client, agentId: string): Promise<Agent> {
  const { data, error } = await client
    .from('agents')
    .select(COLUMNS)
    .eq('agent_id', agentId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('AGENT');
  return toAgent(data);
}
