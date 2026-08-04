import {
  type AgentContext,
  type AgentDefinition,
  resolvePinnedAgent,
  runAgent,
} from '@meridian/agent-kit/contracts';
import type { AgentDecision, MessageRef } from '@meridian/core/schemas';
import type { ReceivingWorkflowInput } from '@meridian/core/temporal-contract';
import { AGENT_REGISTRY } from '@meridian/generated-agents';
import * as workflow from '@temporalio/workflow';
import { humanDecisionSignal, type HumanDecisionPayload, newMessageSignal } from '../signals.js';
import { planSequences } from './sequence-plan.js';
import {
  activities,
  asWorkflowFailure,
  createWorkflowLogger,
  createWorkflowRecorder,
  createWorkflowToolRegistry,
  workflowClock,
  workflowIdempotency,
} from './tool-proxies.js';

/**
 * The durable orchestration for inbound import receiving.
 *
 * Everything here is deterministic: no clock beyond `workflow.now()`, no randomness, no I/O, and
 * no `p-limit`. Bounded parallelism uses precomputed sorted chunks, because `p-limit`'s scheduling
 * depends on promise resolution order and replay does not reproduce that.
 *
 * The workflow is idempotent on `executionId` and deduplicates messages on `providerMessageId`, so
 * a redelivered signal or a replayed history adds nothing.
 */

/**
 * The wire type from `@meridian/core/temporal-contract`, narrowed to the schema-inferred
 * `MessageRef` the workflow body actually works with. Declaring it as an intersection rather than
 * re-listing the fields is what keeps the worker and the intake service from drifting apart.
 */
export type ReceivingInput = Omit<ReceivingWorkflowInput, 'messageRefs'> & {
  messageRefs: MessageRef[];
};

export interface ReceivingResult {
  executionId: string;
  outcome: AgentDecision['outcome'];
  decision: AgentDecision;
  messageCount: number;
}

/** How long the workflow keeps the door open for a follow-up message before deciding. */
export const QUIET_PERIOD = '30 seconds';

export async function receivingWorkflow(input: ReceivingInput): Promise<ReceivingResult> {
  const seen = new Set<string>();
  const messages: MessageRef[] = [];
  const decisions = new Map<string, HumanDecisionPayload>();

  function accept(messageRef: MessageRef): void {
    // Deduplicating here is what lets Signal-With-Start pass the first message as both the
    // workflow argument and the signal payload without double-counting it.
    if (seen.has(messageRef.providerMessageId)) return;
    seen.add(messageRef.providerMessageId);
    messages.push(messageRef);
  }

  for (const messageRef of input.messageRefs) accept(messageRef);

  workflow.setHandler(newMessageSignal, (messageRef: MessageRef) => {
    accept(messageRef);
  });
  workflow.setHandler(humanDecisionSignal, (payload: HumanDecisionPayload) => {
    decisions.set(payload.requestId, payload);
  });

  const logger = createWorkflowLogger();
  const recorder = createWorkflowRecorder(input.executionId);

  let currentStepInstanceKey = 'intake';
  let currentStepExecutionId: string | null = null;

  const tools = createWorkflowToolRegistry({
    executionId: input.executionId,
    capabilities: input.capabilities,
    toolkitVersion: input.toolkitVersion,
    decisions,
    currentStepInstanceKey: () => currentStepInstanceKey,
    currentStepExecutionId: () => currentStepExecutionId,
  });

  // The agent is resolved from the pinned triple, never from "whatever is active now". Activating
  // a newer version must not change what an already-running workflow executes.
  let definition: AgentDefinition;
  try {
    definition = resolvePinnedAgent(AGENT_REGISTRY, {
      deploymentKey: input.deploymentKey,
      versionNo: input.versionNo,
      specHash: input.specHash,
    });
  } catch (error) {
    // A worker holding the wrong code is a deployment problem, and it will still be the wrong code
    // on the next attempt. Failing the execution says so; retrying the task would hide it.
    throw asWorkflowFailure(error);
  }

  const intakePlan = planSequences({ invoices: [], batchNumbers: [] });
  currentStepInstanceKey = `intake:${input.businessKey}`;
  const intakeStep = await recorder.startStep({
    nodeId: null,
    stepKey: 'intake',
    stepInstanceKey: currentStepInstanceKey,
    sequenceNo: intakePlan.stage('intake'),
    inputSummary: { messageCount: messages.length, businessKey: input.businessKey },
  });
  currentStepExecutionId = intakeStep.stepExecutionId;

  // A quiet period rather than a fixed wait: correlated documents usually arrive within seconds of
  // each other, and deciding before they land would produce an avoidable `missing_information`.
  const before = messages.length;
  await workflow.condition(() => messages.length > before, QUIET_PERIOD);

  await recorder.completeStep(intakeStep.stepExecutionId, {
    messageCount: messages.length,
    threadIds: [...new Set(messages.map((message) => message.threadId))].sort(),
  });

  // Built inline rather than through `createAgentContext`, because the sandbox supplies its own
  // clock and idempotency helper and must not pull the Node-only builder into the bundle.
  const context: AgentContext = {
    executionId: input.executionId,
    agentId: input.agentId,
    agentVersionId: input.agentVersionId,
    deploymentKey: input.deploymentKey,
    versionNo: input.versionNo,
    specHash: input.specHash,
    gitCommitSha: input.gitCommitSha,
    businessKey: input.businessKey,
    capabilities: input.capabilities,
    clock: workflowClock,
    logger,
    toolRegistry: tools,
    recorder,
    idempotency: workflowIdempotency,
    config: {
      toolkitVersions: { composioGmailToolkit: input.toolkitVersion },
      operatorEmail: input.operatorEmail,
      maxConcurrency: input.maxConcurrency,
    },
  };

  let decision: AgentDecision;
  try {
    decision = await runAgent(
      definition,
      { businessKey: input.businessKey, messages, capabilities: input.capabilities },
      context,
    );
  } catch (error) {
    // The row is closed before the failure is rethrown, because a workflow that ends without
    // closing it leaves the execution reading `running` forever — the operator would see a shipment
    // still in flight that failed minutes ago. `fail_execution` is idempotent, so a replay is free.
    await activities.executionFail({
      executionId: input.executionId,
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    // Without this the run would not fail — it would hang, because Temporal retries a workflow
    // task forever when the error is not an `ApplicationFailure`.
    throw asWorkflowFailure(error);
  }

  await activities.recorderAppendEvidence({
    executionId: input.executionId,
    stepExecutionId: null,
    payload: { phase: 'decision', outcome: decision.outcome, reason: decision.reason },
    eventKey: `decision:${input.businessKey}`,
  });

  // `resultKind` rather than a top-level `outcome`: that key is reserved by
  // `ck_executions_manual_review_has_no_workflow` for the intake manual-review path, and a workflow
  // that wrote it would be claiming to be an execution with no workflow. The eval harness records
  // the same shape, so one reader serves both.
  await activities.executionComplete({
    executionId: input.executionId,
    status: 'passed',
    outputSummary: {
      resultKind: decision.outcome,
      businessKey: input.businessKey,
      reason: decision.reason,
      messageCount: messages.length,
      summary: decision.summary,
    },
  });

  return {
    executionId: input.executionId,
    outcome: decision.outcome,
    decision,
    messageCount: messages.length,
  };
}
