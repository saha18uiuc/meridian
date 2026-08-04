import { readFileSync } from 'node:fs';
import { AGENT_REGISTRY } from '@meridian/generated-agents';
import { resolveAgent } from '@meridian/agent-kit';
import {
  assembleCanonicalGraph,
  deriveCanvasHash,
  workerEnv,
  type CanonicalGraph,
} from '@meridian/core';
import type { Json } from '@meridian/core/database';
import type { BuildManifest, PrimitiveType } from '@meridian/core/schemas';
import {
  classify,
  isGreen,
  firstActionableFailure,
  nextRepairAction,
  runSuite,
  stopsRepairLoop,
  summarize,
  type EvalReport,
} from '@meridian/evals';
import { deploymentForKey } from './deployments.js';
import { loadOpsEnv } from './env.js';
import { extractBusinessKey } from './intake/extract-business-key.js';
import { flag, optionalArg, parseArgs } from './lib/args.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';

/**
 * `pnpm evals --agent-version <id>`.
 *
 * Runs out of request, never inside one. The HTTP route enqueues and returns 202; this process is
 * what picks the work up, which is why a fifteen-case suite cannot hold a web request open.
 *
 * On failure it classifies, and on a `policy_gap` classification it records the gap against the
 * board and exits non-zero **without** attempting a repair. That stop is the whole point: a repair
 * loop that continues past a policy gap is a loop that invents business policy.
 */

export const EXIT_FAILED = 1;
export const EXIT_POLICY_GAP = 5;

interface VersionRow {
  agent_version_id: string;
  agent_id: string;
  version_no: number;
  spec_id: string;
  spec_hash: string;
  git_commit_sha: string | null;
  build_manifest_json: unknown;
  status: string;
  agents:
    | { deployment_key: string; whiteboard_id: string }
    | { deployment_key: string; whiteboard_id: string }[];
}

function unwrap<T>(value: T | T[] | null): T | null {
  if (value === null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function loadVersion(
  agentVersionId: string | undefined,
  deploymentKey: string,
): Promise<VersionRow> {
  const client = opsClient();
  // Two round trips rather than one embedded select. `agents` and `agent_versions` reference each
  // other — the version names its agent for lineage, and the agent names its active version — so
  // PostgREST refuses to guess which relationship an embed means, and a name hint would pin this
  // query to a constraint name that a later migration is free to rename. Two plain reads say the
  // same thing and cannot become ambiguous.
  const columns =
    'agent_version_id, agent_id, version_no, spec_id, git_commit_sha, build_manifest_json, status, whiteboard_id';

  const found =
    agentVersionId === undefined
      ? await (async () => {
          const agent = await client
            .from('agents')
            .select('agent_id')
            .eq('deployment_key', deploymentKey)
            .maybeSingle();
          if (agent.error !== null) throw new Error(agent.error.message);
          if (agent.data === null) throw new Error(`no agent for deployment key ${deploymentKey}`);
          return client
            .from('agent_versions')
            .select(columns)
            .eq('agent_id', agent.data.agent_id)
            .order('version_no', { ascending: false })
            .limit(1)
            .maybeSingle();
        })()
      : await client
          .from('agent_versions')
          .select(columns)
          .eq('agent_version_id', agentVersionId)
          .maybeSingle();

  if (found.error !== null) throw new Error(found.error.message);
  if (found.data === null)
    throw new Error('no agent version matched; reserve and finalize one first');

  const [agent, spec] = await Promise.all([
    client
      .from('agents')
      .select('deployment_key, whiteboard_id')
      .eq('agent_id', found.data.agent_id)
      .single(),
    // `spec_hash` lives on the frozen spec, not on the version: the version points at a contract,
    // and the contract owns its hash. Reading it here keeps the single source intact.
    client.from('frozen_specs').select('spec_hash').eq('spec_id', found.data.spec_id).single(),
  ]);
  if (agent.error !== null) throw new Error(agent.error.message);
  if (spec.error !== null) throw new Error(spec.error.message);

  return { ...found.data, spec_hash: spec.data.spec_hash, agents: agent.data };
}

/**
 * Record a policy gap against the board the version was generated from.
 *
 * The board snapshot has to be assembled here rather than inside the RPC, because the RPC's job is
 * to be a transaction, not to know how a canonical graph is built. The hash is derived by the one
 * canonicalizer, never re-implemented.
 */
async function recordPolicyGap(
  version: VersionRow,
  report: EvalReport,
  caseKey: string,
): Promise<string> {
  const client = opsClient();
  const agent = unwrap(version.agents);
  if (agent === null) throw new Error('agent version has no agent');

  const evalExecutionId =
    report.cases.find((entry) => entry.caseKey === caseKey)?.executionId ?? null;
  if (evalExecutionId === null) {
    // The RPC checks that the execution belongs to this version, so there is nothing sensible to
    // send when the case never produced a row. Failing here beats sending a null and reading back
    // an opaque constraint error.
    throw new Error(`case ${caseKey} produced no eval execution to attach the gap to`);
  }

  const [board, nodes, edges] = await Promise.all([
    client
      .from('whiteboards')
      .select('whiteboard_id, title, status, revision_no, owner_id')
      .eq('whiteboard_id', agent.whiteboard_id)
      .single(),
    client
      .from('whiteboard_nodes')
      .select('node_id, primitive_type, title, node_data_json, position_x, position_y, row_version')
      .eq('whiteboard_id', agent.whiteboard_id),
    client
      .from('whiteboard_edges')
      .select(
        'edge_id, source_node_id, target_node_id, label, condition_json, priority, row_version',
      )
      .eq('whiteboard_id', agent.whiteboard_id),
  ]);
  if (board.error !== null) throw new Error(board.error.message);
  if (nodes.error !== null) throw new Error(nodes.error.message);
  if (edges.error !== null) throw new Error(edges.error.message);

  const graph = assembleCanonicalGraph(
    {
      whiteboardId: board.data.whiteboard_id,
      title: board.data.title,
      status: board.data.status as CanonicalGraph['metadata']['status'],
      revisionNo: board.data.revision_no,
    },
    nodes.data.map((row) => ({
      nodeId: row.node_id,
      primitiveType: row.primitive_type as PrimitiveType,
      title: row.title,
      data: (row.node_data_json ?? {}) as Record<string, unknown>,
      position: { x: row.position_x, y: row.position_y },
      rowVersion: row.row_version,
    })),
    edges.data.map((row) => ({
      edgeId: row.edge_id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      label: row.label,
      condition: (row.condition_json ?? null) as Record<string, unknown> | null,
      priority: row.priority,
      rowVersion: row.row_version,
    })),
  );

  const { data, error } = await client.rpc('record_policy_gap', {
    p_actor_user_id: board.data.owner_id,
    p_whiteboard_id: agent.whiteboard_id,
    p_agent_version_id: version.agent_version_id,
    p_eval_execution_id: evalExecutionId,
    p_failure_key: `${caseKey}_policy_gap`,
    p_snapshot: graph as unknown as Json,
    p_snapshot_hash: deriveCanvasHash(graph),
    p_source_revision_no: board.data.revision_no,
  });
  if (error !== null) throw new Error(`record_policy_gap failed: ${error.message}`);
  return (data as unknown as { commentId: string }).commentId;
}

export async function runEvals(options: {
  agentVersionId?: string | undefined;
  deploymentKey: string;
  caseDir?: string | undefined;
  only?: readonly string[] | undefined;
}): Promise<{ report: EvalReport; policyGapCommentId: string | null }> {
  loadOpsEnv();
  const env = workerEnv();
  const version = await loadVersion(options.agentVersionId, options.deploymentKey);
  const agent = unwrap(version.agents);
  if (agent === null) throw new Error('agent version has no agent');

  const manifest = version.build_manifest_json as BuildManifest | null;
  const definition = resolveAgent(AGENT_REGISTRY, agent.deployment_key, version.version_no);

  // Which corpus and which mailbox. Taken from the deployment rather than defaulted, so pointing
  // the harness at the second example runs the second example's mail instead of silently replaying
  // the first one's against it.
  const deployment = deploymentForKey(agent.deployment_key);
  const caseDir = options.caseDir ?? deployment?.evalCaseDir ?? undefined;

  const report = await runSuite({
    supabase: opsClient(),
    repoRoot: repoPath(),
    version: {
      agentId: version.agent_id,
      agentVersionId: version.agent_version_id,
      deploymentKey: agent.deployment_key,
      versionNo: version.version_no,
      specHash: version.spec_hash,
      gitCommitSha: version.git_commit_sha,
      buildManifest: manifest,
    },
    definition,
    capabilities: manifest?.capabilities ?? [
      'mail.read',
      'mail.send',
      'document.extract',
      'human.handoff',
    ],
    toolkitVersion: env.COMPOSIO_GMAIL_TOOLKIT_VERSION,
    operatorEmail: env.OPERATOR_EMAIL,
    maxConcurrency: env.AGENT_MAX_CONCURRENCY,
    ...(caseDir === undefined ? {} : { caseDir }),
    ...(deployment === undefined ? {} : { fixturesRoot: deployment.fixturesRoot }),
    ...(options.only === undefined ? {} : { only: options.only }),
    extractBusinessKey: (source) => {
      const result = (deployment?.extractBusinessKey ?? extractBusinessKey)(source);
      return result.kind === 'ok'
        ? { kind: 'ok' as const, businessKey: result.businessKey }
        : { kind: result.kind };
    },
    // Fault injection is declared here, next to the cases that need it, rather than encoded in the
    // fixtures: a fixture that is secretly broken teaches the wrong lesson about the fixture.
    faults: {
      'case-11': { transientExtractionFailures: 1 },
      'case-15': { crashAfterDispatch: true },
    },
    evalRunId: crypto.randomUUID(),
  });

  const failure = firstActionableFailure(report);
  const action = nextRepairAction({
    green: isGreen(report),
    failure:
      failure === null
        ? null
        : {
            caseKey: failure.caseKey,
            failureClass: failure.failureClass ?? classify({ failures: failure.failures }),
          },
    iterationsUsed: 0,
  });

  // Only a policy gap is written back to the board here. A repairable failure is handed to the
  // operator, who invokes the repair skill; this process never reserves a version on its own.
  if (action.kind !== 'record_policy_gap') return { report, policyGapCommentId: null };

  const commentId = await recordPolicyGap(version, report, action.caseKey);
  return { report, policyGapCommentId: commentId };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    const only = optionalArg(args, 'only');
    const { report, policyGapCommentId } = await runEvals({
      agentVersionId: optionalArg(args, 'agent-version'),
      deploymentKey: optionalArg(args, 'agent') ?? 'inbound-import-receiving',
      caseDir: optionalArg(args, 'cases'),
      only: only === undefined ? undefined : only.split(',').map((key) => key.trim()),
    });

    process.stdout.write(`${summarize(report)}\n`);
    if (flag(args, 'json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }

    if (policyGapCommentId !== null) {
      process.stderr.write(
        `\nPolicy gap recorded as comment ${policyGapCommentId}. The repair loop stops here: the\n` +
          'specification does not decide this case, so answer it on the board and freeze a new spec.\n',
      );
      process.exitCode = EXIT_POLICY_GAP;
      return;
    }
    process.exitCode = isGreen(report) ? 0 : EXIT_FAILED;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = EXIT_FAILED;
  }
}

/** Exposed so a repair driver can honour the bound without re-reading the environment. */
export function repairIterationsRemaining(iteration: number, max: number): number {
  return Math.max(0, max - iteration);
}

export { stopsRepairLoop };

/** Read a checked-in manifest without going through the database, for the skill's verify step. */
export function readManifest(codePath: string): BuildManifest {
  return JSON.parse(readFileSync(repoPath(`${codePath}/manifest.json`), 'utf8')) as BuildManifest;
}
