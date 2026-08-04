'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/**
 * The index that made a frozen specification findable.
 *
 * Before this, freezing redirected to the spec and that was the only way to reach one. The document
 * an agent is generated from was addressable only by a UUID somebody had to have kept.
 */

interface SpecIndexEntry {
  specId: string;
  whiteboardId: string;
  boardTitle: string | null;
  specVersion: number;
  specHash: string;
  sourceRevisionNo: number;
  unresolvedCommentCount: number;
  frozenAt: string;
}

export default function SpecsPage() {
  const router = useRouter();
  const [specs, setSpecs] = useState<SpecIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/specs');
    if (response.status === 401) {
      router.push('/login');
      return;
    }
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      return;
    }
    const body = (await response.json()) as { specs: SpecIndexEntry[] };
    setSpecs(body.specs);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>Specifications</h2>
      <p className="muted">
        Each one is an immutable snapshot of a board at the moment it was submitted, and the
        contract any agent generated from it is pinned to.
      </p>
      {error === null ? null : <p className="banner error">{error}</p>}
      <div className="panel">
        {specs === null ? (
          <p className="muted">Loading…</p>
        ) : specs.length === 0 ? (
          <p className="muted" data-testid="specs-empty">
            Nothing has been submitted yet. Open a board and submit it to produce one.
          </p>
        ) : (
          <table data-testid="specs-table">
            <thead>
              <tr>
                <th>Process</th>
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
                    <Link href={`/specs/${spec.specId}`}>{spec.boardTitle ?? spec.specId}</Link>
                  </td>
                  <td>v{spec.specVersion}</td>
                  <td>
                    <Link href={`/boards/${spec.whiteboardId}`}>r{spec.sourceRevisionNo}</Link>
                  </td>
                  <td>{spec.unresolvedCommentCount}</td>
                  <td className="muted">{new Date(spec.frozenAt).toISOString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
