import { z } from 'zod';
import { PrimitiveTypeSchema } from './primitives.js';

export const PositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();
export type Position = z.infer<typeof PositionSchema>;

/** A node as it exists on the board and in a canonical snapshot. */
export const WhiteboardNodeSchema = z
  .object({
    nodeId: z.uuid(),
    primitiveType: PrimitiveTypeSchema,
    title: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()),
    position: PositionSchema,
    rowVersion: z.number().int().positive(),
  })
  .strict();
export type WhiteboardNode = z.infer<typeof WhiteboardNodeSchema>;

/** A node inside a delta. `rowVersion` present means update; absent means insert. */
export const NodeUpsertSchema = z
  .object({
    nodeId: z.uuid(),
    primitiveType: PrimitiveTypeSchema,
    title: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()),
    position: PositionSchema,
    rowVersion: z.number().int().positive().optional(),
  })
  .strict();
export type NodeUpsert = z.infer<typeof NodeUpsertSchema>;
