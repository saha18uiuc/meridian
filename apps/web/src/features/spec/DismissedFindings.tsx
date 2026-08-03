'use client';

/**
 * Dismissed findings are shown so the operator can see what was considered and set aside. They
 * are never counted as unresolved and never gate the freeze button.
 */
export function DismissedFindings({
  comments,
}: {
  comments: { commentId: string; body: string }[];
}) {
  if (comments.length === 0) return null;
  return (
    <details data-testid="dismissed-findings">
      <summary>{comments.length} dismissed finding(s)</summary>
      <ul>
        {comments.map((comment) => (
          <li key={comment.commentId} className="muted">
            {comment.body}
          </li>
        ))}
      </ul>
    </details>
  );
}
