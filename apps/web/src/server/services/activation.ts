import 'server-only';

import type { Database } from '@meridian/core/database';
import type { ActivationResponse } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAgent } from '@/server/repositories/agents';

type Client = SupabaseClient<Database>;

/**
 * Activation is the release pointer, and rollback is the same operation aimed at an older
 * approved version. Nothing is destroyed by rolling back, and historical executions keep the
 * `agent_version_id` they actually ran.
 */
export async function activateVersion(
  client: Client,
  agentId: string,
  agentVersionId: string,
): Promise<ActivationResponse> {
  const before = await getAgent(client, agentId);
  const { data, error } = await client.rpc('activate_agent_version', {
    p_agent_id: agentId,
    p_agent_version_id: agentVersionId,
  });
  if (error !== null) throw new Error(error.message);
  const result = (data ?? {}) as Record<string, unknown>;
  const after = await getAgent(client, agentId);

  return {
    agentId,
    activeAgentVersionId: after.activeAgentVersionId,
    previousActiveAgentVersionId:
      (result['previousActiveAgentVersionId'] as string | null | undefined) ??
      before.activeAgentVersionId,
    status: after.status,
  };
}
