import { z } from 'zod';
import { WhiteboardEdgeSchema } from './edge.js';
import { WhiteboardNodeSchema } from './node.js';

export const BOARD_STATUSES = ['draft', 'review_ready', 'submitted', 'archived'] as const;
export const BoardStatusSchema = z.enum(BOARD_STATUSES);
export type BoardStatus = z.infer<typeof BoardStatusSchema>;

export const ViewportSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  })
  .strict();
export type Viewport = z.infer<typeof ViewportSchema>;

/**
 * The board title is canonical process metadata, not decoration (A19). It enters the canonical
 * snapshot as `metadata.title`, contributes to `source_canvas_hash`, and is carried into
 * `spec_json.identity.name`, which is why renaming participates in revision semantics.
 */
export const BoardMetadataSchema = z
  .object({
    whiteboardId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    status: BoardStatusSchema,
    revisionNo: z.number().int().positive(),
    viewport: ViewportSchema,
  })
  .strict();
export type BoardMetadata = z.infer<typeof BoardMetadataSchema>;

export const BoardListItemSchema = z
  .object({
    whiteboardId: z.uuid(),
    title: z.string(),
    status: BoardStatusSchema,
    revisionNo: z.number().int().positive(),
    lastReviewedRevisionNo: z.number().int().positive().nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type BoardListItem = z.infer<typeof BoardListItemSchema>;

/** The full board the editor reconstructs from three row-based reads. */
export const BoardSchema = z
  .object({
    metadata: BoardMetadataSchema,
    nodes: z.array(WhiteboardNodeSchema),
    edges: z.array(WhiteboardEdgeSchema),
  })
  .strict();
export type Board = z.infer<typeof BoardSchema>;

/**
 * The immutable snapshot stored in `review_sessions.source_canvas_json` and
 * `frozen_specs.source_canvas_json`. It carries no viewport, because pan and zoom are not
 * process content and must not change a canvas hash.
 */
export const CanonicalGraphSchema = z
  .object({
    metadata: z
      .object({
        whiteboardId: z.uuid(),
        title: z.string(),
        status: BoardStatusSchema,
        revisionNo: z.number().int().positive(),
      })
      .strict(),
    nodes: z.array(WhiteboardNodeSchema),
    edges: z.array(WhiteboardEdgeSchema),
  })
  .strict();
export type CanonicalGraph = z.infer<typeof CanonicalGraphSchema>;

export const CreateBoardRequestSchema = z.object({ title: z.string().min(1).max(200) }).strict();
export type CreateBoardRequest = z.infer<typeof CreateBoardRequestSchema>;

export const CreateBoardResponseSchema = z
  .object({
    whiteboardId: z.uuid(),
    revisionNo: z.number().int().positive(),
    status: BoardStatusSchema,
  })
  .strict();
export type CreateBoardResponse = z.infer<typeof CreateBoardResponseSchema>;

export const RenameBoardRequestSchema = z
  .object({
    expectedRevisionNo: z.number().int().positive(),
    title: z.string().min(1).max(400),
  })
  .strict();
export type RenameBoardRequest = z.infer<typeof RenameBoardRequestSchema>;

export const RenameBoardResponseSchema = z
  .object({
    whiteboardId: z.uuid(),
    title: z.string(),
    revisionNo: z.number().int().positive(),
    status: BoardStatusSchema,
    changed: z.boolean(),
  })
  .strict();
export type RenameBoardResponse = z.infer<typeof RenameBoardResponseSchema>;

export const SetBoardStatusRequestSchema = z
  .object({ status: z.enum(['draft', 'archived']) })
  .strict();
export type SetBoardStatusRequest = z.infer<typeof SetBoardStatusRequestSchema>;
