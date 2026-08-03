import { canonicalJson } from '@meridian/core';
import { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { getSpec } from '@/server/repositories/specs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ specId: string }> };

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { specId } = await params;
    const { client } = await requireUser();
    const spec = await getSpec(client, specId);

    if (new URL(request.url).searchParams.get('download') === '1') {
      // Re-canonicalize rather than echoing whatever `jsonb` hands back, which does not preserve
      // key order: two downloads of one spec must be byte-identical for a diff to mean anything.
      // The bytes do not hash to `spec_hash` directly — that is taken over the semantic view — so
      // a reader verifying the artifact applies `deriveSpecHash` to the parsed document.
      return new NextResponse(canonicalJson(spec.specJson), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="spec-${spec.specVersion}.json"`,
        },
      });
    }

    return json({
      specId: spec.specId,
      specVersion: spec.specVersion,
      specJson: spec.specJson,
      specHash: spec.specHash,
      sourceCanvasHash: spec.sourceCanvasHash,
      sourceRevisionNo: spec.sourceRevisionNo,
      unresolvedCommentIds: spec.unresolvedCommentIds,
    });
  });
}
