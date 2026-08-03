import 'server-only';

import type { Database } from '@meridian/core/database';
import type {
  AgentVersionStatus,
  ReserveVersionRequest,
  ReserveVersionResponse,
} from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAgent } from '@/server/repositories/agents';
import { getAgentVersion } from '@/server/repositories/agent-versions';

type Client = SupabaseClient<Database>;

/**
 * The literal command an operator runs in Cursor or Codex. This is a string, deliberately: the
 * HTTP layer reserves a version row and hands back instructions. It never spawns a coding agent,
 * never writes a file, never runs `git`, and never calls a model (A14).
 */
export function buildOperatorCommand(input: {
  deploymentKey: string;
  agentVersionId: string;
  specId: string;
  versionNo: number;
  codePath: string;
}): string {
  return [
    '/goal Generate the Meridian agent for this reserved version.',
    `deploymentKey=${input.deploymentKey}`,
    `agentVersionId=${input.agentVersionId}`,
    `specId=${input.specId}`,
    `versionNo=${input.versionNo}`,
    `codePath=${input.codePath}`,
    'skill=.codex/skills/spec-to-agent/SKILL.md',
  ].join(' ');
}

export async function reserveVersion(
  client: Client,
  agentId: string,
  request: ReserveVersionRequest,
): Promise<ReserveVersionResponse> {
  const agent = await getAgent(client, agentId);
  const { data, error } = await client.rpc('create_agent_version', {
    p_agent_id: agentId,
    p_spec_id: request.specId,
    p_parent_agent_version_id: request.parentAgentVersionId ?? (null as unknown as string),
  });
  if (error !== null) throw new Error(error.message);
  const reserved = (data ?? {}) as Record<string, unknown>;

  return {
    agentVersionId: reserved['agentVersionId'] as string,
    versionNo: reserved['versionNo'] as number,
    codePath: reserved['codePath'] as string,
    specHash: reserved['specHash'] as string,
    operatorCommand: buildOperatorCommand({
      deploymentKey: agent.deploymentKey,
      agentVersionId: reserved['agentVersionId'] as string,
      specId: request.specId,
      versionNo: reserved['versionNo'] as number,
      codePath: reserved['codePath'] as string,
    }),
  };
}

export async function transitionVersion(
  client: Client,
  agentVersionId: string,
  status: Exclude<AgentVersionStatus, 'generated'>,
) {
  const { error } = await client.rpc('transition_agent_version', {
    p_agent_version_id: agentVersionId,
    p_status: status,
  });
  if (error !== null) throw new Error(error.message);
  const version = await getAgentVersion(client, agentVersionId);
  return {
    agentVersionId: version.agentVersionId,
    status: version.status,
    approvedAt: version.approvedAt,
  };
}
