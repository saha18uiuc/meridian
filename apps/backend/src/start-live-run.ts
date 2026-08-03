import { createLogger } from '@meridian/core';
import type { MessageRef } from '@meridian/core/schemas';
import { closeOpsTemporalClient, intakeMessage, opsClient, opsTemporalClient } from '@meridian/ops';

/**
 * Start one live receiving run from the command line.
 *
 * This exists so the correlation path can be exercised without the web app — during the demo, and
 * when reproducing a specific message during debugging. It calls exactly the same `intakeMessage`
 * the HTTP route does, so a bug found here is a bug in the real path.
 */

const logger = createLogger('start-live-run');

export interface StartLiveRunArgs {
  agentId: string;
  messageRef: MessageRef;
  subject?: string;
  bodyText?: string;
}

export async function startLiveRunFromCli(args: StartLiveRunArgs): Promise<void> {
  const supabase = opsClient();
  const temporal = await opsTemporalClient();
  const result = await intakeMessage({ supabase, temporal, logger }, args.agentId, {
    messageRef: args.messageRef,
    content: {
      subject: args.subject ?? args.messageRef.subject,
      body: args.bodyText ?? '',
    },
  });
  logger.info({ result }, 'intake finished');
  console.log(JSON.stringify(result, null, 2));
  await closeOpsTemporalClient();
}
