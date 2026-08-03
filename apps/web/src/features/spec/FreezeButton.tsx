'use client';

import type { FreezeResponse } from '@meridian/core/schemas';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { DismissedFindings } from '@/features/spec/DismissedFindings';
import { StaleReviewWarning } from '@/features/spec/StaleReviewWarning';
import { UnresolvedBlockerWarning } from '@/features/spec/UnresolvedBlockerWarning';

interface Preview {
  revisionNo: number;
  lastReviewedRevisionNo: number | null;
  blockingComments: { commentId: string; body: string }[];
  dismissedComments: { commentId: string; body: string }[];
}

/** Freeze is a separate action from Review, with one checkbox per real condition and no more. */
export function FreezeButton({
  whiteboardId,
  revisionNo,
}: {
  whiteboardId: string;
  revisionNo: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ackBlockers, setAckBlockers] = useState(false);
  const [ackStale, setAckStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<unknown[] | null>(null);

  const loadPreview = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/whiteboards/${whiteboardId}/freeze`);
    if (!response.ok) return;
    setPreview((await response.json()) as Preview);
  }, [whiteboardId]);

  useEffect(() => {
    if (open) void loadPreview();
  }, [open, loadPreview]);

  const needsBlockerAck = (preview?.blockingComments.length ?? 0) > 0;
  const needsStaleAck = preview !== null && preview.lastReviewedRevisionNo !== preview.revisionNo;
  const ready = (!needsBlockerAck || ackBlockers) && (!needsStaleAck || ackStale);

  async function freeze(): Promise<void> {
    setBusy(true);
    setError(null);
    setErrors(null);
    const response = await fetch(`/api/whiteboards/${whiteboardId}/freeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevisionNo: revisionNo,
        acknowledgeUnresolvedBlockers: needsBlockerAck,
        acknowledgeStaleReview: needsStaleAck,
      }),
    });
    setBusy(false);
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
      setErrors((body as { errors?: unknown[] }).errors ?? null);
      return;
    }
    const frozen = body as FreezeResponse;
    router.push(`/specs/${frozen.specId}`);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-testid="freeze-open">
        Freeze Spec
      </button>
    );
  }

  return (
    <div className="panel stack" data-testid="freeze-dialog">
      <h3>Freeze specification</h3>
      {preview === null ? (
        <p className="muted">Checking the board…</p>
      ) : (
        <>
          <UnresolvedBlockerWarning
            comments={preview.blockingComments}
            acknowledged={ackBlockers}
            onAcknowledge={setAckBlockers}
          />
          <StaleReviewWarning
            revisionNo={preview.revisionNo}
            lastReviewedRevisionNo={preview.lastReviewedRevisionNo}
            acknowledged={ackStale}
            onAcknowledge={setAckStale}
          />
          <DismissedFindings comments={preview.dismissedComments} />
        </>
      )}
      {error === null ? null : (
        <div className="banner error stack" data-testid="freeze-error">
          <span>{error}</span>
          {errors === null ? null : <pre>{JSON.stringify(errors, null, 2)}</pre>}
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!ready || busy || preview === null}
          onClick={() => void freeze()}
          data-testid="freeze-confirm"
        >
          {busy ? 'Freezing…' : 'Freeze'}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
