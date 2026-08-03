import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  truncateAll,
} from '../helpers/db.js';
import {
  type AgentFixture,
  type ExecutionFixture,
  idempotencyKey,
  seedActiveAgent,
  seedExecutionWithStep,
} from '../helpers/lineage.js';

/**
 * The external-action state machine (§5.9, A22).
 *
 * Its shape encodes an uncomfortable truth: Gmail accepts no idempotency token, so after a crash
 * between dispatch and completion the system genuinely does not know whether the email went out.
 * `needs_reconciliation` is that ignorance made explicit, and the only route out of it back to a
 * retryable state demands positive proof that nothing was delivered.
 */

let owner: string;
let agent: AgentFixture;
let execution: ExecutionFixture;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  agent = await seedActiveAgent(owner);
  execution = await seedExecutionWithStep(agent);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

interface ActionResult {
  executionActionId: string;
  status: string;
  markerToken: string;
  attemptCount: number;
  wasExisting?: boolean;
}

function reserve(suffix = 'a'): Promise<ActionResult> {
  return rpcAsService<ActionResult>('reserve_execution_action', [
    execution.executionId,
    execution.stepExecutionId,
    'mail.send',
    JSON.stringify({ to: 'broker@example.test', subject: 'Ready for entry' }),
    idempotencyKey(execution.executionId, 'intake', 'mail.send', suffix),
  ]);
}

async function statusOf(actionId: string): Promise<{
  status: string;
  completed_at: string | null;
  dispatched_at: string | null;
  attempt_count: number;
  provider_action_id: string | null;
}> {
  const { rows } = await asPostgres(async (client) =>
    client.query<{
      status: string;
      completed_at: string | null;
      dispatched_at: string | null;
      attempt_count: number;
      provider_action_id: string | null;
    }>(
      'select status, completed_at, dispatched_at, attempt_count, provider_action_id from public.execution_actions where execution_action_id = $1',
      [actionId],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('action disappeared');
  return row;
}

describe('reserve_execution_action', () => {
  it('creates a reserved action with a marker token derived from the key', async () => {
    const action = await reserve();
    expect(action).toMatchObject({ status: 'reserved', attemptCount: 0, wasExisting: false });
    expect(action.markerToken).toHaveLength(12);
  });

  it('returns the existing row for a duplicate reservation instead of creating a second', async () => {
    const first = await reserve();
    const second = await reserve();
    // This is the property that makes an activity retry safe: the same four inputs derive the
    // same key, and the same key can only ever name one action.
    expect(second).toMatchObject({ executionActionId: first.executionActionId, wasExisting: true });
  });

  it('rejects an action type outside the allowed set', async () => {
    await expectPgError(
      rpcAsService('reserve_execution_action', [
        execution.executionId,
        execution.stepExecutionId,
        'database.drop',
        JSON.stringify({}),
        idempotencyKey('x'),
      ]),
      'INVALID_ACTION_TYPE',
    );
  });

  it('rejects a reservation for an execution that does not exist', async () => {
    await expectPgError(
      rpcAsService('reserve_execution_action', [
        '00000000-0000-4000-8000-000000000000',
        null,
        'mail.send',
        JSON.stringify({}),
        idempotencyKey('y'),
      ]),
      'EXECUTION_NOT_FOUND',
    );
  });
});

describe('the happy path', () => {
  it('reserves, dispatches, and completes, incrementing the attempt count once', async () => {
    const action = await reserve();
    const dispatched = await rpcAsService<ActionResult>('dispatch_execution_action', [
      action.executionActionId,
    ]);
    expect(dispatched).toMatchObject({ status: 'dispatched', attemptCount: 1 });

    await rpcAsService('complete_execution_action', [
      action.executionActionId,
      'succeeded',
      'gmail-msg-1',
      JSON.stringify({ threadId: 't1' }),
    ]);
    const row = await statusOf(action.executionActionId);
    expect(row).toMatchObject({ status: 'succeeded', provider_action_id: 'gmail-msg-1' });
    expect(row.completed_at).not.toBeNull();
  });

  it('refuses to record success without a provider id', async () => {
    const action = await reserve();
    await rpcAsService('dispatch_execution_action', [action.executionActionId]);
    await expectPgError(
      rpcAsService('complete_execution_action', [
        action.executionActionId,
        'succeeded',
        '  ',
        null,
      ]),
      'PROVIDER_ID_REQUIRED_FOR_SUCCESS',
    );
  });

  it('refuses to dispatch anything that is not reserved', async () => {
    const action = await reserve();
    await rpcAsService('dispatch_execution_action', [action.executionActionId]);
    await expectPgError(
      rpcAsService('dispatch_execution_action', [action.executionActionId]),
      'ILLEGAL_TRANSITION',
    );
  });

  it('treats a repeated completion with the same status as already terminal', async () => {
    const action = await reserve();
    await rpcAsService('dispatch_execution_action', [action.executionActionId]);
    await rpcAsService('complete_execution_action', [
      action.executionActionId,
      'succeeded',
      'gmail-msg-1',
      null,
    ]);
    const again = await rpcAsService<{ wasAlreadyTerminal: boolean }>('complete_execution_action', [
      action.executionActionId,
      'succeeded',
      'gmail-msg-1',
      null,
    ]);
    expect(again.wasAlreadyTerminal).toBe(true);
  });
});

describe('reconciliation', () => {
  async function dispatchedAction(): Promise<ActionResult> {
    const action = await reserve();
    await rpcAsService('dispatch_execution_action', [action.executionActionId]);
    return action;
  }

  it('marks a dispatched action for reconciliation without making it terminal', async () => {
    const action = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      action.executionActionId,
      JSON.stringify({ code: 'INDETERMINATE_PROVIDER_RESULT' }),
    ]);
    const row = await statusOf(action.executionActionId);
    // Not terminal: the send might still have happened, so `completed_at` would be a claim the
    // system cannot support.
    expect(row).toMatchObject({ status: 'needs_reconciliation', completed_at: null });
  });

  it('promotes to succeeded when the marker is found in the sent folder', async () => {
    const action = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      action.executionActionId,
      JSON.stringify({ code: 'CRASH' }),
    ]);
    await rpcAsService('reconcile_execution_action', [
      action.executionActionId,
      'succeeded',
      'gmail-msg-9',
      JSON.stringify({ method: 'gmail.search', matchedProviderActionId: 'gmail-msg-9' }),
    ]);
    const row = await statusOf(action.executionActionId);
    expect(row).toMatchObject({ status: 'succeeded', provider_action_id: 'gmail-msg-9' });
    expect(row.completed_at).not.toBeNull();
  });

  it('refuses to return to reserved without proof of non-delivery', async () => {
    const action = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      action.executionActionId,
      JSON.stringify({ code: 'CRASH' }),
    ]);
    await expectPgError(
      rpcAsService('reconcile_execution_action', [
        action.executionActionId,
        'reserved',
        null,
        JSON.stringify({ method: 'gmail.search', inspectedCount: 0 }),
      ]),
      'RETRY_REQUIRES_PROVEN_NON_DELIVERY',
    );
  });

  it('returns to reserved and clears dispatched_at when non-delivery is proven', async () => {
    const action = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      action.executionActionId,
      JSON.stringify({ code: 'CRASH' }),
    ]);
    await rpcAsService('reconcile_execution_action', [
      action.executionActionId,
      'reserved',
      null,
      JSON.stringify({ provenNotDelivered: true, method: 'gmail.search', inspectedCount: 0 }),
    ]);
    const row = await statusOf(action.executionActionId);
    expect(row).toMatchObject({ status: 'reserved', dispatched_at: null, completed_at: null });
    // The attempt count is deliberately not reset: it is the budget that stops an indefinite loop.
    expect(row.attempt_count).toBe(1);
  });

  it('rejects abandoned as a reconciliation outcome, since it has its own function', async () => {
    const action = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      action.executionActionId,
      JSON.stringify({}),
    ]);
    await expectPgError(
      rpcAsService('reconcile_execution_action', [
        action.executionActionId,
        'abandoned',
        null,
        JSON.stringify({ provenNotDelivered: true }),
      ]),
      'INVALID_RECONCILIATION_OUTCOME',
    );
  });

  it('requires evidence for every reconciliation and abandonment', async () => {
    const action = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      action.executionActionId,
      JSON.stringify({}),
    ]);
    await expectPgError(
      rpcAsService('reconcile_execution_action', [
        action.executionActionId,
        'succeeded',
        'x',
        null,
      ]),
      'RECONCILIATION_EVIDENCE_REQUIRED',
    );
    await expectPgError(
      rpcAsService('abandon_execution_action', [action.executionActionId, null]),
      'RECONCILIATION_EVIDENCE_REQUIRED',
    );
  });

  it('abandons from needs_reconciliation and from reserved, but not from dispatched', async () => {
    const fromMarked = await dispatchedAction();
    await rpcAsService('mark_execution_action_for_reconciliation', [
      fromMarked.executionActionId,
      JSON.stringify({}),
    ]);
    await rpcAsService('abandon_execution_action', [
      fromMarked.executionActionId,
      JSON.stringify({ code: 'RECONCILIATION_AMBIGUOUS' }),
    ]);
    expect((await statusOf(fromMarked.executionActionId)).status).toBe('abandoned');

    // Abandoning from `reserved` is only reachable after a dispatch cycle returned the action to
    // `reserved`, because `ck_execution_actions_dispatch_counts` forbids a non-reserved-looking
    // action with no attempts — an action nobody ever tried to send has nothing to abandon.
    const fromReserved = await reserve('b');
    await rpcAsService('dispatch_execution_action', [fromReserved.executionActionId]);
    await rpcAsService('mark_execution_action_for_reconciliation', [
      fromReserved.executionActionId,
      JSON.stringify({}),
    ]);
    await rpcAsService('reconcile_execution_action', [
      fromReserved.executionActionId,
      'reserved',
      null,
      JSON.stringify({ provenNotDelivered: true, inspectedCount: 0 }),
    ]);
    await rpcAsService('abandon_execution_action', [
      fromReserved.executionActionId,
      JSON.stringify({ code: 'DISPATCH_BUDGET_EXHAUSTED' }),
    ]);
    expect((await statusOf(fromReserved.executionActionId)).status).toBe('abandoned');

    const stillDispatched = await reserve('c');
    await rpcAsService('dispatch_execution_action', [stillDispatched.executionActionId]);
    await expectPgError(
      rpcAsService('abandon_execution_action', [
        stillDispatched.executionActionId,
        JSON.stringify({ code: 'X' }),
      ]),
      'ILLEGAL_TRANSITION',
    );
  });
});

describe('the action event trail', () => {
  it('writes one event per phase, keyed by the marker token', async () => {
    const action = await reserve();
    await rpcAsService('dispatch_execution_action', [action.executionActionId]);
    await rpcAsService('complete_execution_action', [
      action.executionActionId,
      'succeeded',
      'gmail-1',
      null,
    ]);
    const { rows } = await asPostgres(async (client) =>
      client.query<{ event_key: string }>(
        "select event_key from public.execution_events where event_type = 'action' order by event_id",
      ),
    );
    expect(rows.map((row) => row.event_key)).toEqual([
      `action:reserved:${action.markerToken}`,
      `action:dispatched:${action.markerToken}:1`,
      `action:succeeded:${action.markerToken}`,
    ]);
  });
});
