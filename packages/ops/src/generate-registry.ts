import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from './lib/state.js';

/**
 * Regenerate `generated-agents/index.ts` from what is actually on disk.
 *
 * The registry is a static map with top-level imports because it is bundled into the Temporal
 * workflow sandbox, where `import()` and directory reads do not exist. Writing it by hand would be
 * an invitation to forget an entry; scanning the directory at build time and emitting the same
 * static shape gets the ergonomics without giving up the constraint.
 */

const VERSION_DIR = /^v(\d{3})$/;

export interface DiscoveredVersion {
  deploymentKey: string;
  versionNo: number;
  dirName: string;
  importAlias: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toAlias(deploymentKey: string, versionNo: number): string {
  const camel = deploymentKey
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join('');
  return `${camel}V${String(versionNo).padStart(3, '0')}`;
}

export function discoverVersions(root: string): DiscoveredVersion[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const found: DiscoveredVersion[] = [];
  for (const deploymentKey of entries.sort()) {
    const agentDir = join(root, deploymentKey);
    if (!isDirectory(agentDir) || deploymentKey.startsWith('.') || deploymentKey === 'node_modules')
      continue;
    for (const dirName of readdirSync(agentDir).sort()) {
      const match = VERSION_DIR.exec(dirName);
      if (match === null) continue;
      if (!isDirectory(join(agentDir, dirName))) continue;
      const versionNo = Number.parseInt(match[1] as string, 10);
      found.push({
        deploymentKey,
        versionNo,
        dirName,
        importAlias: toAlias(deploymentKey, versionNo),
      });
    }
  }
  return found;
}

export function renderRegistry(versions: readonly DiscoveredVersion[]): string {
  const header = `import type { AgentDefinition, AgentRegistry } from '@meridian/agent-kit/contracts';
import { resolveAgent as resolveFromRegistry } from '@meridian/agent-kit/contracts';
`;

  const imports = versions
    .map(
      (version) =>
        `import { agent as ${version.importAlias} } from './${version.deploymentKey}/${version.dirName}/agent.js';`,
    )
    .join('\n');

  const grouped = new Map<string, DiscoveredVersion[]>();
  for (const version of versions) {
    const list = grouped.get(version.deploymentKey) ?? [];
    list.push(version);
    grouped.set(version.deploymentKey, list);
  }

  const body =
    grouped.size === 0
      ? '{}'
      : `{\n${[...grouped.entries()]
          .map(
            ([key, list]) =>
              `  '${key}': {\n${list
                .sort((a, b) => a.versionNo - b.versionNo)
                .map((version) => `    ${version.versionNo}: ${version.importAlias},`)
                .join('\n')}\n  },`,
          )
          .join('\n')}\n}`;

  return `${header}${imports === '' ? '' : `${imports}\n`}
/**
 * GENERATED FILE — regenerate with \`pnpm exec tsx scripts/generate-registry.ts\`.
 *
 * The map is static and synchronous on purpose. It is bundled into the Temporal workflow sandbox,
 * where dynamic \`import()\` and filesystem globbing are unavailable, so every registered version has
 * to be reachable through a top-level import statement written here.
 *
 * Everything imported here also enters the sandbox bundle, which is why the resolver comes from
 * \`@meridian/agent-kit/contracts\` rather than from the package root: the root pulls in the live
 * Composio, OpenAI, and OCR adapters, none of which can be bundled for a workflow.
 *
 * Adding a version therefore requires regenerating this file and restarting the worker.
 */

export const AGENT_REGISTRY = ${body} as const satisfies AgentRegistry;

export function resolveAgent(deploymentKey: string, versionNo: number): AgentDefinition {
  return resolveFromRegistry(AGENT_REGISTRY, deploymentKey, versionNo);
}
`;
}

export interface GenerateResult {
  outPath: string;
  versions: DiscoveredVersion[];
  changed: boolean;
}

export function generateRegistry(root = repoPath('generated-agents')): GenerateResult {
  const versions = discoverVersions(root);
  const rendered = renderRegistry(versions);
  const outPath = join(root, 'index.ts');
  let previous: string;
  try {
    previous = readFileSync(outPath, 'utf8');
  } catch {
    previous = '';
  }
  const changed = previous !== rendered;
  if (changed) writeFileSync(outPath, rendered, 'utf8');
  return { outPath, versions, changed };
}

export async function main(_argv: readonly string[] = []): Promise<void> {
  const result = generateRegistry();
  process.stdout.write(
    `${JSON.stringify(
      {
        outPath: 'generated-agents/index.ts',
        changed: result.changed,
        versions: result.versions.map((v) => `${v.deploymentKey}@${v.versionNo}`),
      },
      null,
      2,
    )}\n`,
  );
}
