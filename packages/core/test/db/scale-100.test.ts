import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleCanonicalGraph, deriveCanvasHash } from '../../src/graph.js';

import {
  asPostgres,
  asUser,
  buildSnapshot,
  closePool,
  createTestUsers,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';

/**
 * A hundred-node board, which is the size the brief asks the canvas to stay usable at.
 *
 * The claim being tested is not that the database is fast — it is that nothing in the design
 * degrades non-linearly with board size. Two things could: the delta path, if it rewrote the whole
 * graph on every save, and the snapshot path, if canonicalization were order-dependent and had to
 * sort repeatedly. Both are checked here against a real board rather than a microbenchmark.
 *
 * The timing assertions are deliberately loose. A tight budget on a developer laptop measures the
 * laptop; these numbers exist to catch a change of complexity class, not a change of milliseconds.
 */

const NODE_COUNT = 100;

let owner: string;
let boardId: string;
let nodeIds: string[];
let revisionNo: number;

beforeAll(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  const created = await rpcAsUser<{ whiteboardId: string }>(owner, 'create_whiteboard', [
    'Hundred node process',
  ]);
  boardId = created.whiteboardId;

  // A realistic shape rather than a hundred disconnected nodes: one input, a long spine of
  // alternating rules and actions, and a terminal outcome.
  nodeIds = Array.from({ length: NODE_COUNT }, () => randomUUID());
  const nodes = nodeIds.map((nodeId, index) => {
    if (index === 0) {
      return {
        nodeId,
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
      };
    }
    if (index === NODE_COUNT - 1) {
      return {
        nodeId,
        primitiveType: 'outcome',
        title: 'Ready for entry',
        data: { resultKind: 'ready', terminal: true },
        position: { x: index * 120, y: 0 },
      };
    }
    if (index % 2 === 1) {
      return {
        nodeId,
        primitiveType: 'rule',
        title: `Check ${String(index)}`,
        data: {
          ruleKind: 'validation',
          expression: `field_${String(index)} is present`,
          onFailure: 'flag',
        },
        position: { x: index * 120, y: 0 },
      };
    }
    return {
      nodeId,
      primitiveType: 'action',
      title: `Step ${String(index)}`,
      data: {
        actor: 'agent',
        operation: 'document.extract',
        instructions: '',
        system: 'ocr',
        inputs: [],
        outputs: [],
      },
      position: { x: index * 120, y: 0 },
    };
  });

  const edges = nodeIds.slice(0, -1).map((nodeId, index) => ({
    edgeId: randomUUID(),
    sourceNodeId: nodeId,
    targetNodeId: nodeIds[index + 1] as string,
    priority: 0,
  }));

  const result = await rpcAsUser<{ revisionNo: number }>(owner, 'save_whiteboard_delta', [
    boardId,
    1,
    JSON.stringify(nodes),
    [],
    JSON.stringify(edges),
    [],
    null,
  ]);
  revisionNo = result.revisionNo;
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

describe('a hundred-node board', () => {
  it('is created in one revision, not one per node', async () => {
    // The board moves from revision 1 to revision 2 for the whole batch. A per-node revision would
    // make every save O(n) round trips and make optimistic concurrency useless.
    expect(revisionNo).toBe(2);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ nodes: string; edges: string }>(
        `select (select count(*) from public.whiteboard_nodes where whiteboard_id = $1) as nodes,
                (select count(*) from public.whiteboard_edges where whiteboard_id = $1) as edges`,
        [boardId],
      ),
    );
    expect(rows[0]?.nodes).toBe(String(NODE_COUNT));
    expect(rows[0]?.edges).toBe(String(NODE_COUNT - 1));
  });

  it('touches only the nodes a partial save names', async () => {
    const before = await asPostgres(async (client) =>
      client.query<{ node_id: string; row_version: number }>(
        'select node_id, row_version from public.whiteboard_nodes where whiteboard_id = $1',
        [boardId],
      ),
    );
    const target = nodeIds[42] as string;

    const saved = await rpcAsUser<{ revisionNo: number }>(owner, 'save_whiteboard_delta', [
      boardId,
      revisionNo,
      JSON.stringify([
        {
          nodeId: target,
          primitiveType: 'action',
          title: 'Step 42, renamed',
          data: {
            actor: 'agent',
            operation: 'document.extract',
            instructions: '',
            system: 'ocr',
            inputs: [],
            outputs: [],
          },
          position: { x: 42 * 120, y: 0 },
          rowVersion: before.rows.find((row) => row.node_id === target)?.row_version,
        },
      ]),
      [],
      JSON.stringify([]),
      [],
      null,
    ]);
    revisionNo = saved.revisionNo;

    const after = await asPostgres(async (client) =>
      client.query<{ node_id: string; row_version: number }>(
        'select node_id, row_version from public.whiteboard_nodes where whiteboard_id = $1',
        [boardId],
      ),
    );
    const bumped = after.rows.filter((row) => {
      const previous = before.rows.find((other) => other.node_id === row.node_id);
      return previous !== undefined && previous.row_version !== row.row_version;
    });
    // One node changed, so exactly one row version moved. If the delta rewrote the graph, all
    // hundred would have moved and every other client's cached row versions would be stale.
    expect(bumped.map((row) => row.node_id)).toEqual([target]);
  });

  it('canonicalizes the whole board to a stable hash', async () => {
    const first = await buildSnapshot(boardId);
    const second = await buildSnapshot(boardId);
    expect(second.hash).toBe(first.hash);
    expect(first.snapshot.nodes).toHaveLength(NODE_COUNT);
  });

  it('produces the same hash however the rows come back from the database', async () => {
    // Canonicalization sorts, so a different physical row order must not change the digest. This
    // is what lets the client and the server agree on a hash without agreeing on a query plan.
    const { snapshot, hash } = await buildSnapshot(boardId);
    const shuffled = assembleCanonicalGraph(
      snapshot.metadata,
      [...snapshot.nodes].reverse(),
      [...snapshot.edges].reverse(),
    );
    expect(deriveCanvasHash(shuffled)).toBe(hash);
  });

  it('reads the whole board in one query as its owner', async () => {
    const started = performance.now();
    const rows = await asUser(owner, async (client) => {
      const result = await client.query(
        `select n.node_id from public.whiteboard_nodes n where n.whiteboard_id = $1`,
        [boardId],
      );
      return result.rowCount;
    });
    const elapsed = performance.now() - started;
    expect(rows).toBe(NODE_COUNT);
    // Row-level security adds a subquery per row in the worst case. A hundred rows in under a
    // second says the planner turned it into a join instead, which is the property that matters.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('freezes a hundred-node board without special handling', async () => {
    const { snapshot, hash, revisionNo: current } = await buildSnapshot(boardId);
    expect(deriveCanvasHash(snapshot)).toBe(hash);
    expect(current).toBe(revisionNo);
  });
});
