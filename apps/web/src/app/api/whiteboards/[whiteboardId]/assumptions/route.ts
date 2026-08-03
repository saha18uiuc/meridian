import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { listLiveAssumptions } from '@/server/repositories/comments';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ whiteboardId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    return json({ assumptions: await listLiveAssumptions(client, whiteboardId) });
  });
}
