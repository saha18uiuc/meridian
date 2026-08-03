import { z } from 'zod';

/**
 * The fourteen deterministic checks (§5.5.2). Each is a pure function over a `CanonicalGraph`,
 * so a model outage still yields a full deterministic finding set.
 */
export const CHECK_CODES = [
  'DISCONNECTED_NODE',
  'UNREACHABLE_OUTCOME',
  'MISSING_INITIAL_PATH',
  'MISSING_TERMINAL_PATH',
  'UNLABELED_RULE_BRANCH',
  'MISSING_REQUIRED_PRIMITIVE_FIELD',
  'INVALID_EDGE_REFERENCE',
  'ORPHANED_EXCEPTION_PATH',
  'ACTION_WITHOUT_ACTOR',
  'ACTION_WITHOUT_SYSTEM',
  'RULE_INVALID_BRANCH_CONFIG',
  'RETRY_RULE_WITHOUT_MAX_ATTEMPTS',
  'WAIT_RULE_WITHOUT_TIMEOUT',
  'UNKNOWN_CAPABILITY',
] as const;
export const CheckCodeSchema = z.enum(CHECK_CODES);
export type CheckCode = z.infer<typeof CheckCodeSchema>;

/**
 * The closed list of eighteen codes a model may return (§5.5.3). Because this is an enum in the
 * Structured Outputs schema, the model cannot invent a code, which is what makes `issue_key`
 * stable across rounds.
 */
export const NORMALIZED_ISSUE_CODES = [
  'ambiguous_business_rule',
  'missing_data_requirement',
  'contradictory_requirement',
  'undefined_actor_responsibility',
  'unspecified_error_handling',
  'unspecified_timeout_behaviour',
  'unspecified_retry_policy',
  'missing_escalation_path',
  'unclear_branch_condition',
  'duplicate_or_overlapping_logic',
  'unvalidated_external_input',
  'missing_correlation_key',
  'unbounded_wait',
  'missing_acceptance_criteria',
  'undefined_output_contract',
  'compliance_or_policy_gap',
  'unclear_deduplication_rule',
  'unspecified_document_source',
] as const;
export const NormalizedIssueCodeSchema = z.enum(NORMALIZED_ISSUE_CODES);
export type NormalizedIssueCode = z.infer<typeof NormalizedIssueCodeSchema>;

export const ANCHOR_TYPES = ['node', 'edge', 'canvas'] as const;
export const AnchorTypeSchema = z.enum(ANCHOR_TYPES);
export type AnchorType = z.infer<typeof AnchorTypeSchema>;

export const SEVERITIES = ['blocking', 'non_blocking'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const FINDING_ORIGINS = ['deterministic', 'model'] as const;
export const FindingOriginSchema = z.enum(FINDING_ORIGINS);
export type FindingOrigin = z.infer<typeof FindingOriginSchema>;

/** One collapsed finding, ready to be handed to `finalize_review_session`. */
export const FindingSchema = z
  .object({
    issueKey: z.string().min(1),
    checkCode: CheckCodeSchema.nullable(),
    normalizedIssueCode: NormalizedIssueCodeSchema.nullable(),
    origin: FindingOriginSchema,
    anchorType: AnchorTypeSchema,
    anchorId: z.uuid().nullable(),
    anchorFieldPath: z.string().nullable(),
    severity: SeveritySchema,
    body: z.string().min(1),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

/**
 * The Structured Outputs schema handed to `zodTextFormat`. It is a root `z.object()` with a
 * closed enum for the issue code, so the model physically cannot return a code the issue-key
 * derivation does not understand.
 */
export const ModelFindingSchema = z
  .object({
    normalizedIssueCode: NormalizedIssueCodeSchema,
    anchorType: AnchorTypeSchema,
    anchorId: z.string().nullable(),
    anchorFieldPath: z.string().nullable(),
    severity: SeveritySchema,
    body: z.string(),
  })
  .strict();
export type ModelFinding = z.infer<typeof ModelFindingSchema>;

export const ReviewOutputSchema = z
  .object({
    findings: z.array(ModelFindingSchema),
    summary: z.string(),
  })
  .strict();
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const REVIEW_SESSION_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export const ReviewSessionStatusSchema = z.enum(REVIEW_SESSION_STATUSES);
export type ReviewSessionStatus = z.infer<typeof ReviewSessionStatusSchema>;

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * The review request body. It deliberately has no `sourceCanvasJson` or `sourceCanvasHash`
 * field, so a forged authoritative artifact is a 400 from `.strict()` rather than a value the
 * server silently ignores (A21).
 */
export const StartReviewRequestSchema = z
  .object({ expectedRevisionNo: z.number().int().positive() })
  .strict();
export type StartReviewRequest = z.infer<typeof StartReviewRequestSchema>;

export const ReviewCountsSchema = z
  .object({
    inserted: z.number().int().nonnegative(),
    recurred: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewCounts = z.infer<typeof ReviewCountsSchema>;

export const ReviewResultResponseSchema = z
  .object({
    reviewSessionId: z.uuid(),
    roundNo: z.number().int().positive(),
    sourceRevisionNo: z.number().int().positive(),
    sourceCanvasHash: z.string().length(64),
    modelName: z.string(),
    reasoningEffort: ReasoningEffortSchema,
    status: z.enum(['completed', 'failed']),
    counts: ReviewCountsSchema,
    findings: z.array(FindingSchema),
    errorJson: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type ReviewResultResponse = z.infer<typeof ReviewResultResponseSchema>;
