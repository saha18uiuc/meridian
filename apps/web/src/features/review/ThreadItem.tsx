'use client';

import type { CommentThread } from '@meridian/core/schemas';
import { ApplyPatchButton } from '@/features/review/ApplyPatchButton';
import { AssumptionDialog } from '@/features/review/AssumptionDialog';
import { RejectDialog } from '@/features/review/RejectDialog';
import { ReplyBox } from '@/features/review/ReplyBox';

/**
 * A thread shows its root status and its history. There is deliberately no "resolve" control:
 * resolution is an outcome of the next review round, not something an operator can assert.
 */
export function ThreadItem({
  thread,
  revisionNo,
  onChanged,
}: {
  thread: CommentThread;
  revisionNo: number;
  onChanged: () => void | Promise<void>;
}) {
  const { root, replies } = thread;
  const status = root.status ?? 'open';
  const isActionable = status === 'open' || status === 'answered';

  return (
    <li className="panel stack" data-testid={`thread-${root.commentId}`} data-status={status}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row">
          <span
            className={root.severity === 'blocking' ? 'badge blocking' : 'badge'}
            data-testid={`severity-${root.commentId}`}
          >
            {root.severity ?? 'non_blocking'}
          </span>
          <span className="badge" data-testid={`status-${root.commentId}`}>
            {status}
          </span>
        </span>
        <code className="muted">{root.issueKey}</code>
      </div>

      <p>{root.body}</p>

      {replies.length === 0 ? null : (
        <ul className="stack" style={{ listStyle: 'none', paddingLeft: 12 }}>
          {replies.map((reply) => (
            <li key={reply.commentId} className="muted">
              <strong>{reply.authorType}</strong>: {reply.body}
            </li>
          ))}
        </ul>
      )}

      {isActionable ? (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <ReplyBox commentId={root.commentId} onDone={onChanged} />
          <RejectDialog commentId={root.commentId} onDone={onChanged} />
          <AssumptionDialog commentId={root.commentId} onDone={onChanged} />
          {root.suggestedPatchJson === null ? null : (
            <ApplyPatchButton
              commentId={root.commentId}
              revisionNo={revisionNo}
              onDone={onChanged}
            />
          )}
        </div>
      ) : (
        <p className="muted">
          {status === 'rejected'
            ? 'Dismissed by the operator. It stays in history and never gates a freeze.'
            : 'Resolved by a later review round.'}
        </p>
      )}
    </li>
  );
}
