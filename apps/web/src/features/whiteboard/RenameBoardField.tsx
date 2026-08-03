'use client';

import type { RenameBoardResponse } from '@meridian/core/schemas';
import { useEffect, useState } from 'react';
import { useGraphStore, type GraphStore } from '@/features/whiteboard/useGraphStore';

/**
 * The title is canonical process metadata (A19), so renaming is a revisioned write. It sends the
 * revision the graph store holds and writes the returned revision back, otherwise the next delta
 * would 409 for a change the operator just made themselves.
 */
export function RenameBoardField({
  store,
  whiteboardId,
  onConflict,
}: {
  store: GraphStore;
  whiteboardId: string;
  onConflict: (currentRevisionNo: number | null) => void;
}) {
  const metadata = useGraphStore(store, (s) => s.metadata);
  const [draft, setDraft] = useState(metadata.title);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(metadata.title);
  }, [metadata.title]);

  async function submit(): Promise<void> {
    const title = draft.trim();
    if (title === '' || title === metadata.title) {
      setDraft(metadata.title);
      return;
    }
    setBusy(true);
    const response = await fetch(`/api/whiteboards/${whiteboardId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevisionNo: metadata.revisionNo, title }),
    });
    setBusy(false);
    if (response.status === 409) {
      const body = (await response.json()) as { currentRevisionNo?: number };
      onConflict(body.currentRevisionNo ?? null);
      return;
    }
    if (!response.ok) {
      setDraft(metadata.title);
      return;
    }
    const renamed = (await response.json()) as RenameBoardResponse;
    if (renamed.changed) store.setTitle(renamed.title, renamed.revisionNo, renamed.status);
  }

  return (
    <input
      className="rename-board"
      aria-label="Board title"
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void submit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(metadata.title);
      }}
      data-testid="rename-board"
    />
  );
}
