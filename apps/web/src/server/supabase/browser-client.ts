'use client';

import type { Database } from '@meridian/core/database';
import { createBrowserClient as createSsrBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient<Database> | undefined;

/**
 * The only Supabase client that ever reaches the bundle. It carries the anon key, which is not a
 * secret: every table it can touch is RLS-protected and every mutation goes through an RPC.
 */
export function createBrowserClient(): SupabaseClient<Database> {
  cached ??= createSsrBrowserClient<Database>(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] as string,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] as string,
  );
  return cached;
}
