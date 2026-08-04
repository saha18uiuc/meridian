import { temporalTarget } from '@meridian/core';
import { Client, Connection } from '@temporalio/client';

let cached: Client | null = null;

export async function opsTemporalClient(): Promise<Client> {
  if (cached !== null) return cached;
  const target = temporalTarget();
  const connection = await Connection.connect(target.connection);
  cached = new Client({ connection, namespace: target.namespace });
  return cached;
}

export async function closeOpsTemporalClient(): Promise<void> {
  if (cached === null) return;
  const client = cached;
  cached = null;
  await client.connection.close();
}
