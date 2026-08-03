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
 * The response distinguishes `started`, `signalled`, and `manual_review` because those are three
 * genuinely different outcomes for the operator: a new workflow, a message routed into a running
 * one, and a message that could not be correlated at all.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    const body = await parseBody(request, StartLiveRunRequestSchema);
    const result = await startLiveRun(client, body.agentId, body.messageRef, body.content);
    return json(result, result.action === 'manual_review' ? 200 : 202);
  });
}
