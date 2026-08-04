import { describe, expect, it } from 'vitest';
import { checkLiveModeCoherence } from '../src/preflight.js';

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
