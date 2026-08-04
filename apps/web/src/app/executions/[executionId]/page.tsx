'use client';

import type { Agent, Execution, ExecutionAction, ExecutionStep } from '@meridian/core/schemas';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ActionPanel } from '@/features/executions/ActionPanel';
import { EvalDiff } from '@/features/executions/EvalDiff';
import { EventFeed } from '@/features/executions/EventFeed';
import { ExecutionSummary } from '@/features/executions/ExecutionSummary';
import { HumanDecisionPanel } from '@/features/executions/HumanDecisionPanel';
import { StepTable } from '@/features/executions/StepTable';

interface Detail {
  execution: Execution;
  agent: Agent;
  version: {
    agentVersionId: string;
    versionNo: number;
    specId: string;
    specHash: string | null;
    gitCommitSha: string | null;
    isActiveRelease: boolean;
  };
}

const TERMINAL = new Set(['passed', 'failed', 'error']);

export default function ExecutionDetailPage() {
  const params = useParams<{ executionId: string }>();
  const executionId = params.executionId;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [actions, setActions] = useState<ExecutionAction[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [detailResponse, stepsResponse, actionsResponse] = await Promise.all([
      fetch(`/api/executions/${executionId}`),
      fetch(`/api/executions/${executionId}/steps`),
      fetch(`/api/executions/${executionId}/actions`),
    ]);
    if (!detailResponse.ok) {
      setError(`HTTP ${detailResponse.status}`);
      return;
    }
    setDetail((await detailResponse.json()) as Detail);
    if (stepsResponse.ok) {
      setSteps(((await stepsResponse.json()) as { steps: ExecutionStep[] }).steps);
    }
    if (actionsResponse.ok) {
      const body = (await actionsResponse.json()) as {
        actions: (Omit<ExecutionAction, 'createdAt' | 'dispatchedAt' | 'completedAt'> & {
          timings: { reservedAt: string; dispatchedAt: string | null; completedAt: string | null };
        })[];
      };
      setActions(
        body.actions.map((action) => ({
          ...action,
          createdAt: action.timings.reservedAt,
          dispatchedAt: action.timings.dispatchedAt,
          completedAt: action.timings.completedAt,
        })),
      );
    }
  }, [executionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (detail === null || TERMINAL.has(detail.execution.status)) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [detail, load]);

  if (error !== null) return <p className="banner error">{error}</p>;
  if (detail === null) return <p className="muted">Loading execution…</p>;

  const live = !TERMINAL.has(detail.execution.status);

  return (
    <div className="stack">
      <ExecutionSummary
        execution={detail.execution}
        lineage={{
          agentId: detail.agent.agentId,
          deploymentKey: detail.agent.deploymentKey,
          agentVersionId: detail.version.agentVersionId,
          versionNo: detail.version.versionNo,
          specId: detail.version.specId,
          specHash: detail.version.specHash,
          gitCommitSha: detail.version.gitCommitSha,
        }}
      />
      <p className="muted">
        <Link href={`/agents/${detail.agent.agentId}`}>{detail.agent.name}</Link>
        {detail.version.isActiveRelease ? ' · this version is the current active release' : ''}
      </p>

      {/* Above the steps, because a question nobody has answered is the only thing on this page
          that is waiting on the reader rather than reporting to them. */}
      <HumanDecisionPanel executionId={executionId} live={live} onAnswered={() => void load()} />

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Steps</h3>
        <p className="muted">
          Grouped by step instance. The sequence column is a display ordinal and is not unique.
        </p>
        <StepTable steps={steps} />
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>External actions</h3>
        <ActionPanel actions={actions} />
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Outcome</h3>
        <EvalDiff execution={detail.execution} />
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Events</h3>
        <EventFeed executionId={executionId} live={live} />
      </div>
    </div>
  );
}
