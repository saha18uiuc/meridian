import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';

/**
 * A1: the transactional RPC is the *only* graph write path. If a browser session could write a
 * node row directly it could also skip the row-version check, the revision increment, and the
 * status transition, so this file proves the grant is missing rather than merely unused.
 */

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const EDGE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_NODE_ID = '44444444-4444-4444-8444-444444444444';

let owner: string;
let boardId: string;

beforeAll(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  const board = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', ['Board']);
  boardId = board.whiteboardId;

  await rpcAsUser(owner, 'save_whiteboard_delta', [
    boardId,
    1,
    JSON.stringify([
      {
        nodeId: NODE_ID,
        primitiveType: 'action',
        title: 'A',
        data: { actor: 'agent', operation: 'mail.read' },
        position: { x: 0, y: 0 },
      },
      {
        nodeId: OTHER_NODE_ID,
        primitiveType: 'outcome',
        title: 'B',
        data: { resultKind: 'ready', terminal: true },
        position: { x: 1, y: 1 },
      },
    ]),
    [],
    JSON.stringify([
      { edgeId: EDGE_ID, sourceNodeId: NODE_ID, targetNodeId: OTHER_NODE_ID, priority: 0 },
    ]),
    [],
    null,
  ]);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('the browser cannot bypass the transactional write path', () => {
  const cases: Array<[string, string]> = [
    [
      'insert a node',
      `insert into public.whiteboard_nodes (node_id, whiteboard_id, primitive_type, title, node_data_json, position_x, position_y)
       values (gen_random_uuid(), '${'00000000-0000-4000-8000-000000000001'}', 'action', 'X', '{}'::jsonb, 0, 0)`,
    ],
    ['update a node', `update public.whiteboard_nodes set title = 'hacked'`],
    ['delete a node', `delete from public.whiteboard_nodes`],
    [
      'insert an edge',
      `insert into public.whiteboard_edges (edge_id, whiteboard_id, source_node_id, target_node_id)
       values (gen_random_uuid(), '${'00000000-0000-4000-8000-000000000001'}', '${NODE_ID}', '${OTHER_NODE_ID}')`,
    ],
    ['update an edge', `update public.whiteboard_edges set label = 'hacked'`],
    ['delete an edge', `delete from public.whiteboard_edges`],
  ];

  for (const [name, statement] of cases) {
    it(`denies an authenticated user attempting to ${name} directly`, async () => {
      await expectPgError(
        asUser(owner, async (client) => client.query(statement)),
        'permission denied',
      );
    });

    it(`denies an anonymous session attempting to ${name} directly`, async () => {
      await expectPgError(
        asAnon(async (client) => client.query(statement)),
        'permission denied',
      );
    });
  }

  it('denies a direct revision bump on the board', async () => {
    await expectPgError(
      asUser(owner, async (client) =>
        client.query('update public.whiteboards set revision_no = revision_no + 1'),
      ),
      'permission denied',
    );
  });

  it('denies a direct viewport write', async () => {
    await expectPgError(
      asUser(owner, async (client) =>
        client.query(
          `update public.whiteboards set viewport_json = '{"x":9,"y":9,"zoom":9}'::jsonb`,
        ),
      ),
      'permission denied',
    );
  });

  it('denies writing authoritative review metadata directly', async () => {
    await expectPgError(
      asUser(owner, async (client) =>
        client.query(
          `insert into public.review_sessions (whiteboard_id, round_no, source_revision_no,
             source_canvas_json, source_canvas_hash, requested_by)
           values ('${boardId}', 1, 1, '{}'::jsonb, repeat('a', 64), '${owner}')`,
        ),
      ),
      'permission denied',
    );
  });

  it('still lets the owner read everything the RPC wrote', async () => {
    const result = await asUser(owner, async (client) =>
      client.query(
        `select (select count(*) from public.whiteboard_nodes) as nodes,
                (select count(*) from public.whiteboard_edges) as edges,
                (select revision_no from public.whiteboards) as revision`,
      ),
    );
    expect(result.rows[0]).toMatchObject({ nodes: '2', edges: '1', revision: 2 });
  });
});
