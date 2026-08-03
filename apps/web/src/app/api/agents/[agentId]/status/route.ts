import { SetAgentStatusRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { setAgentStatus } from '@/server/services/agents';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentId: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentId } = await params;
    const { client, userId } = await requireUser();
    const body = await parseBody(request, SetAgentStatusRequestSchema);
    return json(await setAgentStatus(client, userId, agentId, body.status));
  });
}
