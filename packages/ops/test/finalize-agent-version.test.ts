import { describe, expect, it } from 'vitest';
import { GENERATED_FILES, FinalizeError, parseManifest } from '../src/finalize-agent-version.js';

/**
 * The manifest parser that stands between a generated folder and a recorded commit.
 *
 * `parseManifest` is the last thing that runs before a SHA is written into `agent_versions`, so
 * every rejection here is a lineage claim that never gets made. The two that matter most are the
 * unresolved toolkit version — which would make the execution record unreproducible — and any
 * field the database gate reads, because a manifest that parses here and fails the gate turns a
 * generation run into a confusing constraint violation three steps later.
 */

const validManifest = {
  manifestVersion: 1,
  deploymentKey: 'inbound-import-receiving',
  versionNo: 1,
  codePath: 'generated-agents/inbound-import-receiving/v001',
  specId: '11111111-1111-4111-8111-111111111111',
  specHash: 'a'.repeat(64),
  specVersion: 1,
  generatedFiles: [...GENERATED_FILES],
  capabilities: ['mail.read', 'mail.send'],
  generatedAt: '2026-02-11T00:00:00.000Z',
  generator: { skill: 'spec-to-agent', model: 'gpt-5.1-codex' },
  toolkitVersions: { composioGmailToolkit: '20260115_02' },
  validation: { commands: ['pnpm lint', 'pnpm typecheck'], evalCaseKeys: ['case-01'] },
};

function parse(overrides: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...validManifest, ...overrides }), 'the test manifest');
}

describe('build manifest parsing', () => {
  it('accepts the manifest the generation skill is told to write', () => {
    const manifest = parse({});
    expect(manifest.generatedFiles).toEqual([...GENERATED_FILES]);
    expect(manifest.validation.commands.length).toBeGreaterThan(0);
  });

  it('names the field and the reason when a manifest is wrong', () => {
    expect(() => parse({ specHash: 'too-short' })).toThrow(FinalizeError);
    expect(() => parse({ specHash: 'too-short' })).toThrow(/specHash/);
  });

  it('rejects an unresolved toolkit version', () => {
    // This is the one rejection that is about auditability rather than shape: "latest" names a
    // different toolkit next week, so an execution recorded against it cannot be reproduced.
    expect(() => parse({ toolkitVersions: { composioGmailToolkit: 'latest' } })).toThrow(
      /concrete resolved version/,
    );
    expect(() => parse({ toolkitVersions: { composioGmailToolkit: 'LATEST' } })).toThrow(
      /concrete resolved version/,
    );
  });

  it('rejects the two fields the database gate reads when they are empty', () => {
    // `check_agent_version_gate` refuses to promote a version whose manifest has no generated
    // files or no validation record. Catching it here turns a P0001 into a sentence.
    expect(() => parse({ generatedFiles: [] })).toThrow(/generatedFiles/);
    expect(() => parse({ validation: { commands: [], evalCaseKeys: [] } })).toThrow(/commands/);
  });

  it('rejects a code path that does not match the reserved layout', () => {
    expect(() => parse({ codePath: 'src/agents/inbound' })).toThrow(/codePath/);
    expect(() => parse({ codePath: 'generated-agents/inbound-import-receiving/1' })).toThrow(
      /codePath/,
    );
  });

  it('rejects unknown keys rather than silently dropping them', () => {
    // A manifest carrying a field nobody reads is a claim nobody checks.
    expect(() => parse({ evalReport: 'all green' })).toThrow(FinalizeError);
  });

  it('reports invalid JSON as invalid JSON', () => {
    expect(() => parseManifest('{ not json', 'the test manifest')).toThrow(/not valid JSON/);
  });
});
