import { defineConfig } from 'vitest/config';

/**
 * Six isolated projects. `db` runs serially because every case in it shares one local Postgres
 * instance and several of them deliberately provoke row-level lock contention.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          // The jsonb round-trip lives outside `db/` because it is a hashing test, but it needs a
          // real PostgreSQL to be worth anything: the claim it makes is about what the database
          // does to a value, and a simulation of that would only test the simulation.
          exclude: [
            'packages/core/test/db/**',
            'packages/core/test/hashing.jsonb-roundtrip.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'db',
          include: [
            'packages/core/test/db/**/*.test.ts',
            'packages/core/test/hashing.jsonb-roundtrip.test.ts',
          ],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // `fileParallelism: false` with a single worker, rather than
          // `poolOptions.threads.singleThread`: pool options are a root-level setting in Vitest 4
          // and are rejected inside an inline project. The guarantee wanted here is the same one —
          // no two files in this project run at once.
          pool: 'threads',
          maxWorkers: 1,
        },
      },
      './apps/web/vitest.service.config.ts',
      './apps/web/vitest.component.config.ts',
      './apps/backend/vitest.temporal.config.ts',
    ],
  },
});
