'use client';

import type { ExecutionAction } from '@meridian/core/schemas';
import { isTerminalActionStatus } from '@meridian/core/schemas';

/**
 * The panel states delivery honestly. `dispatched` means the request left the process, not that
 * the mail arrived, and `needs_reconciliation` is shown as an open question rather than a failure.
 */
function describe(status: ExecutionAction['status']): string {
  switch (status) {
    case 'reserved':
      return 'Reserved. Nothing has been sent.';
    case 'dispatched':
      return 'Dispatched. Delivery is not yet confirmed.';
    case 'succeeded':
      return 'Provider accepted the request.';
    case 'failed':
      return 'Provider rejected the request.';
    case 'needs_reconciliation':
      return 'Outcome unknown. Resending requires proof of non-delivery.';
    case 'abandoned':
      return 'Abandoned without proof, to avoid duplicating a possibly real send.';
  }
}

export function ActionPanel({ actions }: { actions: ExecutionAction[] }) {
  if (actions.length === 0) {
    return (
      <p className="muted" data-testid="actions-empty">
        No external actions.
      </p>
    );
  }
  return (
    <table data-testid="action-panel">
      <thead>
        <tr>
          <th>Type</th>
          <th>Status</th>
          <th>Marker</th>
          <th>Provider id</th>
          <th>Attempts</th>
          <th>Meaning</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((action) => (
          <tr key={action.executionActionId}>
            <td>{action.actionType}</td>
            <td>
              <span
                className={
                  action.status === 'succeeded'
                    ? 'badge ok'
                    : action.status === 'needs_reconciliation'
                      ? 'badge warn'
                      : 'badge'
                }
              >
                {action.status}
              </span>
              {isTerminalActionStatus(action.status) ? null : (
                <span className="muted"> in flight</span>
              )}
            </td>
            <td>
              <code>{action.markerToken}</code>
            </td>
            <td>
              <code>{action.providerActionId ?? '—'}</code>
            </td>
            <td>{action.attemptCount}</td>
            <td className="muted">{describe(action.status)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
