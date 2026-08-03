import { EventPageRequestSchema } from '@meridian/core/schemas';
import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json, parseQuery } from '@/server/http/json';
import { listEvents, signEventArtifacts } from '@/server/repositories/execution-events';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ executionId: string }> };

/** Cursor paging on `event_id`, which is the authoritative append order. */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { executionId } = await params;
    const { client } = await requireUser();
    const query = parseQuery(request, EventPageRequestSchema);
    const page = await listEvents(client, executionId, {
      ...(query.afterEventId === undefined ? {} : { afterEventId: query.afterEventId }),
      limit: query.limit,
    });
    const artifactUrls = await signEventArtifacts(client, page.events);
    return json({ ...page, artifactUrls });
  });
}
