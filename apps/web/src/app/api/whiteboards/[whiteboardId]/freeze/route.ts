import { FreezeRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { freezePreview, freezeSpec } from '@/server/services/freeze-spec';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ whiteboardId: string }> };

/** What the freeze dialog needs to decide how many acknowledgements to require. */
export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    return json(await freezePreview(client, whiteboardId));
  });
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client, userId } = await requireUser();
    const body = await parseBody(request, FreezeRequestSchema);
    return json(await freezeSpec(client, userId, whiteboardId, body), 201);
  });
}
