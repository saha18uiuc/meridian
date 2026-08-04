import { describe, expect, it } from 'vitest';
import { checkLiveModeCoherence, checkTemporalTarget } from '../src/preflight.js';

describe('live mode coherence', () => {
  it('rejects a live inbox wired to a mocked model, which can only fail mid-run', () => {
    const result = checkLiveModeCoherence('true', 'mock');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/cannot extract fields without a model/);
  });

  it('treats an absent AI_MODE as mock, matching the schema default', () => {
    expect(checkLiveModeCoherence('true', undefined).ok).toBe(false);
  });

  it('accepts a live inbox with a live model', () => {
    expect(checkLiveModeCoherence('true', 'live').ok).toBe(true);
  });

  it('leaves the mocked inbox alone, where the model is never reached', () => {
    expect(checkLiveModeCoherence('false', 'mock').ok).toBe(true);
    expect(checkLiveModeCoherence(undefined, 'mock').ok).toBe(true);
  });

  it('reads 1 as true, the other spelling the env schema accepts', () => {
    expect(checkLiveModeCoherence('1', 'mock').ok).toBe(false);
  });
});

describe('the Temporal target', () => {
  const CLOUD = 'meridian.a1b2c.tmprl.cloud:7233';

  it('accepts the untouched dev server', () => {
    expect(checkTemporalTarget(undefined, undefined, undefined).ok).toBe(true);
    expect(checkTemporalTarget('127.0.0.1:7233', '', 'default').ok).toBe(true);
  });

  it('accepts a fully configured Cloud namespace', () => {
    expect(checkTemporalTarget(CLOUD, 'key', 'meridian.a1b2c').ok).toBe(true);
  });

  it('rejects a key pointed at the dev server, which would ignore it', () => {
    const result = checkTemporalTarget('127.0.0.1:7233', 'key', 'default');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/still names this machine/);
  });

  it('rejects a Cloud endpoint with no key, which Cloud will refuse', () => {
    expect(checkTemporalTarget(CLOUD, undefined, 'meridian.a1b2c').ok).toBe(false);
  });

  it('accepts self-hosted Temporal with no key, which needs none on a trusted network', () => {
    // Open-source Temporal on Postgres is a production deployment, not a lesser Cloud. Faulting
    // every remote address that lacks a key would make preflight fail the supported setup.
    const result = checkTemporalTarget('temporal.internal:7233', undefined, 'default');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('self-hosted');
  });

  it('rejects a Cloud namespace missing its account suffix', () => {
    // The dashboard heading shows the namespace alone, so copying what is on screen produces
    // exactly this — and the resulting error names neither the namespace nor the account.
    const result = checkTemporalTarget(CLOUD, 'key', 'meridian');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/account suffix/);
  });

  it('never prints the key itself, only whether there is one', () => {
    const detail = checkTemporalTarget(CLOUD, 'super-secret', 'meridian.a1b2c').detail;
    expect(detail).not.toContain('super-secret');
    expect(detail).toContain('api key present');
  });
});
