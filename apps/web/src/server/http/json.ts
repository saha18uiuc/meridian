import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';

export function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body as unknown as Record<string, unknown>, { status });
}

export class BadRequestError extends Error {
  readonly code = 'BAD_REQUEST';
  readonly issues: unknown;

  constructor(message: string, issues: unknown) {
    super(message);
    this.name = 'BadRequestError';
    this.issues = issues;
  }
}

/** Parse a JSON body with a Zod schema, turning every shape failure into one typed 400. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new BadRequestError('INVALID_JSON_BODY', []);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestError('INVALID_REQUEST_BODY', result.error.issues);
  return result.data;
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) throw new BadRequestError('INVALID_QUERY', result.error.issues);
  return result.data;
}
