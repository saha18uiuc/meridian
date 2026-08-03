import { z } from 'zod';
import { ViewportSchema } from './board.js';
import { EdgeUpsertSchema } from './edge.js';
import { NodeUpsertSchema } from './node.js';

/**
 * The transactional delta (§5.3). The client mirrors the server's shape rules so it can never
 * construct a payload `save_whiteboard_delta` would reject for shape reasons; the RPC still
 * re-validates every one of them, because the client is not trusted.
 */

function findDuplicate(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

function findIntersection(a: readonly string[], b: readonly string[]): string | null {
  const set = new Set(a);
  for (const id of b) if (set.has(id)) return id;
  return null;
}

export const WhiteboardDeltaRequestSchema = z
  .object({
    expectedRevisionNo: z.number().int().positive(),
    nodeUpserts: z.array(NodeUpsertSchema).default([]),
    nodeDeletes: z.array(z.uuid()).default([]),
    edgeUpserts: z.array(EdgeUpsertSchema).default([]),
    edgeDeletes: z.array(z.uuid()).default([]),
    /**
     * Absent and `null` both mean "leave the viewport alone", because a JSON client has no way to
     * send `undefined` and rejecting the only spelling available over the wire would be a contract
     * that cannot be honoured. `saveWhiteboardDelta` passes either through to the RPC as SQL NULL,
     * which is already how the RPC spells an unchanged viewport.
     */
    viewport: ViewportSchema.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodeUpsertIds = value.nodeUpserts.map((n) => n.nodeId);
    const edgeUpsertIds = value.edgeUpserts.map((e) => e.edgeId);

    for (const [path, ids] of [
      ['nodeUpserts', nodeUpsertIds],
      ['nodeDeletes', value.nodeDeletes],
      ['edgeUpserts', edgeUpsertIds],
      ['edgeDeletes', value.edgeDeletes],
    ] as const) {
      const duplicate = findDuplicate(ids);
      if (duplicate !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: `DUPLICATE_ID_IN_DELTA: ${duplicate}`,
        });
      }
    }

    const nodeCollision = findIntersection(nodeUpsertIds, value.nodeDeletes);
    if (nodeCollision !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodeDeletes'],
        message: `ID_IN_UPSERT_AND_DELETE: ${nodeCollision}`,
      });
    }

    const edgeCollision = findIntersection(edgeUpsertIds, value.edgeDeletes);
    if (edgeCollision !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['edgeDeletes'],
        message: `ID_IN_UPSERT_AND_DELETE: ${edgeCollision}`,
      });
    }
  });
export type WhiteboardDeltaRequest = z.infer<typeof WhiteboardDeltaRequestSchema>;

export const WhiteboardDeltaResponseSchema = z
  .object({
    revisionNo: z.number().int().positive(),
    changed: z.boolean(),
    nodeRowVersions: z.record(z.string(), z.number().int().positive()),
    edgeRowVersions: z.record(z.string(), z.number().int().positive()),
  })
  .strict();
export type WhiteboardDeltaResponse = z.infer<typeof WhiteboardDeltaResponseSchema>;
