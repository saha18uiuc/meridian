import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';
import {
  RECONCILE_MIN_AGE_MS,
  reconcileQueuedExecutions,
} from '../src/intake/reconcile-queued-executions.js';

interface QueuedRow {
  execution_id: string;
  temporal_workflow_id: string | null;
  created_at: string;
}

function supabaseWith(
  rows: QueuedRow[],
  rpcResults: Record<string, unknown> = {},
): {
  supabase: SupabaseClient<Database>;
  rpc: ReturnType<typeof vi.fn>;
  filters: Record<string, unknown>;
} {
  const filters: Record<string, unknown> = {};
  const rpc = vi.fn((name: string) =>
    Promise.resolve({ data: rpcResults[name] ?? {}, error: null }),
  );

  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters[`eq:${column}`] = value;
      return builder;
    },
    not: (column: string, operator: string, value: unknown) => {
      filters[`not:${column}`] = `${operator}:${String(value)}`;
      return builder;
    },
    lt: (column: string, value: unknown) => {
      filters[`lt:${column}`] = value;
      return builder;
    },
    order: () => Promise.resolve({ data: rows, error: null }),
  };

  return {
    supabase: { from: () => builder, rpc } as unknown as SupabaseClient<Database>,
    rpc,
    filters,
  };
}

function temporalWith(describeImpl: () => Promise<{ runId: string }>): Client {
  return {
    workflow: { getHandle: () => ({ describe: describeImpl }) },
  } as unknown as Client;
}

const now = () => Date.parse('2026-01-01T00:10:00.000Z');

describe('reconcileQueuedExecutions', () => {
  it('only considers queued rows with a workflow ID older than the grace period', async () => {
    const { supabase, filters } = supabaseWith([]);
    await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(async () => ({ runId: 'r' })),
      now,
    });
    expect(filters['eq:status']).toBe('queued');
    expect(filters['not:temporal_workflow_id']).toBe('is:null');
    expect(filters['lt:created_at']).toBe(new Date(now() - RECONCILE_MIN_AGE_MS).toISOString());
  });

  it('replays start_execution for a workflow Temporal confirms is running', async () => {
    const { supabase, rpc } = supabaseWith(
      [
        {
          execution_id: 'e1',
          temporal_workflow_id: 'receiving:K',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      { start_execution: { wasAlreadyStarted: false } },
    );
    const outcomes = await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(async () => ({ runId: 'run-9' })),
      now,
    });
    expect(rpc).toHaveBeenCalledWith('start_execution', {
      p_execution_id: 'e1',
      p_temporal_workflow_id: 'receiving:K',
      p_temporal_run_id: 'run-9',
    });
    expect(outcomes).toEqual([{ executionId: 'e1', action: 'started', workflowId: 'receiving:K' }]);
  });

  it('is a no-op when the row already left queued', async () => {
    const { supabase } = supabaseWith(
      [
        {
          execution_id: 'e1',
          temporal_workflow_id: 'receiving:K',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      { start_execution: { wasAlreadyStarted: true } },
    );
    const outcomes = await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(async () => ({ runId: 'run-9' })),
      now,
    });
    expect(outcomes[0]?.action).toBe('already_started');
  });

  it('fails the execution instead of starting a second workflow when none exists', async () => {
    const { supabase, rpc } = supabaseWith([
      {
        execution_id: 'e1',
        temporal_workflow_id: 'receiving:K',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    const outcomes = await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(() => Promise.reject(new Error('workflow not found'))),
      now,
    });
    expect(rpc).toHaveBeenCalledWith('fail_execution', {
      p_execution_id: 'e1',
      p_error: { code: 'WORKFLOW_START_FAILED', detail: 'workflow not found' },
    });
    expect(outcomes[0]?.action).toBe('failed_missing_workflow');
    // The point of the sweep: it never compensates by launching anything.
    expect(rpc.mock.calls.map((call) => call[0])).not.toContain('create_execution');
  });
});
