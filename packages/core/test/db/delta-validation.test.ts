import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  asUser,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';

const A = '55555555-5555-4555-8555-555555555551';
const B = '55555555-5555-4555-8555-555555555552';
const E = '66666666-6666-4666-8666-666666666661';

function nodeUpsert(nodeId: string, overrides: Record<string, unknown> = {}) {
  return {
    nodeId,
    primitiveType: 'action',
    title: 'Card',
    data: { actor: 'agent', operation: 'mail.read' },
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

let owner: string;
let boardId: string;

async function delta(
  revision: number,
  payload: {
    nodeUpserts?: unknown[];
    nodeDeletes?: string[] | null;
    edgeUpserts?: unknown[];
    edgeDeletes?: string[] | null;
    viewport?: unknown;
  },
) {
  return rpcAsUser<{
    revisionNo: number;
    changed: boolean;
    nodeRowVersions: Record<string, number>;
    edgeRowVersions: Record<string, number>;
  }>(owner, 'save_whiteboard_delta', [
    boardId,
    revision,
    JSON.stringify(payload.nodeUpserts ?? []),
    payload.nodeDeletes === undefined ? [] : payload.nodeDeletes,
    JSON.stringify(payload.edgeUpserts ?? []),
    payload.edgeDeletes === undefined ? [] : payload.edgeDeletes,
    payload.viewport === undefined ? null : JSON.stringify(payload.viewport),
  ]);
}

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  const board = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', ['Board']);
  boardId = board.whiteboardId;
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe('save_whiteboard_delta shape validation', () => {
  it('inserts a node and increments the revision exactly once', async () => {
    const result = await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    expect(result.revisionNo).toBe(2);
    expect(result.changed).toBe(true);
    expect(result.nodeRowVersions[A]).toBe(1);
  });

  it('rejects duplicate ids inside nodeUpserts', async () => {
    await expectPgError(
      delta(1, { nodeUpserts: [nodeUpsert(A), nodeUpsert(A)] }),
      'DUPLICATE_ID_IN_DELTA: nodeUpserts',
    );
  });

  it('rejects duplicate ids inside nodeDeletes', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    await expectPgError(delta(2, { nodeDeletes: [A, A] }), 'DUPLICATE_ID_IN_DELTA: nodeDeletes');
  });

  it('rejects an id that is both upserted and deleted', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    await expectPgError(
      delta(2, { nodeUpserts: [nodeUpsert(A, { rowVersion: 1 })], nodeDeletes: [A] }),
      'ID_IN_UPSERT_AND_DELETE: node',
    );
  });

  it('treats an empty array and NULL identically as "no deletions"', async () => {
    const empty = await delta(1, { nodeUpserts: [nodeUpsert(A)], nodeDeletes: [] });
    expect(empty.changed).toBe(true);
    const nulled = await delta(2, { nodeUpserts: [nodeUpsert(B)], nodeDeletes: null });
    expect(nulled.changed).toBe(true);
    expect(nulled.revisionNo).toBe(3);
  });

  it('never raises DUPLICATE_ID_IN_DELTA for empty or NULL arrays', async () => {
    await expect(delta(1, { nodeDeletes: [], edgeDeletes: null })).resolves.toMatchObject({
      changed: false,
    });
  });

  it('rejects a stale expected revision without writing anything', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    await expectPgError(delta(1, { nodeUpserts: [nodeUpsert(B)] }), 'STALE_BOARD_REVISION');
    const rows = await asUser(owner, async (client) =>
      client.query('select node_id from public.whiteboard_nodes'),
    );
    expect(rows.rowCount).toBe(1);
  });

  it('rejects a stale node row version', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    await expectPgError(
      delta(2, { nodeUpserts: [nodeUpsert(A, { rowVersion: 99 })] }),
      'STALE_NODE_ROW_VERSION',
    );
  });

  it('rejects a non-positive row version outright', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    await expectPgError(
      delta(2, { nodeUpserts: [nodeUpsert(A, { rowVersion: 0 })] }),
      'INVALID_ROW_VERSION',
    );
  });

  it('rejects an invalid viewport', async () => {
    await expectPgError(delta(1, { viewport: { x: 0, y: 0 } }), 'INVALID_VIEWPORT');
  });

  it('rejects deleting a node that is not on the board', async () => {
    await expectPgError(delta(1, { nodeDeletes: [A] }), 'DELETE_TARGET_NOT_FOUND: node');
  });

  it('rejects an edge whose endpoint is not on the board', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A)] });
    await expectPgError(
      delta(2, { edgeUpserts: [{ edgeId: E, sourceNodeId: A, targetNodeId: B, priority: 0 }] }),
      'EDGE_ENDPOINT_NOT_ON_BOARD',
    );
  });

  it('deletes incident edges when their node is deleted', async () => {
    await delta(1, { nodeUpserts: [nodeUpsert(A), nodeUpsert(B)] });
    await delta(2, {
      edgeUpserts: [{ edgeId: E, sourceNodeId: A, targetNodeId: B, priority: 0 }],
    });
    await delta(3, { nodeDeletes: [A] });
    const rows = await asUser(owner, async (client) =>
      client.query('select edge_id from public.whiteboard_edges'),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('applies a whole delta atomically: one bad element rolls back the good ones', async () => {
    await expectPgError(
      delta(1, { nodeUpserts: [nodeUpsert(A), nodeUpsert(B, { rowVersion: 7 })] }),
      'STALE_NODE_ROW_VERSION',
    );
    const rows = await asUser(owner, async (client) =>
      client.query('select node_id from public.whiteboard_nodes'),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('returns a submitted or reviewed board to draft when a save changes something', async () => {
    await asUser(owner, async (client) =>
      client.query('select public.set_whiteboard_status($1, $2)', [boardId, 'archived']),
    );
    await expectPgError(delta(1, { nodeUpserts: [nodeUpsert(A)] }), 'WHITEBOARD_ARCHIVED');
  });
});
