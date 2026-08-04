import type { ExecutionEvent } from '@meridian/core/schemas';

/**
 * Which questions a run is waiting on, derived from the event log it already writes.
 *
 * A handoff leaves two traces and no row of its own. The workflow's activity appends evidence with
 * `phase: 'human_handoff_requested'` under `handoff:requested:<requestId>`, and answering appends
 * evidence under `human-decision:<requestId>`. There is no `human_decisions` table and no status on
 * the execution saying "parked": the workflow is sitting in a `workflow.condition`, which is
 * Temporal state and not database state.
 *
 * So "is anyone waiting on me" is a question about the difference between two sets of events, and
 * it is computed here rather than added to the server. The events endpoint already returns
 * payloads, already enforces ownership through the caller's own client, and is already polled by
 * the detail page. A new endpoint would mean a second definition of what pending means, and the two
 * would eventually disagree about a run somebody was waiting on.
 *
 * This is a pure function so the derivation can be tested without a browser or a workflow.
 */

export interface DecisionRequest {
  requestId: string;
  question: string;
  evidence: Record<string, unknown>;
  askedAt: string;
}

export interface DecisionAnswer {
  requestId: string;
  decision: string;
  notes: string | null;
  answeredAt: string;
}

export interface DecisionState {
  /** Asked and not yet answered, oldest first — the order they blocked the run in. */
  pending: DecisionRequest[];
  /** Answered, kept because what a person decided and why is audit history. */
  answered: (DecisionRequest & DecisionAnswer)[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function deriveDecisionState(events: readonly ExecutionEvent[]): DecisionState {
  const requests = new Map<string, DecisionRequest>();
  const answers = new Map<string, DecisionAnswer>();

  for (const event of events) {
    const payload = asRecord(event.payloadJson);
    const requestId = asString(payload['requestId']);
    if (requestId === null) continue;

    if (payload['phase'] === 'human_handoff_requested') {
      // A replayed activity re-appends under the same idempotency key, so the first sighting wins
      // and the question keeps the time it was actually asked.
      if (!requests.has(requestId)) {
        requests.set(requestId, {
          requestId,
          question: asString(payload['question']) ?? 'A decision is needed.',
          evidence: asRecord(payload['evidence']),
          askedAt: event.createdAt,
        });
      }
      continue;
    }

    // The answer carries no `phase`; it is identified by having a decision for a known request.
    const decision = asString(payload['decision']);
    if (decision === null) continue;
    if (!answers.has(requestId)) {
      answers.set(requestId, {
        requestId,
        decision,
        notes: asString(payload['notes']),
        answeredAt: event.createdAt,
      });
    }
  }

  const pending: DecisionRequest[] = [];
  const answered: (DecisionRequest & DecisionAnswer)[] = [];
  for (const request of requests.values()) {
    const answer = answers.get(request.requestId);
    if (answer === undefined) pending.push(request);
    else answered.push({ ...request, ...answer });
  }
  return { pending, answered };
}
