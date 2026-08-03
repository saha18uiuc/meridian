import { SetBoardStatusRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ whiteboardId: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, SetBoardStatusRequestSchema);
    const { data, error } = await client.rpc('set_whiteboard_status', {
      p_whiteboard_id: whiteboardId,
      p_status: body.status,
    });
    if (error !== null) throw new Error(error.message);
    return json(data as unknown as { whiteboardId: string; status: string });
  });
}
