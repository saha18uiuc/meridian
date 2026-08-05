import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadOpsEnv } from './env.js';
import { optionalArg, parseArgs, requireArg } from './lib/args.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';
import { GENERATED_FILES } from './finalize-agent-version.js';
import { reserveAgentVersion, ReservationError } from './reserve-agent-version.js';

/**
 * Reserve the next version as a repair of an existing one.
 *
 * The parent folder is read and never written. That is the property the whole repair design rests
 * on: an evaluated version has a recorded commit and recorded eval results, and editing it in place
 * would silently invalidate both. Copying the five allowed files into a fresh folder means the
 * parent stays byte-identical and a `git diff` after a repair shows only the new directory.
 */

export const EXIT_REFUSED = 4;

export interface RepairReservation {
  parentAgentVersionId: string;
  agentVersionId: string;
  versionNo: number;
  codePath: string;
  specHash: string;
  copiedFiles: string[];
  operatorCommand: string;
}

/**
 * Give the copies their own identity.
 *
 * A verbatim copy inherits the parent's: `agent.ts` states `versionNo` as a literal and
 * `manifest.json` names the folder it was generated into. Left alone, the new version calls itself
 * v001 — `defineAgent` derives the agent id from that number — so it runs under the parent's
 * lineage and stamps the parent's version onto its evidence, while the registry lists it under the
 * real one. Nothing fails; the two just disagree, which is the worst way for this to be wrong.
 *
 * Done here rather than left to the repairing agent because it is mechanical, and an instruction to
 * remember it is an instruction that will eventually be forgotten.
 */
function retargetCopies(codePath: string, versionNo: number): void {
  const agentPath = repoPath(codePath, 'agent.ts');
  if (existsSync(agentPath)) {
    const source = readFileSync(agentPath, 'utf8');
    const rewritten = source.replace(/^(\s*versionNo:\s*)\d+/m, `$1${String(versionNo)}`);
    if (rewritten === source) {
      throw new ReservationError(
        `could not find a versionNo declaration to update in ${codePath}/agent.ts`,
        EXIT_REFUSED,
      );
    }
    writeFileSync(agentPath, rewritten);
  }

  const manifestPath = repoPath(codePath, 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.versionNo = versionNo;
    manifest.codePath = codePath;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export async function reserveRepairVersion(options: {
  parentAgentVersionId: string;
  specId?: string | undefined;
}): Promise<RepairReservation> {
  const client = opsClient();
  const { data, error } = await client
    .from('agent_versions')
    .select('agent_version_id, agent_id, spec_id, code_path, status')
    .eq('agent_version_id', options.parentAgentVersionId)
    .maybeSingle();
  if (error !== null) throw new ReservationError(error.message, EXIT_REFUSED);
  if (data === null) {
    throw new ReservationError(`no agent version ${options.parentAgentVersionId}`, EXIT_REFUSED);
  }
  const parent = data;

  const reservation = await reserveAgentVersion({
    agentId: parent.agent_id,
    // A repair answers the same frozen specification. Repairing against a different spec would be
    // a new version of a different process wearing a repair's name.
    specId: options.specId ?? parent.spec_id,
    parentAgentVersionId: parent.agent_version_id,
  });

  mkdirSync(repoPath(reservation.codePath), { recursive: true });
  const copied: string[] = [];
  for (const file of GENERATED_FILES) {
    const source = repoPath(parent.code_path, file);
    if (!existsSync(source)) continue;
    copyFileSync(source, repoPath(reservation.codePath, file));
    copied.push(file);
  }
  retargetCopies(reservation.codePath, reservation.versionNo);

  return {
    parentAgentVersionId: parent.agent_version_id,
    agentVersionId: reservation.agentVersionId,
    versionNo: reservation.versionNo,
    codePath: reservation.codePath,
    specHash: reservation.specHash,
    copiedFiles: copied,
    operatorCommand: [
      '/goal Use the eval-repair skill.',
      `Edit only the files inside ${reservation.codePath}.`,
      `The parent ${parent.code_path} is read-only and must be byte-identical afterwards.`,
      'Then run: bash .codex/skills/eval-repair/scripts/run-suite.sh',
    ].join(' '),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  try {
    const result = await reserveRepairVersion({
      parentAgentVersionId: requireArg(args, 'parent'),
      specId: optionalArg(args, 'spec'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = error instanceof ReservationError ? error.exitCode : 1;
  }
}
