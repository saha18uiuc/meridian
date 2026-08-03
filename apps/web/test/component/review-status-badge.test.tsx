import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewStatusBadge, reviewFreshness } from '@/features/whiteboard/ReviewStatusBadge';

/**
 * The review-currency badge.
 *
 * It answers one question — can I trust the review I am looking at — and there are exactly three
 * honest answers. The failure that matters is the badge claiming "current" when it is not, because
 * that is the state in which an operator freezes a spec believing it was reviewed.
 */

describe('the three states', () => {
  it('says a board with no review has never been reviewed', () => {
    render(<ReviewStatusBadge revisionNo={4} lastReviewedRevisionNo={null} />);
    const badge = screen.getByTestId('review-status');
    expect(badge).toHaveAttribute('data-freshness', 'never');
    expect(badge).toHaveTextContent('Never reviewed');
  });

  it('says the review is current when the revisions match', () => {
    render(<ReviewStatusBadge revisionNo={4} lastReviewedRevisionNo={4} />);
    const badge = screen.getByTestId('review-status');
    expect(badge).toHaveAttribute('data-freshness', 'current');
    expect(badge).toHaveTextContent('Review current');
  });

  it('says how far behind the review is once the board moves', () => {
    render(<ReviewStatusBadge revisionNo={7} lastReviewedRevisionNo={4} />);
    const badge = screen.getByTestId('review-status');
    expect(badge).toHaveAttribute('data-freshness', 'stale');
    expect(badge).toHaveTextContent('Board changed since review (3 revisions)');
  });

  it('counts a single revision in the singular', () => {
    render(<ReviewStatusBadge revisionNo={5} lastReviewedRevisionNo={4} />);
    expect(screen.getByTestId('review-status')).toHaveTextContent('(1 revision)');
  });
});

describe('reviewFreshness', () => {
  it('treats revision zero as a real reviewed revision, not as absence', () => {
    // `null` means no review has ever run. Zero is a value, and conflating the two would make a
    // freshly reviewed board at revision zero report itself as never reviewed.
    expect(reviewFreshness(0, 0)).toBe('current');
    expect(reviewFreshness(0, null)).toBe('never');
  });

  it('never reports current for anything but equality', () => {
    expect(reviewFreshness(4, 3)).toBe('stale');
    // A review recorded ahead of the board should not be reported as current either. It cannot
    // happen through the RPCs, and if it ever did, the honest answer is still "do not trust this".
    expect(reviewFreshness(3, 4)).toBe('stale');
  });
});

describe('a review that failed', () => {
  it('leaves the badge where it was', () => {
    // `fail_review_session` does not advance `last_reviewed_revision_no`, so a board that was
    // stale before a failed round is still stale after it, and never briefly claims otherwise.
    const beforeFailure = <ReviewStatusBadge revisionNo={9} lastReviewedRevisionNo={4} />;
    const { rerender } = render(beforeFailure);
    expect(screen.getByTestId('review-status')).toHaveAttribute('data-freshness', 'stale');

    rerender(<ReviewStatusBadge revisionNo={9} lastReviewedRevisionNo={4} />);
    expect(screen.getByTestId('review-status')).toHaveTextContent('(5 revisions)');
  });
});
