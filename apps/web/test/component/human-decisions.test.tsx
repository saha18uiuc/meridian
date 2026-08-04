import type { ExecutionEvent } from '@meridian/core/schemas';
import { describe, expect, it } from 'vitest';
import { deriveDecisionState } from '@/features/executions/humanDecisions';

/**
 * Whether anyone is waiting on the operator, worked out from the event log.
 *
 * There is no row that says "this run is parked": the workflow is sitting in a Temporal condition,
 * and the only trace in the database is the pair of evidence events around it. Getting this
 * derivation wrong is not a cosmetic bug — a question that never appears is a run that sits for
 * twenty-four hours and then fails on a handoff timeout.
 */

let nextEventId = 1;

function event(
  payload: Record<string, unknown>,
  createdAt = '2026-01-01T00:00:00.000Z',
): ExecutionEvent {
  return {
    eventId: nextEventId++,
    executionId: '11111111-1111-4111-8111-111111111111',
    stepExecutionId: null,
    executionActionId: null,
    eventType: 'evidence',
    eventKey: null,
    payloadJson: payload,
    storagePath: null,
    idempotencyKey: null,
    createdAt,
  };
}

function asked(requestId: string, question = 'Is this HS code right?'): ExecutionEvent {
  return event({
    phase: 'human_handoff_requested',
    requestId,
    question,
    evidence: { hts: '3004' },
  });
}

function answered(requestId: string, decision = 'approve', notes: string | null = null) {
  return event({ requestId, decision, notes });
}

describe('deriving what a run is waiting on', () => {
  it('reports a question nobody has answered', () => {
    const state = deriveDecisionState([asked('handoff:intake:1')]);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({
      requestId: 'handoff:intake:1',
      question: 'Is this HS code right?',
      evidence: { hts: '3004' },
    });
    expect(state.answered).toEqual([]);
  });

  it('moves a question to history once it is answered', () => {
    const state = deriveDecisionState([
      asked('handoff:intake:1'),
      answered('handoff:intake:1', 'reject', 'The broker disagreed.'),
    ]);
    expect(state.pending).toEqual([]);
    expect(state.answered[0]).toMatchObject({
      decision: 'reject',
      notes: 'The broker disagreed.',
      question: 'Is this HS code right?',
    });
  });

  it('counts a replayed request once, keeping the time it was first asked', () => {
    // A Temporal replay re-runs the activity, which appends under the same idempotency key. Two
    // sightings of one question must not become two questions on screen.
    const state = deriveDecisionState([
      asked('handoff:intake:1'),
      event(
        {
          phase: 'human_handoff_requested',
          requestId: 'handoff:intake:1',
          question: 'Is this HS code right?',
          evidence: {},
        },
        '2026-01-01T09:00:00.000Z',
      ),
    ]);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.askedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps the first answer when the button was pressed twice', () => {
    // `submitHumanDecision` is idempotent on the execution and request, so a second press is a
    // no-op the workflow never sees. The history must say the same.
    const state = deriveDecisionState([
      asked('handoff:intake:1'),
      answered('handoff:intake:1', 'approve'),
      answered('handoff:intake:1', 'approve'),
    ]);
    expect(state.answered).toHaveLength(1);
    expect(state.pending).toEqual([]);
  });

  it('keeps two concurrent questions apart', () => {
    const state = deriveDecisionState([
      asked('handoff:a', 'First?'),
      asked('handoff:b', 'Second?'),
      answered('handoff:a'),
    ]);
    expect(state.pending.map((p) => p.question)).toEqual(['Second?']);
    expect(state.answered.map((a) => a.question)).toEqual(['First?']);
  });

  it('ignores the run’s ordinary events', () => {
    const state = deriveDecisionState([
      event({ phase: 'decision', outcome: 'ready', reason: 'all documents present' }),
      event({ phase: 'extraction', invoiceNumber: 'INV-1' }),
    ]);
    expect(state).toEqual({ pending: [], answered: [] });
  });

  it('does not invent a question from an answer with no request', () => {
    // An answer whose request is off the end of the page must not appear as something to do.
    const state = deriveDecisionState([answered('handoff:unknown')]);
    expect(state.pending).toEqual([]);
    expect(state.answered).toEqual([]);
  });
});
