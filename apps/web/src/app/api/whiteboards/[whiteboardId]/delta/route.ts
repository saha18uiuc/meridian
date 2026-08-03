import { WhiteboardDeltaRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { saveWhiteboardDelta } from '@/server/services/save-whiteboard-delta';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ whiteboardId: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, WhiteboardDeltaRequestSchema);
    return json(await saveWhiteboardDelta(client, whiteboardId, body));
  });
}
