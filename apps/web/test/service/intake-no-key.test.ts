import { randomUUID } from 'node:crypto';
import { intakeMessage } from '@meridian/ops/intake';
import type { Client } from '@temporalio/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activeAgent,
  createBoard,
  ensureUser,
  freezeBoard,
  serviceClient,
  userClient,
} from './helpers';

/**
 * The no-business-key intake path, asserted with a Temporal client that records every call.
 *
 * The assertion that matters is negative: **no Temporal method is invoked at all**. A mock that
 * merely returns a plausible result would let a regression start a workflow and still pass, so the
 * client here has no working methods, only spies.
 */

function recordingTemporal(): { client: Client; calls: string[] } {
  const calls: string[] = [];
  const trap = (name: string) =>
    vi.fn(() => {
      calls.push(name);
      throw new Error(`Temporal.${name} must not be called on the no-key intake path`);
    });
  const client = {
    workflow: {
      start: trap('workflow.start'),
      signalWithStart: trap('workflow.signalWithStart'),
      signal: trap('workflow.signal'),
      getHandle: trap('workflow.getHandle'),
      execute: trap('workflow.execute'),
    },
  } as unknown as Client;
  return { client, calls };
}

let agentId: string;

beforeAll(async () => {
  const service = serviceClient();
  const email = `intake-${randomUUID()}@meridian.test`;
  const password = 'meridian-test-password';
  const ownerId = await ensureUser(email, password);

  // `create_whiteboard` derives the owner from `auth.uid()`, so the board is created through a
  // real signed-in client rather than by the service role inserting a row with an owner column.
  const operator = await userClient(email, password);
  const board = await createBoard(operator);
  const { specId, specHash } = await freezeBoard(service, ownerId, board.whiteboardId);
  ({ agentId } = await activeAgent(
    service,
    operator,
    ownerId,
    board.whiteboardId,
    specId,
    specHash,
  ));
});

describe('intake with no usable business key', () => {
  it('writes a terminal manual-review execution and never touches Temporal', async () => {
    const service = serviceClient();
    const { client, calls } = recordingTemporal();
    const providerMessageId = `<no-key-${randomUUID()}@forwarder.example>`;

    const result = await intakeMessage({ supabase: service, temporal: client }, agentId, {
      messageRef: {
        provider: 'gmail',
        providerMessageId,
        threadId: 'thread-no-key',
        subject: "Documents for next week's arrival",
        receivedAt: '2026-02-11T00:00:00.000Z',
        storagePath: null,
      },
      content: {
        subject: "Documents for next week's arrival",
        body: 'Paperwork attached. Please confirm receipt.',
      },
    });

    expect(result.action).toBe('manual_review');
    expect(calls).toEqual([]);

    const { data, error } = await service
      .from('executions')
      .select(
        'status, run_type, business_key, temporal_workflow_id, output_summary_json, completed_at',
      )
      .eq('execution_id', result.executionId)
      .single();
    expect(error).toBeNull();
    expect(data?.status).toBe('passed');
    expect(data?.run_type).toBe('live');
    expect(data?.business_key).toBeNull();
    expect(data?.temporal_workflow_id).toBeNull();
    expect(data?.completed_at).not.toBeNull();
    expect((data?.output_summary_json as { outcome?: string } | null)?.outcome).toBe(
      'manual_review',
    );

    const events = await service
      .from('execution_events')
      .select('event_type, event_key')
      .eq('execution_id', result.executionId);
    expect(events.error).toBeNull();
    expect(events.data?.some((event) => event.event_type === 'evidence')).toBe(true);
  });

  it('is idempotent: redelivering the same message reuses the terminal row', async () => {
    const service = serviceClient();
    const providerMessageId = `<no-key-${randomUUID()}@forwarder.example>`;
    const message = {
      messageRef: {
        provider: 'gmail' as const,
        providerMessageId,
        threadId: 'thread-no-key',
        subject: 'Paperwork',
        receivedAt: '2026-02-11T00:00:00.000Z',
        storagePath: null,
      },
      content: { subject: 'Paperwork', body: 'No identifiers in this message.' },
    };

    const first = await intakeMessage(
      { supabase: service, temporal: recordingTemporal().client },
      agentId,
      message,
    );
    const second = await intakeMessage(
      { supabase: service, temporal: recordingTemporal().client },
      agentId,
      message,
    );

    expect(second.executionId).toBe(first.executionId);
    expect(second.wasExisting).toBe(true);
  });

  it('records conflicting keys as a conflict, with both candidates', async () => {
    const service = serviceClient();
    const result = await intakeMessage(
      { supabase: service, temporal: recordingTemporal().client },
      agentId,
      {
        messageRef: {
          provider: 'gmail',
          providerMessageId: `<conflict-${randomUUID()}@forwarder.example>`,
          threadId: 'thread-conflict',
          subject: 'Combined update - MSKU1234565 and TGHU7654320',
          receivedAt: '2026-02-11T00:00:00.000Z',
          storagePath: null,
        },
        content: {
          subject: 'Combined update - MSKU1234565 and TGHU7654320',
          body: 'Two shipments in one message.',
        },
      },
    );

    expect(result.action).toBe('manual_review');
    if (result.action !== 'manual_review') throw new Error('unreachable');
    expect(result.reason).toBe('CONFLICTING_BUSINESS_KEYS');
    // Both candidates are recorded. Picking one would be a guess, and the whole point of this
    // branch is that the system does not guess.
    expect(result.candidates).toHaveLength(2);
  });
});
