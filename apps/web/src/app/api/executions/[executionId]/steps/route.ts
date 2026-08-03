import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseQuery } from '@/server/http/json';
import { listSteps } from '@/server/repositories/execution-steps';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ executionId: string }> };

const QuerySchema = z
  .object({ limit: z.coerce.number().int().positive().max(500).default(200) })
  .strict();

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { executionId } = await params;
    const { client } = await requireUser();
    const { limit } = parseQuery(request, QuerySchema);
    const steps = await listSteps(client, executionId, limit);
    return json({ steps, nextCursor: null });
  });
}
