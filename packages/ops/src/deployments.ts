/**
 * The deployments this repository ships as worked examples.
 *
 * There are two, and the second one is the point. Everything upstream of this file — the
 * primitives, the compiler, the review loop, the freeze, the lineage checks, the eval harness, the
 * Temporal runtime — is supposed to be indifferent to which process it is carrying. A single
 * example cannot demonstrate that; it can only fail to contradict it. So the release path takes a
 * deployment rather than naming one, and the table below is the whole of what distinguishes the
 * two: a key, a title, a board, and the directory its generated code lives in.
 *
 * If adding a third required editing anything other than this table and the agent registry, the
 * generalisation claim would be false.
 */

export interface DeploymentFixture {
  /** The stable key intake correlates against and `agents.deployment_key` stores. */
  deploymentKey: string;
  /** The agent's display name, and the board title the seed matches on. */
  name: string;
  boardPath: string;
  codePath: string;
}

export const DEPLOYMENTS: readonly DeploymentFixture[] = [
  {
    deploymentKey: 'inbound-import-receiving',
    name: 'Inbound Import Receiving',
    boardPath: 'examples/inbound-import-receiving/board.seed.json',
    codePath: 'generated-agents/inbound-import-receiving/v001',
  },
  {
    deploymentKey: 'vendor-coi-renewal',
    name: 'Vendor Insurance Certificate Renewal',
    boardPath: 'examples/vendor-coi-renewal/board.seed.json',
    codePath: 'generated-agents/vendor-coi-renewal/v001',
  },
];

export function deploymentForBoardPath(boardPath: string): DeploymentFixture {
  const found = DEPLOYMENTS.find((entry) => entry.boardPath === boardPath);
  if (found === undefined) {
    throw new Error(
      `no deployment is declared for board ${boardPath}; add it to DEPLOYMENTS in packages/ops/src/deployments.ts`,
    );
  }
  return found;
}

export function deploymentForTitle(title: string): DeploymentFixture {
  const found = DEPLOYMENTS.find((entry) => entry.name === title);
  if (found === undefined) {
    throw new Error(`no deployment is declared for board titled "${title}"`);
  }
  return found;
}
