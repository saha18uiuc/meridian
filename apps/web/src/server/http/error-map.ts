import { randomUUID } from 'node:crypto';
import { createLogger } from '@meridian/core';
import { NextResponse } from 'next/server';
import { UnauthenticatedError } from '@/server/auth/require-user';
import { BadRequestError } from '@/server/http/json';

const log = createLogger('api');

/**
 * The RPCs raise `CODE` or `CODE: detail` strings. Mapping them here — once — is what keeps every
 * route handler down to "authenticate, validate, call one service".
 *
 * The list is ordered and the first match wins, so the codes that read like a family they do not
 * belong to come first. Anything unlisted but shaped like a raised code is caught by
 * `DOMAIN_CODE` below rather than reaching the 500, because the database raises roughly a hundred
 * of these and a refusal the caller can act on must never be reported as a server fault.
 */
const STATUS_BY_CODE: ReadonlyArray<[RegExp, number]> = [
  [/^NOT_AUTHENTICATED/, 401],

  // Exceptions, first: each of these matches a family rule below that would misclassify it.
  [/^DELETE_TARGET_NOT_FOUND/, 400], // a bad id in the delta, not a missing resource
  [/^EDGE_ENDPOINT_NOT_ON_BOARD/, 400], // the delta is malformed, not the board's state
  [/^ACTOR_REQUIRED/, 403],
  [/^GIT_COMMIT_REQUIRED/, 409], // the lifecycle gate: nothing about the request is wrong
  [/^MANIFEST_/, 409],
  [/^RECONCILIATION_EVIDENCE_REQUIRED/, 409],

  // 404 — deliberately indistinguishable from "not yours", so it is decided before the 403 family
  // below claims anything ending in `_FORBIDDEN`.
  [/_NOT_FOUND_OR_FORBIDDEN/, 404],
  [/_NOT_FOUND$/, 404],

  // 403 — the row is visible and the caller is known; the operation is not theirs to perform.
  [/^CAPABILITY_DENIED/, 403],
  [/^LINEAGE_/, 403],
  [/^IMMUTABLE_ROW/, 403],
  [/_IMMUTABLE(_FIELD)?$/, 403],
  [/_FROZEN$/, 403],
  [/_FORBIDDEN$/, 403],

  // 400 — the payload is wrong, and re-sending it unchanged will fail the same way.
  [/^INVALID_/, 400],
  [/^EMPTY_/, 400],
  [/^SNAPSHOT_/, 400],
  [/^ID_IN_UPSERT_AND_DELETE/, 400],
  [/^STATUS_NOT_OPERATOR_SETTABLE/, 400],
  [/^NOT_A_ROOT_COMMENT/, 400],
  [/^CANNOT_REPLY_TO_REPLY/, 400],
  [/^NO_SUGGESTED_PATCH/, 400],
  [/^ANCHOR_NOT_IN_REVIEWED_SNAPSHOT/, 400],
  [/^PROVIDER_ID_REQUIRED_FOR_SUCCESS/, 400],
  [/_REQUIRED$/, 400],

  // 409 — the request is well formed and the current state refuses it.
  [/^STALE_/, 409],
  [/^DUPLICATE_/, 409],
  [/^ACTIVE_REVIEW_EXISTS/, 409],
  [/^BOARD_CHANGED_DURING_FREEZE/, 409],
  [/^SPEC_ALREADY_FROZEN/, 409],
  [/^ILLEGAL_TRANSITION/, 409],
  [/^WHITEBOARD_ARCHIVED/, 409],
  [/^ACTION_.*_CONFLICT/, 409],
  [/^UNRESOLVED_BLOCKERS/, 409],
  [/^AGENT_ARCHIVE/, 409],
  [/^AGENT_NOT_ACTIVE/, 409],
  [/^ACTIVE_VERSION_NOT_APPROVED/, 409],
  [/^VERSION_NOT_/, 409],
  [/^STATUS_NOT_TRANSITIONABLE/, 409],
  [/^REVIEW_SESSION_NOT_RUNNING/, 409],
  [/^DEPLOYMENT_KEY_TAKEN/, 409],
  [/^PARENT_VERSION_NOT_LOWER/, 409],
  [/^CODE_PATH_MISMATCH/, 409],
  [/^RESERVED_MUST_CLEAR_DISPATCHED_AT/, 409],
  [/REQUIRES_/, 409],
  [/MUST_NOT_/, 409],
  [/_NOT_ON_/, 409],
];

/** The status this message is contracted to produce, or undefined if nothing claims it. */
export function mappedStatus(message: string): number | undefined {
  for (const [pattern, status] of STATUS_BY_CODE) {
    if (pattern.test(message)) return status;
  }
  return undefined;
}

/**
 * A message that opens with a `SCREAMING_SNAKE` token is one of ours.
 *
 * Postgres surfaces its own failures in prose — `duplicate key value violates unique constraint` —
 * and the driver's are prose too, so requiring at least two underscore-joined uppercase words at
 * the very start separates a deliberate `raise exception` from anything unplanned. Those get a 409
 * rather than a 500: the code is a contract the client can branch on, and calling a refusal an
 * internal error tells the caller to retry something that will never succeed.
 */
const DOMAIN_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?::|\s|$)/;

export class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE';
  readonly modelName: string;

  constructor(modelName: string) {
    super(`MODEL_UNAVAILABLE: ${modelName}`);
    this.name = 'ModelUnavailableError';
    this.modelName = modelName;
  }
}

export class ReviewModelCallFailedError extends Error {
  readonly code = 'REVIEW_MODEL_CALL_FAILED';
  readonly reviewSessionId: string;

  constructor(reviewSessionId: string, message: string) {
    super(message);
    this.name = 'ReviewModelCallFailedError';
    this.reviewSessionId = reviewSessionId;
  }
}

export class CompilationFailedError extends Error {
  readonly code = 'SPEC_COMPILATION_FAILED';
  readonly errors: unknown[];

  constructor(errors: unknown[]) {
    super('SPEC_COMPILATION_FAILED');
    this.name = 'CompilationFailedError';
    this.errors = errors;
  }
}

function firstToken(message: string): string {
  const colon = message.indexOf(':');
  return (colon === -1 ? message : message.slice(0, colon)).trim();
}

function currentRevisionFrom(message: string): number | undefined {
  const match = /current=(\d+)/.exec(message);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

/** The one response shape for a refusal the caller can read: a code, and the revision if it carries one. */
function domainResponse(message: string, status: number): NextResponse {
  const code = firstToken(message);
  const currentRevisionNo = currentRevisionFrom(message);
  return NextResponse.json(
    currentRevisionNo === undefined ? { code, message } : { code, message, currentRevisionNo },
    { status },
  );
}

export function mapError(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  if (error instanceof BadRequestError) {
    return NextResponse.json({ code: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof ModelUnavailableError) {
    return NextResponse.json({ code: error.code, modelName: error.modelName }, { status: 503 });
  }
  if (error instanceof ReviewModelCallFailedError) {
    return NextResponse.json(
      { code: error.code, reviewSessionId: error.reviewSessionId, message: error.message },
      { status: 502 },
    );
  }
  if (error instanceof CompilationFailedError) {
    return NextResponse.json({ code: error.code, errors: error.errors }, { status: 422 });
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = mappedStatus(message);
  if (status !== undefined) return domainResponse(message, status);

  if (DOMAIN_CODE.test(message)) {
    // Answered correctly, but logged: a code that reaches here has no considered status, and the
    // log entry is how it acquires one instead of sitting unnoticed behind a plausible 409.
    log.warn({ code: firstToken(message) }, 'domain error with no mapped status; answering 409');
    return domainResponse(message, 409);
  }

  // Unmapped failures never leak internals; the correlation id is the only handle the client
  // gets, and the detail stays in the (redacted) server log.
  const correlationId = randomUUID();
  log.error({ correlationId, err: message }, 'unhandled API error');
  return NextResponse.json({ code: 'INTERNAL_ERROR', correlationId }, { status: 500 });
}

/** Wrap a route handler body so every throw funnels through one mapping. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    return mapError(error);
  }
}
