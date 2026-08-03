import { ActivationRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseBody } from '@/server/http/json';
import { activateVersion } from '@/server/services/activation';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentId: string }> };

/** This is also the rollback endpoint: rolling back is activating an earlier approved version. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentId } = await params;
    const { client } = await requireUser();
    const body = await parseBody(request, ActivationRequestSchema);
    return json(await activateVersion(client, agentId, body.agentVersionId));
  });
}
