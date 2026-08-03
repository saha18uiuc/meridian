'use client';

import type { Comment } from '@meridian/core/schemas';
import type { Selection } from '@/features/whiteboard/Canvas';
import type { LocalEdge, LocalNode } from '@/features/whiteboard/useGraphStore';

/**
 * Pins are informational. They never open a modal on their own and never block editing, because
 * review is advisory and drafting must stay uninterrupted.
 */
export function CommentPins({
  comments,
  nodes,
  edges,
  onSelect,
}: {
  comments: Comment[];
  nodes: LocalNode[];
  edges: LocalEdge[];
  onSelect: (selection: Selection) => void;
}) {
  const roots = comments.filter((c) => c.parentCommentId === null);
  const nodeIds = new Set(nodes.map((n) => n.nodeId));
  const edgeIds = new Set(edges.map((e) => e.edgeId));

  const live = roots.filter(
    (c) =>
      (c.anchorType === 'node' && c.anchorId !== null && nodeIds.has(c.anchorId)) ||
      (c.anchorType === 'edge' && c.anchorId !== null && edgeIds.has(c.anchorId)),
  );
  const orphaned = roots.filter(
    (c) =>
      c.anchorId !== null &&
      ((c.anchorType === 'node' && !nodeIds.has(c.anchorId)) ||
        (c.anchorType === 'edge' && !edgeIds.has(c.anchorId))),
  );

  if (live.length === 0 && orphaned.length === 0) return null;

  return (
    <div className="comment-pins" data-testid="comment-pins">
      <ul>
        {live.map((comment) => {
          const node = nodes.find((n) => n.nodeId === comment.anchorId);
          return (
            <li key={comment.commentId}>
              <button
                type="button"
                className={comment.severity === 'blocking' ? 'pin blocking' : 'pin'}
                onClick={() =>
                  onSelect({
                    kind: comment.anchorType === 'edge' ? 'edge' : 'node',
                    id: comment.anchorId as string,
                  })
                }
              >
                {comment.severity === 'blocking' ? '●' : '○'}{' '}
                {node?.title ?? (comment.anchorType === 'edge' ? 'connection' : 'card')}
              </button>
            </li>
          );
        })}
      </ul>
      {orphaned.length === 0 ? null : (
        <div className="orphaned-anchors" data-testid="orphaned-anchors">
          <h4>Anchored to a removed object</h4>
          <ul>
            {orphaned.map((comment) => (
              <li key={comment.commentId} className="muted">
                {comment.body.slice(0, 80)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
