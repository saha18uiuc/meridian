import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';

/**
 * The empty-array contract.
 *
 * `array_length('{}'::uuid[], 1)` is `NULL`, not `0`, so a duplicate check written as
 * `array_length(x, 1) <> cardinality(distinct …)` rejects the perfectly ordinary case of "this
 * delta only touches nodes". Every comparison in the RPC therefore wraps the call in `coalesce`,
 * and these cases exist to make a regression to the bare form fail loudly rather than surface as
 * a mysterious `DUPLICATE_ID_IN_DELTA` during a normal edit.
 */

let owner: string;
let boardId: string;

type DeltaResult = { revisionNo: number; changed: boolean };

function delta(
  revision: number,
  overrides: {
    nodeUpserts?: unknown[];
    nodeDeletes?: string[] | null;
    edgeUpserts?: unknown[];
    edgeDeletes?: string[] | null;
  } = {},
): Promise<DeltaResult> {
  return rpcAsUser<DeltaResult>(owner, 'save_whiteboard_delta', [
    boardId,
    revision,
    JSON.stringify(overrides.nodeUpserts ?? []),
    overrides.nodeDeletes === undefined ? [] : overrides.nodeDeletes,
    JSON.stringify(overrides.edgeUpserts ?? []),
    overrides.edgeDeletes === undefined ? [] : overrides.edgeDeletes,
    null,
  ]);
}

function inputNode(nodeId: string): Record<string, unknown> {
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

describe('empty and NULL array parameters', () => {
  it('accepts empty arrays for all four parameters', async () => {
    await expect(delta(1)).resolves.toMatchObject({ changed: false, revisionNo: 1 });
  });

  it('accepts NULL for all four array parameters', async () => {
    await expect(delta(1, { nodeDeletes: null, edgeDeletes: null })).resolves.toMatchObject({
      changed: false,
      revisionNo: 1,
    });
  });

  it('accepts an empty delete array alongside a real node upsert', async () => {
    const result = await delta(1, { nodeUpserts: [inputNode(randomUUID())], nodeDeletes: [] });
    expect(result).toMatchObject({ changed: true, revisionNo: 2 });
  });

  it('accepts a NULL delete array alongside a real node upsert', async () => {
    const result = await delta(1, { nodeUpserts: [inputNode(randomUUID())], nodeDeletes: null });
    expect(result).toMatchObject({ changed: true, revisionNo: 2 });
  });

  it('accepts a single-element delete array', async () => {
    const nodeId = randomUUID();
    await delta(1, { nodeUpserts: [inputNode(nodeId)] });
    await expect(delta(2, { nodeDeletes: [nodeId] })).resolves.toMatchObject({ changed: true });
  });

  it('still rejects a genuinely duplicated id, proving coalesce did not weaken the check', async () => {
    const nodeId = randomUUID();
    await delta(1, { nodeUpserts: [inputNode(nodeId)] });
    await expectPgError(delta(2, { nodeDeletes: [nodeId, nodeId] }), 'DUPLICATE_ID_IN_DELTA');
  });

  it('leaves revision_no untouched for both the all-empty and the all-NULL delta', async () => {
    await delta(1);
    const second = await delta(1, { nodeDeletes: null, edgeDeletes: null });
    expect(second.revisionNo).toBe(1);
    expect(second.changed).toBe(false);
  });
});

describe('the migration source', () => {
  it('wraps every array_length comparison in coalesce', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../../supabase/migrations/0003_whiteboard_rpcs.sql', import.meta.url),
      ),
      'utf8',
    )
      // The comment above the guard names the bare form in prose, so counting it as code would
      // make this assertion permanently red for the wrong reason.
      .replaceAll(/^\s*--.*$/gm, '');
    const total = source.match(/array_length\(/g)?.length ?? 0;
    const guarded = source.match(/coalesce\(array_length\(/g)?.length ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(guarded).toBe(total);
  });
});
