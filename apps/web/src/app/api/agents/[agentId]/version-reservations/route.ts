import { ReserveVersionRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { reserveVersion } from '@/server/services/agent-versions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentId: string }> };

/**
 * Reserves a version row and returns the exact `/goal` command. It never invokes a coding agent,
 * never writes files under `generated-agents/`, never runs `git`, and never calls a model.
 */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, ReserveVersionRequestSchema);
    return json(await reserveVersion(client, agentId, body), 201);
  });
}
