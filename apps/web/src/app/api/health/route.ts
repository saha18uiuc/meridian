import { temporalTarget, workerHealthUrl } from '@meridian/core';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/server/supabase/service-client';

export const dynamic = 'force-dynamic';

async function checkSupabase(): Promise<boolean> {
  try {
    const client = createServiceClient();
    const { error } = await client.from('whiteboards').select('whiteboard_id').limit(1);
    return error === null;
  } catch {
    return false;
  }
}

async function checkTemporal(): Promise<boolean> {
  const { connection: options } = temporalTarget();
  const [host, port] = options.address.split(':');
  if (host === undefined || port === undefined) return false;
  try {
    const { Connection } = await import('@temporalio/client');
    const connection = await Connection.connect({
      ...options,
      connectTimeout: 2000,
    });
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

async function checkWorker(): Promise<boolean> {
  try {
    const response = await fetch(workerHealthUrl(), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The one public route. It reports each dependency separately so a partial outage is visible. */
export async function GET(): Promise<NextResponse> {
  const [supabase, temporal, worker] = await Promise.all([
    checkSupabase(),
    checkTemporal(),
    checkWorker(),
  ]);
  const ok = supabase;
  return NextResponse.json({ ok, supabase, temporal, worker }, { status: ok ? 200 : 503 });
}
