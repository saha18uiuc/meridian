import 'server-only';

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database, Json } from '@meridian/core/database';
import { sha256Hex } from '@meridian/core/hashing';
import type {
  EvalRunStatus,
  EvalRunStatusResponse,
  StartEvalRunRequest,
  StartEvalRunResponse,
} from '@meridian/core/schemas';
import { DEFAULT_CASE_DIR, loadEvalCases } from '@meridian/evals';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAgentVersion } from '@/server/repositories/agent-versions';
import { createServiceClient } from '@/server/supabase/service-client';

/**
 * Enqueue and report on an eval run.
 *
 * Enqueuing means writing one `queued` execution per case and returning. The suite itself is run by
 * `pnpm evals`, never inside the request (decision 25): fifteen cases take minutes, and an HTTP
 * handler that outlives its response has no guarantee of finishing. The identity of a run is the
 * `evalRunId` recorded in each execution's `input_ref_json`, which is also what the harness derives
 * its idempotency key from — so the CLI picks up exactly the rows this function created rather than
 * making a second, parallel set.
 */

type Client = SupabaseClient<Database>;

interface EvalRunRow {
  execution_id: string;
  case_key: string | null;
  status: string;
  input_ref_json: Json;
  diff_summary_json: Json;
}

const RUN_COLUMNS = 'execution_id, case_key, status, input_ref_json, diff_summary_json';

/** `sha256('eval' | evalRunId | caseKey)`, byte-for-byte what `runCase` computes. */
export function evalIdempotencyKey(evalRunId: string, caseKey: string): string {
  return sha256Hex(['eval', evalRunId, caseKey].join('|'));
}

function evalRunIdOf(row: Pick<EvalRunRow, 'input_ref_json'>): string | null {
  const ref = row.input_ref_json as { evalRunId?: unknown } | null;
  return typeof ref?.evalRunId === 'string' ? ref.evalRunId : null;
}

async function unfinishedRunId(client: Client, agentVersionId: string): Promise<string | null> {
  const { data, error } = await client
    .from('executions')
    .select(RUN_COLUMNS)
    .eq('agent_version_id', agentVersionId)
    .eq('run_type', 'eval')
    .in('status', ['queued', 'running']);
  if (error !== null) throw new Error(error.message);
  for (const row of data) {
    const id = evalRunIdOf(row);
    if (id !== null) return id;
  }
  return null;
}

export interface StartEvalRunOptions {
  repoRoot?: string;
  service?: Client;
  /** Injected so the enqueue test does not depend on how many case files happen to exist. */
  caseKeysOverride?: readonly string[];
}

export async function startEvalRun(
  userClient: Client,
  agentVersionId: string,
  request: StartEvalRunRequest,
  options: StartEvalRunOptions = {},
): Promise<StartEvalRunResponse> {
  // Ownership first, through the caller's own client: the service client below bypasses RLS, so it
  // must never be the thing that decides whether this caller may see this version.
  const version = await getAgentVersion(userClient, agentVersionId);

  const existing = await unfinishedRunId(userClient, agentVersionId);
  if (existing !== null) {
    const { count, error } = await userClient
      .from('executions')
      .select('execution_id', { count: 'exact', head: true })
      .eq('agent_version_id', agentVersionId)
      .eq('run_type', 'eval');
    if (error !== null) throw new Error(error.message);
    return { evalRunId: existing, status: 'queued', caseCount: count ?? 0, wasExisting: true };
  }

  const available =
    options.caseKeysOverride ??
    loadEvalCases(join(options.repoRoot ?? process.cwd(), DEFAULT_CASE_DIR)).map(
      (entry) => entry.caseKey,
    );
  const known = new Set(available);
  const selected = request.caseKeys ?? available;
  const unknown = selected.filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`UNKNOWN_EVAL_CASE: ${unknown.join(', ')}`);

  const service = options.service ?? createServiceClient();
  const evalRunId = randomUUID();

  for (const caseKey of selected) {
    const { error } = await service.rpc('create_execution', {
      p_agent_id: version.agentId,
      p_agent_version_id: agentVersionId,
      p_run_type: 'eval',
      p_case_key: caseKey,
      p_business_key: null as unknown as string,
      p_temporal_workflow_id: null as unknown as string,
      p_idempotency_key: evalIdempotencyKey(evalRunId, caseKey),
      p_input_ref: { evalRunId, caseKey, enqueuedBy: 'api' } as unknown as Json,
    });
    if (error !== null) throw new Error(`create_execution(${caseKey}): ${error.message}`);
  }

  return { evalRunId, status: 'queued', caseCount: selected.length, wasExisting: false };
}

/** `running` while anything is unfinished; otherwise the worst terminal state observed. */
function aggregate(statuses: readonly string[]): EvalRunStatus {
  if (statuses.length === 0) return 'queued';
  if (statuses.some((status) => status === 'queued' || status === 'running')) return 'running';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('failed')) return 'failed';
  return 'passed';
}

export async function getEvalRun(
  client: Client,
  agentVersionId: string,
  evalRunId: string,
): Promise<EvalRunStatusResponse> {
  const { data, error } = await client
    .from('executions')
    .select(RUN_COLUMNS)
    .eq('agent_version_id', agentVersionId)
    .eq('run_type', 'eval')
    .order('created_at', { ascending: true });
  if (error !== null) throw new Error(error.message);

  const rows = data.filter((row) => evalRunIdOf(row) === evalRunId);
  if (rows.length === 0) throw new Error('EVAL_RUN_NOT_FOUND');

  const cases = rows.map((row) => {
    const diff = row.diff_summary_json as { failureClass?: unknown } | null;
    return {
      caseKey: row.case_key ?? '',
      executionId: row.execution_id,
      status: row.status as EvalRunStatus,
      failureClass: typeof diff?.failureClass === 'string' ? diff.failureClass : null,
    };
  });

  return {
    evalRunId,
    agentVersionId,
    status: aggregate(cases.map((entry) => entry.status)),
    passed: cases.filter((entry) => entry.status === 'passed').length,
    failed: cases.filter((entry) => entry.status === 'failed' || entry.status === 'error').length,
    pending: cases.filter((entry) => entry.status === 'queued' || entry.status === 'running')
      .length,
    cases,
  };
}
