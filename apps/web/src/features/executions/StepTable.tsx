'use client';

import type { ExecutionStep } from '@meridian/core/schemas';
import { useState } from 'react';

/**
 * Attempts of the same logical step are grouped under `stepInstanceKey`, not `sequenceNo`, so a
 * retry reads as a second attempt of one step rather than as a second step.
 */
function groupByInstance(steps: ExecutionStep[]): Map<string, ExecutionStep[]> {
  const groups = new Map<string, ExecutionStep[]>();
  for (const step of steps) {
    const list = groups.get(step.stepInstanceKey) ?? [];
    list.push(step);
    groups.set(step.stepInstanceKey, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.attemptNo - b.attemptNo);
  return groups;
}

export function StepTable({ steps }: { steps: ExecutionStep[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const groups = [...groupByInstance(steps).entries()].sort((a, b) => {
    const left = a[1][0];
    const right = b[1][0];
    if (left === undefined || right === undefined) return 0;
    return left.sequenceNo - right.sequenceNo || a[0].localeCompare(b[0]);
  });

  if (groups.length === 0) {
    return (
      <p className="muted" data-testid="steps-empty">
        No steps recorded.
      </p>
    );
  }

  return (
    <table data-testid="step-table">
      <thead>
        <tr>
          <th>Seq</th>
          <th>Step instance</th>
          <th>Step key</th>
          <th>Attempts</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {groups.map(([instanceKey, attempts]) => {
          const latest = attempts[attempts.length - 1];
          if (latest === undefined) return null;
          const isOpen = expanded === instanceKey;
          return (
            <tr key={instanceKey}>
              <td className="muted">{latest.sequenceNo}</td>
              <td>
                <button type="button" onClick={() => setExpanded(isOpen ? null : instanceKey)}>
                  <code>{instanceKey}</code>
                </button>
                {isOpen ? (
                  <pre data-testid={`step-detail-${instanceKey}`}>
                    {JSON.stringify(
                      {
                        input: latest.inputSummaryJson,
                        output: latest.outputSummaryJson,
                        error: latest.errorJson,
                      },
                      null,
                      2,
                    )}
                  </pre>
                ) : null}
              </td>
              <td>{latest.stepKey}</td>
              <td>{attempts.length}</td>
              <td>
                <span className={latest.status === 'succeeded' ? 'badge ok' : 'badge'}>
                  {latest.status}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
