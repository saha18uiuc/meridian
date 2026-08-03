import { z } from 'zod';
import { CommentMetadataSchema } from './comment-metadata.js';
import { AnchorTypeSchema, SeveritySchema } from './review.js';

export const ROOT_COMMENT_STATUSES = ['open', 'answered', 'rejected', 'resolved'] as const;
export const RootCommentStatusSchema = z.enum(ROOT_COMMENT_STATUSES);
export type RootCommentStatus = z.infer<typeof RootCommentStatusSchema>;

export const AUTHOR_TYPES = ['ai', 'user', 'system'] as const;
export const AuthorTypeSchema = z.enum(AUTHOR_TYPES);
export type AuthorType = z.infer<typeof AuthorTypeSchema>;

export const CommentSchema = z
  .object({
    commentId: z.uuid(),
    whiteboardId: z.uuid(),
    reviewSessionId: z.uuid(),
    threadId: z.uuid(),
    parentCommentId: z.uuid().nullable(),
    authorType: AuthorTypeSchema,
    authorUserId: z.uuid().nullable(),
    body: z.string().min(1),
    anchorType: AnchorTypeSchema,
    anchorId: z.uuid().nullable(),
    anchorFieldPath: z.string().nullable(),
    status: RootCommentStatusSchema.nullable(),
    severity: SeveritySchema.nullable(),
    issueKey: z.string().nullable(),
    metadataJson: CommentMetadataSchema.or(z.record(z.string(), z.unknown())),
    suggestedPatchJson: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .strict();
export type Comment = z.infer<typeof CommentSchema>;

export const CommentThreadSchema = z
  .object({ root: CommentSchema, replies: z.array(CommentSchema) })
  .strict();
export type CommentThread = z.infer<typeof CommentThreadSchema>;

export const ReplyRequestSchema = z.object({ body: z.string().trim().min(1) }).strict();
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;

export const RejectRequestSchema = z.object({ reason: z.string().trim().min(1) }).strict();
export type RejectRequest = z.infer<typeof RejectRequestSchema>;

export const ApplyPatchRequestSchema = z
  .object({ expectedRevisionNo: z.number().int().positive() })
  .strict();
export type ApplyPatchRequest = z.infer<typeof ApplyPatchRequestSchema>;

export const AssumptionRequestSchema = z.object({ text: z.string().trim().min(1) }).strict();
export type AssumptionRequest = z.infer<typeof AssumptionRequestSchema>;
