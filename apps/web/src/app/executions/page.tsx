'use client';

import type { Execution, ExecutionEvent, RunType } from '@meridian/core/schemas';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ExecutionList } from '@/features/executions/ExecutionList';
import { deriveDecisionState } from '@/features/executions/humanDecisions';

const TERMINAL = new Set(['passed', 'failed', 'error']);

export default function ExecutionsPage() {
  const router = useRouter();
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [awaitingDecision, setAwaitingDecision] = useState<ReadonlySet<string>>(new Set());
  const [runType, setRunType] = useState<RunType | 'all'>('all');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null): Promise<void> => {
      const query = new URLSearchParams({ limit: '50' });
      if (runType !== 'all') query.set('runType', runType);
      if (cursor !== null) query.set('cursor', cursor);
      const response = await fetch(`/api/executions?${query.toString()}`);
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (!response.ok) {
        setError(`HTTP ${response.status}`);
        return;
      }
      const page = (await response.json()) as {
        executions: Execution[];
        nextCursor: string | null;
      };
      setExecutions((previous) =>
        cursor === null ? page.executions : [...previous, ...page.executions],
      );
      setNextCursor(page.nextCursor);
    },
    [router, runType],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  /**
   * Which of these runs is waiting on a person.
   *
   * Only unfinished runs are asked, because a finished one cannot be waiting, and that bound is
   * what makes this affordable: the table pages at fifty rows but the live ones are a handful. The
   * alternative — a status the server maintains — would mean the database tracking a fact that
   * lives in Temporal's workflow state, and the two would disagree exactly when it mattered.
   */
  useEffect(() => {
    const live = executions.filter((execution) => !TERMINAL.has(execution.status));
    if (live.length === 0) {
      setAwaitingDecision(new Set());
      return;
    }
    let cancelled = false;
    async function scan(): Promise<void> {
      const waiting = await Promise.all(
        live.map(async (execution) => {
          const response = await fetch(`/api/executions/${execution.executionId}/events?limit=500`);
          if (!response.ok) return null;
          const body = (await response.json()) as { events: ExecutionEvent[] };
          return deriveDecisionState(body.events).pending.length > 0 ? execution.executionId : null;
        }),
      );
      if (cancelled) return;
      setAwaitingDecision(new Set(waiting.filter((id): id is string => id !== null)));
    }
    void scan();
    return () => {
      cancelled = true;
    };
  }, [executions]);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Executions</h2>
        <select
          value={runType}
          onChange={(event) => setRunType(event.target.value as RunType | 'all')}
          data-testid="run-type-filter"
        >
          <option value="all">all runs</option>
          <option value="live">live</option>
          <option value="eval">eval</option>
        </select>
      </div>
      {error === null ? null : <p className="banner error">{error}</p>}
      <div className="panel stack">
        <ExecutionList executions={executions} awaitingDecision={awaitingDecision} />
        {nextCursor === null ? null : (
          <button type="button" onClick={() => void load(nextCursor)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
