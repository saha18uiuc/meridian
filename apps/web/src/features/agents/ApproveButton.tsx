'use client';

import { useState } from 'react';

/** Approving records a judgement about a version. It explicitly does not release it. */
export function ApproveButton({
  agentVersionId,
  disabled,
  onDone,
}: {
  agentVersionId: string;
  disabled: boolean;
  onDone: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function approve(): Promise<void> {
    setBusy(true);
    await fetch(`/api/agent-versions/${agentVersionId}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    setBusy(false);
    setConfirming(false);
    await onDone();
  }

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        data-testid={`approve-${agentVersionId}`}
      >
        Approve
      </button>
    );
  }

  return (
    <span className="row">
      <span className="muted">Approval does not activate this version.</span>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => void approve()}
        data-testid={`approve-confirm-${agentVersionId}`}
      >
        Approve anyway
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
