'use client';

import { useState } from 'react';

/**
 * Converting an answer into an explicit assumption is what lets a later round resolve a model
 * finding that simply stops being reported: the assumption, not the model's silence, is the
 * evidence.
 */
export function AssumptionDialog({
  commentId,
  onDone,
}: {
  commentId: string;
  onDone: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (text.trim() === '') return;
    setBusy(true);
    await fetch(`/api/comments/${commentId}/assumption`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    });
    setBusy(false);
    setOpen(false);
    setText('');
    await onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`assumption-open-${commentId}`}
      >
        Record assumption
      </button>
    );
  }

  return (
    <div className="row">
      <input
        aria-label="Assumption text"
        placeholder="State the assumption this finding relies on…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        data-testid={`assumption-text-${commentId}`}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        data-testid={`assumption-submit-${commentId}`}
      >
        Save assumption
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
