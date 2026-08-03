import { createHash } from 'node:crypto';

/**
 * The one and only canonicalization and hashing implementation in Meridian (§5.4 rule 8).
 *
 * Every app, service, script, skill, and test imports `canonicalJson`, `canonicalBytes`, or
 * `sha256Hex` from here. No other module may reimplement either operation, because a second
 * implementation is a second answer to "are these two artifacts the same?".
 *
 * The output conforms to RFC 8785 (JSON Canonicalization Scheme) over the value subset Meridian
 * actually stores: null, boolean, finite number, string, array, and plain object.
 *
 * Hashes identify content and let the system verify equality with it. They are not an
 * authorization or authentication mechanism and prove nothing about who created or approved
 * anything.
 */

export class NonCanonicalizableValueError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path === '' ? '<root>' : path})`);
    this.name = 'NonCanonicalizableValueError';
    this.path = path;
  }
}

/**
 * The single number serializer, shared by the canonicalizer and its tests so the two can never
 * disagree. `String(n)` implements ECMAScript `Number::toString`, which is exactly what RFC 8785
 * mandates, and it renders `-0` as `0` — so `-0` and `0` canonicalize identically (A4).
 */
export function serializeNumber(n: number, path = ''): string {
  if (Number.isNaN(n)) {
    throw new NonCanonicalizableValueError('NaN is not canonicalizable', path);
  }
  if (!Number.isFinite(n)) {
    throw new NonCanonicalizableValueError(
      `${n > 0 ? 'Infinity' : '-Infinity'} is not canonicalizable`,
      path,
    );
  }
  return String(n);
}

function serializeString(s: string, path: string): string {
  // RFC 8785 forbids lone surrogates. `JSON.stringify` would emit a `\udXXX` escape for one
  // rather than failing, which would silently produce a hash for a string that is not valid
  // Unicode, so the check is explicit.
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new NonCanonicalizableValueError('lone high surrogate in string', path);
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new NonCanonicalizableValueError('lone low surrogate in string', path);
    }
  }
  // JSON.stringify's string escaping is byte-for-byte the escaping RFC 8785 §3.2.2.2 requires.
  return JSON.stringify(s);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnsupported(value: unknown, path: string): never {
  throw rejectUnsupportedError(value, path);
}

function rejectUnsupportedError(value: unknown, path: string): NonCanonicalizableValueError {
  const kind =
    typeof value === 'function'
      ? 'function'
      : typeof value === 'symbol'
        ? 'symbol'
        : typeof value === 'bigint'
          ? 'BigInt'
          : value instanceof Date
            ? 'Date'
            : value instanceof Map
              ? 'Map'
              : value instanceof Set
                ? 'Set'
                : Object.prototype.toString.call(value);
  return new NonCanonicalizableValueError(
    `${kind} is not canonicalizable; normalize it before hashing`,
    path,
  );
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(serializeNumber(value, path));
      return;
    case 'string':
      out.push(serializeString(value, path));
      return;
    case 'undefined':
      throw new NonCanonicalizableValueError('undefined is not canonicalizable', path);
    case 'bigint':
    case 'symbol':
    case 'function':
      // `rejectUnsupported` returns `never`; the `throw` is written out anyway so the control flow
      // is visible to a reader and to the no-fallthrough rule, neither of which reads signatures.
      throw rejectUnsupportedError(value, path);
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Array order is semantically meaningful and is always preserved. Set-like collections are
    // sorted and de-duplicated by the caller, before they ever reach this function (§5.4 rule 4).
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(',');
      write(value[i], `${path}[${i}]`, out);
    }
    out.push(']');
    return;
  }

  if (!isPlainObject(value)) {
    rejectUnsupported(value, path);
  }

  // RFC 8785 sorts member names by UTF-16 code unit, which is what the default string comparison
  // in JavaScript already does.
  const keys = Object.keys(value).sort();
  out.push('{');
  let first = true;
  for (const key of keys) {
    const child = value[key];
    // An absent property and a property explicitly set to `undefined` must canonicalize the same
    // way, matching JSON.stringify: both are omitted. Inside an array, `undefined` is rejected
    // instead, because dropping an element would change the array's length.
    if (child === undefined) continue;
    if (!first) out.push(',');
    first = false;
    out.push(serializeString(key, path));
    out.push(':');
    write(child, path === '' ? key : `${path}.${key}`, out);
  }
  out.push('}');
}

/** The canonical UTF-8 JSON serialization of `value`, per RFC 8785. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, '', out);
  return out.join('');
}

/** The canonical serialization encoded as UTF-8 bytes. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(value), 'utf8'));
}

/** SHA-256 of the canonical UTF-8 bytes, as 64 lowercase hex characters. */
export function sha256Hex(value: unknown): string {
  return createHash('sha256')
    .update(Buffer.from(canonicalJson(value), 'utf8'))
    .digest('hex');
}

/** SHA-256 of an already-serialized string or byte buffer. */
export function sha256HexOfBytes(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input))
    .digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}
