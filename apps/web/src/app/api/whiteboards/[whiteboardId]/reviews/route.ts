import { StartReviewRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { listReviewSessions } from '@/server/repositories/reviews';
import { runReview } from '@/server/services/run-review';

export const dynamic = 'force-dynamic';
// A review is one bounded model call; the handler awaits it end to end (A20).
export const maxDuration = 300;

type Params = { params: Promise<{ whiteboardId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    return json({ sessions: await listReviewSessions(client, whiteboardId) });
  });
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client, userId } = await requireUser();
    const body = await parseBody(request, StartReviewRequestSchema);
    const result = await runReview(client, userId, whiteboardId, body.expectedRevisionNo);
    return json(result);
  });
}
