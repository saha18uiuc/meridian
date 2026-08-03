import { z } from 'zod';

export const EVENT_TYPES = ['evidence', 'action', 'state_transition', 'metric'] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Events are append-only and cursor-pageable by `event_id`, which is the authoritative persisted
 * append order. Large artifacts stay in Storage and are referenced by `storage_path`.
 */
export const ExecutionEventSchema = z
  .object({
    eventId: z.number().int().positive(),
    executionId: z.uuid(),
    stepExecutionId: z.uuid().nullable(),
    executionActionId: z.uuid().nullable(),
    eventType: EventTypeSchema,
    eventKey: z.string().nullable(),
    payloadJson: z.record(z.string(), z.unknown()),
    storagePath: z.string().nullable(),
    idempotencyKey: z.string().length(64).nullable(),
    createdAt: z.string(),
  })
  .strict();
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

export const EventPageRequestSchema = z
  .object({
    afterEventId: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(500).default(100),
  })
  .strict();
export type EventPageRequest = z.infer<typeof EventPageRequestSchema>;
