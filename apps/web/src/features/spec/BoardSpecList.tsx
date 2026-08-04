'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

/**
 * The specifications this board has been submitted as, and the way back to each of them.
 *
 * Freezing used to redirect to `/specs/{specId}` and that was the only route to a frozen spec in
 * the entire product: close the tab and the document was reachable only by remembering a UUID. A
 * spec is the contract a generated agent is built against, so "which versions has this board
 * produced, and which one is that agent running" is a question the board itself has to answer.
 */

export interface BoardSpecSummary {
  specId: string;
  specVersion: number;
  specHash: string;
  sourceRevisionNo: number;
  unresolvedCommentCount: number;
  frozenAt: string;
}

export function BoardSpecList({
  whiteboardId,
  refreshToken,
}: {
  whiteboardId: string;
  refreshToken: number;
}) {
  const [specs, setSpecs] = useState<BoardSpecSummary[] | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/whiteboards/${whiteboardId}/specs`);
    if (!response.ok) return;
    const body = (await response.json()) as { specs: BoardSpecSummary[] };
    setSpecs(body.specs);
  }, [whiteboardId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <section className="panel stack" data-testid="board-spec-list">
      <h3 style={{ margin: 0 }}>Submitted specifications</h3>
      {specs === null ? (
        <p className="muted">Loading…</p>
      ) : specs.length === 0 ? (
        <p className="muted" data-testid="board-specs-empty">
          This board has not been submitted yet. Submitting freezes the process as an immutable
          specification, which is what an agent gets built from.
        </p>
      ) : (
        <table data-testid="board-specs-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>From revision</th>
              <th>Unresolved at freeze</th>
              <th>Frozen</th>
            </tr>
          </thead>
          <tbody>
            {specs.map((spec) => (
              <tr key={spec.specId}>
                <td>
                  <Link href={`/specs/${spec.specId}`}>v{spec.specVersion}</Link>
                </td>
                <td>{spec.sourceRevisionNo}</td>
                <td>{spec.unresolvedCommentCount}</td>
                <td className="muted">{new Date(spec.frozenAt).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
