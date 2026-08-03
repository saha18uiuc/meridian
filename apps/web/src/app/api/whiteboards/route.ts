import { CreateBoardRequestSchema, type CreateBoardResponse } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { listBoards } from '@/server/repositories/whiteboards';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    return json({ boards: await listBoards(client) });
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    const body = await parseBody(request, CreateBoardRequestSchema);
    const { data, error } = await client.rpc('create_whiteboard', { p_title: body.title });
    if (error !== null) throw new Error(error.message);
    return json(data as unknown as CreateBoardResponse, 201);
  });
}
