'use client';

export interface BlockingComment {
  commentId: string;
  body: string;
}

/** Blocking findings warn and require an acknowledgement. They never silently block. */
export function UnresolvedBlockerWarning({
  comments,
  acknowledged,
  onAcknowledge,
}: {
  comments: BlockingComment[];
  acknowledged: boolean;
  onAcknowledge: (next: boolean) => void;
}) {
  if (comments.length === 0) return null;
  return (
    <div className="banner stack" data-testid="blocker-warning">
      <strong>
        {comments.length} unresolved blocking finding{comments.length === 1 ? '' : 's'}
      </strong>
      <ul>
        {comments.map((comment) => (
          <li key={comment.commentId}>{comment.body}</li>
        ))}
      </ul>
      <label className="row">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
          data-testid="ack-blockers"
          style={{ width: 'auto' }}
        />
        <span>Freeze anyway and record these as known gaps.</span>
      </label>
    </div>
  );
}
