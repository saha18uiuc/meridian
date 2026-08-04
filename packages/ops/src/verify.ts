import { readFileSync } from 'node:fs';
import { sha256Hex } from '@meridian/core';
import { loadOpsEnv } from './env.js';
import { buildSnapshot, SNAPSHOT_TARGETS, type SnapshotTarget } from './fixtures/spec-snapshot.js';
import { formatGates, gates } from './gates.js';
import { flag, parseArgs } from './lib/args.js';
import { runAsync } from './lib/proc.js';
import { repoPath } from './lib/state.js';
import { formatTreeReport, verifyTree } from './verify-tree.js';

const SEED_BOARD_PATH = 'examples/inbound-import-receiving/board.seed.json';
const SNAPSHOT_CODE_PATH = 'generated-agents/inbound-import-receiving/v001';

/**
 * The four places that describe external delivery, plus the two documents a reader reaches for
 * first. Named explicitly rather than globbed: the point is that these files are the ones making a
 * promise to somebody, and a list is easier to argue with than a glob.
 */
const SCANNED_FOR_WORDING = [
  'apps/backend/src/temporal/activities/actions.ts',
  'packages/core/src/schemas/action.ts',
  'packages/agent-kit/src/recording/actions.ts',
  `${SNAPSHOT_CODE_PATH}/agent.ts`,
  'docs/ARCHITECTURE.md',
  'README.md',
];

/**
 * One command that proves the system.
 *
 * The audit greps below are not stylistic. Each one encodes an invariant that a type checker cannot
 * see and that a reviewer would have to remember: a detached promise in the review path, a bare
 * `workflow.start` in the intake path, the literal string `latest` in recorded metadata. They are
 * scoped to source directories so documentation prose describing the rule does not trip the rule.
 */

export interface VerifyStep {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
  required: boolean;
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
  required: boolean;
}

async function command(name: string, argv: string[]): Promise<{ ok: boolean; detail: string }> {
  const result = await runAsync(argv[0] as string, argv.slice(1), { cwd: repoPath() });
  if (result.unavailable) return { ok: false, detail: `${argv[0] ?? name} is not installed` };
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    ok: result.code === 0,
    detail: result.code === 0 ? 'ok' : output.split('\n').slice(-25).join('\n'),
  };
}

/**
 * A negative grep, expressed as a step.
 *
 * `rg --files-with-matches` is used rather than a match count because the useful message is *which
 * file* broke the rule, and because a zero-exit-on-no-match is exactly the semantics wanted here.
 */
export function forbid(options: {
  name: string;
  pattern: string;
  paths: string[];
  reason: string;
  globs?: string[];
  /** Paths the rule cannot apply to, chiefly this file, which must spell the patterns out. */
  exclude?: string[];
}): VerifyStep {
  return {
    name: options.name,
    required: true,
    run: async () => {
      // `--pcre2` unconditionally, because ripgrep's default engine rejects look-around outright
      // and a rule that fails to compile reads, in the summary, exactly like a rule that failed.
      const args = ['--pcre2', '--files-with-matches', '--no-heading', '-e', options.pattern];
      for (const glob of options.globs ?? ['*.ts', '*.tsx']) args.push('--glob', glob);
      for (const path of options.exclude ?? []) args.push('--glob', `!${path}`);
      args.push(...options.paths);
      const result = await runAsync('rg', args, { cwd: repoPath() });
      if (result.unavailable) return { ok: false, detail: 'ripgrep (rg) is not installed' };
      // ripgrep exits 1 when nothing matched, which is the passing case here.
      if (result.code === 1) return { ok: true, detail: 'no matches' };
      if (result.code !== 0) return { ok: false, detail: result.stderr.trim() };
      return {
        ok: false,
        detail: `${options.reason}\n${result.stdout.trim()}`,
      };
    },
  };
}

const SOURCE_PATHS = ['apps', 'packages', 'generated-agents'];

/**
 * This file has to contain the literal patterns it bans, so it excludes itself from the two audits
 * that would otherwise match their own definitions.
 */
const AUDIT_SELF = 'packages/ops/src/verify.ts';

export function auditSteps(): VerifyStep[] {
  return [
    forbid({
      name: 'audit: no unfinished work on the critical path',
      pattern: String.raw`\b(TODO|FIXME|XXX)\b|not implemented|unimplemented`,
      paths: [...SOURCE_PATHS, 'scripts'],
      reason: 'a marker left in shipped source means the path it sits on was never finished',
      exclude: [AUDIT_SELF],
    }),
    forbid({
      name: 'audit: no skipped or stubbed test',
      pattern: String.raw`(it|test|describe)\.(skip|todo)\(|\.skipIf\(`,
      paths: [...SOURCE_PATHS, 'scripts'],
      reason: 'a skipped test is a check that reports success without running',
      exclude: [AUDIT_SELF],
    }),
    forbid({
      name: 'audit: no secrets in shipped source',
      pattern: String.raw`(sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{30,}\.)`,
      paths: SOURCE_PATHS,
      reason: 'a value shaped like an API key or a JWT is committed in source',
    }),
    forbid({
      name: 'audit: no child_process in API routes',
      pattern: String.raw`from '(node:)?child_process'`,
      paths: ['apps/web/src/app/api'],
      reason: 'an HTTP route may not shell out; generation is operator-invoked',
    }),
    forbid({
      name: 'audit: no comment-body prefix parsing',
      pattern: String.raw`body_(md|text)?\s*\.\s*(startsWith|match)\(`,
      paths: SOURCE_PATHS,
      reason: 'comment meaning comes from metadata_json, never from a body-text prefix convention',
    }),
    {
      name: 'audit: no absolute exactly-once claim',
      required: true,
      run: () => Promise.resolve(checkExactlyOnceWording()),
    },
    forbid({
      name: 'audit: no detached promise in the review path',
      pattern: String.raw`^\s*void\s+\w+\(|\.then\(\s*\(\)\s*=>`,
      paths: ['apps/web/src/server/services', 'apps/web/src/app/api'],
      reason: 'the review round is fully awaited (A20); a detached promise loses the failure',
    }),
    forbid({
      name: 'audit: no bare workflow.start in the intake path',
      pattern: String.raw`workflow\.start\(`,
      paths: ['packages/ops/src/intake', 'apps/web/src/server/services'],
      reason:
        'intake correlates with signalWithStart (A24); start alone races a concurrent message',
    }),
    forbid({
      name: 'audit: no literal "latest" in recorded metadata',
      pattern: String.raw`"(toolkitVersions?|composioGmailToolkit)"\s*:\s*"latest"`,
      paths: ['generated-agents', 'packages/evals/src', 'packages/ops/src'],
      globs: ['*.ts', '*.json'],
      reason: 'a recorded "latest" makes the build metadata irreproducible (A29)',
    }),
  ];
}

/** Words that turn "exactly-once" from a description of a database fact into a delivery promise. */
const DELIVERY_SENSE = /\b(delivery|guarantee[ds]?|behaviour|behavior|semantics)\b/i;
/** Words that make such a promise honest: either the qualified form, or an explicit denial. */
const QUALIFIER = /best[- ]effort|\bnot\b|\bNOT\b|\bnever\b|\bno\b/;

/**
 * Every claim of exactly-once *delivery* has to be qualified.
 *
 * Written out rather than expressed as one grep because the distinction is contextual in two ways a
 * single pattern cannot capture. "Increments the revision exactly once per delta" is a database fact
 * the system does enforce and is none of this rule's business; "best-effort external exactly-once
 * behaviour, not an absolute exactly-once guarantee" is one sentence spanning two lines, so the
 * qualifier and the claim never share a line. A window of the surrounding lines is what reads it
 * the way a person would.
 */
export function checkExactlyOnceWording(): { ok: boolean; detail: string } {
  const offenders: string[] = [];
  for (const relative of SCANNED_FOR_WORDING) {
    const lines = readFileSync(repoPath(relative), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/exactly[- ]once/i.test(line) || !DELIVERY_SENSE.test(line)) return;
      const window = lines.slice(Math.max(0, index - 2), index + 3).join(' ');
      if (QUALIFIER.test(window)) return;
      offenders.push(`${relative}:${String(index + 1)}: ${line.trim()}`);
    });
  }
  return offenders.length === 0
    ? { ok: true, detail: 'every exactly-once claim is qualified' }
    : {
        ok: false,
        detail: [
          'Gmail accepts no idempotency token, so the honest claim is replay deduplication plus',
          'best-effort external exactly-once — never an absolute guarantee:',
          ...offenders,
        ].join('\n'),
      };
}

export function checkCommittedSnapshot(): { ok: boolean; detail: string } {
  const seed = JSON.parse(readFileSync(repoPath(SEED_BOARD_PATH), 'utf8')) as Parameters<
    typeof buildSnapshot
  >[0];
  const rebuilt = buildSnapshot(seed, SNAPSHOT_TARGETS[0] as SnapshotTarget);

  const snapshotPath = repoPath(SNAPSHOT_CODE_PATH, 'spec.snapshot.json');
  const committedSpec = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
  const manifest = JSON.parse(
    readFileSync(repoPath(SNAPSHOT_CODE_PATH, 'manifest.json'), 'utf8'),
  ) as { specHash: string };
  const agentSource = readFileSync(repoPath(SNAPSHOT_CODE_PATH, 'agent.ts'), 'utf8');

  // Both sides are re-canonicalized before comparing, per the snapshot-file contract: the committed
  // file is compared by hash, never by bytes, because `jsonb` round trips do not preserve bytes.
  const problems: string[] = [];
  if (sha256Hex(committedSpec) !== sha256Hex(rebuilt.specJson)) {
    problems.push('spec.snapshot.json does not re-canonicalize to the board it names');
  }
  if (manifest.specHash !== rebuilt.specHash) {
    problems.push(`manifest.specHash is ${manifest.specHash}, board yields ${rebuilt.specHash}`);
  }
  if (!agentSource.includes(`const SPEC_HASH = '${rebuilt.specHash}'`)) {
    problems.push('agent.ts pins a different spec hash than the board yields');
  }

  return problems.length === 0
    ? { ok: true, detail: `spec_hash ${rebuilt.specHash}` }
    : { ok: false, detail: `${problems.join('; ')} — re-run the fixture generators` };
}

export function verifySteps(): VerifyStep[] {
  return [
    { name: 'lint', required: true, run: () => command('lint', ['pnpm', 'lint']) },
    {
      name: 'format:check',
      required: true,
      run: () => command('format', ['pnpm', 'format:check']),
    },
    { name: 'typecheck', required: true, run: () => command('typecheck', ['pnpm', 'typecheck']) },
    { name: 'build:ts', required: true, run: () => command('build:ts', ['pnpm', 'build:ts']) },
    // `next build` is its own line because a broken server component must fail verification (A28).
    { name: 'build:web', required: true, run: () => command('build:web', ['pnpm', 'build:web']) },
    {
      name: 'tree',
      required: true,
      run: async () => {
        const report = verifyTree();
        return { ok: report.ok, detail: formatTreeReport(report) };
      },
    },
    {
      // The committed snapshot is what ties the generated agent to a contract. If the example board
      // moves and the snapshot does not, everything downstream still passes — the manifest parses,
      // the agent compiles, the tests are green — and the only thing that is wrong is the one claim
      // the artifact exists to make. Recomputing it from the board is the only way to notice.
      name: 'spec snapshot matches the example board',
      required: true,
      run: () => Promise.resolve(checkCommittedSnapshot()),
    },
    {
      // Reported, not enforced. Four claims need a credential this repository cannot contain, and
      // a green summary that stays silent about them invites the reader to assume the live paths
      // were exercised. The step passes when the report is produced; what it says is the point.
      name: 'external gates reported',
      required: true,
      run: () => {
        const all = gates();
        process.stdout.write(`${formatGates(all)}\n`);
        const notRun = all.filter((gate) => gate.state === 'not run');
        return Promise.resolve({
          ok: true,
          detail:
            notRun.length === 0
              ? 'all gates have prerequisites'
              : `not run: ${notRun.map((gate) => gate.id).join(', ')}`,
        });
      },
    },
    { name: 'test:unit', required: true, run: () => command('unit', ['pnpm', 'test:unit']) },
    { name: 'test:db', required: true, run: () => command('db', ['pnpm', 'test:db']) },
    {
      name: 'test:temporal',
      required: true,
      run: () => command('temporal', ['pnpm', 'test:temporal']),
    },
    ...auditSteps(),
  ];
}

export async function runSteps(steps: readonly VerifyStep[]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const startedAt = Date.now();
    process.stdout.write(`… ${step.name}\n`);
    const outcome = await step.run();
    results.push({
      name: step.name,
      ok: outcome.ok,
      detail: outcome.detail,
      durationMs: Date.now() - startedAt,
      required: step.required,
    });
    process.stdout.write(
      `${outcome.ok ? 'PASS' : 'FAIL'} ${step.name} (${String(Date.now() - startedAt)} ms)\n`,
    );
    if (!outcome.ok) process.stdout.write(`${outcome.detail}\n`);
  }
  return results;
}

export function formatSummary(results: readonly StepResult[]): string {
  const failed = results.filter((result) => !result.ok);
  const lines = [
    '',
    '───────────────────────────────────────────────',
    ...results.map(
      (result) =>
        `${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(44)} ${String(result.durationMs).padStart(7)} ms`,
    ),
    '───────────────────────────────────────────────',
    failed.length === 0
      ? `all ${String(results.length)} steps passed`
      : `${String(failed.length)} of ${String(results.length)} steps failed: ${failed.map((r) => r.name).join(', ')}`,
  ];
  return lines.join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  const steps = flag(args, 'audits-only') ? auditSteps() : verifySteps();
  const results = await runSteps(steps);
  process.stdout.write(`${formatSummary(results)}\n`);
  process.exitCode = results.some((result) => !result.ok && result.required) ? 1 : 0;
}
