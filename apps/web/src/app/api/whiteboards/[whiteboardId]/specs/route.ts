import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { listBoardSpecs } from '@/server/repositories/specs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ whiteboardId: string }> };

/**
 * The specifications frozen from one board, newest first.
 *
 * `spec_json` is deliberately not returned: a board can hold many versions, each carrying a full
 * compiled process, and the caller is a list. `GET /api/specs/[specId]` serves the document itself.
 */
export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { whiteboardId } = await params;
    const { client } = await requireUser();
    const specs = await listBoardSpecs(client, whiteboardId);
    return json({
      specs: specs.map((spec) => ({
        specId: spec.specId,
        specVersion: spec.specVersion,
        specHash: spec.specHash,
        sourceRevisionNo: spec.sourceRevisionNo,
        unresolvedCommentCount: spec.unresolvedCommentIds.length,
        frozenAt: spec.frozenAt,
      })),
    });
  });
}
