'use client';

import { useState } from 'react';

/** Rejecting requires a rationale, which the database also insists on as a reply row. */
export function RejectDialog({
  commentId,
  onDone,
}: {
  commentId: string;
  onDone: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (reason.trim() === '') return;
    setBusy(true);
    await fetch(`/api/comments/${commentId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    });
    setBusy(false);
    setOpen(false);
    setReason('');
    await onDone();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-testid={`reject-open-${commentId}`}>
        Reject
      </button>
    );
  }

  return (
    <div className="row">
      <input
        aria-label="Rejection reason"
        placeholder="Why is this not an issue?"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        data-testid={`reject-reason-${commentId}`}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        data-testid={`reject-submit-${commentId}`}
      >
        Confirm rejection
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
