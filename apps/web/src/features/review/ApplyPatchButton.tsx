'use client';

import { useState } from 'react';

export function ApplyPatchButton({
  commentId,
  revisionNo,
  onDone,
}: {
  commentId: string;
  revisionNo: number;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/comments/${commentId}/apply-patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevisionNo: revisionNo }),
    });
    setBusy(false);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
      return;
    }
    await onDone();
  }

  return (
    <span className="row">
      <button
        type="button"
        disabled={busy}
        onClick={() => void apply()}
        data-testid={`apply-patch-${commentId}`}
      >
        Apply suggested patch
      </button>
      {error === null ? null : <span className="badge blocking">{error}</span>}
    </span>
  );
}
