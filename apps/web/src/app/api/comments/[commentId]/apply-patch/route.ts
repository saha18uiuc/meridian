import { ApplyPatchRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { applyCommentPatch } from '@/server/services/comment-actions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ commentId: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { commentId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, ApplyPatchRequestSchema);
    return json(await applyCommentPatch(client, commentId, body.expectedRevisionNo));
  });
}
