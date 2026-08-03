import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '@/server/auth/require-user';
import { mapError, mappedStatus } from '@/server/http/error-map';
import { BadRequestError } from '@/server/http/json';

/**
 * The HTTP contract from §12, pinned.
 *
 * Route handlers do not choose status codes; they throw and this module decides. That makes the
 * mapping the only place where "the database refused this" becomes something a client can branch
 * on, and a code that falls through it is reported as a server fault — telling the caller to retry
 * an operation that will never succeed. The exhaustive case at the bottom is the one that matters:
 * it reads the codes out of the migrations rather than out of a list somebody remembered to update.
 */

const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

async function statusAndBody(
  error: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = mapError(error);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Every `raise exception 'CODE'` the schema contains, read from the SQL itself. */
function raisedCodes(): string[] {
  const codes = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
    for (const match of sql.matchAll(/raise exception\s+'([A-Z][A-Z0-9_]*)/g)) {
      if (match[1] !== undefined) codes.add(match[1]);
    }
  }
  return [...codes].sort();
}

describe('mapError', () => {
  it('answers 401 for an unauthenticated caller without inventing a code', async () => {
    const { status, body } = await statusAndBody(new UnauthenticatedError());
    expect(status).toBe(401);
    expect(body['code']).toBe('UNAUTHENTICATED');
  });

  it('attaches the current revision to a stale write so recovery is one reload', async () => {
    const { status, body } = await statusAndBody(
      new Error('STALE_BOARD_REVISION: expected=6 current=7'),
    );
    expect(status).toBe(409);
    expect(body['code']).toBe('STALE_BOARD_REVISION');
    expect(body['currentRevisionNo']).toBe(7);
  });

  it.each([
    // A lifecycle gate is a conflict: the request is well formed and the state refuses it.
    ['GIT_COMMIT_REQUIRED', 409],
    ['MANIFEST_GENERATED_FILES_REQUIRED', 409],
    ['MANIFEST_SPEC_HASH_MISMATCH', 409],
    ['ILLEGAL_TRANSITION: generated -> approved', 409],
    ['ACTIVE_VERSION_NOT_APPROVED', 409],
    ['VERSION_NOT_ON_AGENT', 409],
    ['DEPLOYMENT_KEY_TAKEN', 409],
    ['UNRESOLVED_BLOCKERS: 3', 409],
    ['SPEC_ALREADY_FROZEN: abc', 409],

    // Not found, and deliberately indistinguishable from not yours.
    ['WHITEBOARD_NOT_FOUND_OR_FORBIDDEN', 404],
    ['AGENT_VERSION_NOT_FOUND', 404],

    // Forbidden: the caller may see the row but may not do this to it.
    ['CAPABILITY_DENIED: mail.send', 403],
    ['LINEAGE_MISMATCH', 403],
    ['ACTOR_REQUIRED', 403],
    ['EXECUTION_LINEAGE_IMMUTABLE', 403],
    ['AGENT_VERSION_LINEAGE_FROZEN', 403],
    ['WHITEBOARD_GRAPH_DIRECT_WRITE_FORBIDDEN', 403],

    // Bad request: re-sending the same payload will fail the same way.
    ['INVALID_GIT_SHA', 400],
    ['EMPTY_REASON', 400],
    ['MODEL_NAME_REQUIRED', 400],
    ['NOT_A_ROOT_COMMENT', 400],
    ['CANNOT_REPLY_TO_REPLY', 400],

    // Two that read like a family they do not belong to.
    ['DELETE_TARGET_NOT_FOUND', 400],
    ['EDGE_ENDPOINT_NOT_ON_BOARD', 400],
  ])('maps %s to %i', async (message, expected) => {
    const { status, body } = await statusAndBody(new Error(message));
    expect(status).toBe(expected);
    expect(body['code']).toBe(message.split(':')[0]);
  });

  it('keeps a Zod failure at 400 with its issues attached', async () => {
    const { status, body } = await statusAndBody(
      new BadRequestError('INVALID_REQUEST_BODY', [{ path: ['title'], message: 'Required' }]),
    );
    expect(status).toBe(400);
    expect(body['issues']).toHaveLength(1);
  });

  it('gives an unrecognised failure a correlation id and nothing else', async () => {
    const { status, body } = await statusAndBody(
      new Error('duplicate key value violates unique constraint "uq_secret_internal"'),
    );
    expect(status).toBe(500);
    expect(body['code']).toBe('INTERNAL_ERROR');
    expect(typeof body['correlationId']).toBe('string');
    expect(JSON.stringify(body)).not.toContain('uq_secret_internal');
  });

  it('gives every code the schema raises a considered client status', async () => {
    const codes = raisedCodes();
    // Guards the guard: a regex that stopped matching would make this vacuously true.
    expect(codes.length).toBeGreaterThan(50);
    expect(codes).toContain('GIT_COMMIT_REQUIRED');

    // `mappedStatus`, not `mapError`: the 409 fallback would answer every one of these and make
    // the assertion meaningless. What is checked is that each code was actually thought about.
    const unmapped = codes.filter((code) => mappedStatus(code) === undefined);
    expect(unmapped).toEqual([]);

    const misrouted: string[] = [];
    for (const code of codes) {
      const { status, body } = await statusAndBody(new Error(code));
      if (status >= 500 || body['code'] !== code) misrouted.push(`${code} -> ${String(status)}`);
    }
    expect(misrouted).toEqual([]);
  });
});
