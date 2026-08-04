'use client';

import type { ExecutionEvent } from '@meridian/core/schemas';
import { useCallback, useEffect, useState } from 'react';
import {
  deriveDecisionState,
  type DecisionRequest,
  type DecisionState,
} from '@/features/executions/humanDecisions';

/**
 * The one place a person is in the loop while a run is happening.
 *
 * When the agent reaches a state the specification does not decide, it asks and waits — up to
 * twenty-four hours, on a workflow condition rather than an activity, so the worker holds no slot.
 * Every piece of the answering path already existed and none of it had a caller: the run parked,
 * nothing on screen said so, and the handoff expired.
 *
 * The submit is deliberately thin. `submitHumanDecision` records the evidence under an idempotency
 * key derived from the execution and the request, signals the workflow, and reports a run that has
 * already finished as `workflowRunning: false` rather than as an error — because by then the answer
 * is recorded and there is nothing for the operator to fix. Pressing twice therefore produces one
 * answer in history and two 200s, which is why the button does not need to guard itself and why
 * this component must not invent a second notion of "already answered".
 */

const CHOICES = ['approve', 'reject', 'escalate'] as const;

export function HumanDecisionPanel({
  executionId,
  live,
  onAnswered,
}: {
  executionId: string;
  live: boolean;
  onAnswered: () => void | Promise<void>;
}) {
  const [state, setState] = useState<DecisionState>({ pending: [], answered: [] });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/executions/${executionId}/events?limit=500`);
    if (!response.ok) return;
    const body = (await response.json()) as { events: ExecutionEvent[] };
    setState(deriveDecisionState(body.events));
  }, [executionId]);

  useEffect(() => {
    void load();
    if (!live) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, live]);

  if (state.pending.length === 0 && state.answered.length === 0) return null;

  return (
    <div className="panel stack" data-testid="human-decision-panel">
      <h3 style={{ margin: 0 }}>Decisions for a person</h3>
      {error === null ? null : (
        <p className="banner error" data-testid="human-decision-error">
          {error}
        </p>
      )}

      {state.pending.length === 0 ? (
        <p className="muted" data-testid="human-decision-none-pending">
          Nothing is waiting on you.
        </p>
      ) : (
        <ul className="stack plain-list">
          {state.pending.map((request) => (
            <PendingDecision
              key={request.requestId}
              executionId={executionId}
              request={request}
              onError={setError}
              onAnswered={async () => {
                await load();
                await onAnswered();
              }}
            />
          ))}
        </ul>
      )}

      {state.answered.length === 0 ? null : (
        <div className="stack" data-testid="human-decision-history">
          <h4 style={{ margin: 0 }}>Already answered</h4>
          <ul className="stack plain-list">
            {state.answered.map((entry) => (
              <li key={entry.requestId} className="muted">
                <strong>{entry.decision}</strong> — {entry.question}
                {entry.notes === null ? null : <> ({entry.notes})</>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PendingDecision({
  executionId,
  request,
  onAnswered,
  onError,
}: {
  executionId: string;
  request: DecisionRequest;
  onAnswered: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function answer(decision: string): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      const response = await fetch(`/api/executions/${executionId}/human-decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: request.requestId,
          decision,
          notes: notes.trim() === '' ? null : notes.trim(),
        }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}));
        onError((body as { code?: string }).code ?? `HTTP ${response.status}`);
        return;
      }
      const body = (await response.json()) as { workflowRunning: boolean };
      if (!body.workflowRunning) {
        // Recorded but not delivered: the run finished while the question was on screen. Saying so
        // is the difference between the operator believing they steered the run and knowing they
        // annotated it after the fact.
        onError('Recorded, but the run had already finished — the answer did not change it.');
      }
      await onAnswered();
    } finally {
      setBusy(false);
    }
  }

  const evidenceKeys = Object.keys(request.evidence);

  return (
    <li className="stack" data-testid={`decision-${request.requestId}`}>
      <p style={{ margin: 0 }}>
        <strong>{request.question}</strong>
      </p>
      <p className="field-hint">
        Asked {new Date(request.askedAt).toLocaleString()}. The run is paused here until it is
        answered.
      </p>
      {evidenceKeys.length === 0 ? null : (
        <pre className="code-block">{JSON.stringify(request.evidence, null, 2)}</pre>
      )}
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted">Notes (optional, kept in the run history)</span>
        <textarea
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          data-testid={`decision-notes-${request.requestId}`}
        />
      </label>
      <div className="row">
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            className={choice === 'approve' ? 'primary' : undefined}
            disabled={busy}
            onClick={() => void answer(choice)}
            data-testid={`decision-${choice}-${request.requestId}`}
          >
            {choice}
          </button>
        ))}
      </div>
    </li>
  );
}
