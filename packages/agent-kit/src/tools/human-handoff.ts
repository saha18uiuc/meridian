import type { HumanHandoffTool } from '../contracts.js';

export type { HumanHandoffTool };

/**
 * The request ID is derived, not random, so a replayed workflow asks the same question under the
 * same identity instead of opening a second handoff for the same decision.
 */
export function deriveRequestId(input: {
  executionId: string;
  stepInstanceKey: string;
  question: string;
}): string {
  const normalized = input.question.trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return `handoff:${input.stepInstanceKey}:${hash.toString(16).padStart(8, '0')}`;
}

/** Waiting is a workflow `condition`, never an activity, so the worker holds no blocked slot. */
export const HUMAN_DECISION_TIMEOUT = '24 hours';
