import 'server-only';

import type { Database } from '@meridian/core/database';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The trusted client. It bypasses RLS, so every caller must have already resolved the acting
 * user and must pass that user's ID into the RPC as `p_actor_user_id`; the RPCs re-derive
 * ownership from it rather than trusting the caller (§5.13, A21).
 *
 * `import 'server-only'` makes importing this from a client component a build error, not a
 * runtime surprise.
 */
export function createServiceClient(): SupabaseClient<Database> {
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (key === undefined || key.length === 0) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return createClient<Database>(process.env['NEXT_PUBLIC_SUPABASE_URL'] as string, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
