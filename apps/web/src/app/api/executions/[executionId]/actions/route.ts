import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { listActions } from '@/server/repositories/execution-actions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ executionId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { executionId } = await params;
    const { client } = await requireUser();
    const actions = await listActions(client, executionId);
    return json({
      actions: actions.map((action) => ({
        executionActionId: action.executionActionId,
        actionType: action.actionType,
        status: action.status,
        markerToken: action.markerToken,
        providerActionId: action.providerActionId,
        attemptCount: action.attemptCount,
        reconciliationJson: action.reconciliationJson,
        timings: {
          reservedAt: action.createdAt,
          dispatchedAt: action.dispatchedAt,
          completedAt: action.completedAt,
        },
      })),
    });
  });
}
