import { z } from 'zod';
import { RESULT_KINDS } from './primitives.js';
import { ActionTypeSchema } from './action.js';

/**
 * `emailPaths` is a list rather than a single path because correlation is the behaviour under
 * test: several of the cases only mean anything when two or more messages land on one shipment.
 * The paths are repository-relative and ordered by delivery time.
 */
export const EvalInputRefsSchema = z
  .object({
    emailPaths: z.array(z.string().min(1)).min(1),
    attachmentPaths: z.array(z.string().min(1)).default([]),
    expectedPath: z.string().min(1),
  })
  .strict();
export type EvalInputRefs = z.infer<typeof EvalInputRefsSchema>;

export const ExpectedExternalActionSchema = z
  .object({
    actionType: ActionTypeSchema,
    count: z.number().int().nonnegative(),
    /** Asserted against `execution_actions.status` for every matching row. */
    finalStatus: z.enum(['succeeded', 'failed', 'abandoned']).default('succeeded'),
  })
  .strict();
export type ExpectedExternalAction = z.infer<typeof ExpectedExternalActionSchema>;

export const EvalExpectationSchema = z
  .object({
    outcome: z.enum(RESULT_KINDS),
    missingFields: z.array(z.string()).optional(),
    externalActions: z.array(ExpectedExternalActionSchema).optional(),
    businessKey: z.string().nullable().optional(),
    /** Logical step identity (§5.9). Never `sequence_no`, which is display ordering only. */
    stepInstanceKeys: z.array(z.string().min(1)).optional(),
    evidenceKeys: z.array(z.string().min(1)).optional(),
    retries: z.record(z.string(), z.number().int().nonnegative()).optional(),
    humanDecisionRequired: z.boolean().optional(),
    /**
     * Set when the case documents behaviour the frozen spec does not state. The repair loop treats
     * such a failure as a policy gap and stops, instead of editing code to satisfy an expectation
     * nobody has agreed to.
     */
    knownGap: z.boolean().optional(),
  })
  .strict();
export type EvalExpectation = z.infer<typeof EvalExpectationSchema>;

export const EvalCaseSchema = z
  .object({
    caseKey: z.string().regex(/^case-\d{2}$/),
    description: z.string().min(1),
    /**
     * Every expectation must trace to a statement in the frozen spec. A case that encodes policy
     * the spec does not state is a known gap, not a passing assertion.
     */
    specTrace: z.string().min(1),
    inputRefs: EvalInputRefsSchema,
    expected: EvalExpectationSchema,
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EVAL_RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'error'] as const;
export const EvalRunStatusSchema = z.enum(EVAL_RUN_STATUSES);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

export const StartEvalRunRequestSchema = z
  .object({
    /** Absent means the whole suite. An empty array is rejected rather than silently meaning all. */
    caseKeys: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type StartEvalRunRequest = z.infer<typeof StartEvalRunRequestSchema>;

export const StartEvalRunResponseSchema = z
  .object({
    evalRunId: z.uuid(),
    status: z.literal('queued'),
    caseCount: z.number().int().nonnegative(),
    wasExisting: z.boolean(),
  })
  .strict();
export type StartEvalRunResponse = z.infer<typeof StartEvalRunResponseSchema>;

export const EvalRunCaseSchema = z
  .object({
    caseKey: z.string().min(1),
    executionId: z.uuid(),
    status: EvalRunStatusSchema,
    failureClass: z.string().nullable(),
  })
  .strict();

export const EvalRunStatusResponseSchema = z
  .object({
    evalRunId: z.uuid(),
    agentVersionId: z.uuid(),
    /** Aggregated: `running` while any case is unfinished, otherwise the worst terminal state. */
    status: EvalRunStatusSchema,
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    cases: z.array(EvalRunCaseSchema),
  })
  .strict();
export type EvalRunStatusResponse = z.infer<typeof EvalRunStatusResponseSchema>;

export const FAILURE_CLASSES = [
  'extraction',
  'implementation',
  'policy_gap',
  'tool_infrastructure',
] as const;
export const FailureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClassSchema>;
