import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { getReviewSession } from '@/server/repositories/reviews';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ reviewSessionId: string }> };

/** History and the stuck-session health check. Reviews are synchronous, so nothing polls this. */
export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { reviewSessionId } = await params;
    const { client } = await requireUser();
    const session = await getReviewSession(client, reviewSessionId);
    return json({
      reviewSessionId: session.reviewSessionId,
      status: session.status,
      roundNo: session.roundNo,
      modelName: session.modelName,
      reasoningEffort: session.reasoningEffort,
      summary: session.summary,
      errorJson: session.errorJson,
    });
  });
}
