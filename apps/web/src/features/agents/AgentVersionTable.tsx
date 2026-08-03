'use client';

import type { Agent, AgentVersion } from '@meridian/core/schemas';
import { ApproveButton } from '@/features/agents/ApproveButton';
import { LineageBadge } from '@/features/agents/LineageBadge';

export function AgentVersionTable({
  agent,
  versions,
  onChanged,
}: {
  agent: Agent;
  versions: AgentVersion[];
  onChanged: () => void | Promise<void>;
}) {
  if (versions.length === 0) {
    return (
      <p className="muted" data-testid="versions-empty">
        No versions reserved yet.
      </p>
    );
  }
  return (
    <table data-testid="agent-version-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Status</th>
          <th>Lineage</th>
          <th>Code path</th>
          <th>Release</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {versions.map((version) => {
          const manifest = version.buildManifestJson as { specHash?: string };
          const parent = versions.find(
            (candidate) => candidate.agentVersionId === version.parentAgentVersionId,
          );
          return (
            <tr key={version.agentVersionId}>
              <td>v{String(version.versionNo).padStart(3, '0')}</td>
              <td>
                <span className={version.status === 'approved' ? 'badge ok' : 'badge'}>
                  {version.status}
                </span>
              </td>
              <td>
                <LineageBadge
                  specHash={manifest.specHash ?? null}
                  gitCommitSha={version.gitCommitSha}
                  parentVersionNo={parent?.versionNo ?? null}
                />
              </td>
              <td>
                <code>{version.codePath}</code>
              </td>
              <td>
                {agent.activeAgentVersionId === version.agentVersionId ? (
                  <span className="badge ok">active</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <ApproveButton
                  agentVersionId={version.agentVersionId}
                  disabled={version.status === 'approved' || version.gitCommitSha === null}
                  onDone={onChanged}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
