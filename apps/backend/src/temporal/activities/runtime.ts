import {
  createExecutionRecorder,
  createTools,
  type ExecutionRecorder,
  type ToolRegistry,
} from '@meridian/agent-kit';
import { type WorkerEnv, workerEnv } from '@meridian/core';
import type { Database } from '@meridian/core/database';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { modelExtractStructured } from './model.js';

/**
 * Everything with I/O lives behind this module.
 *
 * Activities are the only place a Supabase client, a provider SDK, or the filesystem may be
 * touched. Building those resources here — rather than inside each activity — keeps one client per
 * process and makes it obvious, from the import graph alone, that the workflow bundle contains
 * none of them.
 */

export interface ActivityEnvelope {
  executionId: string;
  capabilities: string[];
  /**
   * The messages the workflow has accepted so far, sent with every mailbox read.
   *
   * Absent on the other activities, which have no inbox to scope, and absent on a send: what a
   * reply may say is not limited by what has arrived.
   */
  deliveredMessageIds?: string[];
}

let cachedClient: SupabaseClient<Database> | null = null;

export function serviceClient(env: WorkerEnv = workerEnv()): SupabaseClient<Database> {
  cachedClient ??= createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return cachedClient;
}

const recorders = new Map<string, ExecutionRecorder>();
const toolRegistries = new Map<string, ToolRegistry>();

/**
 * The delivered set per execution, kept outside the registry so a growing one does not have to
 * rebuild it. The registry is cached for the life of the execution and reads this through a
 * closure, so a mailbox built before a follow-up message arrived still sees that message after.
 */
const delivered = new Map<string, string[]>();

export function recorderFor(executionId: string): ExecutionRecorder {
  let recorder = recorders.get(executionId);
  if (recorder === undefined) {
    recorder = createExecutionRecorder(serviceClient(), { executionId });
    recorders.set(executionId, recorder);
  }
  return recorder;
}

export function toolsFor(envelope: ActivityEnvelope): ToolRegistry {
  const executionId = envelope.executionId;
  if (envelope.deliveredMessageIds !== undefined) {
    delivered.set(executionId, envelope.deliveredMessageIds);
  }

  let tools = toolRegistries.get(executionId);
  if (tools === undefined) {
    const env = workerEnv();
    tools = createTools({
      env,
      executionId,
      capabilities: envelope.capabilities,
      supabase: serviceClient(env),
      extractStructured: modelExtractStructured,
      visibleMessageIds: () => delivered.get(executionId) ?? null,
    });
    toolRegistries.set(executionId, tools);
  }
  return tools;
}

/** Called when an execution reaches a terminal state so a long-lived worker does not leak. */
export function releaseExecution(executionId: string): void {
  recorders.delete(executionId);
  toolRegistries.delete(executionId);
  delivered.delete(executionId);
}

/** Test-only: drop every cached resource. */
export function resetRuntimeForTests(): void {
  cachedClient = null;
  recorders.clear();
  toolRegistries.clear();
  delivered.clear();
}
