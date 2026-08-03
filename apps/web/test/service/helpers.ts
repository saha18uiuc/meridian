import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@meridian/core/database';
import {
  assembleCanonicalGraph,
  compileSpec,
  deriveCanvasHash,
  deriveSpecHash,
  type CanonicalGraph,
} from '@meridian/core';

/**
 * Fixtures for the service tests.
 *
 * These run against the real local stack, so every helper creates its own board with a unique title
 * and its own agent with a unique deployment key. Sharing a fixture across files would make the
 * order the files happen to run in part of the contract.
 */

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54521';
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const ANON_KEY = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '';

export function serviceClient(): SupabaseClient<Database> {
  return createClient<Database>(URL_, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client carrying a real user JWT, so RLS applies exactly as it does to a browser. */
export async function userClient(
  email: string,
  password: string,
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(URL_, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error !== null) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return client;
}

export async function ensureUser(email: string, password: string): Promise<string> {
  const admin = serviceClient();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error === null && created.data.user !== null) return created.data.user.id;
  const list = await admin.auth.admin.listUsers({ perPage: 200 });
  if (list.error !== null) throw new Error(list.error.message);
  const existing = list.data.users.find((user) => user.email === email);
  if (existing === undefined) throw new Error(`could not create or find ${email}`);
  return existing.id;
}

export interface TestBoard {
  whiteboardId: string;
  ownerId: string;
  revisionNo: number;
  nodeIds: string[];
}

/**
 * A three-node board that compiles: one Input, one Action, one terminal Outcome, wired in a line.
 * Anything smaller fails `NO_TERMINAL_PATH` and turns every freeze test into a compiler test.
 */
export async function createBoard(
  client: SupabaseClient<Database>,
  title = `service-${randomUUID()}`,
): Promise<TestBoard> {
  const { data: created, error } = await client.rpc('create_whiteboard', { p_title: title });
  if (error !== null) throw new Error(`create_whiteboard: ${error.message}`);
  const board = created as unknown as { whiteboardId: string; revisionNo: number };

  const input = randomUUID();
  const action = randomUUID();
  const outcome = randomUUID();

  const { data: saved, error: deltaError } = await client.rpc('save_whiteboard_delta', {
    p_whiteboard_id: board.whiteboardId,
    p_expected_revision_no: board.revisionNo,
    p_node_upserts: [
      {
        nodeId: input,
        primitiveType: 'input',
        title: 'Arrival notice email',
        data: {
          inputKind: 'event',
          sourceSystem: 'gmail',
          required: true,
          fields: [{ name: 'containerNumber', type: 'string', required: true }],
          correlationKeys: ['containerNumber'],
        },
        position: { x: 0, y: 0 },
      },
      {
        nodeId: action,
        primitiveType: 'action',
        title: 'Extract fields',
        data: {
          actor: 'agent',
          operation: 'document.extract',
          instructions: 'Read every attachment.',
          system: 'documents',
          inputs: ['attachments'],
          outputs: ['goods'],
        },
        position: { x: 260, y: 0 },
      },
      {
        nodeId: outcome,
        primitiveType: 'outcome',
        title: 'Ready to receive',
        data: { resultKind: 'ready', terminal: true },
        position: { x: 520, y: 0 },
      },
    ] as never,
    p_node_deletes: [],
    p_edge_upserts: [
      {
        edgeId: randomUUID(),
        sourceNodeId: input,
        targetNodeId: action,
        label: 'documents attached',
        priority: 1,
      },
      {
        edgeId: randomUUID(),
        sourceNodeId: action,
        targetNodeId: outcome,
        label: 'all fields present',
        priority: 1,
      },
    ] as never,
    p_edge_deletes: [],
    p_viewport: null as never,
  });
  if (deltaError !== null) throw new Error(`save_whiteboard_delta: ${deltaError.message}`);

  const { data: row, error: readError } = await client
    .from('whiteboards')
    .select('owner_id')
    .eq('whiteboard_id', board.whiteboardId)
    .single();
  if (readError !== null) throw new Error(readError.message);

  return {
    whiteboardId: board.whiteboardId,
    ownerId: row.owner_id,
    revisionNo: (saved as unknown as { revisionNo: number }).revisionNo,
    nodeIds: [input, action, outcome],
  };
}

/** Assemble the canonical snapshot the same way the server does, for tests that need its hash. */
export async function snapshotOf(
  client: SupabaseClient<Database>,
  whiteboardId: string,
): Promise<{ snapshot: CanonicalGraph; hash: string; revisionNo: number }> {
  const [board, nodes, edges] = await Promise.all([
    client
      .from('whiteboards')
      .select('whiteboard_id, title, status, revision_no')
      .eq('whiteboard_id', whiteboardId)
      .single(),
    client
      .from('whiteboard_nodes')
      .select('node_id, primitive_type, title, node_data_json, position_x, position_y, row_version')
      .eq('whiteboard_id', whiteboardId),
    client
      .from('whiteboard_edges')
      .select(
        'edge_id, source_node_id, target_node_id, label, condition_json, priority, row_version',
      )
      .eq('whiteboard_id', whiteboardId),
  ]);
  if (board.error !== null) throw new Error(board.error.message);
  if (nodes.error !== null) throw new Error(nodes.error.message);
  if (edges.error !== null) throw new Error(edges.error.message);

  const snapshot = assembleCanonicalGraph(
    {
      whiteboardId: board.data.whiteboard_id,
      title: board.data.title,
      status: board.data.status as CanonicalGraph['metadata']['status'],
      revisionNo: board.data.revision_no,
    },
    nodes.data.map((row) => ({
      nodeId: row.node_id,
      primitiveType: row.primitive_type as CanonicalGraph['nodes'][number]['primitiveType'],
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

  return { snapshot, hash: deriveCanvasHash(snapshot), revisionNo: board.data.revision_no };
}

/**
 * Freeze a real compiled spec through the real RPC.
 *
 * The spec is produced by `compileSpec`, not hand-written. A hand-written `spec_json` would drift
 * from the validation trigger the moment the compiler changed, and the resulting failure would look
 * like a bug in freeze rather than a stale fixture.
 */
export async function freezeBoard(
  service: SupabaseClient<Database>,
  ownerId: string,
  whiteboardId: string,
): Promise<{ specId: string; specHash: string }> {
  const { snapshot, hash, revisionNo } = await snapshotOf(service, whiteboardId);
  const specId = randomUUID();
  const compiled = compileSpec({
    graph: snapshot,
    specId,
    specVersion: 1,
    name: snapshot.metadata.title,
    canvasHash: hash,
    reviewSessionIds: [],
    frozenAt: new Date().toISOString(),
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: true,
    assumptions: [],
    knownGaps: [],
  });
  if ('errors' in compiled) {
    throw new Error(`the fixture board does not compile: ${JSON.stringify(compiled.errors)}`);
  }
  const specHash = deriveSpecHash(compiled.specJson);

  const { data, error } = await service.rpc('freeze_whiteboard_spec', {
    p_actor_user_id: ownerId,
    p_whiteboard_id: whiteboardId,
    p_expected_revision_no: revisionNo,
    p_canvas_json: snapshot as unknown as Json,
    p_canvas_hash: hash,
    p_spec_json: compiled.specJson as unknown as Json,
    p_spec_hash: specHash,
    p_unresolved_comment_ids: [],
    p_ack_blockers: false,
    p_ack_stale_review: true,
  });
  if (error !== null) throw new Error(`freeze_whiteboard_spec: ${error.message}`);
  return { specId: (data as unknown as { specId: string }).specId, specHash };
}

/**
 * Walk an agent all the way to active: create, version, commit, evaluate, approve, activate.
 *
 * Every gate is walked rather than short-circuited. A test that activates an unapproved version
 * proves nothing about the paths that depend on activation meaning something.
 */
export async function activeAgent(
  service: SupabaseClient<Database>,
  operator: SupabaseClient<Database>,
  ownerId: string,
  whiteboardId: string,
  specId: string,
  specHash: string,
): Promise<{ agentId: string; agentVersionId: string; deploymentKey: string }> {
  // Creating and activating an agent are operator acts, and the grants say so: those two functions
  // are executable by `authenticated` and not by `service_role`. The backend-only steps in between
  // are the mirror image. Using the right client for each is what makes the test exercise the real
  // authorization surface instead of routing around it.
  const deploymentKey = `svc-${randomUUID().slice(0, 8)}`;
  const agent = await operator.rpc('create_agent', {
    p_whiteboard_id: whiteboardId,
    p_deployment_key: deploymentKey,
    p_name: 'Service test agent',
  });
  if (agent.error !== null) throw new Error(`create_agent: ${agent.error.message}`);
  const agentId = (agent.data as unknown as { agentId: string }).agentId;

  const version = await service.rpc('create_agent_version', {
    p_agent_id: agentId,
    p_spec_id: specId,
    p_parent_agent_version_id: null as unknown as string,
  });
  if (version.error !== null) throw new Error(`create_agent_version: ${version.error.message}`);
  const agentVersionId = (version.data as unknown as { agentVersionId: string }).agentVersionId;

  const commit = await service.rpc('record_agent_commit', {
    p_actor_user_id: ownerId,
    p_agent_version_id: agentVersionId,
    p_git_commit_sha: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8),
    p_build_manifest: {
      manifestVersion: 1,
      deploymentKey,
      versionNo: 1,
      codePath: `generated-agents/${deploymentKey}/v001`,
      specId,
      specHash,
      specVersion: 1,
      generatedFiles: ['agent.ts', 'rules.ts', 'prompts.ts', 'manifest.json', 'spec.snapshot.json'],
      capabilities: ['mail.read'],
      generatedAt: new Date().toISOString(),
      generator: { skill: 'spec-to-agent', model: 'service-test' },
      toolkitVersions: { composioGmailToolkit: '0.0.0-test' },
      validation: { commands: ['pnpm lint'], evalCaseKeys: [] },
    } as unknown as Json,
  });
  if (commit.error !== null) throw new Error(`record_agent_commit: ${commit.error.message}`);

  for (const status of ['evaluating', 'approved'] as const) {
    const moved = await service.rpc('transition_agent_version', {
      p_agent_version_id: agentVersionId,
      p_status: status,
    });
    if (moved.error !== null) throw new Error(`transition to ${status}: ${moved.error.message}`);
  }

  const activated = await operator.rpc('activate_agent_version', {
    p_agent_id: agentId,
    p_agent_version_id: agentVersionId,
  });
  if (activated.error !== null) throw new Error(`activate: ${activated.error.message}`);

  return { agentId, agentVersionId, deploymentKey };
}
