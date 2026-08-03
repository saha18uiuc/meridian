'use client';

export type ReviewFreshness = 'never' | 'current' | 'stale';

export function reviewFreshness(
  revisionNo: number,
  lastReviewedRevisionNo: number | null,
): ReviewFreshness {
  if (lastReviewedRevisionNo === null) return 'never';
  return lastReviewedRevisionNo === revisionNo ? 'current' : 'stale';
}

/**
 * A failed review must not move `last_reviewed_revision_no`, so a failure leaves this badge
 * exactly where it was rather than falsely claiming the board is reviewed.
 */
export function ReviewStatusBadge({
  revisionNo,
  lastReviewedRevisionNo,
}: {
  revisionNo: number;
  lastReviewedRevisionNo: number | null;
}) {
  const freshness = reviewFreshness(revisionNo, lastReviewedRevisionNo);
  if (freshness === 'never') {
    return (
      <span className="badge" data-testid="review-status" data-freshness="never">
        Never reviewed
      </span>
    );
  }
  if (freshness === 'current') {
    return (
      <span className="badge ok" data-testid="review-status" data-freshness="current">
        Review current
      </span>
    );
  }
  const behind = revisionNo - (lastReviewedRevisionNo as number);
  return (
    <span className="badge stale" data-testid="review-status" data-freshness="stale">
      Board changed since review ({behind} revision{behind === 1 ? '' : 's'})
    </span>
  );
}
