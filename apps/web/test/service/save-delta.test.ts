import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { saveWhiteboardDelta } from '@/server/services/save-whiteboard-delta';
import { createBoard, ensureUser, serviceClient, userClient, type TestBoard } from './helpers';

/**
 * The save path, as the browser reaches it.
 *
 * Two things are being checked. The first is that a save is one transaction: a delta that touches
 * five nodes and two edges either lands whole or not at all, because a half-applied graph edit is
 * worse than a rejected one — the operator would be looking at a process that never existed.
 *
 * The second is optimistic concurrency. Two people editing one board is the normal case, not the
 * exception, and the resolution has to be a refusal the client can act on rather than a
 * last-writer-wins overwrite that silently discards somebody's work.
 */

const EMAIL = 'save-delta@meridian.test';
const PASSWORD = 'meridian-test-password';

let owner: Awaited<ReturnType<typeof userClient>>;
let ownerId: string;
let board: TestBoard;

beforeAll(async () => {
  ownerId = await ensureUser(EMAIL, PASSWORD);
  owner = await userClient(EMAIL, PASSWORD);
  board = await createBoard(owner);
});

function actionNode(nodeId: string, title: string, rowVersion?: number) {
  return {
    nodeId,
    primitiveType: 'action' as const,
    title,
    data: {
      actor: 'agent',
      operation: 'document.extract',
      instructions: '',
      system: 'documents',
      inputs: [],
      outputs: [],
    },
    position: { x: 120, y: 240 },
    ...(rowVersion === undefined ? {} : { rowVersion }),
  };
}

describe('saveWhiteboardDelta', () => {
  it('advances the board revision by exactly one per save', async () => {
    const before = board.revisionNo;
    const result = await saveWhiteboardDelta(owner, board.whiteboardId, {
      expectedRevisionNo: before,
      nodeUpserts: [actionNode(randomUUID(), 'Check the certificate')],
      nodeDeletes: [],
      edgeUpserts: [],
      edgeDeletes: [],
      viewport: null,
    });
    expect(result.revisionNo).toBe(before + 1);
    board.revisionNo = result.revisionNo;
  });

  it('refuses a save built on a revision somebody else has already replaced', async () => {
    const stale = board.revisionNo - 1;
    await expect(
      saveWhiteboardDelta(owner, board.whiteboardId, {
        expectedRevisionNo: stale,
        nodeUpserts: [actionNode(randomUUID(), 'From a stale tab')],
        nodeDeletes: [],
        edgeUpserts: [],
        edgeDeletes: [],
        viewport: null,
      }),
    ).rejects.toThrow(/STALE_BOARD_REVISION/);
  });

  it('leaves the board untouched when any part of the delta is rejected', async () => {
    const good = randomUUID();
    const before = board.revisionNo;

    await expect(
      saveWhiteboardDelta(owner, board.whiteboardId, {
        expectedRevisionNo: before,
        nodeUpserts: [actionNode(good, 'This one is fine')],
        nodeDeletes: [],
        // An edge to a node that does not exist. The whole delta must fail, including the node
        // that would otherwise have been perfectly acceptable.
        edgeUpserts: [
          {
            edgeId: randomUUID(),
            sourceNodeId: good,
            targetNodeId: randomUUID(),
            label: null,
            condition: null,
            priority: 1,
          },
        ],
        edgeDeletes: [],
        viewport: null,
      }),
    ).rejects.toThrow();

    const { data } = await owner
      .from('whiteboards')
      .select('revision_no')
      .eq('whiteboard_id', board.whiteboardId)
      .single();
    expect(data?.revision_no).toBe(before);

    const { count } = await owner
      .from('whiteboard_nodes')
      .select('node_id', { count: 'exact', head: true })
      .eq('node_id', good);
    expect(count).toBe(0);
  });

  it('rejects a node update that names a stale row version', async () => {
    const nodeId = board.nodeIds[1] as string;
    const { data } = await owner
      .from('whiteboard_nodes')
      .select('row_version')
      .eq('node_id', nodeId)
      .single();
    const current = data?.row_version ?? 1;

    await expect(
      saveWhiteboardDelta(owner, board.whiteboardId, {
        expectedRevisionNo: board.revisionNo,
        nodeUpserts: [actionNode(nodeId, 'Renamed from a stale copy', current - 1)],
        nodeDeletes: [],
        edgeUpserts: [],
        edgeDeletes: [],
        viewport: null,
      }),
    ).rejects.toThrow(/INVALID_ROW_VERSION/);
  });

  it('treats a save with nothing in it as a no-op rather than a new revision', async () => {
    const before = board.revisionNo;
    const result = await saveWhiteboardDelta(owner, board.whiteboardId, {
      expectedRevisionNo: before,
      nodeUpserts: [],
      nodeDeletes: [],
      edgeUpserts: [],
      edgeDeletes: [],
      viewport: null,
    });
    // Autosave fires on a timer, so empty deltas are common. Bumping the revision for each would
    // invalidate every other client's optimistic token for no reason at all.
    expect(result.revisionNo).toBe(before);
  });

  it('refuses a save from someone who does not own the board', async () => {
    const strangerEmail = 'save-delta-stranger@meridian.test';
    await ensureUser(strangerEmail, PASSWORD);
    const stranger = await userClient(strangerEmail, PASSWORD);

    await expect(
      saveWhiteboardDelta(stranger, board.whiteboardId, {
        expectedRevisionNo: board.revisionNo,
        nodeUpserts: [actionNode(randomUUID(), 'Not mine to edit')],
        nodeDeletes: [],
        edgeUpserts: [],
        edgeDeletes: [],
        viewport: null,
      }),
    ).rejects.toThrow(/WHITEBOARD_NOT_FOUND_OR_FORBIDDEN/);
  });

  it('refuses a direct table write even with the service role', async () => {
    // The delta RPC sets a transaction-local marker that the graph tables' triggers check for. A
    // service-role client that tries to write around the RPC is refused, which is what makes "all
    // writes are transactional" a property of the database rather than a habit of the callers.
    const service = serviceClient();
    const { error } = await service.from('whiteboard_nodes').insert({
      node_id: randomUUID(),
      whiteboard_id: board.whiteboardId,
      primitive_type: 'action',
      title: 'Written directly',
      node_data_json: {},
      position_x: 0,
      position_y: 0,
    } as never);
    expect(error?.message ?? '').toMatch(/DIRECT_GRAPH_WRITE|delta/i);
    expect(ownerId).toBeTypeOf('string');
  });
});
