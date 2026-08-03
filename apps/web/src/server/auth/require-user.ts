import 'server-only';

import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@/server/supabase/server-client';

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('UNAUTHENTICATED');
    this.name = 'UnauthenticatedError';
  }
}

export interface AuthenticatedContext {
  userId: string;
  client: SupabaseClient<Database>;
}

/**
 * `getUser()` rather than `getSession()`: the session cookie is client-writable, so only a
 * token the auth server has actually validated may decide who the caller is.
 */
export async function requireUser(): Promise<AuthenticatedContext> {
  const client = await createServerClient();
  const { data, error } = await client.auth.getUser();
  if (error !== null || data.user === null) throw new UnauthenticatedError();
  return { userId: data.user.id, client };
}
