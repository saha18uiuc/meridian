import { z } from 'zod';

export const STEP_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/**
 * Step identity (§5.9, A6).
 *
 *   step_key          the stable operation type, e.g. `validate_invoice_good`
 *   step_instance_key one logical instance in one execution, e.g. `validate-good:INV-1024:LINE-7`
 *   attempt_no        retries of that instance
 *   sequence_no       a NON-UNIQUE display ordinal, assigned deterministically before scheduling
 *
 * Parallel siblings legitimately share `sequence_no`, which is why it carries no unique
 * constraint and is never used as an identity.
 */
export const ExecutionStepSchema = z
  .object({
    stepExecutionId: z.uuid(),
    executionId: z.uuid(),
    nodeId: z.uuid().nullable(),
    stepKey: z.string().min(1),
    stepInstanceKey: z.string().min(1),
    sequenceNo: z.number().int().positive(),
    attemptNo: z.number().int().positive(),
    status: StepStatusSchema,
    inputSummaryJson: z.record(z.string(), z.unknown()),
    outputSummaryJson: z.record(z.string(), z.unknown()),
    errorJson: z.record(z.string(), z.unknown()).nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;

export const StartStepInputSchema = z
  .object({
    nodeId: z.uuid().nullable(),
    stepKey: z.string().min(1),
    stepInstanceKey: z.string().min(1),
    sequenceNo: z.number().int().positive(),
    attemptNo: z.number().int().positive().default(1),
    inputSummary: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type StartStepInput = z.infer<typeof StartStepInputSchema>;
