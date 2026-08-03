import { describe, expect, it } from 'vitest';
import {
  VersionResolutionError,
  resolveToolkitVersion,
  type ToolkitClient,
} from '../src/resolve-versions.js';

/**
 * Turning `latest` into something an execution record can honestly cite.
 *
 * The single rule under test is that the string `latest` never reaches a recorded artifact. It
 * describes a different toolkit every week, so a run that claims it cannot be reproduced and a
 * regression against it cannot be attributed. When resolution is impossible the module raises
 * rather than recording a plausible-looking value, because a wrong lineage is worse than a stopped
 * cold start.
 */

const now = () => new Date('2026-02-11T00:00:00.000Z');

function toolkitClient(response: {
  version?: string;
  latestVersion?: string;
  meta?: { availableVersions?: string[] };
}): ToolkitClient {
  return { toolkits: { get: async () => response } };
}

describe('toolkit version resolution', () => {
  it('passes a concrete request straight through', async () => {
    const resolved = await resolveToolkitVersion({
      requested: '20250115_01',
      apiKeyPresent: true,
      now,
      coreVersion: '0.14.1',
    });
    expect(resolved.composioGmailToolkit).toBe('20250115_01');
    expect(resolved.resolvedFrom).toBe('COMPOSIO_GMAIL_TOOLKIT_VERSION');
  });

  it('records "mock" when there is no key, rather than a version it never used', async () => {
    const resolved = await resolveToolkitVersion({
      requested: 'latest',
      apiKeyPresent: false,
      now,
      coreVersion: '0.14.1',
    });
    expect(resolved.composioGmailToolkit).toBe('mock');
    expect(resolved.resolvedFrom).toBe('no-composio-key');
  });

  it('resolves through the provider when a key is present', async () => {
    const resolved = await resolveToolkitVersion({
      requested: 'latest',
      apiKeyPresent: true,
      client: toolkitClient({ version: '20260115_02' }),
      now,
      coreVersion: '0.14.1',
    });
    expect(resolved.composioGmailToolkit).toBe('20260115_02');
    expect(resolved.resolvedFrom).toBe('composio.toolkits.get(gmail)');
  });

  it('falls back to latestVersion when the provider names it that way', async () => {
    const resolved = await resolveToolkitVersion({
      requested: 'latest',
      apiKeyPresent: true,
      client: toolkitClient({ latestVersion: '20260201_01' }),
      now,
    });
    expect(resolved.composioGmailToolkit).toBe('20260201_01');
  });

  it('reads meta.availableVersions, which is where Composio actually publishes them', async () => {
    const resolved = await resolveToolkitVersion({
      requested: 'latest',
      apiKeyPresent: true,
      client: toolkitClient({ meta: { availableVersions: ['20260721_00', '20260702_01'] } }),
      now,
    });
    expect(resolved.composioGmailToolkit).toBe('20260721_00');
    expect(resolved.resolvedFrom).toBe('composio.toolkits.get(gmail)');
  });

  it('takes the newest available version rather than trusting the array order', async () => {
    const resolved = await resolveToolkitVersion({
      requested: 'latest',
      apiKeyPresent: true,
      client: toolkitClient({
        meta: { availableVersions: ['20260126_00', '20260721_00', '20260702_01'] },
      }),
      now,
    });
    expect(resolved.composioGmailToolkit).toBe('20260721_00');
  });

  it('ignores available versions whose shape it cannot rank', async () => {
    await expect(
      resolveToolkitVersion({
        requested: 'latest',
        apiKeyPresent: true,
        client: toolkitClient({ meta: { availableVersions: ['latest', 'stable'] } }),
        now,
      }),
    ).rejects.toThrow(/concrete/);
  });

  it('refuses to record the literal string "latest" even if the provider returns it', async () => {
    await expect(
      resolveToolkitVersion({
        requested: 'latest',
        apiKeyPresent: true,
        client: toolkitClient({ version: 'latest' }),
        now,
      }),
    ).rejects.toBeInstanceOf(VersionResolutionError);
  });

  it('refuses to guess when the provider answers with nothing', async () => {
    await expect(
      resolveToolkitVersion({
        requested: 'latest',
        apiKeyPresent: true,
        client: toolkitClient({}),
        now,
      }),
    ).rejects.toThrow(/concrete/);
  });

  it('reports the provider failure instead of degrading to a default', async () => {
    await expect(
      resolveToolkitVersion({
        requested: 'latest',
        apiKeyPresent: true,
        client: {
          toolkits: {
            get: async () => {
              throw new Error('403 forbidden');
            },
          },
        },
        now,
      }),
    ).rejects.toThrow(/403 forbidden/);
  });

  it('stops when a key is present but no client could be built', async () => {
    await expect(
      resolveToolkitVersion({ requested: 'latest', apiKeyPresent: true, client: null, now }),
    ).rejects.toBeInstanceOf(VersionResolutionError);
  });
});
