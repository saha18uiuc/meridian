'use client';

import type { Agent, AgentVersion } from '@meridian/core/schemas';
import { useState } from 'react';

/** Activation and rollback are the same control, because they are the same operation. */
export function ActivationControls({
  agent,
  versions,
  onDone,
}: {
  agent: Agent;
  versions: AgentVersion[];
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const approved = versions.filter((version) => version.status === 'approved');

  async function activate(agentVersionId: string): Promise<void> {
    setBusy(agentVersionId);
    await fetch(`/api/agents/${agent.agentId}/activation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentVersionId }),
    });
    setBusy(null);
    await onDone();
  }

  if (approved.length === 0) {
    return (
      <p className="muted" data-testid="activation-empty">
        No approved versions yet. Only approved versions can be released.
      </p>
    );
  }

  return (
    <ul
      className="stack"
      style={{ listStyle: 'none', padding: 0 }}
      data-testid="activation-controls"
    >
      {approved.map((version) => {
        const isActive = agent.activeAgentVersionId === version.agentVersionId;
        const isOlder =
          agent.activeAgentVersionId !== null &&
          version.versionNo <
            (versions.find((v) => v.agentVersionId === agent.activeAgentVersionId)?.versionNo ?? 0);
        return (
          <li key={version.agentVersionId} className="row">
            <span>v{String(version.versionNo).padStart(3, '0')}</span>
            {isActive ? (
              <span className="badge ok" data-testid={`active-${version.agentVersionId}`}>
                active release
              </span>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void activate(version.agentVersionId)}
                data-testid={`activate-${version.agentVersionId}`}
              >
                {isOlder ? 'Roll back to this version' : 'Activate'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
