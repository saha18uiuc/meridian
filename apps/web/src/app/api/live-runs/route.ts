import { StartLiveRunRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { startLiveRun } from '@/server/services/intake';

export const dynamic = 'force-dynamic';

/**
 * Start (or join) a live receiving run for one inbound message.
 *
 * The response distinguishes `started`, `signalled`, `manual_review`, and `already_processed`
 * because those are four genuinely different outcomes for the operator: a new workflow, a message
 * routed into a running one, a message that could not be correlated at all, and a redelivery of a
 * message whose run has already finished.
 *
 * Only the first two accepted work, so only those answer 202. The other two answer 200: nothing is
 * pending, and the body already names the execution the operator should look at.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    const body = await parseBody(request, StartLiveRunRequestSchema);
    const result = await startLiveRun(client, body.agentId, body.messageRef, body.content);
    const accepted = result.action === 'started' || result.action === 'signalled';
    return json(result, accepted ? 202 : 200);
  });
}
