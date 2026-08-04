import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  assembleCanonicalGraph,
  canonicalJson,
  compileSpec,
  deriveCanvasHash,
  deriveSpecHash,
  type BuildManifest,
  type CanonicalGraph,
} from '@meridian/core';
import { repoPath } from '../lib/state.js';
import { stableUuid } from './boards.js';

/**
 * Regenerate `generated-agents/inbound-import-receiving/v001/{spec.snapshot.json,manifest.json}`
 * and stamp the resulting `spec_hash` into `agent.ts`.
 *
 * The snapshot is not decoration. `record_agent_commit` refuses a version whose manifest names a
 * `spec_hash` other than the frozen spec's, `verify-build-manifest.ts` re-canonicalizes both the
 * committed file and the database row and compares them, and `resolvePinnedAgent` checks the hash
 * the agent carries against the one the execution was created under. All three of those only mean
 * something if the checked-in artifact corresponds to a spec that can actually be produced.
 *
 * It can, because every input is fixed: the board is the checked-in seed fixture, its ID and every
 * node and edge ID are UUIDv5 values derived from stable slugs, a freshly seeded board is at
 * revision 1 with every row at version 1, and `spec_hash` is taken over the semantic view, which
 * holds out the spec ID, the version counter, the freeze timestamp, the review session IDs, and the
 * acknowledgement flags. So `pnpm seed`, a review, rejecting the findings, and a freeze reproduce
 * exactly the hash committed here — which is what `pnpm demo` and `pnpm verify:e2e` rely on.
 */

/**
 * Which deployment a snapshot is being built for. The three paths are separate parameters rather
 * than derived from the key, because the directory layout is a convention and a convention that
 * silently assumes itself is one nobody can deviate from.
 */
export interface SnapshotTarget {
  deploymentKey: string;
  codePath: string;
  seedPath: string;
  evalCaseDir: string | null;
  /** Namespaced so two boards cannot mint the same spec ID. */
  specIdSlug: string;
}

export const SNAPSHOT_TARGETS: readonly SnapshotTarget[] = [
  {
    deploymentKey: 'inbound-import-receiving',
    codePath: 'generated-agents/inbound-import-receiving/v001',
    seedPath: 'examples/inbound-import-receiving/board.seed.json',
    evalCaseDir: 'examples/inbound-import-receiving/evals',
    specIdSlug: 'spec-inbound-import-receiving-v1',
  },
  {
    deploymentKey: 'vendor-coi-renewal',
    codePath: 'generated-agents/vendor-coi-renewal/v001',
    seedPath: 'examples/vendor-coi-renewal/board.seed.json',
    evalCaseDir: 'examples/vendor-coi-renewal/evals',
    specIdSlug: 'spec-vendor-coi-renewal-v1',
  },
];

interface SeedFile {
  whiteboardId: string;
  title: string;
  nodes: {
    nodeId: string;
    primitiveType: 'input' | 'action' | 'rule' | 'outcome';
    title: string;
    data: Record<string, unknown>;
    position: { x: number; y: number };
  }[];
  edges: {
    edgeId: string;
    sourceNodeId: string;
    targetNodeId: string;
    label: string | null;
    condition: Record<string, unknown> | null;
    priority: number;
  }[];
}

/**
 * The canonical graph a freshly seeded board yields.
 *
 * `meridian.seed_whiteboard_graph` inserts the rows with their defaults, so the revision and every
 * row version are 1 and the board is a draft. Status is excluded from the canvas hash anyway —
 * freezing moves the board to `submitted`, and the hash recorded before that must survive it.
 */
export function seededGraph(seed: SeedFile): CanonicalGraph {
  return assembleCanonicalGraph(
    {
      whiteboardId: seed.whiteboardId,
      title: seed.title,
      status: 'draft',
      revisionNo: 1,
    },
    seed.nodes.map((node) => ({ ...node, rowVersion: 1 })),
    seed.edges.map((edge) => ({ ...edge, rowVersion: 1 })),
  );
}

/**
 * The suite the version was validated against, read from the case files rather than transcribed.
 * A manifest that named cases which no longer exist would claim coverage nobody can reproduce.
 */
function evalCaseKeys(dir: string | null): string[] {
  if (dir === null) return [];
  return readdirSync(repoPath(dir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const parsed = JSON.parse(readFileSync(repoPath(dir, name), 'utf8')) as {
        caseKey: string;
      };
      return parsed.caseKey;
    })
    .sort();
}

export interface GeneratedSnapshot {
  specJson: Record<string, unknown>;
  specHash: string;
  canvasHash: string;
  manifest: BuildManifest;
}

export function buildSnapshot(seed: SeedFile, target: SnapshotTarget): GeneratedSnapshot {
  const graph = seededGraph(seed);
  const canvasHash = deriveCanvasHash(graph);

  // The spec ID and the freeze timestamp are outside the hash, so fixing them here costs nothing in
  // fidelity and buys a file that regenerates byte-identically. A real freeze mints its own.
  const specId = stableUuid(target.specIdSlug);
  const compiled = compileSpec({
    graph,
    specId,
    specVersion: 1,
    name: seed.title,
    canvasHash,
    reviewSessionIds: [],
    frozenAt: '1970-01-01T00:00:00.000Z',
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: false,
    assumptions: [],
    knownGaps: [],
  });
  if ('errors' in compiled) {
    throw new Error(`the seed board does not compile: ${JSON.stringify(compiled.errors, null, 2)}`);
  }

  const specHash = deriveSpecHash(compiled.specJson);

  const manifest: BuildManifest = {
    manifestVersion: 1,
    deploymentKey: target.deploymentKey,
    versionNo: 1,
    codePath: target.codePath,
    specId,
    specHash,
    specVersion: 1,
    generatedFiles: ['agent.ts', 'rules.ts', 'prompts.ts', 'manifest.json', 'spec.snapshot.json'],
    capabilities: [...compiled.specJson.capabilities],
    generatedAt: '1970-01-01T00:00:00.000Z',
    generator: { skill: '.codex/skills/spec-to-agent', model: 'gpt-5-codex' },
    // Concrete versions, matching the workspace pins. `pnpm verify` fails on the literal `latest`
    // here, because a manifest that records a floating version cannot describe the build it claims.
    toolkitVersions: { '@composio/core': '0.14.1', openai: '7.3.0', zod: '4.4.3' },
    validation: {
      commands: ['pnpm lint', 'pnpm typecheck', 'pnpm test:unit', 'pnpm evals'],
      evalCaseKeys: evalCaseKeys(target.evalCaseDir),
    },
  };

  return { specJson: compiled.specJson, specHash, canvasHash, manifest };
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  for (const target of SNAPSHOT_TARGETS) await writeSnapshot(target);
}

async function writeSnapshot(target: SnapshotTarget): Promise<void> {
  const CODE_PATH = target.codePath;
  const seed = JSON.parse(readFileSync(repoPath(target.seedPath), 'utf8')) as SeedFile;
  const { specJson, specHash, canvasHash, manifest } = buildSnapshot(seed, target);

  // Canonical bytes, per the snapshot-file contract: re-canonicalizing this file and re-canonicalizing
  // the `jsonb` read back from the database must produce the same bytes and the same hash.
  writeFileSync(repoPath(CODE_PATH, 'spec.snapshot.json'), `${canonicalJson(specJson)}\n`, 'utf8');
  writeFileSync(
    repoPath(CODE_PATH, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const agentPath = repoPath(CODE_PATH, 'agent.ts');
  const agentSource = readFileSync(agentPath, 'utf8');
  const stamped = agentSource.replace(
    /^const SPEC_HASH = '[^']*';$/m,
    `const SPEC_HASH = '${specHash}';`,
  );
  if (stamped === agentSource && !agentSource.includes(`const SPEC_HASH = '${specHash}'`)) {
    throw new Error(`could not find the SPEC_HASH declaration in ${CODE_PATH}/agent.ts`);
  }
  writeFileSync(agentPath, stamped, 'utf8');

  process.stdout.write(
    `${JSON.stringify({ specHash, canvasHash, codePath: CODE_PATH }, null, 2)}\n`,
  );
}
