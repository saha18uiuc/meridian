import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { getAgent } from '@/server/repositories/agents';
import { listAgentVersions } from '@/server/repositories/agent-versions';
import { listBoardSpecs } from '@/server/repositories/specs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentId } = await params;
    const { client } = await requireUser();
    const agent = await getAgent(client, agentId);
    const [versions, specs] = await Promise.all([
      listAgentVersions(client, agentId),
      listBoardSpecs(client, agent.whiteboardId),
    ]);
    // The reservation panel needs the board's frozen specs, and a version can only ever be
    // generated from a spec on the agent's own board, so they travel together.
    return json({
      agent,
      versions,
      specs: specs.map((spec) => ({
        specId: spec.specId,
        specVersion: spec.specVersion,
        specHash: spec.specHash,
      })),
    });
  });
}
