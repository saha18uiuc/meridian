import { z } from 'zod';
import { PrimitiveTypeSchema } from './primitives.js';
import { SeveritySchema } from './review.js';

/**
 * The frozen specification contract (§5.6). `spec_json` is the immutable, implementation-ready
 * artifact an agent version is generated from, and `spec_hash` binds that version to it.
 */

export const KNOWN_CAPABILITIES = [
  'mail.read',
  'mail.send',
  'browser.read',
  'browser.write',
  'document.extract',
  'human.handoff',
] as const;
export const CapabilitySchema = z.enum(KNOWN_CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/;

/**
 * An Action's `operation` doubles as its capability declaration when it is written in
 * `namespace.verb` form, which is how a card says "this step needs a runtime capability"
 * without adding a fifth primitive field. Free-text operations are left alone.
 */
export function looksLikeCapability(value: string): boolean {
  return CAPABILITY_PATTERN.test(value);
}

export function isKnownCapability(value: string): value is Capability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

export const SpecNodeSchema = z
  .object({
    nodeId: z.uuid(),
    primitiveType: PrimitiveTypeSchema,
    title: z.string(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SpecNode = z.infer<typeof SpecNodeSchema>;

export const SpecTransitionSchema = z
  .object({
    edgeId: z.uuid(),
    from: z.uuid(),
    to: z.uuid(),
    label: z.string().nullable(),
    condition: z.record(z.string(), z.unknown()).nullable(),
    priority: z.number().int(),
  })
  .strict();
export type SpecTransition = z.infer<typeof SpecTransitionSchema>;

export const SpecFieldSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    description: z.string().nullable(),
  })
  .strict();

export const SpecAssumptionSchema = z
  .object({ text: z.string(), sourceCommentId: z.uuid() })
  .strict();
export type SpecAssumption = z.infer<typeof SpecAssumptionSchema>;

export const SpecKnownGapSchema = z
  .object({ text: z.string(), severity: SeveritySchema, sourceCommentId: z.uuid() })
  .strict();
export type SpecKnownGap = z.infer<typeof SpecKnownGapSchema>;

export const SpecJsonSchema = z
  .object({
    schemaVersion: z.literal('1.1'),
    identity: z
      .object({
        specId: z.uuid(),
        whiteboardId: z.uuid(),
        specVersion: z.number().int().positive(),
        name: z.string(),
      })
      .strict(),
    source: z
      .object({
        revisionNo: z.number().int().positive(),
        canvasHash: z.string().length(64),
        /** Sorted and de-duplicated before hashing (§5.4 rule 4). */
        reviewSessionIds: z.array(z.uuid()),
        frozenAt: z.string(),
        acknowledgedUnresolvedBlockers: z.boolean(),
        acknowledgedStaleReview: z.boolean(),
      })
      .strict(),
    process: z
      .object({
        nodes: z.array(SpecNodeSchema),
        transitions: z.array(SpecTransitionSchema),
        initialNodeIds: z.array(z.uuid()),
        terminalNodeIds: z.array(z.uuid()),
      })
      .strict(),
    data: z
      .object({
        documentTypes: z.array(z.string()),
        fieldSchemas: z.record(z.string(), z.array(SpecFieldSchema)),
        correlationKeys: z.array(z.string()),
      })
      .strict(),
    policies: z
      .object({
        validationRules: z.array(
          z
            .object({ nodeId: z.uuid(), condition: z.string(), branches: z.array(z.string()) })
            .strict(),
        ),
        waits: z.array(z.object({ nodeId: z.uuid(), timeoutMinutes: z.number().int() }).strict()),
        retries: z.array(z.object({ nodeId: z.uuid(), maxAttempts: z.number().int() }).strict()),
        exceptions: z.array(
          z.object({ nodeId: z.uuid(), fallbackNodeId: z.uuid().nullable() }).strict(),
        ),
        humanHandoffs: z.array(z.object({ nodeId: z.uuid(), operation: z.string() }).strict()),
      })
      .strict(),
    /** Sorted and de-duplicated before hashing. */
    capabilities: z.array(CapabilitySchema),
    outputs: z
      .object({
        decisionSchema: z.record(z.string(), z.unknown()),
        emailResponseSchema: z.record(z.string(), z.unknown()),
      })
      .strict(),
    /** Sorted by `sourceCommentId` for canonical stability. */
    assumptions: z.array(SpecAssumptionSchema),
    /** Sorted by `sourceCommentId` for canonical stability. */
    knownGaps: z.array(SpecKnownGapSchema),
    acceptanceCriteria: z.array(z.string()),
  })
  .strict();
export type SpecJson = z.infer<typeof SpecJsonSchema>;

/**
 * The freeze request. As with the review request, it carries no artifacts: no `specJson`,
 * `specHash`, `sourceCanvasJson`, or `sourceCanvasHash` field exists, so a forged value is a 400
 * from `.strict()` rather than something the server has to remember to ignore (A21).
 */
export const FreezeRequestSchema = z
  .object({
    expectedRevisionNo: z.number().int().positive(),
    acknowledgeUnresolvedBlockers: z.boolean(),
    acknowledgeStaleReview: z.boolean(),
  })
  .strict();
export type FreezeRequest = z.infer<typeof FreezeRequestSchema>;

export const FreezeResponseSchema = z
  .object({
    specId: z.uuid(),
    specVersion: z.number().int().positive(),
    specHash: z.string().length(64),
    sourceCanvasHash: z.string().length(64),
    sourceRevisionNo: z.number().int().positive(),
    unresolvedCommentIds: z.array(z.uuid()),
    dismissedCommentIds: z.array(z.uuid()),
    blockerCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();
export type FreezeResponse = z.infer<typeof FreezeResponseSchema>;
