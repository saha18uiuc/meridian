import { z } from 'zod';
import { FindingOriginSchema } from './review.js';

/**
 * Structured comment metadata (§5.5.4, A11).
 *
 * Every consumer — the compiler, the review reconciler, and the eval-repair skill — reads
 * `metadata_json` and nothing else. No component anywhere may classify a comment by inspecting
 * its body text; `pnpm verify` greps for body-prefix parsing and fails if it finds any.
 */
export const CommentMetadataSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('review_issue'),
      issueKey: z.string().min(1),
      checkCode: z.string().nullable(),
      origin: FindingOriginSchema,
    })
    .strict(),
  z.object({ kind: z.literal('reply') }).strict(),
  z.object({ kind: z.literal('rejection'), reason: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('graph_patch'),
      patchVersion: z.literal(1),
      appliedRevisionNo: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('assumption'),
      assumptionText: z.string().min(1),
      sourceRootCommentId: z.uuid(),
      supersedesCommentId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('policy_gap'),
      evalRunId: z.string().min(1),
      failureKey: z.string().min(1),
      agentVersionId: z.uuid(),
    })
    .strict(),
  // Recurrence notices are written by `finalize_review_session` as system replies. They carry no
  // policy meaning, but they must still parse, so the union stays exhaustive.
  z
    .object({
      kind: z.literal('recurrence'),
      issueKey: z.string().min(1),
      reviewSessionId: z.uuid(),
    })
    .strict(),
]);
export type CommentMetadata = z.infer<typeof CommentMetadataSchema>;

export type AssumptionMetadata = Extract<CommentMetadata, { kind: 'assumption' }>;
export type PolicyGapMetadata = Extract<CommentMetadata, { kind: 'policy_gap' }>;

/** Tolerant read: unknown or malformed metadata degrades to `null` rather than throwing. */
export function parseCommentMetadata(value: unknown): CommentMetadata | null {
  const result = CommentMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}
