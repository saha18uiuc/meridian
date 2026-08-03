import { readFileSync } from 'node:fs';
import {
  assembleCanonicalGraph,
  compileSpec,
  deriveCanvasHash,
  deriveSpecHash,
  type CanonicalGraph,
} from '@meridian/core';
import { BuildManifestSchema } from '@meridian/core/schemas';
import type { Database, Json } from '@meridian/core/database';
import { workerEnv } from '@meridian/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadOpsEnv, optionalEnv, requireEnv } from './env.js';
import { finalizeAgentVersion } from './finalize-agent-version.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';

/**
 * Take the seeded demo board all the way to a released agent: freeze → agent → version → commit →
 * approved → active.
 *
 * This is what stands in for the operator during `pnpm demo` and `pnpm verify:e2e`. Every link goes
 * through the same RPC the application uses, so if the chain cannot be built here it cannot be built
 * in the product either — which is the point of doing it this way rather than inserting rows.
 *
 * The one shortcut is the Git SHA. The real path is `pnpm agent:finalize`, which stages the
 * generated files, makes a commit, and verifies the commit object before recording it. Here the code
 * for v001 is already committed, so the current HEAD is named instead of a new commit being created
 * — a demo must not write to the repository's history as a side effect of being run.
 *
 * Re-running is safe: an agent that already holds an active version is left exactly as it is.
 */

const DEPLOYMENT_KEY = 'inbound-import-receiving';
const CODE_PATH = 'generated-agents/inbound-import-receiving/v001';

export interface ReleaseResult {
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  specId: string;
  specHash: string;
  gitCommitSha: string;
  created: boolean;
}

/**
 * A client acting as the demo user, not as the service role.
 *
 * `create_agent`, `create_agent_version`, `transition_agent_version`, and `activate_agent_version`
 * are operator actions: they read `auth.uid()` and are not granted to the service role at all.
 * Signing in is therefore not ceremony, it is the only way to call them.
 */
async function operatorClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  // The anon key is read from the environment rather than from `workerEnv()`, which does not carry
  // it: the worker never signs a user in, so its schema has no reason to know about it.
  const client = createClient<Database>(
    workerEnv().NEXT_PUBLIC_SUPABASE_URL,
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error !== null) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return client;
}

async function readGraph(
  service: SupabaseClient<Database>,
  whiteboardId: string,
): Promise<{ graph: CanonicalGraph; canvasHash: string; revisionNo: number }> {
  const board = await service
    .from('whiteboards')
    .select('whiteboard_id, title, status, revision_no')
    .eq('whiteboard_id', whiteboardId)
    .single();
  if (board.error !== null) throw new Error(`could not read board: ${board.error.message}`);

  const nodes = await service
    .from('whiteboard_nodes')
    .select('node_id, primitive_type, title, node_data_json, position_x, position_y, row_version')
    .eq('whiteboard_id', whiteboardId);
  if (nodes.error !== null) throw new Error(`could not read nodes: ${nodes.error.message}`);

  const edges = await service
    .from('whiteboard_edges')
    .select(
      'edge_id, source_node_id, target_node_id, label, condition_json, priority, row_version',
    )
    .eq('whiteboard_id', whiteboardId);
  if (edges.error !== null) throw new Error(`could not read edges: ${edges.error.message}`);

  const graph = assembleCanonicalGraph(
    {
      whiteboardId: board.data.whiteboard_id,
      title: board.data.title,
      status: board.data.status as CanonicalGraph['metadata']['status'],
      revisionNo: board.data.revision_no,
    },
    nodes.data.map((node) => ({
      nodeId: node.node_id,
      primitiveType: node.primitive_type as CanonicalGraph['nodes'][number]['primitiveType'],
      title: node.title,
      data: node.node_data_json as Record<string, unknown>,
      position: { x: node.position_x, y: node.position_y },
      rowVersion: node.row_version,
    })),
    edges.data.map((edge) => ({
      edgeId: edge.edge_id,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      label: edge.label,
      condition: edge.condition_json as Record<string, unknown> | null,
      priority: edge.priority,
      rowVersion: edge.row_version,
    })),
  );

  return { graph, canvasHash: deriveCanvasHash(graph), revisionNo: board.data.revision_no };
}

export async function releaseDemoAgent(options: {
  whiteboardId: string;
  email: string;
  password: string;
}): Promise<ReleaseResult> {
  const service = opsClient();
  const operator = await operatorClient(options.email, options.password);

  const existing = await service
    .from('agents')
    .select('agent_id, active_agent_version_id')
    .eq('deployment_key', DEPLOYMENT_KEY)
    .maybeSingle();
  if (existing.error !== null) throw new Error(`could not read agents: ${existing.error.message}`);
  if (existing.data !== null && existing.data.active_agent_version_id !== null) {
    const active = await service
      .from('agent_versions')
      .select('agent_version_id, spec_id, git_commit_sha')
      .eq('agent_version_id', existing.data.active_agent_version_id)
      .single();
    if (active.error !== null) throw new Error(`could not read version: ${active.error.message}`);
    const spec = await service
      .from('frozen_specs')
      .select('spec_hash')
      .eq('spec_id', active.data.spec_id)
      .single();
    if (spec.error !== null) throw new Error(`could not read spec: ${spec.error.message}`);
    return {
      agentId: existing.data.agent_id,
      agentVersionId: active.data.agent_version_id,
      deploymentKey: DEPLOYMENT_KEY,
      specId: active.data.spec_id,
      specHash: spec.data.spec_hash,
      gitCommitSha: active.data.git_commit_sha ?? '',
      created: false,
    };
  }

  const manifest = BuildManifestSchema.parse(
    JSON.parse(readFileSync(repoPath(CODE_PATH, 'manifest.json'), 'utf8')),
  );

  const { graph, canvasHash, revisionNo } = await readGraph(service, options.whiteboardId);
  const compiled = compileSpec({
    graph,
    specId: manifest.specId,
    specVersion: manifest.specVersion,
    name: graph.metadata.title,
    canvasHash,
    // The demo board is frozen without a review round on purpose: the demo narrative runs the review
    // in the UI, and manufacturing one here would put a second, invisible session in the history.
    // None of these five inputs reach the hash, so the result still matches the committed snapshot.
    reviewSessionIds: [],
    frozenAt: new Date().toISOString(),
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: true,
    assumptions: [],
    knownGaps: [],
  });
  if ('errors' in compiled) {
    throw new Error(`the demo board does not compile: ${JSON.stringify(compiled.errors, null, 2)}`);
  }
  const specHash = deriveSpecHash(compiled.specJson);

  // Refusing here rather than freezing anyway is the whole reason this check exists: a spec that
  // hashes differently from the committed snapshot means the board and the generated code have
  // drifted apart, and every downstream claim about lineage would be describing a pairing that
  // never existed.
  if (specHash !== manifest.specHash) {
    throw new Error(
      `the seeded board yields ${specHash} but ${CODE_PATH}/manifest.json names ${manifest.specHash}; ` +
        'regenerate the fixtures or re-seed the board',
    );
  }

  const frozen = await service.rpc('freeze_whiteboard_spec', {
    p_actor_user_id: (await operator.auth.getUser()).data.user?.id ?? '',
    p_whiteboard_id: options.whiteboardId,
    p_expected_revision_no: revisionNo,
    p_canvas_json: graph as unknown as Json,
    p_canvas_hash: canvasHash,
    p_spec_json: compiled.specJson as unknown as Json,
    p_spec_hash: specHash,
    p_unresolved_comment_ids: [],
    p_ack_blockers: false,
    p_ack_stale_review: true,
  });
  if (frozen.error !== null) throw new Error(`freeze_whiteboard_spec: ${frozen.error.message}`);
  const specId = (frozen.data as unknown as { specId: string }).specId;

  const agentId =
    existing.data?.agent_id ??
    (
      await (async () => {
        const created = await operator.rpc('create_agent', {
          p_whiteboard_id: options.whiteboardId,
          p_deployment_key: DEPLOYMENT_KEY,
          p_name: 'Inbound Import Receiving',
        });
        if (created.error !== null) throw new Error(`create_agent: ${created.error.message}`);
        return created.data as unknown as { agentId: string };
      })()
    ).agentId;

  const version = await operator.rpc('create_agent_version', {
    p_agent_id: agentId,
    p_spec_id: specId,
    // v001 has no parent, and the RPC is typed as taking a UUID rather than an optional one.
    p_parent_agent_version_id: null as unknown as string,
  });
  if (version.error !== null) throw new Error(`create_agent_version: ${version.error.message}`);
  const agentVersionId = (version.data as unknown as { agentVersionId: string }).agentVersionId;

  // The real finalize path, not a shortcut around it: it stages only the generated files, makes one
  // local commit, verifies that commit's *object* with `git ls-tree` and `git show`, checks the
  // committed snapshot re-canonicalizes to the spec hash, and only then records the SHA. Calling it
  // here means the demo exercises the lineage guarantee rather than asserting it.
  const finalized = await finalizeAgentVersion(agentVersionId);
  const gitCommitSha = finalized.gitCommitSha;

  for (const status of ['evaluating', 'approved'] as const) {
    const moved = await operator.rpc('transition_agent_version', {
      p_agent_version_id: agentVersionId,
      p_status: status,
    });
    if (moved.error !== null) {
      throw new Error(`transition to ${status}: ${moved.error.message}`);
    }
  }

  const activated = await operator.rpc('activate_agent_version', {
    p_agent_id: agentId,
    p_agent_version_id: agentVersionId,
  });
  if (activated.error !== null) {
    throw new Error(`activate_agent_version: ${activated.error.message}`);
  }

  return {
    agentId,
    agentVersionId,
    deploymentKey: DEPLOYMENT_KEY,
    specId,
    specHash,
    gitCommitSha,
    created: true,
  };
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  loadOpsEnv();
  const service = opsClient();
  const email = optionalEnv('DEMO_USER_EMAIL', 'demo@meridian.local');
  const { data, error } = await service
    .from('whiteboards')
    .select('whiteboard_id')
    .eq('title', 'Inbound Import Receiving')
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new Error('no seeded board; run `pnpm seed` first');

  const result = await releaseDemoAgent({
    whiteboardId: data.whiteboard_id,
    email,
    password: optionalEnv('DEMO_USER_PASSWORD', 'meridian-demo-password'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
