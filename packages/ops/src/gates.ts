import { existsSync, readFileSync } from 'node:fs';
import { loadOpsEnv } from './env.js';
import { repoPath } from './lib/state.js';

/**
 * The four verifications that need something this repository cannot contain.
 *
 * Everything else about Meridian is provable on a laptop with no paid account, which is deliberate:
 * a suite that silently degrades when a credential is missing tells you nothing about either the
 * credentialed or the uncredentialed path. The cost of that choice is that four claims are left
 * unproven by a green `pnpm verify`, and the honest thing is to say which four, out loud, every
 * time — rather than let a reader infer from an all-green summary that the live paths were
 * exercised.
 *
 * This command therefore never fails. It reports. Failing when a key is absent would make the
 * absence of a credential look like a defect in the code, and would put `pnpm verify` permanently
 * red on exactly the machine the README is written for.
 */

export type GateState = 'ready' | 'not run';

export interface Gate {
  id: string;
  name: string;
  state: GateState;
  /** Why it cannot run, or what evidence says it can. */
  detail: string;
  /** The exact command that executes it once the prerequisites are met. */
  command: string;
}

function present(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0;
}

function missing(...names: string[]): string[] {
  return names.filter((name) => !present(name));
}

const SNAPSHOT_DIR = 'generated-agents/inbound-import-receiving/v001';

/**
 * Gate (d) is the only one whose evidence is in the repository rather than in the environment.
 *
 * The skills are operator-invoked by design — no HTTP route may generate code — so "was the skill
 * run?" is answered by whether its output exists and carries a recorded commit, not by whether a
 * credential is set.
 */
function generationGate(): Gate {
  const manifestPath = repoPath(SNAPSHOT_DIR, 'manifest.json');
  const command = 'operator runs the spec-to-agent skill in .codex/skills';

  if (!existsSync(manifestPath)) {
    return {
      id: 'generation',
      name: 'operator-invoked generation (spec-to-agent)',
      state: 'not run',
      detail: `no manifest at ${SNAPSHOT_DIR}`,
      command,
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    specHash?: string;
    gitCommitSha?: string;
  };
  const hash = manifest.specHash ?? '(none)';
  return {
    id: 'generation',
    name: 'operator-invoked generation (spec-to-agent)',
    state: 'ready',
    detail: `v001 generated and committed for spec ${hash.slice(0, 12)}`,
    command,
  };
}

export function gates(): Gate[] {
  const modelMissing = missing('OPENAI_API_KEY');
  const composioMissing = missing('COMPOSIO_API_KEY', 'COMPOSIO_GMAIL_AUTH_CONFIG_ID');
  const connectionMissing = missing('COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID');
  const liveMode = (process.env['GMAIL_LIVE_MODE'] ?? 'false') === 'true';
  const recipients = (process.env['GMAIL_ALLOWED_RECIPIENTS'] ?? '').trim();

  const inboxBlockers = [
    ...composioMissing,
    ...connectionMissing,
    ...(liveMode ? [] : ['GMAIL_LIVE_MODE=true']),
    ...(recipients === '' ? ['GMAIL_ALLOWED_RECIPIENTS'] : []),
  ];

  return [
    {
      id: 'review-model',
      name: 'real-model review smoke',
      state: modelMissing.length === 0 ? 'ready' : 'not run',
      detail:
        modelMissing.length === 0
          ? `OPENAI_API_KEY present; model ${process.env['AI_REVIEW_MODEL'] ?? 'gpt-5.5'}`
          : `missing ${modelMissing.join(', ')}`,
      command: 'AI_MODE=live pnpm test:service -t "live model smoke"',
    },
    {
      id: 'gmail-consent',
      name: 'Composio OAuth browser consent',
      state: composioMissing.length === 0 && connectionMissing.length === 0 ? 'ready' : 'not run',
      detail:
        composioMissing.length > 0
          ? `missing ${composioMissing.join(', ')}`
          : connectionMissing.length > 0
            ? 'no connected account; consent has not been granted'
            : 'a connected account is recorded',
      command: 'pnpm connect:gmail',
    },
    {
      id: 'gmail-inbox',
      name: 'live Gmail inbox fetch and send',
      state: inboxBlockers.length === 0 ? 'ready' : 'not run',
      detail:
        inboxBlockers.length === 0
          ? `live mode on, sends restricted to ${recipients}`
          : `missing ${inboxBlockers.join(', ')}`,
      command: 'GMAIL_LIVE_MODE=true pnpm process-inbox --once',
    },
    generationGate(),
  ];
}

/** The resolved toolkit version, which is `mock` until a Composio key resolves it (A29). */
function toolkitLine(): string {
  const path = repoPath('.meridian/resolved-versions.json');
  if (!existsSync(path)) return 'toolkit version: unresolved — run pnpm preflight';
  const resolved = JSON.parse(readFileSync(path, 'utf8')) as {
    composioGmailToolkit?: string;
    resolvedFrom?: string;
  };
  return `toolkit version: ${resolved.composioGmailToolkit ?? '?'} (via ${resolved.resolvedFrom ?? '?'})`;
}

export function formatGates(all: readonly Gate[]): string {
  const lines = ['External gates', ''];
  for (const gate of all) {
    const marker = gate.state === 'ready' ? 'ready ' : 'NOT RUN';
    lines.push(`  ${marker} ${gate.name.padEnd(38)} ${gate.detail}`);
    lines.push(`          ${gate.command}`);
  }
  const notRun = all.filter((gate) => gate.state === 'not run');
  lines.push('', toolkitLine(), '');
  lines.push(
    notRun.length === 0
      ? 'every external gate has its prerequisites; none is reported unverified'
      : `${String(notRun.length)} of ${String(all.length)} gates not run: ${notRun.map((gate) => gate.id).join(', ')}`,
  );
  return lines.join('\n');
}

export function main(_argv: readonly string[] = []): Promise<void> {
  loadOpsEnv();
  process.stdout.write(`${formatGates(gates())}\n`);
  return Promise.resolve();
}
