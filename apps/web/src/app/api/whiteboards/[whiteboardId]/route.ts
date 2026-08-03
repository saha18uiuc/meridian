import { RenameBoardRequestSchema, type RenameBoardResponse } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { listEdges } from '@/server/repositories/edges';
import { listNodes } from '@/server/repositories/nodes';
import { getBoardMetadata } from '@/server/repositories/whiteboards';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ whiteboardId: string }> };

/** Three row-based reads, deliberately: the editor reconstructs the board, it never loads a blob. */
export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    const [metadata, nodes, edges] = await Promise.all([
      getBoardMetadata(client, whiteboardId),
      listNodes(client, whiteboardId),
      listEdges(client, whiteboardId),
    ]);
    return json({ metadata, nodes, edges });
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, RenameBoardRequestSchema);
    const { data, error } = await client.rpc('rename_whiteboard', {
      p_whiteboard_id: whiteboardId,
      p_expected_revision_no: body.expectedRevisionNo,
      p_title: body.title,
    });
    if (error !== null) throw new Error(error.message);
    return json(data as unknown as RenameBoardResponse);
  });
}
