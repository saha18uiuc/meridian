import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { getEvalRun } from '@/server/services/eval-runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentVersionId: string; evalRunId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentVersionId, evalRunId } = await params;
    const { client } = await requireUser();
    return json(await getEvalRun(client, agentVersionId, evalRunId));
  });
}
