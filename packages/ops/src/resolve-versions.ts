import { createRequire } from 'node:module';
import { loadOpsEnv } from './env.js';
import { writeResolvedVersions, type ResolvedVersions } from './lib/state.js';

/**
 * External version resolution (A29).
 *
 * An execution record that says it used the "latest" Gmail toolkit describes nothing: the same
 * word means a different thing next week, so the run cannot be reproduced and a regression cannot
 * be attributed. This module turns `latest` into a concrete version *before* anything records it,
 * and refuses to guess when it cannot.
 */

export interface ToolkitClient {
  toolkits: { get(slug: string): Promise<{ version?: string; latestVersion?: string }> };
}

export class VersionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionResolutionError';
  }
}

export function installedComposioCoreVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@composio/core/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface ResolveInput {
  requested: string;
  apiKeyPresent: boolean;
  client?: ToolkitClient | null;
  now?: () => Date;
  coreVersion?: string;
}

/**
 * Resolve the toolkit version that this run will record.
 *
 * - A concrete request passes through untouched; the operator has already been explicit.
 * - `latest` with no API key records `mock`, because the live path is not available anyway and
 *   pretending otherwise would put a fictional version in the lineage.
 * - `latest` with an API key must resolve. A failure here is hard: recording an unreproducible
 *   value is worse than stopping.
 */
export async function resolveToolkitVersion(input: ResolveInput): Promise<ResolvedVersions> {
  const now = input.now ?? (() => new Date());
  const coreVersion = input.coreVersion ?? installedComposioCoreVersion();
  const requested = input.requested.trim();

  if (requested.length > 0 && requested !== 'latest') {
    return {
      composioGmailToolkit: requested,
      resolvedFrom: 'COMPOSIO_GMAIL_TOOLKIT_VERSION',
      resolvedAt: now().toISOString(),
      composioCoreVersion: coreVersion,
    };
  }

  if (!input.apiKeyPresent) {
    return {
      composioGmailToolkit: 'mock',
      resolvedFrom: 'no-composio-key',
      resolvedAt: now().toISOString(),
      composioCoreVersion: coreVersion,
    };
  }

  if (input.client === undefined || input.client === null) {
    throw new VersionResolutionError(
      'COMPOSIO_GMAIL_TOOLKIT_VERSION is "latest" and COMPOSIO_API_KEY is present, but no Composio client could be constructed to resolve it',
    );
  }

  let resolved: string | undefined;
  try {
    const toolkit = await input.client.toolkits.get('gmail');
    resolved = toolkit.version ?? toolkit.latestVersion;
  } catch (error) {
    throw new VersionResolutionError(
      `failed to resolve the Gmail toolkit version from Composio: ${(error as Error).message}`,
    );
  }
  if (resolved === undefined || resolved.trim().length === 0 || resolved.trim() === 'latest') {
    throw new VersionResolutionError(
      'Composio did not return a concrete Gmail toolkit version; refusing to record "latest"',
    );
  }

  return {
    composioGmailToolkit: resolved.trim(),
    resolvedFrom: 'composio.toolkits.get(gmail)',
    resolvedAt: now().toISOString(),
    composioCoreVersion: coreVersion,
  };
}

async function composioClient(): Promise<ToolkitClient | null> {
  const apiKey = process.env['COMPOSIO_API_KEY'];
  if (apiKey === undefined || apiKey.trim().length === 0) return null;
  try {
    const mod = (await import('@composio/core')) as unknown as {
      Composio: new (options: { apiKey: string }) => ToolkitClient;
    };
    return new mod.Composio({ apiKey });
  } catch {
    return null;
  }
}

/** Resolve from the real environment and persist the answer for the rest of the cold start. */
export async function resolveAndWrite(): Promise<ResolvedVersions> {
  loadOpsEnv();
  const apiKey = process.env['COMPOSIO_API_KEY'];
  const apiKeyPresent = typeof apiKey === 'string' && apiKey.trim().length > 0;
  const resolved = await resolveToolkitVersion({
    requested: process.env['COMPOSIO_GMAIL_TOOLKIT_VERSION'] ?? 'latest',
    apiKeyPresent,
    client: apiKeyPresent ? await composioClient() : null,
  });
  writeResolvedVersions(resolved);
  return resolved;
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const resolved = await resolveAndWrite();
  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
}
