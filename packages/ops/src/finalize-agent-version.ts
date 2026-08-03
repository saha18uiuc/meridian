import { readFileSync } from 'node:fs';
import { deriveSpecHash } from '@meridian/core';
import { BuildManifestSchema, type BuildManifest, type SpecJson } from '@meridian/core/schemas';
import { loadOpsEnv } from './env.js';
import { generateRegistry } from './generate-registry.js';
import { parseArgs, requireArg } from './lib/args.js';
import {
  add,
  assertSha1Repository,
  commit,
  headSha,
  showFile,
  stagedPaths,
  treePaths,
  unrelatedDirtyPaths,
} from './lib/git.js';
import { runAsync } from './lib/proc.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';

/**
 * Record a Git commit against an agent version, after proving the commit actually contains what it
 * claims to.
 *
 * The whole reason `agent_versions.git_commit_sha` exists is to make an execution auditable: given
 * a run, you can read the exact code that produced it. That promise is only worth something if the
 * SHA was verified against the **object database** rather than the working tree — a worktree can
 * be edited a second after the commit, and a verification that reads it would happily bless the
 * edit. So every content assertion below goes through `git ls-tree` and `git show`.
 */

export const GENERATED_FILES = [
  'agent.ts',
  'rules.ts',
  'prompts.ts',
  'manifest.json',
  'spec.snapshot.json',
] as const;

export const REGISTRY_PATH = 'generated-agents/index.ts';

export interface CommitVerification {
  sha: string;
  treePaths: string[];
  manifestOk: boolean;
  snapshotHashOk: boolean;
}

export class FinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizeError';
  }
}

interface VersionRow {
  agent_version_id: string;
  code_path: string;
  status: string;
  spec_id: string;
  whiteboard_id: string;
  spec_hash: string;
  owner_id: string;
}

/**
 * Three reads rather than one embedded read.
 *
 * `agent_versions` reaches both `frozen_specs` and `whiteboards` through *composite* foreign keys —
 * the lineage keys that bind an agent, its spec, and its board to the same whiteboard — and
 * PostgREST cannot choose an embedding for those without a hint that breaks the moment a constraint
 * is renamed. Following the two identifiers by hand says the same thing in terms the schema cache
 * cannot misread.
 */
async function loadVersion(agentVersionId: string): Promise<VersionRow> {
  const client = opsClient();
  const { data: row, error } = await client
    .from('agent_versions')
    .select('agent_version_id, code_path, status, spec_id, whiteboard_id')
    .eq('agent_version_id', agentVersionId)
    .maybeSingle();
  if (error !== null) throw new FinalizeError(error.message);
  if (row === null) throw new FinalizeError(`no agent version ${agentVersionId}`);

  const spec = await client
    .from('frozen_specs')
    .select('spec_hash')
    .eq('spec_id', row.spec_id)
    .maybeSingle();
  if (spec.error !== null) throw new FinalizeError(spec.error.message);

  const board = await client
    .from('whiteboards')
    .select('owner_id')
    .eq('whiteboard_id', row.whiteboard_id)
    .maybeSingle();
  if (board.error !== null) throw new FinalizeError(board.error.message);

  if (spec.data === null || board.data === null) {
    throw new FinalizeError(`agent version ${agentVersionId} has an incomplete lineage`);
  }
  return {
    agent_version_id: row.agent_version_id,
    code_path: row.code_path,
    status: row.status,
    spec_id: row.spec_id,
    whiteboard_id: row.whiteboard_id,
    spec_hash: spec.data.spec_hash,
    owner_id: board.data.owner_id,
  };
}

export function parseManifest(text: string, source: string): BuildManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FinalizeError(`${source} is not valid JSON`);
  }
  // Validated against the shared schema rather than a local shape check, so the manifest the
  // database stores and the manifest the eval harness reads can never mean different things.
  const manifest = BuildManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    const detail = manifest.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new FinalizeError(`${source} is not a valid build manifest: ${detail}`);
  }
  return manifest.data;
}

/**
 * Re-run the validation commands the manifest claims passed.
 *
 * A manifest that says `lint: pass` is an assertion by the thing being audited. Running the gates
 * again here is what turns it into a fact.
 */
async function rerunValidation(commands: readonly string[]): Promise<void> {
  for (const command of commands) {
    const [bin, ...args] = command.split(/\s+/);
    if (bin === undefined) continue;
    const result = await runAsync(bin, args, { cwd: repoPath() });
    if (result.code !== 0) {
      throw new FinalizeError(
        `recorded validation command "${command}" failed at the committed tree:\n${result.stderr.trim().slice(0, 2000)}`,
      );
    }
  }
}

export interface FinalizeResult {
  agentVersionId: string;
  gitCommitSha: string;
  specHash: string;
  verified: true;
}

export async function finalizeAgentVersion(agentVersionId: string): Promise<FinalizeResult> {
  assertSha1Repository();

  const version = await loadVersion(agentVersionId);
  if (version.status !== 'generated') {
    throw new FinalizeError(
      `agent version ${agentVersionId} is ${version.status}; only a generated version may record a commit`,
    );
  }

  const versionPaths = GENERATED_FILES.map((file) => `${version.code_path}/${file}`);
  const allowList = [...versionPaths, REGISTRY_PATH];

  const dirty = unrelatedDirtyPaths(allowList);
  if (dirty.length > 0) {
    throw new FinalizeError(
      `the working tree has unrelated changes; commit or stash them first:\n  ${dirty.join('\n  ')}`,
    );
  }

  generateRegistry();

  add(allowList);
  const staged = stagedPaths();
  const forbidden = staged.filter((path) => !allowList.includes(path));
  if (forbidden.length > 0) {
    throw new FinalizeError(
      `refusing to commit paths outside the generated-agent allow-list:\n  ${forbidden.join('\n  ')}`,
    );
  }

  const worktreeManifest = parseManifest(
    readFileSync(repoPath(version.code_path, 'manifest.json'), 'utf8'),
    'the worktree manifest',
  );
  if (worktreeManifest.specHash !== version.spec_hash) {
    throw new FinalizeError(
      `manifest specHash ${worktreeManifest.specHash} does not match the frozen spec ${version.spec_hash}`,
    );
  }

  // An empty stage means the generated files are already in HEAD exactly as they stand — the code
  // was committed before the version was reserved, which is what happens when a release is built
  // from a checked-in agent rather than from a fresh generation run. Naming HEAD is then the honest
  // answer; forcing an empty commit would invent a commit that changed nothing, and failing would
  // refuse a lineage that is already sound. Either way the verification below still reads the
  // commit object, so the SHA is only recorded if it genuinely contains the right bytes.
  const sha =
    staged.length === 0
      ? headSha()
      : commit(
          `feat(agent): generate ${version.code_path} from spec ${version.spec_hash.slice(0, 12)}`,
        );

  const paths = treePaths(sha);
  const missing = versionPaths.filter((path) => !paths.includes(path));
  if (missing.length > 0) {
    throw new FinalizeError(`commit ${sha} is missing:\n  ${missing.join('\n  ')}`);
  }

  const committedManifest = parseManifest(
    showFile(sha, `${version.code_path}/manifest.json`),
    `the manifest committed at ${sha}`,
  );
  const committedSnapshotText = showFile(sha, `${version.code_path}/spec.snapshot.json`);
  const committedSnapshot = JSON.parse(committedSnapshotText) as SpecJson;
  // `deriveSpecHash`, not a hash of the whole document: `spec_hash` is taken over the semantic view,
  // which holds out the spec ID, the version counter, the freeze timestamp, the review sessions, and
  // the acknowledgement flags. Hashing the file wholesale here would compare the snapshot against a
  // number nothing in the system produces, and no honest snapshot could ever pass.
  const snapshotHash = deriveSpecHash(committedSnapshot);

  if (snapshotHash !== version.spec_hash) {
    throw new FinalizeError(
      `the committed spec.snapshot.json hashes to ${snapshotHash}, not the frozen ${version.spec_hash}`,
    );
  }
  if (committedManifest.specHash !== version.spec_hash) {
    throw new FinalizeError(
      `the committed manifest names specHash ${committedManifest.specHash}, not ${version.spec_hash}`,
    );
  }

  for (const file of committedManifest.generatedFiles) {
    const path = `${version.code_path}/${file}`;
    if (!paths.includes(path)) {
      throw new FinalizeError(`the manifest lists ${file}, which is not in the commit tree`);
    }
    const committed = showFile(sha, path);
    const worktree = readFileSync(repoPath(path), 'utf8');
    if (committed !== worktree) {
      throw new FinalizeError(`${path} differs between the commit and the working tree`);
    }
  }

  await rerunValidation(committedManifest.validation.commands);

  const client = opsClient();
  const { error } = await client.rpc('record_agent_commit', {
    p_actor_user_id: version.owner_id,
    p_agent_version_id: agentVersionId,
    p_git_commit_sha: sha,
    p_build_manifest: committedManifest as never,
  });
  if (error !== null) throw new FinalizeError(`record_agent_commit failed: ${error.message}`);

  return { agentVersionId, gitCommitSha: sha, specHash: version.spec_hash, verified: true };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  try {
    const result = await finalizeAgentVersion(requireArg(args, 'agent-version'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
