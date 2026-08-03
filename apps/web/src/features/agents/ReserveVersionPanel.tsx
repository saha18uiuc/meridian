'use client';

import type { ReserveVersionResponse } from '@meridian/core/schemas';
import { useState } from 'react';

/**
 * Reserving a version allocates the row and prints the command. Generation itself is an operator
 * action in Cursor or Codex, which is why this panel hands over a string rather than a spinner.
 */
export function ReserveVersionPanel({
  agentId,
  specs,
  versions,
  onReserved,
}: {
  agentId: string;
  specs: { specId: string; specVersion: number; specHash: string }[];
  versions: { agentVersionId: string; versionNo: number }[];
  onReserved: () => void | Promise<void>;
}) {
  const [specId, setSpecId] = useState(specs[0]?.specId ?? '');
  const [parentAgentVersionId, setParent] = useState('');
  const [reserved, setReserved] = useState<ReserveVersionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reserve(): Promise<void> {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/agents/${agentId}/version-reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        specId,
        ...(parentAgentVersionId === '' ? {} : { parentAgentVersionId }),
      }),
    });
    setBusy(false);
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
      return;
    }
    setReserved(body as ReserveVersionResponse);
    await onReserved();
  }

  return (
    <div className="panel stack" data-testid="reserve-version">
      <h3 style={{ margin: 0 }}>Reserve a version</h3>
      {specs.length === 0 ? (
        <p className="muted">Freeze a specification first; a version is generated from one.</p>
      ) : (
        <>
          <label className="stack" style={{ gap: 4 }}>
            <span className="muted">Frozen spec</span>
            <select
              value={specId}
              onChange={(event) => setSpecId(event.target.value)}
              data-testid="reserve-spec"
            >
              {specs.map((spec) => (
                <option key={spec.specId} value={spec.specId}>
                  v{spec.specVersion} · {spec.specHash.slice(0, 12)}…
                </option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="muted">Parent version (optional)</span>
            <select
              value={parentAgentVersionId}
              onChange={(event) => setParent(event.target.value)}
              data-testid="reserve-parent"
            >
              <option value="">none</option>
              {versions.map((version) => (
                <option key={version.agentVersionId} value={version.agentVersionId}>
                  v{String(version.versionNo).padStart(3, '0')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || specId === ''}
            onClick={() => void reserve()}
            data-testid="reserve-submit"
          >
            Reserve version
          </button>
        </>
      )}
      {error === null ? null : <p className="banner error">{error}</p>}
      {reserved === null ? null : (
        <div className="stack" data-testid="operator-command">
          <p className="muted">
            Run this in Cursor or Codex. Meridian will not generate the code for you.
          </p>
          <pre>{reserved.operatorCommand}</pre>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(reserved.operatorCommand)}
          >
            Copy command
          </button>
        </div>
      )}
    </div>
  );
}
