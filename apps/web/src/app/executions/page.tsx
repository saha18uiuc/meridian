'use client';

import type { Execution, RunType } from '@meridian/core/schemas';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ExecutionList } from '@/features/executions/ExecutionList';

export default function ExecutionsPage() {
  const router = useRouter();
  const [executions, setExecutions] = useState<Execution[]>([]);
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
        <ExecutionList executions={executions} />
        {nextCursor === null ? null : (
          <button type="button" onClick={() => void load(nextCursor)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
