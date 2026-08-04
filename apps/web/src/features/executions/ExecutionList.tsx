'use client';

import type { Execution } from '@meridian/core/schemas';
import Link from 'next/link';

function statusClass(status: Execution['status']): string {
  if (status === 'passed') return 'badge ok';
  if (status === 'failed' || status === 'error') return 'badge error';
  return 'badge';
}

export function ExecutionList({
  executions,
  awaitingDecision,
}: {
  executions: Execution[];
  /** Execution ids with a handoff nobody has answered. Absent when the caller has not looked. */
  awaitingDecision?: ReadonlySet<string>;
}) {
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
              {/* A run parked on a handoff still reads `running`, because it is: the workflow is
                  alive and sitting in a condition. The status column is therefore true and useless
                  for the one thing an operator scanning this table needs to find. */}
              {awaitingDecision?.has(execution.executionId) === true ? (
                <span
                  className="badge blocking"
                  data-testid={`awaiting-decision-${execution.executionId}`}
                  title="This run has asked a question and is waiting for an answer"
                >
                  waiting on you
                </span>
              ) : null}
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
