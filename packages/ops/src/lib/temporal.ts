import { workerEnv } from '@meridian/core';
import { Client, Connection } from '@temporalio/client';

let cached: Client | null = null;

export async function opsTemporalClient(): Promise<Client> {
  if (cached !== null) return cached;
  const env = workerEnv();
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  cached = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  return cached;
}

export async function closeOpsTemporalClient(): Promise<void> {
  if (cached === null) return;
  const client = cached;
  cached = null;
  await client.connection.close();
}
