'use client';

import { isUnresolvedRoot } from '@meridian/core';
import type { Comment } from '@meridian/core/schemas';

/**
 * One definition of unresolved, applied here and nowhere else re-derived: a rejected finding was
 * deliberately dismissed, so counting it as outstanding would misreport the operator's own
 * decision back to them.
 */
export function UnresolvedCounter({ comments }: { comments: Comment[] }) {
  const unresolved = comments.filter((c) => isUnresolvedRoot(c.parentCommentId, c.status));
  const blocking = unresolved.filter((c) => c.severity === 'blocking');
  const dismissed = comments.filter((c) => c.parentCommentId === null && c.status === 'rejected');

  return (
    <span className="row" data-testid="unresolved-counter">
      <span className={blocking.length > 0 ? 'badge blocking' : 'badge'}>
        {unresolved.length} unresolved ({blocking.length} blocking)
      </span>
      {dismissed.length === 0 ? null : (
        <span className="badge muted" data-testid="dismissed-counter">
          {dismissed.length} dismissed
        </span>
      )}
    </span>
  );
}
