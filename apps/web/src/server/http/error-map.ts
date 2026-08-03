import { randomUUID } from 'node:crypto';
import { createLogger } from '@meridian/core';
import { NextResponse } from 'next/server';
import { UnauthenticatedError } from '@/server/auth/require-user';
import { BadRequestError } from '@/server/http/json';

const log = createLogger('api');

/**
 * The RPCs raise `CODE: detail` strings. Mapping them here — once — is what keeps every route
 * handler down to "authenticate, validate, call one service".
 */
const STATUS_BY_CODE: ReadonlyArray<[RegExp, number]> = [
  [/^NOT_AUTHENTICATED/, 401],
  [/_NOT_FOUND_OR_FORBIDDEN/, 404],
  [/_NOT_FOUND/, 404],
  [/^STALE_/, 409],
  [/^ACTIVE_REVIEW_EXISTS/, 409],
  [/^BOARD_CHANGED_DURING_FREEZE/, 409],
  [/^SPEC_ALREADY_FROZEN/, 409],
  [/^ILLEGAL_TRANSITION/, 409],
  [/^DUPLICATE_/, 409],
  [/^WHITEBOARD_ARCHIVED/, 409],
  [/^ACTION_.*_CONFLICT/, 409],
  [/^UNRESOLVED_BLOCKERS/, 409],
  [/^STALE_REVIEW_NOT_ACKNOWLEDGED/, 409],
  [/^CAPABILITY_DENIED/, 403],
  [/^LINEAGE_/, 403],
  [/^ACTOR_REQUIRED/, 403],
  [/^INVALID_/, 400],
  [/^MODEL_NAME_REQUIRED/, 400],
  [/^ID_IN_UPSERT_AND_DELETE/, 400],
  [/^DELETE_TARGET_NOT_FOUND/, 400],
  [/^EDGE_ENDPOINT_NOT_ON_BOARD/, 400],
  [/^SNAPSHOT_/, 400],
  [/^STATUS_NOT_OPERATOR_SETTABLE/, 400],
];

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
  for (const [pattern, status] of STATUS_BY_CODE) {
    if (pattern.test(message)) {
      const code = firstToken(message);
      const currentRevisionNo = currentRevisionFrom(message);
      return NextResponse.json(
        currentRevisionNo === undefined ? { code, message } : { code, message, currentRevisionNo },
        { status },
      );
    }
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
