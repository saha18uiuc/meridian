import { StartEvalRunRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { startEvalRun } from '@/server/services/eval-runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentVersionId: string }> };

/**
 * Enqueue an eval run and return immediately.
 *
 * The 202 is the honest status code: the rows exist, the suite has not run, and the caller polls
 * the sibling GET. Running fifteen cases inside this handler would make the response time depend on
 * a document-extraction pipeline, and a client timeout would leave the run with no owner.
 */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentVersionId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, StartEvalRunRequestSchema);
    const result = await startEvalRun(client, agentVersionId, body);
    return json(result, 202);
  });
}
