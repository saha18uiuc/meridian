import { RunTypeSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseQuery } from '@/server/http/json';
import { listExecutions } from '@/server/repositories/executions';

export const dynamic = 'force-dynamic';

const QuerySchema = z
  .object({
    agentId: z.uuid().optional(),
    agentVersionId: z.uuid().optional(),
    runType: RunTypeSchema.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    const query = parseQuery(request, QuerySchema);
    // RLS scopes this to boards the caller owns, so no extra ownership filter is needed here.
    return json(await listExecutions(client, query));
  });
}
