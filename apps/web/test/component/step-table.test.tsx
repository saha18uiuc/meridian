import type { ExecutionStep } from '@meridian/core/schemas';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StepTable } from '@/features/executions/StepTable';

/**
 * The step table.
 *
 * Steps are grouped by `stepInstanceKey`, never by `sequenceNo`, and that distinction is the whole
 * reason the column exists. Under parallelism several steps legitimately share a sequence number,
 * and a retry is a second attempt at one step rather than a second step. Grouping by the display
 * ordinal would merge unrelated parallel work into one row and report a retried step as two.
 */

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    stepExecutionId: `step-${Math.random().toString(36).slice(2)}`,
    executionId: '11111111-1111-4111-8111-111111111111',
    nodeId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract-fields',
    stepInstanceKey: 'extract-fields',
    sequenceNo: 1,
    attemptNo: 1,
    status: 'succeeded',
    inputSummaryJson: null,
    outputSummaryJson: null,
    errorJson: null,
    startedAt: '2026-02-11T00:00:00.000Z',
    completedAt: '2026-02-11T00:00:01.000Z',
    ...overrides,
  } as ExecutionStep;
}

function rows() {
  return within(screen.getByTestId('step-table')).getAllByRole('row').slice(1);
}

describe('an execution with no steps', () => {
  it('says so instead of rendering an empty table', () => {
    render(<StepTable steps={[]} />);
    expect(screen.getByTestId('steps-empty')).toBeInTheDocument();
  });
});

describe('retries', () => {
  it('collapses attempts of one step into a single row', () => {
    render(
      <StepTable
        steps={[
          step({ attemptNo: 1, status: 'failed' }),
          step({ attemptNo: 2, status: 'failed' }),
          step({ attemptNo: 3, status: 'succeeded' }),
        ]}
      />,
    );

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('3');
    // The row reports the latest attempt's status, which is the one that decided the outcome.
    expect(rows()[0]).toHaveTextContent('succeeded');
  });

  it('reports the latest attempt even when the attempts arrive out of order', () => {
    render(
      <StepTable
        steps={[step({ attemptNo: 2, status: 'failed' }), step({ attemptNo: 1, status: 'failed' })]}
      />,
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('failed');
  });
});

describe('parallel steps', () => {
  it('keeps siblings that share a sequence number as separate rows', () => {
    // Twelve goods extracted in parallel all carry the same display ordinal. Merging them would
    // report one step where twelve ran, and hide eleven failures.
    render(
      <StepTable
        steps={[
          step({ stepInstanceKey: 'extract-goods#0', stepKey: 'extract-goods', sequenceNo: 2 }),
          step({ stepInstanceKey: 'extract-goods#1', stepKey: 'extract-goods', sequenceNo: 2 }),
          step({
            stepInstanceKey: 'extract-goods#2',
            stepKey: 'extract-goods',
            sequenceNo: 2,
            status: 'failed',
          }),
        ]}
      />,
    );

    expect(rows()).toHaveLength(3);
    expect(screen.getAllByText('extract-goods')).toHaveLength(3);
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('orders by sequence, then by instance key so the order is total', () => {
    render(
      <StepTable
        steps={[
          step({ stepInstanceKey: 'send-email', sequenceNo: 3 }),
          step({ stepInstanceKey: 'extract-goods#1', sequenceNo: 2 }),
          step({ stepInstanceKey: 'extract-goods#0', sequenceNo: 2 }),
          step({ stepInstanceKey: 'read-mail', sequenceNo: 1 }),
        ]}
      />,
    );

    const keys = rows().map((row) => row.querySelector('code')?.textContent);
    // Sequence alone is not a total order under parallelism, so the instance key breaks the tie
    // and the table renders the same way every time it is drawn.
    expect(keys).toEqual(['read-mail', 'extract-goods#0', 'extract-goods#1', 'send-email']);
  });
});

describe('step detail', () => {
  it('stays collapsed until asked, then shows input, output, and error together', async () => {
    const user = userEvent.setup();
    render(
      <StepTable
        steps={[
          step({
            stepInstanceKey: 'extract-fields',
            status: 'failed',
            inputSummaryJson: { attachments: 2 },
            // A failed step has no output, and the column is `not null default '{}'`, so the empty
            // object is what the row actually holds — not null.
            outputSummaryJson: {},
            errorJson: { code: 'EXTRACTION_FAILED' },
          }),
        ]}
      />,
    );

    expect(screen.queryByTestId('step-detail-extract-fields')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'extract-fields' }));

    const detail = screen.getByTestId('step-detail-extract-fields');
    expect(detail).toHaveTextContent('attachments');
    expect(detail).toHaveTextContent('EXTRACTION_FAILED');

    await user.click(screen.getByRole('button', { name: 'extract-fields' }));
    expect(screen.queryByTestId('step-detail-extract-fields')).not.toBeInTheDocument();
  });

  it('shows one step’s detail at a time', async () => {
    const user = userEvent.setup();
    render(
      <StepTable
        steps={[
          step({ stepInstanceKey: 'first', sequenceNo: 1 }),
          step({ stepInstanceKey: 'second', sequenceNo: 2 }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'first' }));
    await user.click(screen.getByRole('button', { name: 'second' }));

    expect(screen.queryByTestId('step-detail-first')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-detail-second')).toBeInTheDocument();
  });
});
