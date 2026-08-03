'use client';

import type { Agent } from '@meridian/core/schemas';
import Link from 'next/link';

export function AgentList({
  agents,
  onSetStatus,
}: {
  agents: Agent[];
  onSetStatus: (agentId: string, status: 'active' | 'paused' | 'archived') => void | Promise<void>;
}) {
  if (agents.length === 0) {
    return (
      <p className="muted" data-testid="agents-empty">
        No agents yet. An agent is the logical deployment; versions are what actually run.
      </p>
    );
  }
  return (
    <table data-testid="agent-list">
      <thead>
        <tr>
          <th>Deployment key</th>
          <th>Name</th>
          <th>Status</th>
          <th>Active release</th>
          <th>Lifecycle</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.agentId}>
            <td>
              <Link href={`/agents/${agent.agentId}`}>{agent.deploymentKey}</Link>
            </td>
            <td>{agent.name}</td>
            <td>
              <span className={agent.status === 'active' ? 'badge ok' : 'badge'}>
                {agent.status}
              </span>
            </td>
            <td className="muted">
              {agent.activeAgentVersionId === null
                ? 'none'
                : `${agent.activeAgentVersionId.slice(0, 8)}…`}
            </td>
            <td className="row">
              <button
                type="button"
                onClick={() => void onSetStatus(agent.agentId, 'active')}
                disabled={agent.status === 'active' || agent.status === 'archived'}
              >
                Activate
              </button>
              <button
                type="button"
                onClick={() => void onSetStatus(agent.agentId, 'paused')}
                disabled={agent.status !== 'active'}
              >
                Pause
              </button>
              <button
                type="button"
                onClick={() => void onSetStatus(agent.agentId, 'archived')}
                disabled={agent.status === 'archived'}
              >
                Archive
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
