import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asPostgres,
  closePool,
  createTestUsers,
  expectPgError,
  rpcAsService,
  rpcAsUser,
  truncateAll,
} from '../helpers/db.js';
import {
  type AgentFixture,
  buildManifest,
  fakeGitSha,
  seedAgentVersion,
} from '../helpers/lineage.js';

/**
 * The gate between "some files were generated" and "this version may run" (A5).
 *
 * Everything it enforces exists to make the lineage claim true: an approved version has a Git
 * commit, that commit was built from the spec the version points at, and the manifest names the
 * files that were written. Without those, `Agent → Version → Spec → Commit` would be a convention
 * rather than something the database can vouch for.
 */

let owner: string;
let fixture: AgentFixture;

beforeEach(async () => {
  await truncateAll();
  [owner] = (await createTestUsers(1)) as [string];
  fixture = await seedAgentVersion(owner);
});

afterAll(async () => {
  await truncateAll();
  await closePool();
});

const commit = (manifest: Record<string, unknown> = buildManifest(fixture.specHash)) =>
  rpcAsService('record_agent_commit', [
    owner,
    fixture.agentVersionId,
    fixture.gitCommitSha,
    JSON.stringify(manifest),
  ]);

const transition = (status: string) =>
  rpcAsUser(owner, 'transition_agent_version', [fixture.agentVersionId, status]);

describe('record_agent_commit', () => {
  it('stores the SHA and manifest on a generated version', async () => {
    await commit();
    const { rows } = await asPostgres(async (client) =>
      client.query<{ git_commit_sha: string }>(
        'select git_commit_sha from public.agent_versions where agent_version_id = $1',
        [fixture.agentVersionId],
      ),
    );
    expect(rows[0]?.git_commit_sha).toBe(fixture.gitCommitSha);
  });

  it('rejects a manifest whose specHash does not match the frozen spec', async () => {
    await expectPgError(commit(buildManifest('0'.repeat(64))), 'MANIFEST_SPEC_HASH_MISMATCH');
  });

  it('rejects a value that is not a Git SHA-1', async () => {
    await expectPgError(
      rpcAsService('record_agent_commit', [
        owner,
        fixture.agentVersionId,
        'not-a-sha',
        JSON.stringify(buildManifest(fixture.specHash)),
      ]),
      'INVALID_GIT_SHA',
    );
  });

  it('rejects an actor who does not own the board, even with the service role', async () => {
    // The service client has no `auth.uid()`, so the actor is passed explicitly and re-derived
    // here. Trusting the caller's claim of who they are would defeat the whole arrangement.
    const [other] = (await createTestUsers(1)) as [string];
    await expectPgError(
      rpcAsService('record_agent_commit', [
        other,
        fixture.agentVersionId,
        fakeGitSha(),
        JSON.stringify(buildManifest(fixture.specHash)),
      ]),
      'AGENT_VERSION_NOT_FOUND',
    );
  });

  it('refuses to re-record a commit once the version has left generated', async () => {
    await commit();
    await transition('evaluating');
    await expectPgError(commit(), 'VERSION_NOT_GENERATED');
  });
});

describe('transition_agent_version', () => {
  it('refuses to skip straight from generated to approved', async () => {
    await commit();
    await expectPgError(transition('approved'), 'ILLEGAL_TRANSITION');
  });

  it('refuses to enter evaluating without a Git SHA', async () => {
    await expectPgError(transition('evaluating'), 'GIT_COMMIT_REQUIRED');
  });

  it('refuses to enter evaluating when the manifest lists no generated files', async () => {
    await commit({ state: 'committed', specHash: fixture.specHash, validation: {} });
    await expectPgError(transition('evaluating'), 'MANIFEST_GENERATED_FILES_REQUIRED');
  });

  it('refuses to enter evaluating without a validation block', async () => {
    await commit({
      state: 'committed',
      specHash: fixture.specHash,
      generatedFiles: ['agent.ts'],
    });
    await expectPgError(transition('evaluating'), 'MANIFEST_VALIDATION_REQUIRED');
  });

  it('walks generated → evaluating → approved and stamps approved_at', async () => {
    await commit();
    await transition('evaluating');
    await transition('approved');
    const { rows } = await asPostgres(async (client) =>
      client.query<{ status: string; approved_at: string | null }>(
        'select status, approved_at from public.agent_versions where agent_version_id = $1',
        [fixture.agentVersionId],
      ),
    );
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.approved_at).not.toBeNull();
  });

  it('allows a failed version to be re-evaluated', async () => {
    await commit();
    await transition('evaluating');
    await transition('failed');
    await expect(transition('evaluating')).resolves.toBeDefined();
  });

  it('rejects a status outside the transitionable set', async () => {
    await expectPgError(transition('generated'), 'STATUS_NOT_TRANSITIONABLE');
  });

  it('freezes lineage once the version leaves generated', async () => {
    await commit();
    await transition('evaluating');
    await expectPgError(
      asPostgres(async (client) =>
        client.query(
          'update public.agent_versions set git_commit_sha = $2 where agent_version_id = $1',
          [fixture.agentVersionId, fakeGitSha()],
        ),
      ),
      'AGENT_VERSION_LINEAGE_FROZEN',
    );
  });

  it('never touches the release pointer (A17)', async () => {
    await commit();
    await transition('evaluating');
    await transition('approved');
    const { rows } = await asPostgres(async (client) =>
      client.query<{ active_agent_version_id: string | null; status: string }>(
        'select active_agent_version_id, status from public.agents where agent_id = $1',
        [fixture.agentId],
      ),
    );
    // Approving is a statement about the code; activating is a statement about production. The
    // two are separate on purpose, so approval alone must leave the pointer null.
    expect(rows[0]).toMatchObject({ active_agent_version_id: null, status: 'draft' });
  });
});
