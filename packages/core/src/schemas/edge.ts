import { z } from 'zod';

/**
 * Connections live in `whiteboard_edges`, never inside the whiteboard row. Cycles are allowed;
 * a Rule card explains why a branch, wait, retry, or exception path exists.
 */
export const WhiteboardEdgeSchema = z
  .object({
    edgeId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    label: z.string().nullable(),
    condition: z.record(z.string(), z.unknown()).nullable(),
    priority: z.number().int().min(-32768).max(32767),
    rowVersion: z.number().int().positive(),
  })
  .strict();
export type WhiteboardEdge = z.infer<typeof WhiteboardEdgeSchema>;

export const EdgeUpsertSchema = z
  .object({
    edgeId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    label: z.string().nullable().default(null),
    condition: z.record(z.string(), z.unknown()).nullable().default(null),
    priority: z.number().int().min(-32768).max(32767).default(0),
    rowVersion: z.number().int().positive().optional(),
  })
  .strict();
export type EdgeUpsert = z.infer<typeof EdgeUpsertSchema>;
