import { describe, expect, it } from 'vitest';
import { temporalProbeArgs } from '../src/health-check.js';

describe('the Temporal health probe', () => {
  const CLOUD = 'us-west-2.aws.api.temporal.io:7233';

  it('asks about the namespace, because the cluster-wide question is one Cloud refuses', () => {
    // Verified against the real namespace: `temporal operator cluster health --api-key ... --tls`
    // returns `Request unauthorized`, since an API key is scoped to a namespace and that call is
    // not. The CLI exits non-zero for that exactly as it does for a server that is not running, so
    // the probe reported a healthy Cloud namespace as `not-started`.
    const args = temporalProbeArgs(CLOUD, 'dibyadeep.x1cz2', 'key');
    expect(args.slice(0, 3)).toEqual(['operator', 'namespace', 'describe']);
    expect(args).not.toContain('cluster');
  });

  it('names the namespace it is configured against, not whichever one is default', () => {
    const args = temporalProbeArgs(CLOUD, 'dibyadeep.x1cz2', 'key');
    expect(args).toContain('--namespace');
    expect(args[args.indexOf('--namespace') + 1]).toBe('dibyadeep.x1cz2');
  });

  it('authenticates with TLS when there is a key, so a secured server is not read as absent', () => {
    const args = temporalProbeArgs(CLOUD, 'dibyadeep.x1cz2', 'key');
    expect(args).toContain('--api-key');
    expect(args).toContain('--tls');
  });

  it('sends no credential to the dev server, which has none to check', () => {
    for (const absent of [undefined, '', '   ']) {
      const args = temporalProbeArgs('127.0.0.1:7233', 'default', absent);
      expect(args).not.toContain('--api-key');
      expect(args).not.toContain('--tls');
    }
  });
});
