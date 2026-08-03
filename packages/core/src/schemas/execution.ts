import { z } from 'zod';

export const RUN_TYPES = ['eval', 'live'] as const;
export const RunTypeSchema = z.enum(RUN_TYPES);
export type RunType = z.infer<typeof RunTypeSchema>;

export const EXECUTION_STATUSES = ['queued', 'running', 'passed', 'failed', 'error'] as const;
export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const MANUAL_REVIEW_REASONS = ['NO_BUSINESS_KEY', 'CONFLICTING_BUSINESS_KEYS'] as const;
export const ManualReviewReasonSchema = z.enum(MANUAL_REVIEW_REASONS);
export type ManualReviewReason = z.infer<typeof ManualReviewReasonSchema>;

export const ExecutionSchema = z
  .object({
    executionId: z.uuid(),
    agentId: z.uuid(),
    agentVersionId: z.uuid(),
    runType: RunTypeSchema,
    caseKey: z.string(),
    businessKey: z.string().nullable(),
    temporalWorkflowId: z.string().nullable(),
    temporalRunId: z.string().nullable(),
    idempotencyKey: z.string().length(64),
    status: ExecutionStatusSchema,
    inputRefJson: z.record(z.string(), z.unknown()),
    expectedSummaryJson: z.record(z.string(), z.unknown()).nullable(),
    outputSummaryJson: z.record(z.string(), z.unknown()).nullable(),
    diffSummaryJson: z.record(z.string(), z.unknown()).nullable(),
    errorJson: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type Execution = z.infer<typeof ExecutionSchema>;

export const MessageRefSchema = z
  .object({
    provider: z.enum(['gmail', 'mock']),
    providerMessageId: z.string().min(1),
    threadId: z.string().min(1),
    subject: z.string(),
    receivedAt: z.string(),
    storagePath: z.string().nullable().default(null),
  })
  .strict();
export type MessageRef = z.infer<typeof MessageRefSchema>;

/**
 * The message body travels with the reference because business-key extraction runs before any
 * workflow exists and therefore cannot fetch the message itself. Everything is optional so a caller
 * that only has the reference still gets a well-defined result — an empty body simply yields
 * `NO_BUSINESS_KEY` and a manual-review execution rather than a crash.
 */
export const MessageContentSchema = z
  .object({
    subject: z.string().optional(),
    bodyText: z.string().optional(),
    attachmentFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type MessageContent = z.infer<typeof MessageContentSchema>;

export const StartLiveRunRequestSchema = z
  .object({
    agentId: z.uuid(),
    messageRef: MessageRefSchema,
    content: MessageContentSchema.default({}),
  })
  .strict();
export type StartLiveRunRequest = z.infer<typeof StartLiveRunRequestSchema>;

export const StartLiveRunResponseSchema = z
  .object({
    executionId: z.uuid(),
    temporalWorkflowId: z.string().nullable(),
    temporalRunId: z.string().nullable(),
    wasExisting: z.boolean(),
    // `already_processed` is the redelivery answer: this exact message has an execution that has
    // already finished, so no run is started and the caller is pointed at the run that happened.
    action: z.enum(['started', 'signalled', 'manual_review', 'already_processed']),
  })
  .strict();
export type StartLiveRunResponse = z.infer<typeof StartLiveRunResponseSchema>;

export const HumanDecisionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.string().min(1),
    /** Absent and `null` both mean the operator left no note; JSON cannot spell `undefined`. */
    notes: z.string().nullish(),
  })
  .strict();
export type HumanDecisionRequest = z.infer<typeof HumanDecisionRequestSchema>;
