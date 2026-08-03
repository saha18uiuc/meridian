import { canonicalJson, deriveSpecHash } from '@meridian/core';
import type { SpecJson } from '@meridian/core/schemas';
import { describe, expect, it } from 'vitest';
import { GENERATED_FILES } from '../src/finalize-agent-version.js';
import { verifyCommitContents, type VerificationSources } from '../src/verify-build-manifest.js';

/**
 * Re-verifying a recorded commit long after it was recorded.
 *
 * The sources are injected, which is what lets these tests describe commits that would be awkward
 * to create for real: one whose manifest names a file that is not in the tree, one whose snapshot
 * has been altered, one whose commit does not resolve at all. Each of those is a way the audit
 * trail could be quietly wrong, and each has to produce a specific failing check rather than an
 * exception that stops the report.
 */

const CODE_PATH = 'generated-agents/inbound-import-receiving/v001';

// Only the fields `spec_hash` is derived from need to be real here: the name and the board it came
// from, which are hashed, and the spec ID and freeze instant, which are not.
const SPEC = {
  schemaVersion: '1.1',
  identity: {
    specId: '11111111-1111-4111-8111-111111111111',
    whiteboardId: '33333333-3333-4333-8333-333333333333',
    specVersion: 1,
    name: 'Inbound Import Receiving',
  },
  source: {
    revisionNo: 7,
    canvasHash: 'd'.repeat(64),
    reviewSessionIds: [],
    frozenAt: '2026-02-11T00:00:00.000Z',
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: false,
  },
} as unknown as SpecJson;
const SPEC_HASH = deriveSpecHash(SPEC);

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifestVersion: 1,
    deploymentKey: 'inbound-import-receiving',
    versionNo: 1,
    codePath: CODE_PATH,
    specId: '11111111-1111-4111-8111-111111111111',
    specHash: SPEC_HASH,
    specVersion: 1,
    generatedFiles: [...GENERATED_FILES],
    capabilities: ['mail.read'],
    generatedAt: '2026-02-11T00:00:00.000Z',
    generator: { skill: 'spec-to-agent', model: 'gpt-5.1-codex' },
    toolkitVersions: { composioGmailToolkit: '20260115_02' },
    validation: { commands: ['pnpm lint'], evalCaseKeys: ['case-01'] },
    ...overrides,
  });
}

function sources(
  options: { files?: Record<string, string>; paths?: string[] } = {},
): VerificationSources {
  const files: Record<string, string> = {
    [`${CODE_PATH}/manifest.json`]: manifest(),
    [`${CODE_PATH}/spec.snapshot.json`]: canonicalJson(SPEC),
    ...options.files,
  };
  return {
    treePaths: () => options.paths ?? GENERATED_FILES.map((file) => `${CODE_PATH}/${file}`),
    showFile: (_sha, path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`git show failed: ${path}`);
      return content;
    },
  };
}

const input = {
  agentVersionId: '22222222-2222-4222-8222-222222222222',
  gitCommitSha: 'b'.repeat(40),
  codePath: CODE_PATH,
  specHash: SPEC_HASH,
  specJson: SPEC,
};

function check(result: ReturnType<typeof verifyCommitContents>, name: string) {
  const found = result.checks.find((entry) => entry.name.includes(name));
  expect(found, `no check named ${name}`).toBeDefined();
  return found!;
}

describe('commit content verification', () => {
  it('passes for a commit that contains what its manifest claims', () => {
    const result = verifyCommitContents(input, sources());
    expect(result.ok).toBe(true);
  });

  it('fails the specific check when a manifest file is missing from the tree', () => {
    const result = verifyCommitContents(
      input,
      sources({ paths: [`${CODE_PATH}/agent.ts`, `${CODE_PATH}/manifest.json`] }),
    );
    expect(result.ok).toBe(false);
    expect(check(result, 'files present in tree').detail).toContain('rules.ts');
  });

  it('accepts a snapshot that differs only in when it was frozen', () => {
    // The committed file and the database row are both serializations of the same contract, and
    // neither is byte-stable. What must agree is the contract, so a different `frozenAt` — or a
    // re-freeze that minted a new spec ID — is not evidence of tampering.
    const reissued = canonicalJson({
      ...SPEC,
      identity: { ...SPEC.identity, specId: '99999999-9999-4999-8999-999999999999' },
      source: { ...SPEC.source, frozenAt: '2026-06-01T12:00:00.000Z' },
    });
    const result = verifyCommitContents(input, {
      ...sources({ files: { [`${CODE_PATH}/spec.snapshot.json`]: reissued } }),
    });
    expect(check(result, 'hashes to the frozen spec').ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('fails when the committed snapshot does not hash to the frozen spec', () => {
    const tampered = canonicalJson({
      ...SPEC,
      identity: { ...SPEC.identity, name: 'Something else' },
    });
    const result = verifyCommitContents(input, {
      ...sources({ files: { [`${CODE_PATH}/spec.snapshot.json`]: tampered } }),
    });
    expect(result.ok).toBe(false);
    expect(check(result, 'hashes to the frozen spec').ok).toBe(false);
  });

  it('fails when the manifest names a different spec hash than the database', () => {
    const result = verifyCommitContents(input, {
      ...sources({
        files: { [`${CODE_PATH}/manifest.json`]: manifest({ specHash: 'c'.repeat(64) }) },
      }),
    });
    expect(result.ok).toBe(false);
    expect(check(result, 'specHash matches').ok).toBe(false);
  });

  it('fails when the manifest records an unresolved toolkit version', () => {
    const result = verifyCommitContents(input, {
      ...sources({
        files: {
          [`${CODE_PATH}/manifest.json`]: manifest({
            toolkitVersions: { composioGmailToolkit: 'latest' },
          }),
        },
      }),
    });
    expect(result.ok).toBe(false);
  });

  it('reports a commit that does not resolve without throwing', () => {
    const result = verifyCommitContents(input, {
      treePaths: () => {
        throw new Error('fatal: bad object');
      },
      showFile: () => '',
    });
    expect(result.ok).toBe(false);
    expect(check(result, 'commit resolves').detail).toContain('bad object');
  });
});
