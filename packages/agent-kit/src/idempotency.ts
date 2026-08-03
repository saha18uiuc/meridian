import { canonicalJson, sha256Hex } from '@meridian/core/hashing';
import type { IdempotencyHelper } from './contracts.js';

/**
 * One key formula, shared by the workflow that reserves an action and the activity that dispatches
 * it. It is a pure function of four values, with no clock and no randomness, so a replay after a
 * crash derives the identical key and finds the existing reservation instead of creating a second
 * one.
 *
 * The payload is canonicalized before hashing, so `{a:1,b:2}` and `{b:2,a:1}` are the same action.
 */
export function deriveActionKey(input: {
  executionId: string;
  stepInstanceKey: string;
  actionType: string;
  payload: unknown;
}): string {
  const payloadDigest = sha256Hex(canonicalJson(input.payload));
  return sha256Hex(
    [input.executionId, input.stepInstanceKey, input.actionType, payloadDigest].join('|'),
  );
}

/**
 * The first twelve hex characters of the key. Gmail has no idempotency header, so this token is
 * embedded in the outgoing body and later used as the reconciliation search term.
 */
export function markerToken(key: string): string {
  return key.slice(0, 12);
}

export const idempotency: IdempotencyHelper = { deriveActionKey, markerToken };
