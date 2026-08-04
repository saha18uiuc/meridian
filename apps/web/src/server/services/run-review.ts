import 'server-only';

import {
  canonicalJson,
  collapseFindings,
  createLogger,
  reanchorToCanvasIfUnknown,
  runDeterministicChecks,
  serverEnv,
  toModelFinding,
} from '@meridian/core';
import type { Database, Json } from '@meridian/core/database';
import {
  ReviewOutputSchema,
  type CanonicalGraph,
  type Finding,
  type ReasoningEffort,
  type ReviewResultResponse,
} from '@meridian/core/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ModelUnavailableError, ReviewModelCallFailedError } from '@/server/http/error-map';
import { createServiceClient } from '@/server/supabase/service-client';
import { assembleSnapshot } from '@/server/services/assemble-snapshot';
import { assertOwner, ownerOfBoard } from '@/server/services/ownership';

type Client = SupabaseClient<Database>;

const log = createLogger('review');

export interface ResolvedModel {
  modelName: string;
  reasoningEffort: ReasoningEffort;
}

/**
 * Settle the concrete model **before** any session row exists. `model_name` and
 * `reasoning_effort` are immutable once a session is inserted, so preflighting afterwards would
 * require mutating a column a trigger refuses to let us mutate.
 */
export async function resolveModel(): Promise<ResolvedModel> {
  const env = serverEnv();
  const requested: ResolvedModel = {
    modelName: env.AI_REVIEW_MODEL,
    reasoningEffort: env.AI_REASONING_EFFORT,
  };
  if (env.AI_MODE === 'mock') return requested;

  const available = await modelIsAvailable(requested.modelName);
  if (available) return requested;

  if (env.AI_ALLOW_LOCAL_FALLBACK && env.AI_REVIEW_MODEL_FALLBACK !== undefined) {
    const fallback = env.AI_REVIEW_MODEL_FALLBACK;
    if (await modelIsAvailable(fallback)) {
      log.warn(
        { requested: requested.modelName, fallback },
        'configured review model unavailable; using the explicitly allowed fallback',
      );
      return { modelName: fallback, reasoningEffort: requested.reasoningEffort };
    }
  }
  throw new ModelUnavailableError(requested.modelName);
}

async function modelIsAvailable(modelName: string): Promise<boolean> {
  const env = serverEnv();
  if (env.OPENAI_API_KEY === undefined) return false;
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    await client.models.retrieve(modelName);
    return true;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = [
  'You are reviewing a business process whiteboard before it is frozen into an executable',
  'specification. Report only issues that would make the process ambiguous, unsafe, or',
  'unrunnable. Anchor every finding to a node id, an edge id, or the canvas. Choose the single',
  'closest normalized issue code. Do not restate the graph.',
].join(' ');

/** Deterministic stand-in for the model, keyed by the snapshot hash so runs are reproducible. */
function mockModelFindings(graph: CanonicalGraph, snapshotHash: string): Finding[] {
  const firstAction = graph.nodes.find((node) => node.primitiveType === 'action');
  const anchorId = firstAction?.nodeId ?? null;
  const seed = Number.parseInt(snapshotHash.slice(0, 4), 16);
  const findings: Finding[] = [
    toModelFinding({
      normalizedIssueCode: 'missing_acceptance_criteria',
      anchorType: 'canvas',
      anchorId: null,
      anchorFieldPath: null,
      severity: 'non_blocking',
      body: 'The board does not state how an operator decides the process ran correctly.',
    }),
  ];
  if (anchorId !== null && seed % 2 === 0) {
    findings.push(
      toModelFinding({
        normalizedIssueCode: 'unspecified_error_handling',
        anchorType: 'node',
        anchorId,
        anchorFieldPath: null,
        severity: 'blocking',
        body: 'This action has no described behaviour when the downstream system rejects it.',
      }),
    );
  }
  return findings;
}

async function callModel(
  graph: CanonicalGraph,
  snapshotHash: string,
  model: ResolvedModel,
): Promise<{ findings: Finding[]; summary: string }> {
  const env = serverEnv();
  if (env.AI_MODE === 'mock') {
    return {
      findings: mockModelFindings(graph, snapshotHash),
      summary: 'Deterministic mock review.',
    };
  }

  const { default: OpenAI } = await import('openai');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY as string });

  let lastError: unknown = null;
  const backoffs = [1000, 4000];
  for (let attempt = 0; attempt <= env.AI_REVIEW_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.AI_REVIEW_TIMEOUT_MS);
    try {
      const response = await client.responses.parse(
        {
          model: model.modelName,
          reasoning: { effort: model.reasoningEffort },
          input: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: canonicalJson(graph) },
          ],
          text: { format: zodTextFormat(ReviewOutputSchema, 'review') },
        },
        { signal: controller.signal },
      );
      const parsed = response.output_parsed;
      if (parsed === null || parsed === undefined) throw new Error('EMPTY_MODEL_OUTPUT');
      return {
        findings: parsed.findings.map(toModelFinding),
        summary: parsed.summary,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === env.AI_REVIEW_MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, backoffs[attempt] ?? 4000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  if (status !== undefined) return false;
  const name = (error as { name?: string }).name;
  // An abort is a timeout, and a timeout is worth one more bounded attempt.
  return name === 'AbortError' || name === 'TypeError' || name === 'FetchError';
}

/**
 * One review round, start to finish, inside one awaited request (A20). No database lock is held
 * across the model call, and the `finally` block guarantees the session cannot be left `running`.
 *
 * Reconciliation against earlier rounds — what recurs, what resolves, what stays live — is decided
 * inside `finalize_review_session` and not here. This service assembles and validates the round's
 * findings, which is the A21 boundary; the classification of *previous* roots is a cross-row
 * invariant over `comments` and belongs with the transaction that writes them.
 */
export async function runReview(
  userClient: Client,
  userId: string,
  whiteboardId: string,
  expectedRevisionNo: number,
): Promise<ReviewResultResponse> {
  assertOwner(await ownerOfBoard(userClient, whiteboardId), userId, 'WHITEBOARD');

  const assembled = await assembleSnapshot(userClient, whiteboardId);
  if (assembled.revisionNo !== expectedRevisionNo) {
    throw new Error(
      `STALE_BOARD_REVISION: expected=${expectedRevisionNo} current=${assembled.revisionNo}`,
    );
  }

  const deterministic = runDeterministicChecks(assembled.snapshot);
  const model = await resolveModel();

  const service = createServiceClient();
  const created = await rpc(service, 'create_review_session', {
    p_actor_user_id: userId,
    p_whiteboard_id: whiteboardId,
    p_expected_revision_no: expectedRevisionNo,
    p_snapshot: assembled.snapshot as unknown as Json,
    p_snapshot_hash: assembled.hash,
    p_model_name: model.modelName,
    p_reasoning_effort: model.reasoningEffort,
  });
  const reviewSessionId = created['reviewSessionId'] as string;
  const roundNo = created['roundNo'] as number;

  try {
    const { findings: modelFindings, summary } = await callModel(
      assembled.snapshot,
      assembled.hash,
      model,
    );
    const collapsed = collapseFindings(
      [...deterministic, ...modelFindings].map((finding) =>
        reanchorToCanvasIfUnknown(assembled.snapshot, finding),
      ),
    );

    const finalized = await rpc(service, 'finalize_review_session', {
      p_actor_user_id: userId,
      p_review_session_id: reviewSessionId,
      p_findings: collapsed,
      p_summary: {
        summary,
        deterministicCount: deterministic.length,
        modelCount: modelFindings.length,
      },
    });

    return {
      reviewSessionId,
      roundNo,
      sourceRevisionNo: assembled.revisionNo,
      sourceCanvasHash: assembled.hash,
      modelName: model.modelName,
      reasoningEffort: model.reasoningEffort,
      status: 'completed',
      counts: {
        inserted: (finalized['inserted'] as number | undefined) ?? 0,
        recurred: (finalized['recurred'] as number | undefined) ?? 0,
        resolved: (finalized['resolved'] as number | undefined) ?? 0,
        recurredRejected: (finalized['recurredRejected'] as string[] | undefined) ?? [],
      },
      findings: collapsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rpc(service, 'fail_review_session', {
      p_actor_user_id: userId,
      p_review_session_id: reviewSessionId,
      p_error: { code: 'REVIEW_MODEL_CALL_FAILED', message },
    }).catch((failError: unknown) => {
      log.error({ reviewSessionId, err: String(failError) }, 'fail_review_session also failed');
    });
    throw new ReviewModelCallFailedError(reviewSessionId, message);
  }
}

async function rpc<Name extends keyof Database['public']['Functions']>(
  client: Client,
  name: Name,
  args: Database['public']['Functions'][Name]['Args'],
): Promise<Record<string, unknown>> {
  const { data, error } = (await client.rpc(name, args)) as unknown as {
    data: unknown;
    error: { message: string } | null;
  };
  if (error !== null) throw new Error(error.message);
  return (data ?? {}) as Record<string, unknown>;
}
