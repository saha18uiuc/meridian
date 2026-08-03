'use client';

/**
 * Staleness is a second, independent acknowledgement (A18). One checkbox covering both
 * conditions would let an operator wave through a condition they never actually read.
 */
export function StaleReviewWarning({
  revisionNo,
  lastReviewedRevisionNo,
  acknowledged,
  onAcknowledge,
}: {
  revisionNo: number;
  lastReviewedRevisionNo: number | null;
  acknowledged: boolean;
  onAcknowledge: (next: boolean) => void;
}) {
  if (lastReviewedRevisionNo === revisionNo) return null;
  return (
    <div className="banner stack" data-testid="stale-review-warning">
      <strong>
        {lastReviewedRevisionNo === null
          ? 'This board has never been reviewed.'
          : `The last review covered revision ${lastReviewedRevisionNo}; the board is at ${revisionNo}.`}
      </strong>
      <span className="muted">
        Freezing does not require a new review. It does require you to say you know.
      </span>
      <label className="row">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
          data-testid="ack-stale-review"
          style={{ width: 'auto' }}
        />
        <span>Freeze against the current revision anyway.</span>
      </label>
    </div>
  );
}
