import { randomUUID } from 'node:crypto';
import { compileSpec, deriveSpecHash } from '../../src/compiler.js';
import { sha256Hex } from '../../src/hashing.js';
import { asPostgres, buildSnapshot, rpcAsService, rpcAsUser, seedSimpleBoard } from './db.js';

/**
 * Builds the full lineage chain the execution tests need: board → frozen spec → agent → version →
 * approved → activated.
 *
 * Every link goes through the real RPC, so a test that depends on this fixture is also, quietly, a
 * test that the chain can actually be built the way the application builds it. Direct inserts are
 * used only where a test would otherwise have to run a coding agent to obtain a Git SHA.
 */

export interface FrozenSpecFixture {
  boardId: string;
  specId: string;
  specHash: string;
  specVersion: number;
  revisionNo: number;
}

/** A random 40-hex string; the schema only checks the shape, not that the object exists. */
export function fakeGitSha(): string {
  return sha256Hex(randomUUID()).slice(0, 40);
}

/** Compile the current state of a board exactly the way the freeze service does. */
export async function compileBoard(
  boardId: string,
  specVersion: number,
): Promise<{
  specId: string;
  specJson: unknown;
  specHash: string;
  snapshot: unknown;
  canvasHash: string;
  revisionNo: number;
}> {
  const { snapshot, hash, revisionNo } = await buildSnapshot(boardId);
  const specId = randomUUID();
  const compiled = compileSpec({
    graph: snapshot,
    specId,
    specVersion,
    name: snapshot.metadata.title,
    canvasHash: hash,
    reviewSessionIds: [],
    // A fixed instant keeps the spec hash reproducible across runs of the same fixture.
    frozenAt: '2026-01-01T00:00:00.000Z',
    acknowledgedUnresolvedBlockers: false,
    acknowledgedStaleReview: true,
    assumptions: [],
    knownGaps: [],
  });
  if ('errors' in compiled) {
    throw new Error(`fixture board failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  return {
    specId,
    specJson: compiled.specJson,
    specHash: deriveSpecHash(compiled.specJson),
    snapshot,
    canvasHash: hash,
    revisionNo,
  };
}

/**
 * Open a review round on a board and leave it running.
 *
 * Used by the tests that need a live session to exist; the freeze fixtures below deliberately do
 * not call it, because a board that was never reviewed is exactly the case A18 says must still be
 * freezable after an explicit acknowledgement.
 */
export async function openReviewSession(owner: string, boardId: string): Promise<string> {
  const { snapshot, hash, revisionNo } = await buildSnapshot(boardId);
  const session = await rpcAsService<{ reviewSessionId: string }>('create_review_session', [
    owner,
    boardId,
    revisionNo,
    JSON.stringify(snapshot),
    hash,
    'gpt-5.5',
    'high',
  ]);
  return session.reviewSessionId;
}

export async function freezeBoard(owner: string, title = 'Board'): Promise<FrozenSpecFixture> {
  const board = await seedSimpleBoard(owner, title);
  const compiled = await compileBoard(board.boardId, 1);

  // Freezing normally follows a review; these fixtures are about what comes after the freeze, so
  // the never-reviewed board is acknowledged rather than a review manufactured for it. Leaving a
  // session running here would also make every later `create_review_session` on the fixture board
  // fail with ACTIVE_REVIEW_EXISTS, which has nothing to do with what those tests are checking.
  const result = await rpcAsService<{ specId: string; specVersion: number }>(
    'freeze_whiteboard_spec',
    [
      owner,
      board.boardId,
      compiled.revisionNo,
      JSON.stringify(compiled.snapshot),
      compiled.canvasHash,
      JSON.stringify(compiled.specJson),
      compiled.specHash,
      [],
      false,
      true,
    ],
  );

  return {
    boardId: board.boardId,
    specId: result.specId,
    specHash: compiled.specHash,
    specVersion: result.specVersion,
    revisionNo: compiled.revisionNo,
  };
}

export interface AgentFixture extends FrozenSpecFixture {
  agentId: string;
  deploymentKey: string;
  agentVersionId: string;
  versionNo: number;
  gitCommitSha: string;
}

let keyCounter = 0;

export function nextDeploymentKey(): string {
  keyCounter += 1;
  return `test-agent-${String(process.pid).slice(-4)}-${keyCounter}`;
}

/** Board → spec → agent → v001 in `generated` state, with no Git SHA yet. */
export async function seedAgentVersion(owner: string): Promise<AgentFixture> {
  const frozen = await freezeBoard(owner);
  const deploymentKey = nextDeploymentKey();
  const agent = await rpcAsUser<{ agentId: string }>(owner, 'create_agent', [
    frozen.boardId,
    deploymentKey,
    'Test agent',
  ]);
  const version = await rpcAsUser<{ agentVersionId: string; versionNo: number }>(
    owner,
    'create_agent_version',
    [agent.agentId, frozen.specId, null],
  );
  return {
    ...frozen,
    agentId: agent.agentId,
    deploymentKey,
    agentVersionId: version.agentVersionId,
    versionNo: version.versionNo,
    gitCommitSha: fakeGitSha(),
  };
}

/**
 * A manifest the version gate will accept.
 *
 * The gate insists on a non-empty `generatedFiles` list and a `validation` block before a version
 * may leave `generated`, so a fixture that omits them is not a shortcut — it is a version that
 * could never have been approved in the first place.
 */
export function buildManifest(specHash: string): Record<string, unknown> {
  return {
    state: 'committed',
    specHash,
    generatedFiles: ['agent.ts', 'rules.ts', 'prompts.ts', 'manifest.json', 'spec.snapshot.json'],
    validation: { lint: 'pass', typecheck: 'pass', unit: 'pass', smokeEval: 'pass' },
  };
}

/** The same chain, carried all the way to an activated release pointer. */
export async function seedActiveAgent(owner: string): Promise<AgentFixture> {
  const fixture = await seedAgentVersion(owner);
  await rpcAsService('record_agent_commit', [
    owner,
    fixture.agentVersionId,
    fixture.gitCommitSha,
    JSON.stringify(buildManifest(fixture.specHash)),
  ]);
  await rpcAsUser(owner, 'transition_agent_version', [fixture.agentVersionId, 'evaluating']);
  await rpcAsUser(owner, 'transition_agent_version', [fixture.agentVersionId, 'approved']);
  await rpcAsUser(owner, 'activate_agent_version', [fixture.agentId, fixture.agentVersionId]);
  return fixture;
}

export function idempotencyKey(...parts: string[]): string {
  return sha256Hex(parts.join('|'));
}

export interface ExecutionFixture {
  executionId: string;
  stepExecutionId: string;
}

/**
 * A running execution with one step, which is the minimum an action needs to attach to.
 *
 * Steps are inserted directly: there is no step RPC, because steps are written by the recorder
 * with the service role and guarded by triggers rather than by a transactional entry point.
 */
export async function seedExecutionWithStep(
  agent: AgentFixture,
  options: { businessKey?: string; caseKey?: string } = {},
): Promise<ExecutionFixture> {
  const businessKey = options.businessKey ?? 'MSKU1234565';
  const caseKey = options.caseKey ?? `live:${businessKey}`;
  const created = await rpcAsService<{ executionId: string }>('create_execution', [
    agent.agentId,
    agent.agentVersionId,
    'live',
    caseKey,
    businessKey,
    `receiving:${businessKey}`,
    idempotencyKey('live', businessKey, caseKey),
    JSON.stringify({ specHash: agent.specHash }),
  ]);
  await rpcAsService('start_execution', [created.executionId, `receiving:${businessKey}`, 'run-1']);

  const stepExecutionId = await asPostgres(async (client) => {
    const { rows } = await client.query<{ step_execution_id: string }>(
      // `started_at` is paired with the running status by a check constraint, so a step row that
      // claims to be running without one is rejected — as it should be.
      `insert into public.execution_steps
         (execution_id, node_id, step_key, step_instance_key, sequence_no, attempt_no, status, started_at)
       values ($1, null, 'intake', $2, 1, 1, 'running', now())
       returning step_execution_id`,
      [created.executionId, `intake:${businessKey}`],
    );
    const id = rows[0]?.step_execution_id;
    if (id === undefined) throw new Error('step insert produced no row');
    return id;
  });

  return { executionId: created.executionId, stepExecutionId };
}
