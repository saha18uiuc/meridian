import { z } from 'zod';

/**
 * External action semantics (§5.9, A16, A22).
 *
 * Meridian provides replay deduplication and best-effort external exactly-once behaviour. It
 * does NOT provide an absolute exactly-once guarantee, because Gmail's send endpoint accepts no
 * client-supplied idempotency token. The protocol is honest about that:
 *
 *   reserved -> dispatched -> succeeded | failed | needs_reconciliation
 *   needs_reconciliation -> succeeded | reserved (only with proof) | abandoned
 *   reserved -> abandoned
 *
 * `dispatched -> reserved` deliberately does not exist. The only route back to `reserved` runs
 * through reconciliation and requires positive, recorded evidence of non-delivery, because a
 * blind resend can duplicate a real email.
 */

export const ACTION_TYPES = [
  'mail.send',
  'mail.draft',
  'mail.reply',
  'browser.write',
  'human.handoff',
] as const;
export const ActionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ACTION_STATUSES = [
  'reserved',
  'dispatched',
  'succeeded',
  'failed',
  'needs_reconciliation',
  'abandoned',
] as const;
export const ActionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/** Exactly these three carry a non-null `completed_at`; the database states it as a check. */
export const TERMINAL_ACTION_STATUSES = ['succeeded', 'failed', 'abandoned'] as const;

export function isTerminalActionStatus(status: ActionStatus): boolean {
  return (TERMINAL_ACTION_STATUSES as readonly string[]).includes(status);
}

export const ExecutionActionSchema = z
  .object({
    executionActionId: z.uuid(),
    executionId: z.uuid(),
    stepExecutionId: z.uuid().nullable(),
    actionType: ActionTypeSchema,
    idempotencyKey: z.string().length(64),
    /** First 12 hex characters of the idempotency key; fixed at reservation and immutable. */
    markerToken: z.string().length(12),
    status: ActionStatusSchema,
    requestPayloadJson: z.record(z.string(), z.unknown()),
    providerActionId: z.string().nullable(),
    providerResponseJson: z.record(z.string(), z.unknown()).nullable(),
    reconciliationJson: z.record(z.string(), z.unknown()).nullable(),
    attemptCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    dispatchedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type ExecutionAction = z.infer<typeof ExecutionActionSchema>;

/**
 * Reconciliation evidence. Returning an action to `reserved` requires
 * `provenNotDelivered: true`, which the RPC enforces — an inconclusive result must abandon.
 */
export const ReconciliationEvidenceSchema = z
  .object({
    provenNotDelivered: z.boolean(),
    method: z.string().min(1),
    query: z.string().optional(),
    matchedProviderActionId: z.string().nullable().optional(),
    inspectedCount: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
  })
  .passthrough();
export type ReconciliationEvidence = z.infer<typeof ReconciliationEvidenceSchema>;
