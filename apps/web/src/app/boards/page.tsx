'use client';

import type { BoardListItem } from '@meridian/core/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ReviewStatusBadge } from '@/features/whiteboard/ReviewStatusBadge';

export default function BoardsPage() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardListItem[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/whiteboards');
    if (response.status === 401) {
      router.push('/login');
      return;
    }
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      return;
    }
    const body = (await response.json()) as { boards: BoardListItem[] };
    setBoards(body.boards);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (title.trim() === '') return;
    setBusy(true);
    setError(null);
    const response = await fetch('/api/whiteboards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
      return;
    }
    const created = (await response.json()) as { whiteboardId: string };
    router.push(`/boards/${created.whiteboardId}`);
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Process boards</h2>
        <form
          className="row"
          onSubmit={(event) => {
            void onSubmit(event);
          }}
        >
          <input
            placeholder="New board title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            style={{ width: 260 }}
            data-testid="new-board-title"
          />
          {/* Disabled while the title is blank, because the handler refuses a blank one anyway and
              did so in silence: the button looked live, the click did nothing, and nothing on the
              page said why. A requirement the UI enforces has to be a requirement the UI shows. */}
          <button
            type="submit"
            className="primary"
            disabled={busy || title.trim() === ''}
            title={title.trim() === '' ? 'Name the board first' : undefined}
            data-testid="new-board-submit"
          >
            Create
          </button>
        </form>
      </div>

      {error === null ? null : <p className="banner error">{error}</p>}

      <div className="panel">
        {boards === null ? (
          <p className="muted">Loading…</p>
        ) : boards.length === 0 ? (
          <p className="muted" data-testid="boards-empty">
            No boards yet. Create one to start whiteboarding a process.
          </p>
        ) : (
          <table data-testid="boards-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Revision</th>
                <th>Review</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {boards.map((board) => (
                <tr key={board.whiteboardId}>
                  <td>
                    <Link href={`/boards/${board.whiteboardId}`}>{board.title}</Link>
                  </td>
                  <td>{board.status}</td>
                  <td>{board.revisionNo}</td>
                  <td>
                    <ReviewStatusBadge
                      revisionNo={board.revisionNo}
                      lastReviewedRevisionNo={board.lastReviewedRevisionNo}
                    />
                  </td>
                  <td className="muted">{new Date(board.updatedAt).toISOString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
