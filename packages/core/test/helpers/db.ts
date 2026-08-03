import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assembleCanonicalGraph, deriveCanvasHash } from '../../src/graph.js';
import type { CanonicalGraph } from '../../src/schemas/board.js';
import type { WhiteboardNode } from '../../src/schemas/node.js';

const { Pool } = pg;
type PoolClient = pg.PoolClient;

const ENV_PATH = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const CONNECTION_STRING =
  process.env['SUPABASE_DB_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres';

/**
 * The `db` Vitest project runs serially against one local PostgreSQL instance, and several of
 * its cases deliberately provoke row-lock contention, so the pool stays small and every helper
 * releases its client in a `finally`.
 */
export const pool = new Pool({ connectionString: CONNECTION_STRING, max: 8 });

export type DbRole = 'anon' | 'authenticated' | 'service_role' | 'postgres';

/** Every table the tests may truncate, in no particular order; `cascade` handles the graph. */
export const APPLICATION_TABLES = [
  'execution_actions',
  'execution_events',
  'execution_steps',
  'executions',
  'agent_versions',
  'agents',
  'frozen_specs',
  'comments',
  'review_sessions',
  'whiteboard_edges',
  'whiteboard_nodes',
  'whiteboards',
] as const;

export const RPC_NAMES = [
  'create_whiteboard',
  'rename_whiteboard',
  'set_whiteboard_status',
  'save_whiteboard_delta',
  'create_review_session',
  'finalize_review_session',
  'fail_review_session',
  'reply_to_comment',
  'reject_comment',
  'apply_comment_patch',
  'record_explicit_assumption',
  'record_policy_gap',
  'freeze_whiteboard_spec',
  'create_agent',
  'create_agent_version',
  'record_agent_commit',
  'transition_agent_version',
  'activate_agent_version',
  'create_execution',
  'start_execution',
  'complete_execution',
  'fail_execution',
  'create_manual_review_intake_execution',
  'reserve_execution_action',
  'dispatch_execution_action',
  'complete_execution_action',
  'mark_execution_action_for_reconciliation',
  'reconcile_execution_action',
  'abandon_execution_action',
] as const;

async function applyRole(client: PoolClient, role: DbRole, userId: string | null): Promise<void> {
  if (role === 'postgres') {
    await client.query('reset role');
  } else {
    await client.query(`set local role ${role}`);
  }
  const claims = userId === null ? '' : JSON.stringify({ sub: userId, role, aud: 'authenticated' });
  await client.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
}

/**
 * Run `fn` inside one transaction as `role`. The transaction is rolled back on failure so a
 * deliberately-rejected write never leaks into the next case.
 */
export async function withRole<T>(
  role: DbRole,
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyRole(client, role, userId);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const asUser = <T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  withRole('authenticated', userId, fn);

export const asAnon = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  withRole('anon', null, fn);

export const asService = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  withRole('service_role', null, fn);

/** Superuser access, used only for fixtures and assertions the roles above cannot make. */
export const asPostgres = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  withRole('postgres', null, fn);

/**
 * A client whose transaction the caller drives, for the concurrency cases that need two
 * sessions holding locks at the same time.
 */
export async function openSession(
  role: DbRole,
  userId: string | null,
): Promise<{ client: PoolClient; release: () => void }> {
  const client = await pool.connect();
  await client.query('begin');
  await applyRole(client, role, userId);
  return {
    client,
    release: () => {
      client.release();
    },
  };
}

export async function createTestUser(email: string): Promise<string> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                               email_confirmed_at, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
               'authenticated', $1, crypt($2, gen_salt('bf')), now(), now(), now())
       returning id`,
      [email, 'meridian-test-password'],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`failed to create test user ${email}`);
    return id;
  } finally {
    client.release();
  }
}

let userCounter = 0;

export async function createTestUsers(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    userCounter += 1;
    ids.push(await createTestUser(`test-${process.pid}-${userCounter}@meridian.local`));
  }
  return ids;
}

export async function truncateAll(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `truncate table ${APPLICATION_TABLES.map((t) => `public.${t}`).join(', ')} restart identity cascade`,
    );
    await client.query('delete from auth.users');
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/** Call an RPC as `userId` and return its `jsonb` result. */
export async function rpcAsUser<T = Record<string, unknown>>(
  userId: string,
  fn: string,
  args: readonly unknown[],
): Promise<T> {
  return asUser(userId, async (client) => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query<{ result: T }>(
      `select public.${fn}(${placeholders}) as result`,
      [...args],
    );
    return rows[0]?.result as T;
  });
}

export async function rpcAsService<T = Record<string, unknown>>(
  fn: string,
  args: readonly unknown[],
): Promise<T> {
  return asService(async (client) => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query<{ result: T }>(
      `select public.${fn}(${placeholders}) as result`,
      [...args],
    );
    return rows[0]?.result as T;
  });
}

export interface SeededBoard {
  boardId: string;
  inputNodeId: string;
  actionNodeId: string;
  outcomeNodeId: string;
  edgeIds: [string, string];
  revisionNo: number;
}

/** A tiny but structurally valid board: Input -> Action -> terminal Outcome. */
export async function seedSimpleBoard(owner: string, title = 'Seeded board'): Promise<SeededBoard> {
  const created = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', [title]);
  const boardId = created.whiteboardId;

  const inputNodeId = randomUUID();
  const actionNodeId = randomUUID();
  const outcomeNodeId = randomUUID();
  const edgeIds: [string, string] = [randomUUID(), randomUUID()];

  const result = await rpcAsUser<{ revisionNo: number }>(owner, 'save_whiteboard_delta', [
    boardId,
    1,
    JSON.stringify([
      {
        nodeId: inputNodeId,
        primitiveType: 'input',
        title: 'Arrival notice',
        data: {
          inputKind: 'event',
          sourceSystem: 'mailbox',
          required: true,
          fields: [],
          correlationKeys: ['containerNumber'],
        },
        position: { x: 0, y: 0 },
      },
      {
        nodeId: actionNodeId,
        primitiveType: 'action',
        title: 'Read the mailbox',
        data: {
          actor: 'agent',
          operation: 'mail.read',
          instructions: '',
          system: 'gmail',
          inputs: [],
          outputs: [],
        },
        position: { x: 100, y: 0 },
      },
      {
        nodeId: outcomeNodeId,
        primitiveType: 'outcome',
        title: 'Ready for entry',
        data: { resultKind: 'ready', terminal: true },
        position: { x: 200, y: 0 },
      },
    ]),
    [],
    JSON.stringify([
      { edgeId: edgeIds[0], sourceNodeId: inputNodeId, targetNodeId: actionNodeId, priority: 0 },
      { edgeId: edgeIds[1], sourceNodeId: actionNodeId, targetNodeId: outcomeNodeId, priority: 0 },
    ]),
    [],
    null,
  ]);

  return {
    boardId,
    inputNodeId,
    actionNodeId,
    outcomeNodeId,
    edgeIds,
    revisionNo: result.revisionNo,
  };
}

/**
 * Build the server-side canonical snapshot exactly the way the review and freeze services do,
 * so the database's `assert_snapshot_matches_board` structural check passes for real reasons.
 */
export async function buildSnapshot(
  boardId: string,
): Promise<{ snapshot: CanonicalGraph; hash: string; revisionNo: number }> {
  const client = await pool.connect();
  try {
    const board = await client.query<{
      whiteboard_id: string;
      title: string;
      status: CanonicalGraph['metadata']['status'];
      revision_no: number;
    }>(
      'select whiteboard_id, title, status, revision_no from public.whiteboards where whiteboard_id = $1',
      [boardId],
    );
    const row = board.rows[0];
    if (row === undefined) throw new Error(`no such board ${boardId}`);

    const nodes = await client.query<{
      node_id: string;
      primitive_type: WhiteboardNode['primitiveType'];
      title: string;
      node_data_json: Record<string, unknown>;
      position_x: number;
      position_y: number;
      row_version: number;
    }>('select * from public.whiteboard_nodes where whiteboard_id = $1', [boardId]);

    const edges = await client.query<{
      edge_id: string;
      source_node_id: string;
      target_node_id: string;
      label: string | null;
      condition_json: Record<string, unknown> | null;
      priority: number;
      row_version: number;
    }>('select * from public.whiteboard_edges where whiteboard_id = $1', [boardId]);

    const snapshot = assembleCanonicalGraph(
      {
        whiteboardId: row.whiteboard_id,
        title: row.title,
        status: row.status,
        revisionNo: row.revision_no,
      },
      nodes.rows.map((n) => ({
        nodeId: n.node_id,
        primitiveType: n.primitive_type,
        title: n.title,
        data: n.node_data_json,
        position: { x: n.position_x, y: n.position_y },
        rowVersion: n.row_version,
      })),
      edges.rows.map((e) => ({
        edgeId: e.edge_id,
        sourceNodeId: e.source_node_id,
        targetNodeId: e.target_node_id,
        label: e.label,
        condition: e.condition_json,
        priority: e.priority,
        rowVersion: e.row_version,
      })),
    );

    return { snapshot, hash: deriveCanvasHash(snapshot), revisionNo: row.revision_no };
  } finally {
    client.release();
  }
}

/** Assert that `promise` rejects with a PostgreSQL error whose message contains `fragment`. */
export async function expectPgError(promise: Promise<unknown>, fragment: string): Promise<void> {
  let message = '<no error thrown>';
  try {
    await promise;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes(fragment)) {
    throw new Error(`expected a PostgreSQL error containing "${fragment}", got: ${message}`);
  }
}
