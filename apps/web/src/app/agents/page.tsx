'use client';

import type { Agent, BoardListItem } from '@meridian/core/schemas';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AgentList } from '@/features/agents/AgentList';
import { CreateAgentDialog } from '@/features/agents/CreateAgentDialog';

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [boards, setBoards] = useState<BoardListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [agentsResponse, boardsResponse] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/whiteboards'),
    ]);
    if (agentsResponse.status === 401) {
      router.push('/login');
      return;
    }
    if (!agentsResponse.ok) {
      setError(`HTTP ${agentsResponse.status}`);
      return;
    }
    setAgents(((await agentsResponse.json()) as { agents: Agent[] }).agents);
    if (boardsResponse.ok) {
      setBoards(((await boardsResponse.json()) as { boards: BoardListItem[] }).boards);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(
    agentId: string,
    status: 'active' | 'paused' | 'archived',
  ): Promise<void> {
    await fetch(`/api/agents/${agentId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>Agents</h2>
      {error === null ? null : <p className="banner error">{error}</p>}
      <CreateAgentDialog
        whiteboards={boards.map((board) => ({
          whiteboardId: board.whiteboardId,
          title: board.title,
        }))}
        onCreated={load}
      />
      <div className="panel">
        {agents === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <AgentList agents={agents} onSetStatus={setStatus} />
        )}
      </div>
    </div>
  );
}
