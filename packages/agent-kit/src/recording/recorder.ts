import type { Database } from '@meridian/core/database';
import { sha256Hex } from '@meridian/core/hashing';
import type { ActionType, ExecutionAction, ExecutionStep } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExecutionRecorder } from '../contracts.js';
import { deriveActionKey } from '../idempotency.js';
import { artifactPath, createArtifactStore, type StorageBucket } from '../storage.js';
import * as actions from './actions.js';
import { appendEvent, isOversizePayload } from './events.js';
import { finishStep, insertStep } from './steps.js';

type Client = SupabaseClient<Database>;

export interface RecorderOptions {
  executionId: string;
  /** Bucket used when an evidence payload is too large to keep inline. */
  overflowBucket?: StorageBucket;
}

/**
 * The persistence surface generated agents never see directly.
 *
 * It exists so a generated folder can stay ignorant of the Supabase schema: it records steps and
 * evidence through this interface, and the day the storage layout changes, nothing under
 * `generated-agents/` has to change with it.
 */
export function createExecutionRecorder(
  client: Client,
  options: RecorderOptions,
): ExecutionRecorder {
  const executionId = options.executionId;
  const overflowBucket: StorageBucket = options.overflowBucket ?? 'ocr';
  const store = createArtifactStore(client);
  const instanceKeyByStep = new Map<string, string>();

  /**
   * A retried activity gets a fresh recorder, so the in-process map may be cold. The instance key
   * is read back from the row in that case, because the idempotency key must come out identical
   * across processes or the replay would reserve a second action.
   */
  async function instanceKeyOf(stepExecutionId: string | null): Promise<string> {
    if (stepExecutionId === null) return 'execution';
    const cached = instanceKeyByStep.get(stepExecutionId);
    if (cached !== undefined) return cached;
    const { data, error } = await client
      .from('execution_steps')
      .select('step_instance_key')
      .eq('step_execution_id', stepExecutionId)
      .maybeSingle();
    if (error !== null) throw new Error(`Step lookup failed: ${error.message}`);
    if (data === null) throw new Error(`Step ${stepExecutionId} not found.`);
    instanceKeyByStep.set(stepExecutionId, data.step_instance_key);
    return data.step_instance_key;
  }

  return {
    async startStep(input): Promise<ExecutionStep> {
      const step = await insertStep(client, {
        executionId,
        nodeId: input.nodeId,
        stepKey: input.stepKey,
        stepInstanceKey: input.stepInstanceKey,
        sequenceNo: input.sequenceNo,
        attemptNo: input.attemptNo ?? 1,
        inputSummary: input.inputSummary ?? {},
      });
      instanceKeyByStep.set(step.stepExecutionId, step.stepInstanceKey);
      return step;
    },

    async completeStep(stepExecutionId, output): Promise<ExecutionStep> {
      return finishStep(client, stepExecutionId, { status: 'succeeded', output });
    },

    async failStep(stepExecutionId, error): Promise<ExecutionStep> {
      return finishStep(client, stepExecutionId, { status: 'failed', error });
    },

    async appendEvidence(stepExecutionId, payload, evidenceOptions): Promise<{ eventId: number }> {
      let storagePath = evidenceOptions?.storagePath ?? null;
      let inlinePayload = payload;

      // An oversized payload is moved wholesale to Storage and replaced by a pointer, so paging
      // the event feed never has to stream a megabyte of extracted text.
      if (storagePath === null && isOversizePayload(payload)) {
        const instanceKey = await instanceKeyOf(stepExecutionId);
        storagePath = artifactPath({
          bucket: overflowBucket,
          executionId,
          stepInstanceKey: instanceKey,
          // Content-addressed rather than time-stamped, so a replayed activity overwrites the
          // same object instead of littering Storage with near-identical copies.
          filename: `${evidenceOptions?.eventKey ?? 'evidence'}-${sha256Hex(payload).slice(0, 16)}.json`,
        });
        await store.put(storagePath, JSON.stringify(payload), 'application/json');
        inlinePayload = { truncated: true, reason: 'PAYLOAD_MOVED_TO_STORAGE' };
      }

      return appendEvent(client, {
        executionId,
        stepExecutionId,
        eventType: 'evidence',
        eventKey: evidenceOptions?.eventKey ?? null,
        payload: inlinePayload,
        storagePath,
      });
    },

    async reserveAction(
      stepExecutionId: string | null,
      actionType: ActionType,
      payload: Record<string, unknown>,
    ): Promise<ExecutionAction> {
      const instanceKey = await instanceKeyOf(stepExecutionId);
      const idempotencyKey = deriveActionKey({
        executionId,
        stepInstanceKey: instanceKey,
        actionType,
        payload,
      });
      return actions.reserveAction(client, {
        executionId,
        stepExecutionId,
        actionType,
        payload,
        idempotencyKey,
      });
    },

    dispatchAction: (executionActionId) => actions.dispatchAction(client, executionActionId),
    completeAction: (executionActionId, result) =>
      actions.completeAction(client, executionActionId, result),
    markActionForReconciliation: (executionActionId, reason) =>
      actions.markActionForReconciliation(client, executionActionId, reason),
    reconcileAction: (executionActionId, outcome, providerActionId, evidence) =>
      actions.reconcileAction(client, executionActionId, outcome, providerActionId, evidence),
    abandonAction: (executionActionId, reason) =>
      actions.abandonAction(client, executionActionId, reason),
  };
}
