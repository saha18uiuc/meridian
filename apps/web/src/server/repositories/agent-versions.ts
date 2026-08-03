import 'server-only';

import type { Database } from '@meridian/core/database';
import type { AgentVersion, AgentVersionStatus } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NotFoundError } from '@/server/repositories/whiteboards';

type Client = SupabaseClient<Database>;

const COLUMNS =
  'agent_version_id, agent_id, spec_id, version_no, parent_agent_version_id, status, code_path, git_commit_sha, build_manifest_json, created_at, approved_at';

type Row = Database['public']['Tables']['agent_versions']['Row'];

function toVersion(row: Row): AgentVersion {
  return {
    agentVersionId: row.agent_version_id,
    agentId: row.agent_id,
    specId: row.spec_id,
    versionNo: row.version_no,
    parentAgentVersionId: row.parent_agent_version_id,
    status: row.status as AgentVersionStatus,
    codePath: row.code_path,
    gitCommitSha: row.git_commit_sha,
    buildManifestJson: (row.build_manifest_json ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export async function listAgentVersions(client: Client, agentId: string): Promise<AgentVersion[]> {
  const { data, error } = await client
    .from('agent_versions')
    .select(COLUMNS)
    .eq('agent_id', agentId)
    .order('version_no', { ascending: false });
  if (error !== null) throw new Error(error.message);
  return (data ?? []).map((row) => toVersion(row as Row));
}

export async function getAgentVersion(
  client: Client,
  agentVersionId: string,
): Promise<AgentVersion> {
  const { data, error } = await client
    .from('agent_versions')
    .select(COLUMNS)
    .eq('agent_version_id', agentVersionId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new NotFoundError('AGENT_VERSION');
  return toVersion(data as Row);
}
