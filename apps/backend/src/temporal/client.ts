import { Client, Connection } from '@temporalio/client';

let cached: Promise<Client> | null = null;

/**
 * One connection per process. Temporal's client multiplexes over a single gRPC channel, so opening
 * a second one per request would cost handshakes without buying any concurrency.
 */
export async function getTemporalClient(options?: {
  address?: string;
  namespace?: string;
}): Promise<Client> {
  const address = options?.address ?? process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const namespace = options?.namespace ?? process.env.TEMPORAL_NAMESPACE ?? 'default';
  cached ??= (async () => {
    const connection = await Connection.connect({ address });
    return new Client({ connection, namespace });
  })();
  return cached;
}

export async function closeTemporalClient(): Promise<void> {
  if (cached === null) return;
  const client = await cached;
  cached = null;
  await client.connection.close();
}

/** Test-only: drop the memoized client so a test can point at a different server. */
export function resetTemporalClientForTests(): void {
  cached = null;
}
