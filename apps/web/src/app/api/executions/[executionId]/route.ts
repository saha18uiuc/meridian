import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { getExecutionDetail } from '@/server/services/executions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ executionId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { executionId } = await params;
    const { client } = await requireUser();
    return json(await getExecutionDetail(client, executionId));
  });
}
