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

/**
 * Freeze is a separate action from Review, with one checkbox per real condition and no more.
 *
 * The product has two names for this one act. The brief and the board's own `submitted` status call
 * it submitting; the PRD, the compiler, and every column in the database call it freezing, because
 * what it does is take an immutable snapshot. Both names are load-bearing and neither can be
 * deleted, so the interface leads with the verb the process owner recognises — they are submitting
 * their process — and says in the same breath what submitting does. Someone who reads the PRD after
 * using the product finds the same word waiting for them, rather than a concept they have to map.
 */
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Freeze this process as an immutable specification"
        data-testid="freeze-open"
      >
        Submit Process
      </button>
    );
  }

  return (
    <div className="panel stack" data-testid="freeze-dialog">
      <h3>Submit this process</h3>
      <p className="muted">
        Submitting freezes the board as an immutable <strong>specification</strong> — the contract
        an agent is generated from. The board stays editable afterwards; later edits produce a new
        version rather than changing this one.
      </p>
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
          {busy ? 'Freezing…' : 'Submit and freeze'}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
