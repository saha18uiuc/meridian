import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLogger, workerEnv } from '@meridian/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { activities } from './activities/index.js';
import { startHealthServer } from './health-server.js';
import { TASK_QUEUE } from './task-queue.js';

const logger = createLogger('worker');

async function main(): Promise<void> {
  const env = workerEnv();
  const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows/index.js', import.meta.url)),
    activities,
    // `zod` is pulled in through the agent definitions and must run as real code inside the
    // sandbox rather than being stubbed out by the bundler's Node-module shims.
    bundlerOptions: { ignoreModules: ['@supabase/supabase-js', 'pino', 'playwright'] },
    maxConcurrentActivityTaskExecutions: env.WORKER_MAX_CONCURRENT_ACTIVITIES,
    maxConcurrentWorkflowTaskExecutions: env.WORKER_MAX_CONCURRENT_WORKFLOWS,
  });

  const health = startHealthServer(env.WORKER_HEALTH_PORT);
  logger.info(
    { taskQueue: TASK_QUEUE, address: env.TEMPORAL_ADDRESS, healthPort: env.WORKER_HEALTH_PORT },
    'worker started',
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting the worker down');
    worker.shutdown();
    health.close();
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  await worker.run();
  await connection.close();
}

// Only run when executed directly, so tests can import the module without starting a worker.
const require = createRequire(import.meta.url);
if (
  process.argv[1] !== undefined &&
  require.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    logger.error({ error }, 'the worker exited with an error');
    process.exitCode = 1;
  });
}
