import { mkdirSync } from 'node:fs';
import { loadOpsEnv } from './env.js';
import { optionalArg, parseArgs, requireArg } from './lib/args.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';

/**
 * Reserve the next version of an agent and print the command the operator should run next.
 *
 * The reservation happens *before* any code is written, which is what makes generation
 * operator-invoked rather than something an HTTP route pretends to do. The row exists in
 * `generated` with a null Git SHA; until a real commit is recorded against it, it cannot execute
 * anything. An abandoned reservation is therefore inert rather than dangerous.
 */

export const EXIT_NOT_FOUND = 2;
export const EXIT_REFUSED = 4;

export interface ReservationResult {
  agentId: string;
  agentVersionId: string;
  versionNo: number;
  codePath: string;
  specId: string;
  specHash: string;
  operatorCommand: string;
}

export class ReservationError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'ReservationError';
    this.exitCode = exitCode;
  }
}

async function resolveAgentId(options: {
  agentId?: string | undefined;
  deploymentKey?: string | undefined;
}): Promise<{ agentId: string; whiteboardId: string; deploymentKey: string }> {
  const client = opsClient();
  const query = client.from('agents').select('agent_id, whiteboard_id, deployment_key, status');
  const { data, error } =
    options.agentId !== undefined
      ? await query.eq('agent_id', options.agentId).maybeSingle()
      : await query.eq('deployment_key', options.deploymentKey ?? '').maybeSingle();

  if (error !== null) throw new ReservationError(error.message, EXIT_NOT_FOUND);
  if (data === null) {
    throw new ReservationError(
      `no agent matched ${options.agentId ?? options.deploymentKey ?? '<nothing>'}`,
      EXIT_NOT_FOUND,
    );
  }
  if (data.status === 'archived') {
    throw new ReservationError(`agent ${data.deployment_key} is archived`, EXIT_REFUSED);
  }
  return {
    agentId: data.agent_id,
    whiteboardId: data.whiteboard_id,
    deploymentKey: data.deployment_key,
  };
}

async function resolveSpecId(whiteboardId: string, specId?: string): Promise<string> {
  if (specId !== undefined) return specId;
  const client = opsClient();
  const { data, error } = await client
    .from('frozen_specs')
    .select('spec_id, spec_version')
    .eq('whiteboard_id', whiteboardId)
    .order('spec_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error !== null) throw new ReservationError(error.message, EXIT_NOT_FOUND);
  if (data === null) {
    throw new ReservationError(`whiteboard ${whiteboardId} has no frozen spec yet`, EXIT_REFUSED);
  }
  return data.spec_id;
}

export function operatorCommandFor(codePath: string, specId: string): string {
  // The skill reads the spec through the export script, never from the database, so the command
  // hands it the two things it is allowed to know: where to write and which spec to read.
  return [
    '/goal Use the spec-to-agent skill.',
    `Export the frozen specification with: pnpm agent:export-spec --spec ${specId} --out /tmp/spec.json`,
    `Write only agent.ts, rules.ts, prompts.ts, manifest.json and spec.snapshot.json inside ${codePath}.`,
    'Then run: bash .codex/skills/spec-to-agent/scripts/verify.sh',
  ].join(' ');
}

export async function reserveAgentVersion(options: {
  agentId?: string | undefined;
  deploymentKey?: string | undefined;
  specId?: string | undefined;
  parentAgentVersionId?: string | undefined;
}): Promise<ReservationResult> {
  const agent = await resolveAgentId(options);
  const specId = await resolveSpecId(agent.whiteboardId, options.specId);

  const client = opsClient();
  const { data, error } = await client.rpc('create_agent_version', {
    p_agent_id: agent.agentId,
    p_spec_id: specId,
    // Supabase's generator emits every `uuid` argument as non-nullable even when the function
    // accepts null, so the repair case is widened here rather than by relaxing the SQL signature.
    p_parent_agent_version_id: options.parentAgentVersionId ?? (null as unknown as string),
  });
  if (error !== null) {
    const refused = /ARCHIVED|NOT_ON_AGENT_WHITEBOARD/.test(error.message);
    throw new ReservationError(error.message, refused ? EXIT_REFUSED : EXIT_NOT_FOUND);
  }

  const result = data as unknown as {
    agentVersionId: string;
    versionNo: number;
    codePath: string;
    specHash: string;
  };

  mkdirSync(repoPath(result.codePath), { recursive: true });

  return {
    agentId: agent.agentId,
    agentVersionId: result.agentVersionId,
    versionNo: result.versionNo,
    codePath: result.codePath,
    specId,
    specHash: result.specHash,
    operatorCommand: operatorCommandFor(result.codePath, specId),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  try {
    const agentId = optionalArg(args, 'agent');
    const deploymentKey = optionalArg(args, 'deployment');
    if (agentId === undefined && deploymentKey === undefined) {
      requireArg(args, 'deployment');
    }
    const result = await reserveAgentVersion({
      agentId,
      deploymentKey,
      specId: optionalArg(args, 'spec'),
      parentAgentVersionId: optionalArg(args, 'parent'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = error instanceof ReservationError ? error.exitCode : 1;
  }
}
