import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { deploymentForBoardPath, type DeploymentFixture } from './deployments.js';
import { loadOpsEnv, optionalEnv } from './env.js';
import { flag, parseArgs, optionalArg } from './lib/args.js';
import { repoPath } from './lib/state.js';
import { opsClient } from './lib/supabase.js';
import { releaseDemoAgent, type ReleaseResult } from './release-demo-agent.js';

/**
 * Seed the two demo users and the example board.
 *
 * The board is inserted through `meridian.seed_whiteboard_graph`, which sets the delta marker for
 * the duration of one transaction. That is not a loophole in the write-path guard: the guard exists
 * so that no *application* path can write the graph directly, and a service-role seed function that
 * has to announce itself to the same trigger is holding to the rule rather than dodging it.
 *
 * Re-running is safe. Existing users are reused, and a board with the same title is not duplicated.
 */

export interface SeedResult {
  demoUserId: string;
  otherUserId: string;
  whiteboardId: string;
  created: boolean;
  nodeCount: number;
  edgeCount: number;
  /** Null for a draft seed, which has no frozen spec to generate an agent from. */
  release: ReleaseResult | null;
}

interface SeedBoard {
  title: string;
  viewport?: unknown;
  nodes: unknown[];
  edges: unknown[];
}

export const DEFAULT_BOARD_PATH = 'examples/inbound-import-receiving/board.seed.json';

async function ensureUser(email: string, password: string): Promise<string> {
  const client = opsClient();
  const { data: created, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error === null && created.user !== null) return created.user.id;

  // `createUser` fails on a duplicate email, which on a re-run is the expected outcome rather than
  // a problem, so the existing account is looked up instead of the run aborting.
  const { data: list, error: listError } = await client.auth.admin.listUsers({ perPage: 200 });
  if (listError !== null) throw new Error(`could not list users: ${listError.message}`);
  const existing = list.users.find((user) => user.email === email);
  if (existing === undefined) {
    throw new Error(`could not create or find ${email}: ${error?.message ?? 'unknown error'}`);
  }
  return existing.id;
}

/**
 * A board seeded as a draft has no agent behind it, and that is the point.
 *
 * The two worked examples are seeded finished — frozen, generated, released — because `pnpm demo`
 * needs something runnable. A demonstration of the *authoring* loop needs the opposite: a board as
 * it looks after one conversation with the process owner, before any review has run. Releasing that
 * would require freezing a specification nobody has reviewed, which is a state the product is
 * designed to make you work for.
 */
export async function seedDemo(
  boardPath = DEFAULT_BOARD_PATH,
  options: { release?: boolean } = {},
): Promise<SeedResult> {
  loadOpsEnv();
  const client = opsClient();
  const shouldRelease = options.release ?? true;
  const deployment = shouldRelease ? deploymentForBoardPath(boardPath) : null;

  const demoUserId = await ensureUser(
    optionalEnv('DEMO_USER_EMAIL', 'demo@meridian.local'),
    optionalEnv('DEMO_USER_PASSWORD', 'meridian-demo-password'),
  );
  const otherUserId = await ensureUser(
    optionalEnv('DEMO_OTHER_EMAIL', 'other@meridian.local'),
    optionalEnv('DEMO_OTHER_PASSWORD', 'meridian-other-password'),
  );

  const board = JSON.parse(readFileSync(repoPath(boardPath), 'utf8')) as SeedBoard;

  const { data: existing, error: existingError } = await client
    .from('whiteboards')
    .select('whiteboard_id')
    .eq('owner_id', demoUserId)
    .eq('title', board.title)
    .maybeSingle();
  if (existingError !== null) throw new Error(existingError.message);

  if (existing !== null) {
    return {
      demoUserId,
      otherUserId,
      whiteboardId: existing.whiteboard_id,
      created: false,
      nodeCount: board.nodes.length,
      edgeCount: board.edges.length,
      release: await release(existing.whiteboard_id, deployment),
    };
  }

  // `meridian` is deliberately not exposed to PostgREST — it holds internal helpers, not API
  // surface — so the seed helper is called over a direct operator connection instead of widening
  // the REST schema list just to run a development fixture.
  const pg = new Client({
    connectionString: optionalEnv(
      'SUPABASE_DB_URL',
      'postgresql://postgres:postgres@127.0.0.1:54522/postgres',
    ),
  });
  await pg.connect();
  let whiteboardId: string;
  try {
    const seeded = await pg.query<{ seed_whiteboard_graph: string }>(
      'select meridian.seed_whiteboard_graph($1::uuid, $2::jsonb)',
      [demoUserId, JSON.stringify(board)],
    );
    whiteboardId = seeded.rows[0]!.seed_whiteboard_graph;
  } finally {
    await pg.end();
  }

  return {
    demoUserId,
    otherUserId,
    whiteboardId,
    created: true,
    nodeCount: board.nodes.length,
    edgeCount: board.edges.length,
    release: await release(whiteboardId, deployment),
  };
}

/**
 * The seeded board is not, on its own, something the demo can run.
 *
 * `pnpm demo` needs an agent with an active version, because intake refuses to start a workflow for
 * a deployment key that has no release — deliberately, since running "the newest version" would
 * bypass the approval gate that activation exists to enforce. So the seed carries the board through
 * the same chain an operator would: freeze, agent, version, commit, approved, active.
 */
function release(
  whiteboardId: string,
  deployment: DeploymentFixture | null,
): Promise<ReleaseResult | null> {
  if (deployment === null) return Promise.resolve(null);
  return releaseDemoAgent({
    whiteboardId,
    deployment,
    email: optionalEnv('DEMO_USER_EMAIL', 'demo@meridian.local'),
    password: optionalEnv('DEMO_USER_PASSWORD', 'meridian-demo-password'),
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    const result = await seedDemo(optionalArg(args, 'board') ?? DEFAULT_BOARD_PATH, {
      release: !flag(args, 'draft'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
