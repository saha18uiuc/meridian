'use client';

import type { Execution } from '@meridian/core/schemas';
import Link from 'next/link';

function statusClass(status: Execution['status']): string {
  if (status === 'passed') return 'badge ok';
  if (status === 'failed' || status === 'error') return 'badge error';
  return 'badge';
}

export function ExecutionList({ executions }: { executions: Execution[] }) {
  if (executions.length === 0) {
    return (
      <p className="muted" data-testid="executions-empty">
        No executions yet.
      </p>
    );
  }
  return (
    <table data-testid="execution-list">
      <thead>
        <tr>
          <th>Case</th>
          <th>Type</th>
          <th>Business key</th>
          <th>Status</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {executions.map((execution) => (
          <tr key={execution.executionId}>
            <td>
              <Link href={`/executions/${execution.executionId}`}>{execution.caseKey}</Link>
            </td>
            <td>{execution.runType}</td>
            <td>
              <code>{execution.businessKey ?? '—'}</code>
            </td>
            <td>
              <span className={statusClass(execution.status)}>{execution.status}</span>
            </td>
            <td className="muted">
              {execution.startedAt === null
                ? 'not started'
                : new Date(execution.startedAt).toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
