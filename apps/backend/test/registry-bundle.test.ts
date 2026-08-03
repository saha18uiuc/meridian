import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registeredVersions, resolveAgent, resolvePinnedAgent } from '@meridian/agent-kit';
import { SpecHashMismatchError } from '@meridian/agent-kit/contracts';
import { AGENT_REGISTRY } from '@meridian/generated-agents';
import { describe, expect, it } from 'vitest';

/**
 * The generated registry, and why it is a static map rather than a directory scan.
 *
 * The workflow sandbox has no filesystem and no dynamic `import()`, so "load the agent for this
 * version" has to resolve to a top-level import written into a checked-in file. That is an
 * inconvenience with a benefit: the set of agent versions a worker can run is visible in the diff
 * of one file, and a version that was never registered fails at bundle time rather than
 * mid-execution.
 *
 * The second guarantee is the spec hash. A running workflow names the version *and* the hash it
 * expects, so a worker holding differently-generated code for the same version number refuses the
 * work instead of quietly doing something else.
 */

const registryPath = fileURLToPath(new URL('../../../generated-agents/index.ts', import.meta.url));

describe('the generated registry', () => {
  it('registers at least the receiving agent at v1', () => {
    expect(registeredVersions(AGENT_REGISTRY)).toContainEqual({
      key: 'inbound-import-receiving',
      versionNo: 1,
    });
  });

  it('resolves a registered version to a runnable definition', () => {
    const definition = resolveAgent(AGENT_REGISTRY, 'inbound-import-receiving', 1);
    expect(definition.deploymentKey).toBe('inbound-import-receiving');
    expect(definition.versionNo).toBe(1);
    expect(typeof definition.run).toBe('function');
  });

  it('refuses an unknown deployment key', () => {
    expect(() => resolveAgent(AGENT_REGISTRY, 'not-an-agent', 1)).toThrow(/not-an-agent/);
  });

  it('refuses a version number that was never registered', () => {
    expect(() => resolveAgent(AGENT_REGISTRY, 'inbound-import-receiving', 99)).toThrow(/99/);
  });

  it('refuses to run code whose spec hash is not the one pinned to the execution', () => {
    const definition = resolveAgent(AGENT_REGISTRY, 'inbound-import-receiving', 1);
    expect(() =>
      resolvePinnedAgent(AGENT_REGISTRY, {
        deploymentKey: 'inbound-import-receiving',
        versionNo: 1,
        specHash: 'a'.repeat(64),
      }),
    ).toThrow(SpecHashMismatchError);

    expect(
      resolvePinnedAgent(AGENT_REGISTRY, {
        deploymentKey: 'inbound-import-receiving',
        versionNo: 1,
        specHash: definition.specHash,
      }),
    ).toBe(definition);
  });

  it('reaches every version through a top-level import', () => {
    // Dynamic import is unavailable in the sandbox, so a registry that used it would compile,
    // pass review, and fail only when a workflow first tried to resolve an agent.
    const source = readFileSync(registryPath, 'utf8');
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/\bimport\(/);
    expect(withoutComments).not.toMatch(/\brequire\(/);
    expect(withoutComments).toMatch(/^import .* from '\.\//m);
  });

  it('lists versions in a stable order regardless of object key order', () => {
    const forward = registeredVersions(AGENT_REGISTRY);
    const reversed = registeredVersions(
      Object.fromEntries(Object.entries(AGENT_REGISTRY).reverse()),
    );
    expect(reversed).toEqual(forward);
  });

  it('gives each registered definition a distinct identity', () => {
    const seen = new Set<string>();
    for (const { key, versionNo } of registeredVersions(AGENT_REGISTRY)) {
      const definition = resolveAgent(AGENT_REGISTRY, key, versionNo);
      const identity = `${definition.deploymentKey}@${String(definition.versionNo)}`;
      expect(seen.has(identity)).toBe(false);
      seen.add(identity);
      // The registry key and the definition must agree; a copy-pasted agent that kept its parent's
      // identity would run under the wrong lineage and record the wrong version on its evidence.
      expect(identity).toBe(`${key}@${String(versionNo)}`);
    }
  });
});
