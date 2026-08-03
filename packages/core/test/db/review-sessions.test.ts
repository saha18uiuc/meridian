import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/hashing.js';
import {
  asPostgres,
  asUser,
  buildSnapshot,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  rpcAsUser,
  seedSimpleBoard,
  truncateAll,
  type SeededBoard,
} from '../helpers/db.js';

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

async function createSession(expectedRevision = board.revisionNo) {
  const { snapshot, hash } = await buildSnapshot(board.boardId);
  return rpcAsService<{
    reviewSessionId: string;
    roundNo: number;
    sourceRevisionNo: number;
    status: string;
    modelName: string;
  }>('create_review_session', [
    owner,
    board.boardId,
    expectedRevision,
    JSON.stringify(snapshot),
    hash,
    'gpt-5.5',
    'high',
  ]);
}

describe('create_review_session', () => {
  it('inserts directly as running with the resolved model already recorded (A20)', async () => {
    const session = await createSession();
    expect(session).toMatchObject({ roundNo: 1, status: 'running', modelName: 'gpt-5.5' });
  });

  it('moves a draft board to review_ready', async () => {
    await createSession();
    const rows = await asUser(owner, async (client) =>
      client.query('select status from public.whiteboards where whiteboard_id = $1', [
        board.boardId,
      ]),
    );
    expect(rows.rows[0]).toMatchObject({ status: 'review_ready' });
  });

  it('freezes the snapshot and hash at insert time', async () => {
    const { hash } = await buildSnapshot(board.boardId);
    const session = await createSession();

    await rpcAsUser(owner, 'save_whiteboard_delta', [
      board.boardId,
      board.revisionNo,
      JSON.stringify([]),
      [],
      JSON.stringify([]),
      [],
      JSON.stringify({ x: 5, y: 5, zoom: 2 }),
    ]);

    const rows = await asUser(owner, async (client) =>
      client.query(
        'select source_canvas_hash, source_revision_no from public.review_sessions where review_session_id = $1',
        [session.reviewSessionId],
      ),
    );
    expect(rows.rows[0]).toMatchObject({
      source_canvas_hash: hash,
      source_revision_no: board.revisionNo,
    });
  });

  it('rejects a second active session for the same board', async () => {
    await createSession();
    await expectPgError(createSession(), 'ACTIVE_REVIEW_EXISTS');
  });

  it('rejects a stale expected revision', async () => {
    await expectPgError(createSession(board.revisionNo - 1), 'STALE_BOARD_REVISION');
  });

  it('rejects a snapshot that does not describe the board (A21)', async () => {
    const { snapshot, revisionNo } = await buildSnapshot(board.boardId);
    const forged = {
      ...snapshot,
      nodes: [
        ...snapshot.nodes,
        {
          nodeId: '99999999-9999-4999-8999-999999999999',
          primitiveType: 'action' as const,
          title: 'Phantom',
          data: {},
          position: { x: 0, y: 0 },
          rowVersion: 1,
        },
      ],
    };
    await expectPgError(
      rpcAsService('create_review_session', [
        owner,
        board.boardId,
        revisionNo,
        JSON.stringify(forged),
        sha256Hex(forged),
        'gpt-5.5',
        'high',
      ]),
      'SNAPSHOT_DOES_NOT_MATCH_BOARD',
    );
  });

  it('rejects a snapshot whose metadata names another revision', async () => {
    const { snapshot, revisionNo } = await buildSnapshot(board.boardId);
    const forged = { ...snapshot, metadata: { ...snapshot.metadata, revisionNo: revisionNo + 5 } };
    await expectPgError(
      rpcAsService('create_review_session', [
        owner,
        board.boardId,
        revisionNo,
        JSON.stringify(forged),
        sha256Hex(forged),
        'gpt-5.5',
        'high',
      ]),
      'SNAPSHOT_METADATA_MISMATCH',
    );
  });

  it('rejects a malformed hash', async () => {
    const { snapshot, revisionNo } = await buildSnapshot(board.boardId);
    await expectPgError(
      rpcAsService('create_review_session', [
        owner,
        board.boardId,
        revisionNo,
        JSON.stringify(snapshot),
        'not-a-hash'.padEnd(64, 'z'),
        'gpt-5.5',
        'high',
      ]),
      'INVALID_SNAPSHOT_HASH',
    );
  });

  it('rejects an unknown reasoning effort', async () => {
    const { snapshot, revisionNo } = await buildSnapshot(board.boardId);
    await expectPgError(
      rpcAsService('create_review_session', [
        owner,
        board.boardId,
        revisionNo,
        JSON.stringify(snapshot),
        sha256Hex(snapshot),
        'gpt-5.5',
        'extreme',
      ]),
      'INVALID_REASONING_EFFORT',
    );
  });

  it('is not callable by the browser role', async () => {
    const { snapshot, revisionNo } = await buildSnapshot(board.boardId);
    await expectPgError(
      asUser(owner, async (client) =>
        client.query('select public.create_review_session($1,$2,$3,$4,$5,$6,$7)', [
          owner,
          board.boardId,
          revisionNo,
          JSON.stringify(snapshot),
          sha256Hex(snapshot),
          'gpt-5.5',
          'high',
        ]),
      ),
      'permission denied for function create_review_session',
    );
  });

  it('refuses to act for a user who does not own the board', async () => {
    const [stranger] = (await createTestUsers(1)) as [string];
    const { snapshot, revisionNo } = await buildSnapshot(board.boardId);
    await expectPgError(
      rpcAsService('create_review_session', [
        stranger,
        board.boardId,
        revisionNo,
        JSON.stringify(snapshot),
        sha256Hex(snapshot),
        'gpt-5.5',
        'high',
      ]),
      'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN',
    );
  });

  it('keeps every earlier session immutable', async () => {
    const session = await createSession();
    await rpcAsService('fail_review_session', [
      owner,
      session.reviewSessionId,
      JSON.stringify({ code: 'TIMEOUT' }),
    ]);
    // Even a superuser cannot rewrite the recorded snapshot: the guard is a trigger, not a grant.
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          'update public.review_sessions set source_revision_no = 99 where review_session_id = $1',
          [session.reviewSessionId],
        ),
      ),
      'REVIEW_SESSION_IMMUTABLE_FIELD',
    );
  });

  it('allocates increasing round numbers', async () => {
    const first = await createSession();
    await rpcAsService('fail_review_session', [
      owner,
      first.reviewSessionId,
      JSON.stringify({ code: 'TIMEOUT' }),
    ]);
    const second = await createSession();
    expect(second.roundNo).toBe(2);
  });
});
