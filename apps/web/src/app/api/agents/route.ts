import { CreateAgentRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { createAgent, listAgentsForUser } from '@/server/services/agents';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    const whiteboardId = new URL(request.url).searchParams.get('whiteboardId');
    return json({ agents: await listAgentsForUser(client, whiteboardId ?? undefined) });
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    const body = await parseBody(request, CreateAgentRequestSchema);
    return json(await createAgent(client, body), 201);
  });
}
