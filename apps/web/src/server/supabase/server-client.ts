import 'server-only';

import type { Database } from '@meridian/core/database';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * The user-scoped client. Every read it performs is filtered by RLS against `auth.uid()`, which
 * is why ownership never has to be re-checked by hand on the read path.
 */
export async function createServerClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  return createSsrServerClient<Database>(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] as string,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] as string,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. `middleware.ts` refreshes the session on
            // every matched request, so swallowing this is safe rather than lossy.
          }
        },
      },
    },
  );
}
