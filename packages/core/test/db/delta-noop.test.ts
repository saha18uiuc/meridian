import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asUser, closePool, createTestUsers, rpcAsUser, truncateAll } from '../helpers/db.js';

let owner: string;
let boardId: string;

type DeltaResult = { revisionNo: number; changed: boolean };

async function emptyDelta(revision: number, viewport: unknown = null): Promise<DeltaResult> {
  return rpcAsUser<DeltaResult>(owner, 'save_whiteboard_delta', [
    boardId,
    revision,
    JSON.stringify([]),
    [],
    JSON.stringify([]),
    [],
    viewport === null ? null : JSON.stringify(viewport),
  ]);
}

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
 * A save that changes nothing must not burn a revision: a client that autosaves on focus loss
 * would otherwise stale its own review on every click.
 */
describe('no-op deltas', () => {
  it('returns changed:false and leaves the revision alone', async () => {
    const result = await emptyDelta(1);
    expect(result).toMatchObject({ changed: false, revisionNo: 1 });
  });

  it('stays a no-op when repeated', async () => {
    await emptyDelta(1);
    const second = await emptyDelta(1);
    expect(second.revisionNo).toBe(1);
  });

  it('counts a viewport change as a change, but only when the value differs', async () => {
    const moved = await emptyDelta(1, { x: 10, y: 20, zoom: 1.5 });
    expect(moved).toMatchObject({ changed: true, revisionNo: 2 });

    const same = await emptyDelta(2, { x: 10, y: 20, zoom: 1.5 });
    expect(same).toMatchObject({ changed: false, revisionNo: 2 });
  });

  it('leaves the board status untouched on a no-op', async () => {
    await asUser(owner, async (client) =>
      client.query('select public.set_whiteboard_status($1,$2)', [boardId, 'draft']),
    );
    await emptyDelta(1);
    const rows = await asUser(owner, async (client) =>
      client.query('select status from public.whiteboards where whiteboard_id = $1', [boardId]),
    );
    expect(rows.rows[0]).toMatchObject({ status: 'draft' });
  });
});
