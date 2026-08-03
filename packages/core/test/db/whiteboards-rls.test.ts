import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  truncateAll,
  withRole,
} from '../helpers/db.js';

let owner: string;
let stranger: string;
let boardId: string;

beforeAll(async () => {
  await truncateAll();
  [owner, stranger] = (await createTestUsers(2)) as [string, string];
  const created = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', [
    'Owner board',
  ]);
  boardId = created.whiteboardId;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('whiteboard row-level security', () => {
  it('lets the owner read their own board', async () => {
    const rows = await asUser(owner, async (client) =>
      client.query('select whiteboard_id, title, revision_no from public.whiteboards'),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ whiteboard_id: boardId, revision_no: 1 });
  });

  it('hides the board from another authenticated user rather than erroring', async () => {
    const rows = await asUser(stranger, async (client) =>
      client.query('select whiteboard_id from public.whiteboards'),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('denies the anonymous role at the grant level, before RLS is even consulted', async () => {
    await expectPgError(
      asAnon(async (client) => client.query('select whiteboard_id from public.whiteboards')),
      'permission denied for table whiteboards',
    );
  });

  it('does not expose the write RPCs to the anonymous role at all', async () => {
    await expectPgError(
      asAnon(async (client) => client.query("select public.create_whiteboard('Anon board')")),
      'permission denied for function create_whiteboard',
    );
  });

  it('refuses to create a board when the session carries no user identity', async () => {
    await expectPgError(
      withRole('authenticated', null, async (client) =>
        client.query("select public.create_whiteboard('Claimless board')"),
      ),
      'NOT_AUTHENTICATED',
    );
  });

  it('reports a non-owner mutation as not found, never as forbidden detail', async () => {
    await expectPgError(
      rpcAsUser(stranger, 'rename_whiteboard', [boardId, 1, 'Stolen']),
      'WHITEBOARD_NOT_FOUND_OR_FORBIDDEN',
    );
  });

  it('rejects a blank title at creation', async () => {
    await expectPgError(rpcAsUser(owner, 'create_whiteboard', ['   ']), 'INVALID_TITLE');
  });

  it('scopes nodes and edges to the owning user through their board', async () => {
    await rpcAsUser(owner, 'save_whiteboard_delta', [
      boardId,
      1,
      JSON.stringify([
        {
          nodeId: '11111111-1111-4111-8111-111111111111',
          primitiveType: 'action',
          title: 'Do work',
          data: { actor: 'agent', operation: 'mail.read' },
          position: { x: 1, y: 2 },
        },
      ]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);

    const ownerRows = await asUser(owner, async (client) =>
      client.query('select node_id from public.whiteboard_nodes'),
    );
    const strangerRows = await asUser(stranger, async (client) =>
      client.query('select node_id from public.whiteboard_nodes'),
    );
    expect(ownerRows.rowCount).toBe(1);
    expect(strangerRows.rowCount).toBe(0);
  });
});
