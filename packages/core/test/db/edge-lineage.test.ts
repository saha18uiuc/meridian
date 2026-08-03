import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';

/**
 * Edge endpoint integrity (A2, PRD §2 edge storage).
 *
 * Edges are stored with a composite foreign key on `(whiteboard_id, node_id)` rather than on
 * `node_id` alone. The extra column is what makes a cross-board edge unrepresentable instead of
 * merely discouraged: an edge cannot point at a node that lives on a different board, because the
 * board is part of the reference.
 */

let owner: string;
let board: SeededBoard;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  board = await seedSimpleBoard(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

interface EdgeUpsert {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string | null;
  condition?: Record<string, unknown> | null;
  priority?: number;
  rowVersion?: number;
}

function saveEdges(
  upserts: EdgeUpsert[],
  deletes: string[] = [],
  expectedRevision = board.revisionNo,
): Promise<{ revisionNo: number; changed: boolean }> {
  return rpcAsUser(owner, 'save_whiteboard_delta', [
    board.boardId,
    expectedRevision,
    JSON.stringify([]),
    [],
    JSON.stringify(upserts),
    deletes,
    null,
  ]);
}

async function edgeRows(): Promise<
  Array<{
    edge_id: string;
    whiteboard_id: string;
    source_node_id: string;
    target_node_id: string;
    priority: number;
    row_version: number;
    label: string | null;
  }>
> {
  const { rows } = await asPostgres(async (client) =>
    client.query(
      `select edge_id, whiteboard_id, source_node_id, target_node_id, priority, row_version, label
         from public.whiteboard_edges where whiteboard_id = $1 order by created_at, edge_id`,
      [board.boardId],
    ),
  );
  return rows;
}

describe('edge endpoints', () => {
  it('refuses an edge whose source lives on another board', async () => {
    const other = await seedSimpleBoard(owner, 'Other board');
    await expectPgError(
      saveEdges([
        {
          edgeId: randomUUID(),
          sourceNodeId: other.inputNodeId,
          targetNodeId: board.actionNodeId,
        },
      ]),
      'EDGE_ENDPOINT_NOT_ON_BOARD',
    );
  });

  it('refuses an edge whose target lives on another board', async () => {
    const other = await seedSimpleBoard(owner, 'Other board');
    await expectPgError(
      saveEdges([
        {
          edgeId: randomUUID(),
          sourceNodeId: board.actionNodeId,
          targetNodeId: other.outcomeNodeId,
        },
      ]),
      'EDGE_ENDPOINT_NOT_ON_BOARD',
    );
  });

  it('refuses an edge pointing at a node that does not exist anywhere', async () => {
    await expectPgError(
      saveEdges([
        { edgeId: randomUUID(), sourceNodeId: board.inputNodeId, targetNodeId: randomUUID() },
      ]),
      'EDGE_ENDPOINT_NOT_ON_BOARD',
    );
  });

  it('stores a self-edge, leaving the cycle judgement to the compiler', async () => {
    // The database's job is endpoint integrity: both ends exist on this board, so the row is
    // structurally sound. Whether a loop makes the workflow non-terminating is a graph question,
    // and check `cycle_detected` answers it at compile time with the whole graph in view.
    const loop = randomUUID();
    await saveEdges([
      { edgeId: loop, sourceNodeId: board.actionNodeId, targetNodeId: board.actionNodeId },
    ]);
    expect((await edgeRows()).map((r) => r.edge_id)).toContain(loop);
  });

  it('accepts a second edge between the same pair, because a fan-out is legitimate', async () => {
    const extra = randomUUID();
    await saveEdges([
      {
        edgeId: extra,
        sourceNodeId: board.inputNodeId,
        targetNodeId: board.actionNodeId,
        label: 'retry path',
        priority: 1,
      },
    ]);
    const rows = await edgeRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.edge_id === extra)).toMatchObject({
      label: 'retry path',
      priority: 1,
    });
  });
});

describe('edge row versions', () => {
  it('starts at 1 and increments on each accepted update', async () => {
    const before = await edgeRows();
    expect(before[0]?.row_version).toBe(1);

    const revision = await saveEdges([
      {
        edgeId: board.edgeIds[0],
        sourceNodeId: board.inputNodeId,
        targetNodeId: board.actionNodeId,
        label: 'first pass',
        rowVersion: 1,
      },
    ]);
    await saveEdges(
      [
        {
          edgeId: board.edgeIds[0],
          sourceNodeId: board.inputNodeId,
          targetNodeId: board.actionNodeId,
          label: 'second pass',
          rowVersion: 2,
        },
      ],
      [],
      revision.revisionNo,
    );

    const after = await edgeRows();
    expect(after.find((r) => r.edge_id === board.edgeIds[0])).toMatchObject({
      row_version: 3,
      label: 'second pass',
    });
  });

  it('refuses an update that names a row version the edge has already left behind', async () => {
    await saveEdges([
      {
        edgeId: board.edgeIds[0],
        sourceNodeId: board.inputNodeId,
        targetNodeId: board.actionNodeId,
        label: 'first pass',
        rowVersion: 1,
      },
    ]);
    await expectPgError(
      saveEdges(
        [
          {
            edgeId: board.edgeIds[0],
            sourceNodeId: board.inputNodeId,
            targetNodeId: board.actionNodeId,
            label: 'from a stale tab',
            rowVersion: 1,
          },
        ],
        [],
        board.revisionNo + 1,
      ),
      'STALE_EDGE_ROW_VERSION',
    );
  });
});

describe('deleting a node', () => {
  it('takes its edges with it, so no edge is ever left dangling', async () => {
    // `on delete cascade` on the composite key is the mechanism. Without it, deleting a node would
    // either fail on the foreign key or leave an edge pointing at nothing.
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([]),
      [board.outcomeNodeId],
      JSON.stringify([]),
      [],
      null,
    ]);
    const rows = await edgeRows();
    expect(rows.map((r) => r.edge_id)).toEqual([board.edgeIds[0]]);
  });
});

describe('direct edge writes', () => {
  it('are refused for the browser role by privilege', async () => {
    await expectPgError(
      asPostgres(async (client) => {
        await client.query('set local role authenticated');
        await client.query(
          'insert into public.whiteboard_edges (whiteboard_id, source_node_id, target_node_id) values ($1,$2,$3)',
          [board.boardId, board.inputNodeId, board.actionNodeId],
        );
      }),
      'permission denied for table whiteboard_edges',
    );
  });

  it('are refused even for the service role, by the statement-level guard', async () => {
    await expectPgError(
      asPostgres(async (client) => {
        await client.query('set local role service_role');
        await client.query(
          'insert into public.whiteboard_edges (whiteboard_id, source_node_id, target_node_id) values ($1,$2,$3)',
          [board.boardId, board.inputNodeId, board.actionNodeId],
        );
      }),
      'WHITEBOARD_GRAPH_DIRECT_WRITE_FORBIDDEN',
    );
  });
});
