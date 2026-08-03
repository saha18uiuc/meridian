import type { Database } from '@meridian/core/database';
import { workerEnv } from '@meridian/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The service-role client for operational scripts.
 *
 * Scripts run on an operator's machine or in CI, never in a browser, so there is no user session
 * to derive ownership from. They are trusted by construction, which is exactly why they live in a
 * separate package from anything the web app can import.
 */
let cached: SupabaseClient<Database> | null = null;

export function opsClient(): SupabaseClient<Database> {
  if (cached !== null) return cached;
  const env = workerEnv();
  cached = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function resetOpsClientForTests(): void {
  cached = null;
}
