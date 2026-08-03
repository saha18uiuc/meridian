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
  temporal_run_id?: string | null;
  status?: 'queued' | 'running';
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
    in: (column: string, value: unknown) => {
      filters[`in:${column}`] = value;
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

function temporalWith(
  describeImpl: () => Promise<{ runId: string; status?: { name: string } }>,
  resultImpl: () => Promise<unknown> = () => Promise.reject(new Error('no result')),
): Client {
  return {
    workflow: {
      getHandle: () => ({
        describe: async () => {
          const described = await describeImpl();
          return { status: { name: 'RUNNING' }, ...described };
        },
        result: resultImpl,
      }),
    },
  } as unknown as Client;
}

const now = () => Date.parse('2026-01-01T00:10:00.000Z');

describe('reconcileQueuedExecutions', () => {
  it('only considers pending rows with a workflow ID older than the grace period', async () => {
    const { supabase, filters } = supabaseWith([]);
    await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(async () => ({ runId: 'r' })),
      now,
    });
    expect(filters['in:status']).toEqual(['queued', 'running']);
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

  it('leaves a running row alone while its workflow is still working', async () => {
    const { supabase, rpc } = supabaseWith([
      {
        execution_id: 'e1',
        temporal_workflow_id: 'receiving:K',
        temporal_run_id: 'run-1',
        status: 'running',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    const outcomes = await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(async () => ({ runId: 'run-1', status: { name: 'RUNNING' } })),
      now,
    });
    expect(outcomes).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('copies the workflow result across when the completion write was lost', async () => {
    const { supabase, rpc } = supabaseWith([
      {
        execution_id: 'e1',
        temporal_workflow_id: 'receiving:K',
        temporal_run_id: 'run-1',
        status: 'running',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    const outcomes = await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(
        async () => ({ runId: 'run-1', status: { name: 'COMPLETED' } }),
        async () => ({ executionId: 'e1', outcome: 'ready' }),
      ),
      now,
    });
    expect(rpc).toHaveBeenCalledWith('complete_execution', {
      p_execution_id: 'e1',
      p_status: 'passed',
      p_output_summary: { executionId: 'e1', outcome: 'ready' },
      p_diff_summary: null,
    });
    expect(outcomes[0]?.action).toBe('closed_from_workflow');
  });

  it('refuses to attribute a run that reported a different execution', async () => {
    // The shape a duplicate intake leaves behind: the row names a run, but that run was carrying
    // someone else's execution ID. Its outcome is not this row's outcome at any price.
    const { supabase, rpc } = supabaseWith([
      {
        execution_id: 'e1',
        temporal_workflow_id: 'receiving:K',
        temporal_run_id: 'run-1',
        status: 'running',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);
    const outcomes = await reconcileQueuedExecutions({
      supabase,
      temporal: temporalWith(
        async () => ({ runId: 'run-1', status: { name: 'COMPLETED' } }),
        async () => ({ executionId: 'other', outcome: 'ready' }),
      ),
      now,
    });
    expect(rpc).toHaveBeenCalledWith('fail_execution', {
      p_execution_id: 'e1',
      p_error: {
        code: 'RUN_BELONGS_TO_ANOTHER_EXECUTION',
        detail: 'the run reported execution other',
      },
    });
    expect(outcomes[0]?.action).toBe('failed_lost_workflow');
    expect(rpc.mock.calls.map((call) => call[0])).not.toContain('complete_execution');
  });
});
