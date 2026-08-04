import { z } from 'zod';

/**
 * The four whiteboard primitives (§5.2), unchanged from the PRD baseline.
 *
 *   Input   = Event + Information
 *   Action  = Task + System + Human Handoff
 *   Rule    = Decision + Wait + retry/exception behaviour
 *   Outcome = the meaningful result
 *
 * There are exactly four. Adding a fifth is a contract change, not an implementation detail.
 */

export const PRIMITIVE_TYPES = ['input', 'action', 'rule', 'outcome'] as const;
export const PrimitiveTypeSchema = z.enum(PRIMITIVE_TYPES);
export type PrimitiveType = z.infer<typeof PrimitiveTypeSchema>;

const nonEmpty = z.string().trim().min(1);

// ------------------------------------------------------------------------------------- Input

export const INPUT_KINDS = ['event', 'document', 'data'] as const;
export const InputKindSchema = z.enum(INPUT_KINDS);

export const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum'] as const;

export const FieldSpecSchema = z
  .object({
    name: nonEmpty,
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    description: z.string().optional(),
  })
  .strict();
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const InputDataSchema = z
  .object({
    inputKind: InputKindSchema,
    sourceSystem: z.string().default(''),
    /**
     * Retained so existing boards parse; no longer offered as a control and read by nothing.
     *
     * It claims "the process cannot run without this input", and on the reference board it is
     * `true` on all four inputs — including the certificate of analysis, which the board's own
     * decision Rule handles the absence of by routing to `needs_information`. So the flag asserts
     * something the graph beside it disproves, which is worse than an unread field: compiling it
     * would have written the contradiction into the spec.
     *
     * Whether an input is indispensable is already expressed twice, and both times by something
     * that cannot drift from the process: `fields[].required` per value, and the presence of a
     * downstream Rule branch that handles its absence. The field is dropped from the schema at the
     * next spec version, because removing it now would rewrite stored node data and every hash
     * derived from it for no gain.
     */
    required: z.boolean().default(true),
    /** Order is author-meaningful and is preserved into the hash. */
    fields: z.array(FieldSpecSchema).default([]),
    /** Order is author-meaningful and is preserved into the hash. */
    correlationKeys: z.array(nonEmpty).default([]),
  })
  .strict();
export type InputData = z.infer<typeof InputDataSchema>;

// ------------------------------------------------------------------------------------ Action

export const ACTORS = ['agent', 'human', 'system'] as const;
export const ActorSchema = z.enum(ACTORS);

export const ActionDataSchema = z
  .object({
    actor: ActorSchema,
    operation: nonEmpty,
    instructions: z.string().default(''),
    system: z.string().default(''),
    inputs: z.array(nonEmpty).default([]),
    outputs: z.array(nonEmpty).default([]),
  })
  .strict();
export type ActionData = z.infer<typeof ActionDataSchema>;

// -------------------------------------------------------------------------------------- Rule

export const RULE_KINDS = ['decision', 'wait', 'retry', 'exception'] as const;
export const RuleKindSchema = z.enum(RULE_KINDS);

export const BranchSpecSchema = z
  .object({
    label: nonEmpty,
    condition: z.string().default(''),
    targetNodeId: z.uuid().nullable().default(null),
  })
  .strict();
export type BranchSpec = z.infer<typeof BranchSpecSchema>;

export const RuleDataSchema = z
  .object({
    ruleKind: RuleKindSchema,
    condition: z.string().default(''),
    branches: z.array(BranchSpecSchema).default([]),
    timeoutMinutes: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    fallbackNodeId: z.uuid().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A retry rule with no attempt bound and a wait rule with no deadline are both unrunnable;
    // the deterministic review checks report them, and the schema refuses to construct them.
    if (value.ruleKind === 'retry' && value.maxAttempts === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxAttempts'],
        message: "maxAttempts is required when ruleKind is 'retry'",
      });
    }
    if (value.ruleKind === 'wait' && value.timeoutMinutes === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeoutMinutes'],
        message: "timeoutMinutes is required when ruleKind is 'wait'",
      });
    }
  });
export type RuleData = z.infer<typeof RuleDataSchema>;

// ----------------------------------------------------------------------------------- Outcome

export const RESULT_KINDS = [
  'ready',
  'needs_information',
  'manual_review',
  'rejected',
  'completed',
] as const;
export const ResultKindSchema = z.enum(RESULT_KINDS);

export const RequiredActionSchema = z
  .object({
    actionType: nonEmpty,
    description: z.string().default(''),
    capability: z.string().optional(),
  })
  .strict();
export type RequiredAction = z.infer<typeof RequiredActionSchema>;

export const OutcomeDataSchema = z
  .object({
    resultKind: ResultKindSchema,
    terminal: z.boolean().default(false),
    requiredAction: RequiredActionSchema.optional(),
  })
  .strict();
export type OutcomeData = z.infer<typeof OutcomeDataSchema>;

// ----------------------------------------------------------------------------- discriminated

export const NodeDataSchema = z.discriminatedUnion('primitiveType', [
  z.object({ primitiveType: z.literal('input'), data: InputDataSchema }),
  z.object({ primitiveType: z.literal('action'), data: ActionDataSchema }),
  z.object({ primitiveType: z.literal('rule'), data: RuleDataSchema }),
  z.object({ primitiveType: z.literal('outcome'), data: OutcomeDataSchema }),
]);
export type NodeDataUnion = z.infer<typeof NodeDataSchema>;

/** Validate a node's `node_data_json` against the schema its `primitive_type` selects. */
export function parseNodeData(primitiveType: PrimitiveType, data: unknown) {
  switch (primitiveType) {
    case 'input':
      return InputDataSchema.parse(data);
    case 'action':
      return ActionDataSchema.parse(data);
    case 'rule':
      return RuleDataSchema.parse(data);
    case 'outcome':
      return OutcomeDataSchema.parse(data);
  }
}

export function safeParseNodeData(primitiveType: PrimitiveType, data: unknown) {
  switch (primitiveType) {
    case 'input':
      return InputDataSchema.safeParse(data);
    case 'action':
      return ActionDataSchema.safeParse(data);
    case 'rule':
      return RuleDataSchema.safeParse(data);
    case 'outcome':
      return OutcomeDataSchema.safeParse(data);
  }
}
