import 'server-only';

import type { Database } from '@meridian/core/database';
import type { MessageContent, MessageRef, StartLiveRunResponse } from '@meridian/core/schemas';
import { intakeMessage } from '@meridian/ops/intake';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Client, Connection } from '@temporalio/client';
import { createServiceClient } from '@/server/supabase/service-client';

type UserClient = SupabaseClient<Database>;

/**
 * The HTTP-facing wrapper around correlation intake.
 *
 * The route proves ownership with the caller's own client first; only then does the service client
 * — which bypasses RLS — get involved. That ordering is the rule for every privileged path in this
 * codebase, and intake is no exception just because most of its work happens in Temporal.
 */

let cachedTemporal: Promise<Client> | null = null;

export async function temporalClient(): Promise<Client> {
  cachedTemporal ??= (async () => {
    const connection = await Connection.connect({
      address: process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233',
    });
    return new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' });
  })();
  return cachedTemporal;
}

export interface StartLiveRunOptions {
  /** Injected by tests so intake can be exercised without a Temporal server. */
  temporal?: Client;
  service?: SupabaseClient<Database>;
}

export async function startLiveRun(
  userClient: UserClient,
  agentId: string,
  messageRef: MessageRef,
  body: MessageContent,
  options: StartLiveRunOptions = {},
): Promise<StartLiveRunResponse> {
  const service = options.service ?? createServiceClient();
  const temporal = options.temporal ?? (await temporalClient());

  // The user client is used only to prove visibility; the read result itself is discarded.
  const { error } = await userClient
    .from('agents')
    .select('agent_id')
    .eq('agent_id', agentId)
    .single();
  if (error !== null) throw new Error(error.message);

  const result = await intakeMessage({ supabase: service, temporal }, agentId, {
    messageRef,
    content: {
      subject: body.subject ?? messageRef.subject,
      body: body.bodyText ?? '',
      attachmentFields: body.attachmentFields ?? null,
    },
  });

  if (result.action === 'manual_review') {
    return {
      executionId: result.executionId,
      temporalWorkflowId: null,
      temporalRunId: null,
      wasExisting: result.wasExisting,
      action: 'manual_review',
    };
  }

  return {
    executionId: result.executionId,
    temporalWorkflowId: result.temporalWorkflowId,
    temporalRunId: result.temporalRunId,
    wasExisting: result.wasExisting,
    action: result.action === 'signalled' ? 'signalled' : 'started',
  };
}
