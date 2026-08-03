import type {
  AgentConfig,
  AgentContext,
  AgentLogger,
  Clock,
  ExecutionRecorder,
  PinnedVersion,
  ToolRegistry,
} from './contracts.js';
import { idempotency } from './idempotency.js';

/**
 * Builds the context handed to `run()`. Everything time-related arrives through `clock`, which is
 * `workflow.now()` inside the sandbox, so the same context construction works identically in a
 * workflow, in an activity, and in the eval harness.
 */
export function createAgentContext(input: {
  executionId: string;
  pinned: PinnedVersion;
  businessKey: string | null;
  capabilities: readonly string[];
  clock: Clock;
  logger: AgentLogger;
  toolRegistry: ToolRegistry;
  recorder: ExecutionRecorder;
  config: AgentConfig;
}): AgentContext {
  return {
    executionId: input.executionId,
    agentId: input.pinned.agentId,
    agentVersionId: input.pinned.agentVersionId,
    deploymentKey: input.pinned.deploymentKey,
    versionNo: input.pinned.versionNo,
    specHash: input.pinned.specHash,
    gitCommitSha: input.pinned.gitCommitSha,
    businessKey: input.businessKey,
    capabilities: [...input.capabilities],
    clock: input.clock,
    logger: input.logger,
    toolRegistry: input.toolRegistry,
    recorder: input.recorder,
    idempotency,
    config: input.config,
  };
}

/** A logger that discards everything, for unit tests that do not assert on log output. */
export const silentLogger: AgentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A fixed clock, so eval runs are reproducible without touching the wall clock. */
export function fixedClock(epochMillis: number): Clock {
  return { now: () => epochMillis };
}
