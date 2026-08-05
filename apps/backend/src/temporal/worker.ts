import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLogger, forgetEmptyEnvVars, temporalTarget, workerEnv } from '@meridian/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { activities } from './activities/index.js';
import { startHealthServer } from './health-server.js';
import { startKeepAlive } from './keep-alive.js';
import { TASK_QUEUE } from './task-queue.js';

const logger = createLogger('worker');

/**
 * The worker reads `.env` itself rather than relying on whoever launched it.
 *
 * It is started three ways — `pnpm dev`, `pnpm demo`, and by hand — and only the first of those
 * runs through a process manager that could export the file for it. A worker that starts without
 * `SUPABASE_SERVICE_ROLE_KEY` does not fail loudly at the point of the mistake: it answers
 * `/healthz`, accepts workflow tasks, and leaves every execution sitting in `running`. Loading the
 * file here is what makes the three launch paths identical. Real environment variables still win,
 * because `process.loadEnvFile` does not overwrite what is already set — but an empty one is not a
 * value, and leaving it would reproduce the exact silent failure this function exists to prevent.
 */
function loadDotEnvFile(): void {
  forgetEmptyEnvVars();
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * The workflow bundle entry has a different extension depending on how the worker was launched.
 *
 * `pnpm start` runs the compiled tree, where the sibling is `index.js`; `pnpm dev` runs the source
 * through tsx, where only `index.ts` exists and a hardcoded `.js` resolves to nothing. Temporal's
 * bundler accepts either, so the question is settled by looking for the file rather than by
 * assuming which launch path is in use.
 */
function workflowsEntryPoint(): string {
  const candidates = ['./workflows/index.js', './workflows/index.ts'].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `no workflow entry point beside the worker; looked for ${candidates.join(', ')}`,
    );
  }
  return found;
}

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = workerEnv();
  const target = temporalTarget();
  const connection = await NativeConnection.connect(target.connection);

  const worker = await Worker.create({
    connection,
    namespace: target.namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: workflowsEntryPoint(),
    activities,
    // `zod` is pulled in through the agent definitions and must run as real code inside the
    // sandbox rather than being stubbed out by the bundler's Node-module shims.
    bundlerOptions: { ignoreModules: ['@supabase/supabase-js', 'pino', 'playwright'] },
    maxConcurrentActivityTaskExecutions: env.WORKER_MAX_CONCURRENT_ACTIVITIES,
    maxConcurrentWorkflowTaskExecutions: env.WORKER_MAX_CONCURRENT_WORKFLOWS,
  });

  const health = startHealthServer(env.WORKER_HEALTH_PORT);
  const keepAlive =
    env.WORKER_KEEPALIVE_URL === undefined
      ? undefined
      : startKeepAlive(env.WORKER_KEEPALIVE_URL, env.WORKER_KEEPALIVE_INTERVAL_MS, logger);
  logger.info(
    {
      taskQueue: TASK_QUEUE,
      address: target.connection.address,
      namespace: target.namespace,
      // Which server the worker actually reached, so a move to Cloud is confirmable from the log
      // rather than inferred from the absence of errors.
      tls: target.connection.tls === true,
      healthPort: env.WORKER_HEALTH_PORT,
      keepAlive: keepAlive !== undefined,
    },
    'worker started',
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting the worker down');
    worker.shutdown();
    health.close();
    keepAlive?.close();
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
