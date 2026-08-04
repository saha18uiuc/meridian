import type { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/require-user';
import { handle } from '@/server/http/error-map';
import { json } from '@/server/http/json';
import { listSpecs } from '@/server/repositories/specs';

export const dynamic = 'force-dynamic';

/** The caller's frozen specifications across every board, newest first. */
export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    const { client } = await requireUser();
    return json({ specs: await listSpecs(client) });
  });
}
