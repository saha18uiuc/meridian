import { describe, expect, it } from 'vitest';
import {
  EnvironmentError,
  SECRET_ENV_NAMES,
  forgetEmptyEnvVars,
  ownsLocalTemporal,
  parseBrowserEnv,
  parseServerEnv,
  parseWorkerEnv,
  serverEnvSchema,
  temporalTarget,
} from '../src/env.js';
import { REDACTED_PATHS } from '../src/logging.js';

const SECRET_VALUE = 'sk-super-secret-value-do-not-print';

const minimalServer = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54521',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  NEXT_PUBLIC_APP_BASE_URL: 'http://localhost:3000',
  SUPABASE_SERVICE_ROLE_KEY: SECRET_VALUE,
  SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54522/postgres',
  APP_BASE_URL: 'http://localhost:3000',
};

describe('an environment variable set to nothing', () => {
  it('is removed, so a loader that will not override can supply the real one', () => {
    const env = { OPENAI_API_KEY: '', COMPOSIO_API_KEY: '', KEEP: 'value' };
    expect(forgetEmptyEnvVars(env)).toEqual(['COMPOSIO_API_KEY', 'OPENAI_API_KEY']);
    expect('OPENAI_API_KEY' in env).toBe(false);
    expect(env.KEEP).toBe('value');
  });

  it('is distinguished from a variable whose value is whitespace', () => {
    // A space is a value, and a wrong one. Deleting it would hide a typo behind a working default
    // instead of letting the schema reject it, which is a different mistake from the one above.
    const env = { PADDED: ' ' };
    expect(forgetEmptyEnvVars(env)).toEqual([]);
    expect(env.PADDED).toBe(' ');
  });
});

describe('server environment', () => {
  it('parses a minimal environment and applies documented defaults', () => {
    const env = parseServerEnv(minimalServer);
    expect(env.AI_MODE).toBe('mock');
    expect(env.AI_REVIEW_MODEL).toBe('gpt-5.5');
    expect(env.AI_REASONING_EFFORT).toBe('high');
    expect(env.AI_REVIEW_TIMEOUT_MS).toBe(240_000);
    expect(env.TEMPORAL_TASK_QUEUE).toBe('meridian-receiving');
    expect(env.MERIDIAN_STATE_DIR).toBe('.meridian');
    expect(env.GMAIL_LIVE_MODE).toBe(false);
  });

  it('names every missing variable', () => {
    try {
      parseServerEnv({});
      expect.unreachable('expected an EnvironmentError');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const names = (error as EnvironmentError).names;
      expect(names).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(names).toContain('NEXT_PUBLIC_SUPABASE_URL');
    }
  });

  it('never prints a value, only a name', () => {
    try {
      parseServerEnv({ ...minimalServer, APP_BASE_URL: SECRET_VALUE });
      expect.unreachable('expected an EnvironmentError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('APP_BASE_URL');
      expect(message).not.toContain(SECRET_VALUE);
    }
  });

  it('parses comma-separated allow-lists into trimmed arrays', () => {
    const env = parseServerEnv({
      ...minimalServer,
      GMAIL_ALLOWED_RECIPIENTS: ' a@example.com , b@example.com ,',
    });
    expect(env.GMAIL_ALLOWED_RECIPIENTS).toEqual(['a@example.com', 'b@example.com']);
  });

  it('rejects an out-of-range enum', () => {
    expect(() => parseServerEnv({ ...minimalServer, AI_REASONING_EFFORT: 'extreme' })).toThrow(
      /AI_REASONING_EFFORT/,
    );
  });
});

describe('browser environment', () => {
  it('exposes only NEXT_PUBLIC_ names', () => {
    for (const key of Object.keys(parseBrowserEnv(minimalServer))) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(true);
    }
  });

  it('keeps every secret out of the browser schema', () => {
    const browserKeys = Object.keys(parseBrowserEnv(minimalServer));
    for (const secret of SECRET_ENV_NAMES) {
      expect(browserKeys).not.toContain(secret);
    }
  });
});

describe('worker environment', () => {
  it('needs the service role key and the Temporal address', () => {
    const env = parseWorkerEnv({
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54521',
      SUPABASE_SERVICE_ROLE_KEY: SECRET_VALUE,
    });
    expect(env.TEMPORAL_ADDRESS).toBe('127.0.0.1:7233');
  });
});

describe('the Temporal target', () => {
  const cloud = {
    TEMPORAL_ADDRESS: 'meridian.a1b2c.tmprl.cloud:7233',
    TEMPORAL_NAMESPACE: 'meridian.a1b2c',
    TEMPORAL_API_KEY: SECRET_VALUE,
  };

  it('sends no credential and no TLS to the dev server', () => {
    expect(temporalTarget({})).toEqual({
      connection: { address: '127.0.0.1:7233' },
      namespace: 'default',
    });
  });

  it('turns TLS on with the API key, since Cloud refuses the connection without it', () => {
    // The two are never configured separately: a key sent over an unencrypted channel is worse
    // than no key, so there is no combination where one is wanted and the other is not.
    expect(temporalTarget(cloud).connection).toEqual({
      address: cloud.TEMPORAL_ADDRESS,
      tls: true,
      apiKey: SECRET_VALUE,
    });
  });

  it('still allows TLS alone, which is a self-hosted deployment behind it', () => {
    const target = temporalTarget({
      TEMPORAL_ADDRESS: 'temporal.internal:7233',
      TEMPORAL_TLS: 'true',
    });
    expect(target.connection).toEqual({ address: 'temporal.internal:7233', tls: true });
  });

  it('treats a blank key as no key, so a placeholder line in .env cannot half-enable TLS', () => {
    expect(temporalTarget({ TEMPORAL_API_KEY: '   ' }).connection).toEqual({
      address: '127.0.0.1:7233',
    });
  });

  it('hands back the same options both connection classes accept', () => {
    // `Connection` and `NativeConnection` differ in transport but share these three fields, which
    // is what lets one helper serve the worker, the web app, the ops CLI and the health probe.
    expect(Object.keys(temporalTarget(cloud).connection).sort()).toEqual([
      'address',
      'apiKey',
      'tls',
    ]);
  });
});

describe('local Temporal ownership', () => {
  it('is claimed only for a loopback address with no credential', () => {
    expect(ownsLocalTemporal({})).toBe(true);
    expect(ownsLocalTemporal({ TEMPORAL_ADDRESS: 'localhost:7233' })).toBe(true);
  });

  it('is disclaimed once a key is set, even if the address was never changed', () => {
    // The half-finished migration: the dev server ignores credentials, so without this the run
    // would succeed locally and the operator would believe they were on Cloud.
    expect(ownsLocalTemporal({ TEMPORAL_API_KEY: 'k' })).toBe(false);
  });

  it('is disclaimed for any address that is not this machine', () => {
    expect(ownsLocalTemporal({ TEMPORAL_ADDRESS: 'meridian.a1b2c.tmprl.cloud:7233' })).toBe(false);
  });
});

describe('redaction list', () => {
  it('covers every secret env name', () => {
    for (const secret of SECRET_ENV_NAMES) {
      expect(REDACTED_PATHS).toContain(secret);
    }
  });

  it('covers the transport headers that carry credentials', () => {
    for (const name of ['authorization', 'cookie', 'password', 'access_token']) {
      expect(REDACTED_PATHS).toContain(name);
    }
  });

  it('never declares a NEXT_PUBLIC_ name as a secret', () => {
    for (const secret of SECRET_ENV_NAMES) {
      expect(secret.startsWith('NEXT_PUBLIC_')).toBe(false);
    }
  });

  it('keeps the schema and the secret list in step', () => {
    const shape = Object.keys(serverEnvSchema.shape);
    for (const secret of SECRET_ENV_NAMES) {
      expect(shape).toContain(secret);
    }
  });
});
