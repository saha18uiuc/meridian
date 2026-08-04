'use client';

import type { StartLiveRunResponse } from '@meridian/core/schemas';
import Link from 'next/link';
import { useState } from 'react';
import { DEMO_MESSAGES, type DemoMessage } from './demo-mail';

/**
 * Hands one piece of fixture mail to intake and links to the execution it produces.
 *
 * This exists because every other way of starting a run is an operator command. That is the right
 * default for a production deployment — real mail arrives by itself — but it left the deployed app
 * with no way for a visitor to make anything happen, so the executions list was always empty and the
 * whole runtime looked broken to anyone who had not been given a shell.
 *
 * It is deliberately not a "run everything" button. Each message reaches a different outcome, and
 * choosing one and watching where it lands is the part worth seeing; a single button that fired all
 * nine would produce nine rows and explain nothing.
 *
 * The panel states an intent and stops. Correlation, duplicate suppression, and whether this message
 * joins an existing run or starts a new one are all decided downstream, which is why the response is
 * reported verbatim rather than interpreted here.
 */
export function TriggerRunPanel({
  agentId,
  agentStatus,
  onStarted,
}: {
  agentId: string;
  agentStatus: string;
  onStarted: () => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string>(DEMO_MESSAGES[0]?.key ?? '');
  const [result, setResult] = useState<StartLiveRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const message: DemoMessage | undefined = DEMO_MESSAGES.find((entry) => entry.key === selected);

  async function start(): Promise<void> {
    if (message === undefined) return;
    setBusy(true);
    setError(null);
    setResult(null);

    const response = await fetch('/api/live-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId,
        messageRef: {
          // `mock` is the truthful provider for fixture mail. Claiming `gmail` would put a lie in
          // `message_refs` that no later reader could detect.
          provider: 'mock',
          providerMessageId: message.providerMessageId,
          threadId: message.threadId,
          subject: message.subject,
          receivedAt: message.receivedAt,
          storagePath: null,
        },
        content: {
          subject: message.subject,
          bodyText: message.bodyText,
        },
      }),
    });

    setBusy(false);
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
      return;
    }
    setResult(body as StartLiveRunResponse);
    await onStarted();
  }

  return (
    <div className="panel stack" data-testid="trigger-run">
      <h3 style={{ margin: 0 }}>Send a pre-alert email</h3>
      <p className="muted">
        The committed fixture mail, handed to the same intake path that live Gmail uses. Nothing
        about the run below is simulated: it is a real workflow, with real steps and evidence.
      </p>

      {agentStatus !== 'active' ? (
        <p className="banner">
          This agent has no active version, so a run would have nothing to execute. Activate a
          version first.
        </p>
      ) : null}

      <label className="stack" style={{ gap: 4 }}>
        <span className="muted">Message</span>
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          data-testid="trigger-message"
        >
          {DEMO_MESSAGES.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label} → {entry.expectedOutcome}
            </option>
          ))}
        </select>
      </label>

      {message === undefined ? null : <p className="muted">{message.note}</p>}

      <button
        type="button"
        className="primary"
        disabled={busy || message === undefined || agentStatus !== 'active'}
        onClick={() => void start()}
        data-testid="trigger-submit"
      >
        {busy ? 'Starting…' : 'Send and start the run'}
      </button>

      {error === null ? null : <p className="banner error">{error}</p>}

      {result === null ? null : (
        <div className="stack" data-testid="trigger-result">
          <p>
            Intake answered <code>{result.action}</code>
            {result.wasExisting ? ' against a run that already existed' : ''}.
          </p>
          <Link href={`/executions/${result.executionId}`}>Open the execution</Link>
        </div>
      )}
    </div>
  );
}
