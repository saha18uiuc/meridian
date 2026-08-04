'use client';

import type { Agent, AgentVersion, Execution } from '@meridian/core/schemas';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ActivationControls } from '@/features/agents/ActivationControls';
import { AgentVersionTable } from '@/features/agents/AgentVersionTable';
import { ReserveVersionPanel } from '@/features/agents/ReserveVersionPanel';
import { ExecutionList } from '@/features/executions/ExecutionList';
import { TriggerRunPanel } from '@/features/executions/TriggerRunPanel';

interface AgentPayload {
  agent: Agent;
  versions: AgentVersion[];
  specs: { specId: string; specVersion: number; specHash: string }[];
}

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId;
  const [payload, setPayload] = useState<AgentPayload | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [agentResponse, executionsResponse] = await Promise.all([
      fetch(`/api/agents/${agentId}`),
      fetch(`/api/executions?agentId=${agentId}`),
    ]);
    if (!agentResponse.ok) {
      setError(`HTTP ${agentResponse.status}`);
      return;
    }
    setPayload((await agentResponse.json()) as AgentPayload);
    if (executionsResponse.ok) {
      setExecutions(((await executionsResponse.json()) as { executions: Execution[] }).executions);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <p className="banner error">{error}</p>;
  if (payload === null) return <p className="muted">Loading agent…</p>;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{payload.agent.name}</h2>
        <span className="row">
          <code>{payload.agent.deploymentKey}</code>
          <span className={payload.agent.status === 'active' ? 'badge ok' : 'badge'}>
            {payload.agent.status}
          </span>
          <Link href={`/boards/${payload.agent.whiteboardId}`}>Open board</Link>
        </span>
      </div>

      <ReserveVersionPanel
        agentId={agentId}
        specs={payload.specs}
        versions={payload.versions.map((version) => ({
          agentVersionId: version.agentVersionId,
          versionNo: version.versionNo,
        }))}
        onReserved={load}
      />

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Versions</h3>
        <AgentVersionTable agent={payload.agent} versions={payload.versions} onChanged={load} />
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Release pointer</h3>
        <ActivationControls agent={payload.agent} versions={payload.versions} onDone={load} />
      </div>

      <TriggerRunPanel agentId={agentId} agentStatus={payload.agent.status} onStarted={load} />

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Recent executions</h3>
        <ExecutionList executions={executions} />
      </div>
    </div>
  );
}
