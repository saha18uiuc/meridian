'use client';

import type { ReviewResultResponse } from '@meridian/core/schemas';
import { useState } from 'react';

/**
 * The review request is one awaited round trip, so the loading state is held for the whole
 * request rather than handing the operator a job id to poll.
 */
export function ReviewButton({
  whiteboardId,
  revisionNo,
  onComplete,
}: {
  whiteboardId: string;
  revisionNo: number;
  onComplete: (result: ReviewResultResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/whiteboards/${whiteboardId}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevisionNo: revisionNo }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
        return;
      }
      onComplete(body as ReviewResultResponse);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row">
      <button
        type="button"
        className="primary"
        onClick={() => void run()}
        disabled={busy}
        data-testid="review-process"
      >
        {busy ? 'Reviewing…' : 'Review Process'}
      </button>
      {error === null ? null : (
        <span className="badge blocking" data-testid="review-error">
          {error}
        </span>
      )}
    </span>
  );
}
