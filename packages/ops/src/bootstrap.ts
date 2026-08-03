import { runInherit } from './lib/proc.js';
import { repoPath } from './lib/state.js';
import { main as preflightMain } from './preflight.js';

/**
 * The one command a new checkout needs.
 *
 * It is deliberately a sequence of the commands documented in the README rather than a clever
 * orchestrator: if it breaks, the operator can run the same four steps by hand and see exactly
 * which one failed.
 */

interface Step {
  name: string;
  run: () => Promise<number>;
}

const STEPS: Step[] = [
  {
    name: 'preflight',
    run: async () => {
      await preflightMain();
      return process.exitCode === 1 ? 1 : 0;
    },
  },
  {
    name: 'install dependencies',
    run: () => runInherit('pnpm', ['install', '--frozen-lockfile'], { cwd: repoPath() }),
  },
  {
    name: 'install playwright chromium',
    run: () =>
      runInherit(
        'pnpm',
        ['--filter', '@meridian/web', 'exec', 'playwright', 'install', 'chromium'],
        {
          cwd: repoPath(),
        },
      ),
  },
  { name: 'build', run: () => runInherit('pnpm', ['build'], { cwd: repoPath() }) },
];

export async function main(_argv: readonly string[] = []): Promise<void> {
  for (const step of STEPS) {
    process.stdout.write(`\n=== ${step.name} ===\n`);
    process.exitCode = 0;
    const code = await step.run();
    if (code !== 0) {
      process.stderr.write(`\nbootstrap stopped at "${step.name}" (exit ${code})\n`);
      process.exitCode = code;
      return;
    }
  }
  process.exitCode = 0;
  process.stdout.write(
    '\nbootstrap complete. Next: pnpm dev:infra, pnpm db:reset, pnpm seed, then pnpm dev in its own terminal.\n',
  );
}
