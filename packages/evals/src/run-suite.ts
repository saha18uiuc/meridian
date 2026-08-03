import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentContext,
  createExecutionRecorder,
  createMockBrowser,
  createMockDocumentTool,
  fixedClock,
  runAgent,
  silentLogger,
  type AgentDefinition,
  type ExecutionAction,
  type ExecutionStep,
  type HumanHandoffTool,
  type ToolRegistry,
} from '@meridian/agent-kit';
import { sha256Hex } from '@meridian/core/hashing';
import type { Database, Json } from '@meridian/core/database';
import type { AgentDecision, EvalCase } from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAssertions, type AssertionFailure, type RunObservation } from './assertions.js';
import { loadEvalCases } from './case-schema.js';
import { classify } from './classify-failure.js';
import { createCaseMailbox } from './fixture-mailbox.js';
import type { CaseResult, EvalReport } from './report.js';

/**
 * The eval runner.
 *
 * It runs the identical generated agent the worker runs, against the identical recorder, writing to
 * the real database. What it does not do is go through Temporal: a durable-execution round trip per
 * case would make the suite slow and would test Temporal rather than the agent. The properties that
 * do depend on Temporal — replay determinism, signal handling, action reservation across a crash —
 * are covered by `pnpm test:temporal`, which is the right place for them.
 *
 * Everything the harness supplies is deterministic: a fixed clock, a fixture mailbox restricted to
 * the case's own messages, and a fixture-driven document tool. Two runs of a green suite produce
 * identical rows apart from identifiers.
 */

export const EVAL_CLOCK_EPOCH_MS = Date.parse('2026-02-11T00:00:00.000Z');

export interface AgentVersionRef {
  agentId: string;
  agentVersionId: string;
  deploymentKey: string;
  versionNo: number;
  specHash: string;
  gitCommitSha: string | null;
  buildManifest: unknown;
}

export interface RunSuiteOptions {
  supabase: SupabaseClient<Database>;
  repoRoot: string;
  version: AgentVersionRef;
  definition: AgentDefinition;
  capabilities: readonly string[];
  toolkitVersion: string;
  operatorEmail: string;
  maxConcurrency: number;
  caseDir?: string;
  /** Restrict the run to these case keys. Used by the generation skill's smoke check. */
  only?: readonly string[];
  /**
   * Business-key extraction, injected rather than imported: it lives in `@meridian/ops`, which
   * depends on this package, and a cycle would be a worse price than one parameter.
   */
  extractBusinessKey: (source: {
    subject?: string | null;
    body?: string | null;
  }) => { kind: 'ok'; businessKey: string } | { kind: 'none' | 'conflict' };
  /** Per-case fault injection, used by the retry and crash cases. */
  faults?: Record<string, CaseFaults>;
  evalRunId: string;
}

export interface CaseFaults {
  /** Fail `documents.extractText` this many times before succeeding. */
  transientExtractionFailures?: number;
  /** Abort after the action is dispatched but before it is completed, simulating a crash. */
  crashAfterDispatch?: boolean;
}

class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash between dispatch and completion');
    this.name = 'SimulatedCrash';
  }
}

class TransientExtractionFailure extends Error {
  constructor(filename: string) {
    super(`transient extraction failure reading ${filename}`);
    this.name = 'RetryableToolError';
  }
}

function expectedDecision(repoRoot: string, evalCase: EvalCase): AgentDecision | null {
  const raw = JSON.parse(readFileSync(join(repoRoot, evalCase.inputRefs.expectedPath), 'utf8')) as {
    decision: AgentDecision | null;
  };
  return raw.decision;
}

function stubHandoff(state: { requested: boolean }): HumanHandoffTool {
  return {
    async requestDecision() {
      state.requested = true;
      return 'eval-handoff-request';
    },
    async waitForDecision() {
      // A specialist who always answers the same way. The point of the case is that the agent asks
      // and waits, not that a human is simulated convincingly.
      return {
        decision: 'escalated',
        notes: 'resolved by the receiving specialist during evaluation',
      };
    },
  };
}

function withFaults(
  registry: ToolRegistry,
  faults: CaseFaults | undefined,
  counters: { extractionFailures: number },
): ToolRegistry {
  if (faults?.transientExtractionFailures === undefined) return registry;
  const budget = faults.transientExtractionFailures;
  const documents = registry.documents;
  return {
    ...registry,
    documents: {
      ...documents,
      async extractText(fileRef) {
        if (counters.extractionFailures < budget) {
          counters.extractionFailures += 1;
          throw new TransientExtractionFailure(fileRef.filename);
        }
        return documents.extractText(fileRef);
      },
    },
  };
}

async function readObservation(
  supabase: SupabaseClient<Database>,
  executionId: string,
  version: AgentVersionRef,
  decision: AgentDecision | null,
  humanDecisionRequested: boolean,
): Promise<RunObservation> {
  const [steps, actions, events] = await Promise.all([
    supabase.from('execution_steps').select('*').eq('execution_id', executionId),
    supabase.from('execution_actions').select('*').eq('execution_id', executionId),
    supabase
      .from('execution_events')
      .select('event_key, storage_path')
      .eq('execution_id', executionId),
  ]);

  if (steps.error !== null) throw new Error(steps.error.message);
  if (actions.error !== null) throw new Error(actions.error.message);
  if (events.error !== null) throw new Error(events.error.message);

  const manifest = version.buildManifest as { specHash?: string } | null;

  return {
    decision,
    steps: steps.data.map((row): ExecutionStep => ({
      stepExecutionId: row.step_execution_id,
      executionId: row.execution_id,
      nodeId: row.node_id,
      stepKey: row.step_key,
      stepInstanceKey: row.step_instance_key,
      sequenceNo: row.sequence_no,
      attemptNo: row.attempt_no,
      status: row.status as ExecutionStep['status'],
      inputSummaryJson: (row.input_summary_json ?? {}) as Record<string, unknown>,
      outputSummaryJson: (row.output_summary_json ?? {}) as Record<string, unknown>,
      errorJson: (row.error_json ?? null) as Record<string, unknown> | null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
    actions: actions.data.map((row): ExecutionAction => ({
      executionActionId: row.execution_action_id,
      executionId: row.execution_id,
      stepExecutionId: row.step_execution_id,
      actionType: row.action_type as ExecutionAction['actionType'],
      status: row.status as ExecutionAction['status'],
      idempotencyKey: row.idempotency_key,
      markerToken: row.marker_token,
      providerActionId: row.provider_action_id,
      requestPayloadJson: (row.request_payload_json ?? {}) as Record<string, unknown>,
      providerResponseJson: (row.provider_response_json ?? null) as Record<string, unknown> | null,
      reconciliationJson: (row.reconciliation_json ?? null) as Record<string, unknown> | null,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      dispatchedAt: row.dispatched_at,
      completedAt: row.completed_at,
    })),
    evidenceKeys: events.data
      .map((row) => row.event_key)
      .filter((key): key is string => key !== null)
      .sort(),
    storagePaths: events.data
      .map((row) => row.storage_path)
      .filter((path): path is string => path !== null)
      .sort(),
    gitCommitSha: version.gitCommitSha,
    manifestSpecHash: manifest?.specHash ?? null,
    executionSpecHash: version.specHash,
    humanDecisionRequested,
  };
}

/** Compare the recorded decision to the checked-in expected document, field by field. */
function assertExpectedDocument(
  expected: AgentDecision | null,
  actual: AgentDecision | null,
): AssertionFailure[] {
  if (expected === null) {
    return actual === null
      ? []
      : [
          {
            assertion: 'expectedDocument',
            expected: null,
            actual: actual.outcome,
            message: 'the case expects no agent decision, because it is decided at intake',
          },
        ];
  }
  if (actual === null) {
    return [
      {
        assertion: 'expectedDocument',
        expected: expected.outcome,
        actual: null,
        message: 'the run produced no decision',
      },
    ];
  }

  const failures: AssertionFailure[] = [];
  const compare = (field: keyof AgentDecision): void => {
    const left = JSON.stringify(expected[field]);
    const right = JSON.stringify(actual[field]);
    if (left !== right) {
      failures.push({
        assertion: `expectedDocument.${field}`,
        expected: expected[field],
        actual: actual[field],
        message: `${field} differs from the expected document`,
      });
    }
  };

  // `reason` is prose and deliberately not compared: asserting on wording would turn every message
  // improvement into a failing suite without telling anyone anything about behaviour.
  compare('outcome');
  compare('businessKey');
  compare('shipmentSummary');
  compare('missingInformation');
  compare('validationFailures');
  return failures;
}

export async function runCase(options: RunSuiteOptions, evalCase: EvalCase): Promise<CaseResult> {
  const startedAt = Date.now();
  const faults = options.faults?.[evalCase.caseKey];
  const handoffState = { requested: false };
  const counters = { extractionFailures: 0 };

  const base: CaseResult = {
    caseKey: evalCase.caseKey,
    description: evalCase.description,
    status: 'failed',
    executionId: null,
    durationMs: 0,
    failures: [],
    failureClass: null,
    error: null,
  };

  try {
    const { mailbox, messages, messageRefs } = createCaseMailbox(
      options.repoRoot,
      evalCase.inputRefs.emailPaths,
    );

    // Correlation happens before any execution exists, exactly as it does in production.
    const first = messages[0];
    const extraction = options.extractBusinessKey({
      subject: first?.subject ?? '',
      body: first?.bodyText ?? '',
    });

    const { data: created, error: createError } = await options.supabase.rpc('create_execution', {
      p_agent_id: options.version.agentId,
      p_agent_version_id: options.version.agentVersionId,
      p_run_type: 'eval',
      p_case_key: evalCase.caseKey,
      p_business_key: extraction.kind === 'ok' ? extraction.businessKey : (null as never),
      // An eval run is not a Temporal workflow, so it has no workflow ID. Inventing one would also
      // collide with `ck_executions_manual_review_has_no_workflow` on the intake-decided cases.
      p_temporal_workflow_id: null as never,
      p_idempotency_key: sha256Hex(['eval', options.evalRunId, evalCase.caseKey].join('|')),
      p_input_ref: {
        evalRunId: options.evalRunId,
        caseKey: evalCase.caseKey,
        specHash: options.version.specHash,
        gitCommitSha: options.version.gitCommitSha,
        messageRefs,
      } as unknown as Json,
    });
    if (createError !== null) throw new Error(`create_execution failed: ${createError.message}`);

    const executionId = (created as unknown as { executionId: string }).executionId;
    base.executionId = executionId;

    const { error: startError } = await options.supabase.rpc('start_execution', {
      p_execution_id: executionId,
      p_temporal_workflow_id: null as never,
      p_temporal_run_id: null as never,
    });
    if (startError !== null) throw new Error(`start_execution failed: ${startError.message}`);

    let decision: AgentDecision | null = null;
    let runError: Error | null = null;

    if (extraction.kind === 'ok') {
      const attachmentDir = join(
        options.repoRoot,
        'examples/inbound-import-receiving/fixtures/attachments',
      );
      const registry: ToolRegistry = withFaults(
        {
          mailbox,
          documents: createMockDocumentTool({ attachmentDir }),
          browser: createMockBrowser({ allowList: [] }),
          humanHandoff: stubHandoff(handoffState),
        },
        faults,
        counters,
      );

      const recorder = createExecutionRecorder(options.supabase, { executionId });
      const context = createAgentContext({
        executionId,
        pinned: {
          agentId: options.version.agentId,
          agentVersionId: options.version.agentVersionId,
          deploymentKey: options.version.deploymentKey,
          versionNo: options.version.versionNo,
          specHash: options.version.specHash,
          gitCommitSha: options.version.gitCommitSha,
        },
        businessKey: extraction.businessKey,
        capabilities: options.capabilities,
        clock: fixedClock(EVAL_CLOCK_EPOCH_MS),
        logger: silentLogger,
        toolRegistry: registry,
        recorder,
        config: {
          toolkitVersions: { composioGmailToolkit: options.toolkitVersion },
          operatorEmail: options.operatorEmail,
          maxConcurrency: options.maxConcurrency,
        },
      });

      // The retry budget mirrors the frozen spec's retry Rule: three attempts, then escalate.
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          decision = await runAgent(
            options.definition,
            {
              businessKey: extraction.businessKey,
              messages: messageRefs,
              capabilities: options.capabilities,
            },
            context,
          );
          runError = null;
          break;
        } catch (error) {
          runError = error as Error;
          if ((error as Error).name !== 'RetryableToolError') break;
        }
      }

      if (faults?.crashAfterDispatch === true && decision !== null) {
        // The action is already reserved, dispatched, and completed by the first pass. Replaying
        // the agent is what a post-crash Temporal replay does, and the assertion that matters is
        // that the second pass finds the existing reservation instead of sending again.
        decision = await runAgent(
          options.definition,
          {
            businessKey: extraction.businessKey,
            messages: messageRefs,
            capabilities: options.capabilities,
          },
          context,
        );
      }
    } else {
      // No usable key: production records a terminal manual-review execution at intake and never
      // starts an agent. The harness asserts that same shape rather than inventing a run.
      decision = {
        outcome: 'manual_review',
        businessKey: null,
        reason:
          extraction.kind === 'conflict'
            ? 'two different valid business keys appear in one message'
            : 'no valid business key was found',
        shipmentSummary: {
          containerNumber: null,
          mawb: null,
          invoiceNumbers: [],
          batchNumbers: [],
          goodsCount: 0,
          validGoodsCount: 0,
        },
        missingInformation: [],
        validationFailures: [],
        emailResponse: null,
      };
    }

    if (runError !== null) throw runError;

    const observation = await readObservation(
      options.supabase,
      executionId,
      options.version,
      decision,
      handoffState.requested,
    );

    const expected = expectedDecision(options.repoRoot, evalCase);
    const failures = [
      ...runAssertions(evalCase, observation),
      ...assertExpectedDocument(expected, decision),
    ];

    // The eval execution's own status is the case verdict, which is what `run_type='eval'` rows
    // exist to record. The agent decision goes under `resultKind`, never under a top-level
    // `outcome`: that key is reserved by `ck_executions_manual_review_has_no_workflow` for the
    // intake manual-review path, and reusing it here would make an escalating agent unrecordable.
    const { error: completeError } = await options.supabase.rpc('complete_execution', {
      p_execution_id: executionId,
      p_status: failures.length === 0 ? 'passed' : 'failed',
      p_output_summary: {
        resultKind: decision?.outcome ?? null,
        decision,
        counts: {
          steps: observation.steps.length,
          actions: observation.actions.length,
          evidence: observation.evidenceKeys.length,
        },
      } as unknown as Json,
      p_diff_summary: {
        expectedResultKind: expected?.outcome ?? null,
        actualResultKind: decision?.outcome ?? null,
        failures,
      } as unknown as Json,
    });
    if (completeError !== null) {
      throw new Error(`complete_execution failed: ${completeError.message}`);
    }

    return {
      ...base,
      status: failures.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      failures,
      failureClass:
        failures.length === 0
          ? null
          : classify({
              failures,
              ...(evalCase.expected.knownGap === true ? { specTraceKnownGap: true } : {}),
            }),
    };
  } catch (error) {
    const thrown = error as Error;
    return {
      ...base,
      status: thrown instanceof SimulatedCrash ? 'failed' : 'error',
      durationMs: Date.now() - startedAt,
      error: `${thrown.name}: ${thrown.message}`,
      failureClass: classify({ failures: [], errorName: thrown.name }),
    };
  }
}

export async function runSuite(options: RunSuiteOptions): Promise<EvalReport> {
  const startedAt = new Date(EVAL_CLOCK_EPOCH_MS).toISOString();
  const all = loadEvalCases(
    join(options.repoRoot, options.caseDir ?? 'examples/inbound-import-receiving/evals'),
  );
  const only = options.only === undefined ? null : new Set(options.only);
  const cases = only === null ? all : all.filter((entry) => only.has(entry.caseKey));
  if (only !== null && cases.length !== only.size) {
    const found = new Set(cases.map((entry) => entry.caseKey));
    const missing = [...only].filter((key) => !found.has(key));
    throw new Error(`no such eval case: ${missing.join(', ')}`);
  }

  const results: CaseResult[] = [];
  // Sequential: the cases share one database and one agent version, and running them concurrently
  // would trade a few seconds for failures nobody can reproduce.
  for (const evalCase of cases) {
    results.push(await runCase(options, evalCase));
  }

  return {
    evalRunId: options.evalRunId,
    agentVersionId: options.version.agentVersionId,
    deploymentKey: options.version.deploymentKey,
    versionNo: options.version.versionNo,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status !== 'passed').length,
    cases: results,
  };
}
