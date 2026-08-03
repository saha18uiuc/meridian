import { TransitionRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { transitionVersion } from '@/server/services/agent-versions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentVersionId: string }> };

/** Approval records a judgement. It deliberately does not activate anything. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentVersionId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, TransitionRequestSchema);
    return json(await transitionVersion(client, agentVersionId, body.status));
  });
}
