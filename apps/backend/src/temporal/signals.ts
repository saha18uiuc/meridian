import { HUMAN_DECISION_SIGNAL, NEW_MESSAGE_SIGNAL } from '@meridian/core/temporal-contract';
import type { MessageRef } from '@meridian/core/schemas';
import { defineSignal } from '@temporalio/workflow';

/**
 * The two signals the receiving workflow accepts.
 *
 * `newMessage` is also the Signal-With-Start signal, so the very first message arrives through the
 * same channel as every later one. That symmetry is deliberate: the workflow deduplicates on the
 * message reference and therefore needs no special case for "the message that started me".
 */
export const newMessageSignal = defineSignal<[MessageRef]>(NEW_MESSAGE_SIGNAL);

export interface HumanDecisionPayload {
  requestId: string;
  decision: string;
  notes: string | null;
}

export const humanDecisionSignal = defineSignal<[HumanDecisionPayload]>(HUMAN_DECISION_SIGNAL);
