import { HumanDecisionRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { submitHumanDecision } from '@/server/services/executions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ executionId: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { executionId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, HumanDecisionRequestSchema);
    return json(await submitHumanDecision(client, executionId, body));
  });
}
