import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  asUser,
  closePool,
  createTestUsers,
  expectPgError,
  openSession,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';

/**
 * Renaming participates in revision semantics.
 *
 * The title is part of the canonical snapshot, so a rename genuinely changes what a review or a
 * freeze would capture. Treating it as cosmetic metadata would let a board drift away from the
 * spec that was reviewed without anything recording that it had.
 */

let owner: string;
let boardId: string;

interface RenameResult {
  whiteboardId: string;
  title: string;
  revisionNo: number;
  status: string;
  changed: boolean;
}

const rename = (revision: number, title: string): Promise<RenameResult> =>
  rpcAsUser<RenameResult>(owner, 'rename_whiteboard', [boardId, revision, title]);

async function boardRow(): Promise<{
  title: string;
  status: string;
  revision_no: number;
  last_reviewed_revision_no: number | null;
}> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{
      title: string;
      status: string;
      revision_no: number;
      last_reviewed_revision_no: number | null;
    }>(
      'select title, status, revision_no, last_reviewed_revision_no from public.whiteboards where whiteboard_id = $1',
      [boardId],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('board disappeared');
  return row;
}

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  const created = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', [
    'Inbound Import Receiving',
  ]);
  boardId = created.whiteboardId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('rename_whiteboard', () => {
  it('increments the revision on a real change', async () => {
    const result = await rename(1, 'Inbound Receiving v2');
    expect(result).toMatchObject({ changed: true, revisionNo: 2, title: 'Inbound Receiving v2' });
  });

  it('is a no-op when the normalized title is identical', async () => {
    const result = await rename(1, '  Inbound   Import Receiving  ');
    expect(result).toMatchObject({ changed: false, revisionNo: 1 });
  });

  it('normalizes internal whitespace before storing', async () => {
    await rename(1, 'Air   freight\treceiving');
    expect((await boardRow()).title).toBe('Air freight receiving');
  });

  it('rejects a stale expected revision', async () => {
    await rename(1, 'Second');
    await expectPgError(rename(1, 'Third'), 'STALE_BOARD_REVISION');
  });

  it('rejects an empty or overlong title', async () => {
    await expectPgError(rename(1, '   '), 'INVALID_TITLE');
    await expectPgError(rename(1, 'x'.repeat(201)), 'INVALID_TITLE');
  });

  it('resets review_ready to draft, because the reviewed snapshot no longer matches', async () => {
    // `review_ready` is reached through the review pipeline, not by an operator call, so the
    // fixture sets it directly rather than pretending an operator could.
    await asPostgres(async (client) =>
      client.query(
        "update public.whiteboards set status = 'review_ready' where whiteboard_id = $1",
        [boardId],
      ),
    );
    await rename(1, 'Renamed while review-ready');
    expect((await boardRow()).status).toBe('draft');
  });

  it('leaves last_reviewed_revision_no alone so the board reads as stale', async () => {
    await asPostgres(async (client) =>
      client.query(
        'update public.whiteboards set last_reviewed_revision_no = 1 where whiteboard_id = $1',
        [boardId],
      ),
    );
    await rename(1, 'Renamed after review');
    const row = await boardRow();
    expect(row.last_reviewed_revision_no).toBe(1);
    expect(row.revision_no).toBe(2);
  });

  it('refuses to rename an archived board', async () => {
    await rpcAsUser(owner, 'set_whiteboard_status', [boardId, 'archived']);
    await expectPgError(rename(1, 'Anything'), 'WHITEBOARD_ARCHIVED');
  });

  it('is invisible to a different user', async () => {
    const [other] = (await createTestUsers(1)) as [string];
    await expectPgError(
      rpcAsUser(other, 'rename_whiteboard', [boardId, 1, 'Hijacked']),
      'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN',
    );
  });

  it('serializes two concurrent renames so only one wins at a given revision', async () => {
    // Two real sessions, not two awaits: the point is that the row lock, not statement ordering,
    // is what makes the second rename see a revision it did not expect.
    const first = await openSession('authenticated', owner);
    const second = await openSession('authenticated', owner);
    try {
      await first.client.query('select public.rename_whiteboard($1,$2,$3)', [boardId, 1, 'A wins']);

      const blocked = second.client.query('select public.rename_whiteboard($1,$2,$3)', [
        boardId,
        1,
        'B tries',
      ]);
      await first.client.query('commit');

      await expect(blocked).rejects.toThrow(/STALE_BOARD_REVISION/);
      await second.client.query('rollback');
    } finally {
      first.release();
      second.release();
    }

    expect((await boardRow()).title).toBe('A wins');
  });

  it('cannot be called by an unauthenticated session', async () => {
    await expectPgError(
      asUser('00000000-0000-4000-8000-000000000000', async (client) =>
        client.query('select public.rename_whiteboard($1,$2,$3)', [boardId, 1, 'Nope']),
      ),
      'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN',
    );
  });
});
