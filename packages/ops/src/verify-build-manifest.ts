import { deriveSpecHash } from '@meridian/core';
import type { BuildManifest, SpecJson } from '@meridian/core/schemas';
import { loadOpsEnv } from './env.js';
import { parseManifest } from './finalize-agent-version.js';
import { parseArgs, requireArg } from './lib/args.js';
import { showFile, treePaths } from './lib/git.js';
import { opsClient } from './lib/supabase.js';

/**
 * Re-verify a recorded commit long after the fact, reading only the object database.
 *
 * `finalize-agent-version` verifies once, at the moment of recording. This does it again on
 * demand, which is what makes the claim durable: an auditor can run it against a version recorded
 * weeks ago and get an answer that does not depend on the current working tree existing, being
 * clean, or being on the same branch.
 */

export interface ManifestVerification {
  agentVersionId: string;
  gitCommitSha: string;
  specHash: string;
  codePath: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  ok: boolean;
}

export interface VerificationSources {
  treePaths: (sha: string) => string[];
  showFile: (sha: string, path: string) => string;
}

const REAL_SOURCES: VerificationSources = { treePaths, showFile };

export function verifyCommitContents(
  input: {
    agentVersionId: string;
    gitCommitSha: string;
    codePath: string;
    specHash: string;
    specJson: unknown;
  },
  sources: VerificationSources = REAL_SOURCES,
): ManifestVerification {
  const checks: ManifestVerification['checks'] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  let paths: string[] = [];
  try {
    paths = sources.treePaths(input.gitCommitSha);
    record('commit resolves', true, `${paths.length} paths in tree`);
  } catch (error) {
    record('commit resolves', false, (error as Error).message);
    return { ...input, checks, ok: false };
  }

  let manifest: BuildManifest | null = null;
  try {
    manifest = parseManifest(
      sources.showFile(input.gitCommitSha, `${input.codePath}/manifest.json`),
      'the committed manifest',
    );
    record('manifest parses', true, `${manifest.generatedFiles.length} generated file(s)`);
  } catch (error) {
    record('manifest parses', false, (error as Error).message);
  }

  if (manifest !== null) {
    const missing = manifest.generatedFiles.filter(
      (file) => !paths.includes(`${input.codePath}/${file}`),
    );
    record(
      'manifest files present in tree',
      missing.length === 0,
      missing.length === 0 ? 'all present' : `missing ${missing.join(', ')}`,
    );
    record(
      'manifest specHash matches the frozen spec',
      manifest.specHash === input.specHash,
      `${manifest.specHash} vs ${input.specHash}`,
    );
    record(
      'manifest codePath matches the recorded one',
      manifest.codePath === input.codePath,
      `${manifest.codePath} vs ${input.codePath}`,
    );
    // The commands are re-run by `finalize-agent-version` at record time. Here, long after the
    // fact, only their presence can be checked without rebuilding the world at that commit.
    record(
      'manifest names its validation commands',
      manifest.validation.commands.length > 0,
      manifest.validation.commands.join(', '),
    );
    const unresolved = Object.entries(manifest.toolkitVersions).filter(
      ([, value]) => value.trim().toLowerCase() === 'latest',
    );
    record(
      'toolkit versions are concrete',
      unresolved.length === 0,
      unresolved.length === 0
        ? JSON.stringify(manifest.toolkitVersions)
        : `unresolved: ${unresolved.map(([name]) => name).join(', ')}`,
    );
  }

  try {
    const snapshot = JSON.parse(
      sources.showFile(input.gitCommitSha, `${input.codePath}/spec.snapshot.json`),
    ) as SpecJson;
    // Both sides go through the semantic view, because that is what `spec_hash` is taken over: the
    // committed file and the `jsonb` value agree on the contract even though neither is byte-stable.
    const hash = deriveSpecHash(snapshot);
    record('committed snapshot hashes to the frozen spec', hash === input.specHash, hash);
    record(
      'committed snapshot equals the database spec',
      deriveSpecHash(input.specJson as SpecJson) === hash,
      'canonical comparison',
    );
  } catch (error) {
    record('committed snapshot readable', false, (error as Error).message);
  }

  return { ...input, checks, ok: checks.every((check) => check.ok) };
}

export async function verifyBuildManifest(agentVersionId: string): Promise<ManifestVerification> {
  const client = opsClient();
  const { data, error } = await client
    .from('agent_versions')
    .select('agent_version_id, git_commit_sha, code_path, frozen_specs(spec_hash, spec_json)')
    .eq('agent_version_id', agentVersionId)
    .maybeSingle();
  if (error !== null) throw new Error(error.message);
  if (data === null) throw new Error(`no agent version ${agentVersionId}`);

  const row = data as unknown as {
    agent_version_id: string;
    git_commit_sha: string | null;
    code_path: string;
    frozen_specs: { spec_hash: string; spec_json: unknown } | null;
  };
  if (row.git_commit_sha === null) {
    throw new Error(`agent version ${agentVersionId} has no recorded commit yet`);
  }
  if (row.frozen_specs === null) {
    throw new Error(`agent version ${agentVersionId} has no frozen spec`);
  }

  return verifyCommitContents({
    agentVersionId: row.agent_version_id,
    gitCommitSha: row.git_commit_sha,
    codePath: row.code_path,
    specHash: row.frozen_specs.spec_hash,
    specJson: row.frozen_specs.spec_json,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadOpsEnv();
  const args = parseArgs(argv);
  try {
    const result = await verifyBuildManifest(requireArg(args, 'agent-version'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
