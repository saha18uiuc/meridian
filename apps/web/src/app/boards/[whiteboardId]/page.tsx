'use client';

import type {
  BoardMetadata,
  Comment,
  CommentThread,
  WhiteboardEdge,
  WhiteboardNode,
} from '@meridian/core/schemas';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AssumptionsPanel } from '@/features/review/AssumptionsPanel';
import { ReviewButton } from '@/features/review/ReviewButton';
import { ThreadList } from '@/features/review/ThreadList';
import { UnresolvedCounter } from '@/features/review/UnresolvedCounter';
import { BoardSpecList } from '@/features/spec/BoardSpecList';
import { FreezeButton } from '@/features/spec/FreezeButton';
import { Canvas } from '@/features/whiteboard/Canvas';
import { RenameBoardField } from '@/features/whiteboard/RenameBoardField';
import { ReviewStatusBadge } from '@/features/whiteboard/ReviewStatusBadge';
import {
  createGraphStore,
  useGraphStore,
  type GraphStore,
} from '@/features/whiteboard/useGraphStore';

interface BoardPayload {
  metadata: BoardMetadata;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
}

export default function BoardPage() {
  const params = useParams<{ whiteboardId: string }>();
  const whiteboardId = params.whiteboardId;
  const router = useRouter();
  const [store, setStore] = useState<GraphStore | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [lastReviewedRevisionNo, setLastReviewedRevisionNo] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incremented by anything that may have changed a comment, so the panels that read their own
  // endpoints refetch without the page holding their state for them.
  const [refreshToken, setRefreshToken] = useState(0);

  const loadBoard = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/whiteboards/${whiteboardId}`);
    if (response.status === 401) {
      router.push('/login');
      return;
    }
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      return;
    }
    const board = (await response.json()) as BoardPayload;
    setStore((current) => {
      if (current === null) return createGraphStore(board);
      current.reload(board);
      return current;
    });
  }, [whiteboardId, router]);

  const loadReviewState = useCallback(async (): Promise<void> => {
    const [boardsResponse, sessionsResponse] = await Promise.all([
      fetch('/api/whiteboards'),
      fetch(`/api/whiteboards/${whiteboardId}/reviews`),
    ]);
    if (boardsResponse.ok) {
      const body = (await boardsResponse.json()) as {
        boards: { whiteboardId: string; lastReviewedRevisionNo: number | null }[];
      };
      const match = body.boards.find((b) => b.whiteboardId === whiteboardId);
      setLastReviewedRevisionNo(match?.lastReviewedRevisionNo ?? null);
    }
    if (!sessionsResponse.ok) return;
    const sessions = (await sessionsResponse.json()) as {
      sessions: { reviewSessionId: string; status: string }[];
    };
    const latest = sessions.sessions.find((s) => s.status === 'completed');
    if (latest === undefined) {
      setComments([]);
      return;
    }
    const threadsResponse = await fetch(`/api/reviews/${latest.reviewSessionId}/comments`);
    if (!threadsResponse.ok) return;
    const body = (await threadsResponse.json()) as { threads: CommentThread[] };
    setComments(body.threads.flatMap((thread) => [thread.root, ...thread.replies]));
  }, [whiteboardId]);

  useEffect(() => {
    void loadBoard();
    void loadReviewState();
  }, [loadBoard, loadReviewState]);

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([loadBoard(), loadReviewState()]);
    setRefreshToken((token) => token + 1);
  }, [loadBoard, loadReviewState]);

  if (error !== null) return <p className="banner error">{error}</p>;
  if (store === null) return <p className="muted">Loading board…</p>;

  return (
    <BoardBody
      store={store}
      whiteboardId={whiteboardId}
      comments={comments}
      lastReviewedRevisionNo={lastReviewedRevisionNo}
      refreshToken={refreshToken}
      onRefresh={refreshAll}
    />
  );
}

function BoardBody({
  store,
  whiteboardId,
  comments,
  lastReviewedRevisionNo,
  refreshToken,
  onRefresh,
}: {
  store: GraphStore;
  whiteboardId: string;
  comments: Comment[];
  lastReviewedRevisionNo: number | null;
  refreshToken: number;
  onRefresh: () => Promise<void>;
}) {
  const metadata = useGraphStore(store, (s) => s.metadata);
  const threads = useMemo<CommentThread[]>(() => {
    const roots = comments.filter((c) => c.parentCommentId === null);
    return roots.map((root) => ({
      root,
      replies: comments.filter((c) => c.parentCommentId !== null && c.threadId === root.threadId),
    }));
  }, [comments]);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <RenameBoardField
          store={store}
          whiteboardId={whiteboardId}
          onConflict={() => void onRefresh()}
        />
        <div className="row">
          <ReviewStatusBadge
            revisionNo={metadata.revisionNo}
            lastReviewedRevisionNo={lastReviewedRevisionNo}
          />
          <UnresolvedCounter comments={comments} />
          <ReviewButton
            whiteboardId={whiteboardId}
            revisionNo={metadata.revisionNo}
            onComplete={() => void onRefresh()}
          />
          <FreezeButton whiteboardId={whiteboardId} revisionNo={metadata.revisionNo} />
        </div>
      </div>

      <Canvas
        store={store}
        whiteboardId={whiteboardId}
        comments={comments}
        onCommentsChanged={() => void onRefresh()}
      />

      <section className="stack">
        <h3>Review findings</h3>
        <p className="muted">
          Each finding is also a bubble on the board, beside the card it is about. Both open the
          same thread.
        </p>
        <ThreadList
          threads={threads}
          revisionNo={metadata.revisionNo}
          onChanged={() => void onRefresh()}
        />
      </section>

      <AssumptionsPanel whiteboardId={whiteboardId} refreshToken={refreshToken} />
      <BoardSpecList whiteboardId={whiteboardId} refreshToken={refreshToken} />
    </div>
  );
}
