'use client';

import { DEPLOYMENT_KEY_PATTERN } from '@meridian/core/schemas';
import { useState } from 'react';

export function CreateAgentDialog({
  whiteboards,
  onCreated,
}: {
  whiteboards: { whiteboardId: string; title: string }[];
  onCreated: () => void | Promise<void>;
}) {
  const [whiteboardId, setWhiteboardId] = useState(whiteboards[0]?.whiteboardId ?? '');
  const [deploymentKey, setDeploymentKey] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The key becomes a directory name under `generated-agents/`, so it is validated on both sides.
  const keyValid = DEPLOYMENT_KEY_PATTERN.test(deploymentKey);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ whiteboardId, deploymentKey, name: name.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      setError((body as { code?: string }).code ?? `HTTP ${response.status}`);
      return;
    }
    setDeploymentKey('');
    setName('');
    await onCreated();
  }

  return (
    <div className="panel stack" data-testid="create-agent">
      <h3 style={{ margin: 0 }}>New agent</h3>
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted">Board</span>
        <select
          value={whiteboardId}
          onChange={(event) => setWhiteboardId(event.target.value)}
          data-testid="agent-board"
        >
          {whiteboards.map((board) => (
            <option key={board.whiteboardId} value={board.whiteboardId}>
              {board.title}
            </option>
          ))}
        </select>
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted">Deployment key</span>
        <input
          value={deploymentKey}
          placeholder="inbound-import-receiving"
          onChange={(event) => setDeploymentKey(event.target.value)}
          data-testid="agent-deployment-key"
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="agent-name"
        />
      </label>
      {deploymentKey !== '' && !keyValid ? (
        <p className="banner error">
          A deployment key is 3–64 characters, lower-case, starting with a letter.
        </p>
      ) : null}
      {error === null ? null : <p className="banner error">{error}</p>}
      <button
        type="button"
        className="primary"
        disabled={busy || !keyValid || name.trim() === '' || whiteboardId === ''}
        onClick={() => void submit()}
        data-testid="agent-create-submit"
      >
        Create agent
      </button>
    </div>
  );
}
