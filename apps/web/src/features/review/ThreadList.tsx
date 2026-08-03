'use client';

import type { CommentThread } from '@meridian/core/schemas';
import { ThreadItem } from '@/features/review/ThreadItem';

export function ThreadList({
  threads,
  revisionNo,
  onChanged,
}: {
  threads: CommentThread[];
  revisionNo: number;
  onChanged: () => void | Promise<void>;
}) {
  if (threads.length === 0) {
    return (
      <p className="muted" data-testid="threads-empty">
        No findings yet. Run a review to see what the deterministic checks and the model report.
      </p>
    );
  }
  return (
    <ul className="stack" style={{ listStyle: 'none', padding: 0 }} data-testid="thread-list">
      {threads.map((thread) => (
        <ThreadItem
          key={thread.root.commentId}
          thread={thread}
          revisionNo={revisionNo}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}
