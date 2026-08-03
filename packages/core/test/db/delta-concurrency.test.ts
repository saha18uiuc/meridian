import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  closePool,
  createTestUsers,
  openSession,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';

const A = '77777777-7777-4777-8777-777777777771';
const B = '77777777-7777-4777-8777-777777777772';

function nodeUpsert(nodeId: string, title: string, rowVersion?: number) {
  return {
    nodeId,
    primitiveType: 'action',
    title,
    data: { actor: 'agent', operation: 'mail.read' },
    position: { x: 0, y: 0 },
    ...(rowVersion === undefined ? {} : { rowVersion }),
  };
}

let owner: string;
let boardId: string;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  const board = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', ['Board']);
  boardId = board.whiteboardId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

/**
 * The second writer must not be allowed to "win by arriving late". `FOR UPDATE` serialises the
 * two sessions and the revision check then rejects the loser, so the outcome is a clean 409
 * rather than a silent overwrite.
 */
describe('concurrent deltas against one board', () => {
  it('lets the first committer through and stales the second', async () => {
    const first = await openSession('authenticated', owner);
    const second = await openSession('authenticated', owner);

    try {
      await first.client.query('select public.save_whiteboard_delta($1,$2,$3,$4,$5,$6,$7)', [
        boardId,
        1,
        JSON.stringify([nodeUpsert(A, 'From session one')]),
        [],
        JSON.stringify([]),
        [],
        null,
      ]);

      // Session two blocks on the board lock until session one commits.
      const pending = second.client.query(
        'select public.save_whiteboard_delta($1,$2,$3,$4,$5,$6,$7)',
        [
          boardId,
          1,
          JSON.stringify([nodeUpsert(B, 'From session two')]),
          [],
          JSON.stringify([]),
          [],
          null,
        ],
      );

      await first.client.query('commit');

      await expect(pending).rejects.toThrow(/STALE_BOARD_REVISION/);
      await second.client.query('rollback');
    } finally {
      first.release();
      second.release();
    }

    const rows = await asUser(owner, async (client) =>
      client.query('select node_id, title from public.whiteboard_nodes'),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ node_id: A });
  });

  it('increments the revision exactly once per successful delta under contention', async () => {
    for (let i = 0; i < 5; i += 1) {
      await rpcAsUser(owner, 'save_whiteboard_delta', [
        boardId,
        i + 1,
        JSON.stringify([nodeUpsert(A, `title ${i}`, i === 0 ? undefined : i)]),
        [],
        JSON.stringify([]),
        [],
        null,
      ]);
    }
    const rows = await asUser(owner, async (client) =>
      client.query(
        'select w.revision_no, n.row_version from public.whiteboards w join public.whiteboard_nodes n using (whiteboard_id)',
      ),
    );
    expect(rows.rows[0]).toMatchObject({ revision_no: 6, row_version: 5 });
  });

  it('rejects a second writer holding a stale node row version even at the right revision', async () => {
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      boardId,
      1,
      JSON.stringify([nodeUpsert(A, 'v1')]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      boardId,
      2,
      JSON.stringify([nodeUpsert(A, 'v2', 1)]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);

    await expect(
      rpcAsUser(owner, 'save_whiteboard_delta', [
        boardId,
        3,
        JSON.stringify([nodeUpsert(A, 'v2-conflict', 1)]),
        [],
        JSON.stringify([]),
        [],
        null,
      ]),
    ).rejects.toThrow(/STALE_NODE_ROW_VERSION/);
  });
});
