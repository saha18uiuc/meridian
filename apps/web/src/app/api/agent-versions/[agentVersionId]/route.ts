import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { getAgentVersion } from '@/server/repositories/agent-versions';
import { getSpec } from '@/server/repositories/specs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ agentVersionId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { agentVersionId } = await params;
    const { client } = await requireUser();
    const version = await getAgentVersion(client, agentVersionId);
    const spec = await getSpec(client, version.specId);
    return json({
      version,
      spec: { specHash: spec.specHash, specVersion: spec.specVersion },
      manifest: version.buildManifestJson,
      gitCommitSha: version.gitCommitSha,
    });
  });
}
