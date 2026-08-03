'use client';

import { useState } from 'react';

/** A reply flips the root to `answered`. It never resolves it; only a later round can do that. */
export function ReplyBox({
  commentId,
  onDone,
}: {
  commentId: string;
  onDone: () => void | Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (body.trim() === '') return;
    setBusy(true);
    await fetch(`/api/comments/${commentId}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: body.trim() }),
    });
    setBusy(false);
    setBody('');
    await onDone();
  }

  return (
    <div className="row">
      <input
        aria-label="Reply"
        placeholder="Answer this finding…"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        data-testid={`reply-input-${commentId}`}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        data-testid={`reply-submit-${commentId}`}
      >
        Reply
      </button>
    </div>
  );
}
