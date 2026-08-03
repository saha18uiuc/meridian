import { createTools } from '@meridian/agent-kit';
import { createLogger, workerEnv } from '@meridian/core';
import { intakeMessage, type IntakeResult } from './intake/index.js';
import { reconcileQueuedExecutions } from './intake/reconcile-queued-executions.js';
import { optionalArg, parseArgs, positional } from './lib/args.js';
import { opsClient } from './lib/supabase.js';
import { closeOpsTemporalClient, opsTemporalClient } from './lib/temporal.js';

/**
 * One inbox pass: reconcile, fetch, correlate.
 *
 * The reconciliation sweep runs first, before any new message is considered, so a batch that
 * crashed halfway through the previous run is repaired before it can be confused with fresh work.
 *
 * The same code path serves the mock and the live inbox. `GMAIL_LIVE_MODE` decides which mailbox
 * adapter the tool factory hands back, and nothing downstream of that decision can tell.
 */

const logger = createLogger('process-inbox');

export interface ProcessInboxOptions {
  /** The logical agent whose active version handles these messages. */
  deploymentKey: string;
  query?: string;
  maxResults?: number;
  fixtureRoot?: string;
}

export interface ProcessInboxReport {
  reconciled: number;
  considered: number;
  results: (IntakeResult & { providerMessageId: string })[];
}

export async function processInbox(options: ProcessInboxOptions): Promise<ProcessInboxReport> {
  const env = workerEnv();
  const supabase = opsClient();
  const temporal = await opsTemporalClient();

  const reconciled = await reconcileQueuedExecutions({ supabase, temporal, logger });

  const { data: agent, error } = await supabase
    .from('agents')
    .select('agent_id')
    .eq('deployment_key', options.deploymentKey)
    .single();
  if (error !== null) throw new Error(`Unknown deployment key ${options.deploymentKey}`);

  const tools = createTools({
    env,
    // Intake happens before any execution exists, so there is no execution to attribute these
    // reads to. The literal makes that explicit rather than inventing a UUID that means nothing.
    executionId: 'intake',
    capabilities: ['mail.read'],
    supabase,
    ...(options.fixtureRoot === undefined ? {} : { fixtureRoot: options.fixtureRoot }),
  });

  const messages = await tools.mailbox.searchMessages(
    options.query ?? env.GMAIL_SEARCH_QUERY,
    options.maxResults ?? env.GMAIL_MAX_RESULTS,
  );

  const results: (IntakeResult & { providerMessageId: string })[] = [];
  // Sequential on purpose: two messages carrying the same business key must be allowed to
  // converge through Temporal, and processing them concurrently only adds contention to prove a
  // property the database already guarantees.
  for (const message of messages) {
    const result = await intakeMessage({ supabase, temporal, logger }, agent.agent_id, {
      messageRef: {
        provider: env.GMAIL_LIVE_MODE ? 'gmail' : 'mock',
        providerMessageId: message.messageId,
        threadId: message.threadId,
        subject: message.subject,
        receivedAt: message.receivedAt,
        storagePath: null,
      },
      content: {
        subject: message.subject,
        body: message.bodyText,
        attachmentFields: {
          filenames: message.attachments.map((attachment) => attachment.filename).join(' '),
        },
      },
    });
    results.push({ ...result, providerMessageId: message.messageId });
    logger.info(
      { providerMessageId: message.messageId, action: result.action },
      'message correlated',
    );
  }

  return { reconciled: reconciled.length, considered: messages.length, results };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    const report = await processInbox({
      // The positional form is `process-inbox <deployment-key>`. A leading `--once` — which the
      // live-gate command in the README passes and this script satisfies by never looping — is a
      // flag, not a deployment key, and taking it as one looks up an agent that cannot exist.
      deploymentKey: optionalArg(args, 'agent') ?? positional(argv) ?? 'inbound-import-receiving',
      ...(optionalArg(args, 'query') === undefined ? {} : { query: optionalArg(args, 'query')! }),
      ...(optionalArg(args, 'fixtures') === undefined
        ? {}
        : { fixtureRoot: optionalArg(args, 'fixtures')! }),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closeOpsTemporalClient();
  }
}
