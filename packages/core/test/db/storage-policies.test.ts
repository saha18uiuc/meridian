import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asPostgres,
  asUser,
  closePool,
  createTestUsers,
  truncateAll,
} from '../helpers/db.js';
import { seedActiveAgent, seedExecutionWithStep, type AgentFixture } from '../helpers/lineage.js';

/**
 * Stored artifacts inherit the visibility of the execution that produced them.
 *
 * The raw email, its attachments, and the OCR output are the evidence behind an extraction, so a
 * reviewer must be able to open them — and only for their own runs. Rather than maintain a second
 * ownership table for files, the path itself carries the lineage: the first folder segment is the
 * execution id, and the policy joins from there to the board owner. The convention is therefore
 * load-bearing, not documentation, and a file written outside it is invisible to everyone.
 */

const BUCKETS = ['emails', 'attachments', 'ocr', 'screenshots'] as const;

let mine: string;
let theirs: string;
let myExecutionId: string;
let theirExecutionId: string;
let myAgent: AgentFixture;

async function putObject(bucket: string, name: string): Promise<void> {
  await asPostgres(async (client) => {
    await client.query(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       values ($1, $2, null, '{}'::jsonb)`,
      [bucket, name],
    );
  });
}

async function visibleTo(userId: string, bucket: string): Promise<string[]> {
  return asUser(userId, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      'select name from storage.objects where bucket_id = $1 order by name',
      [bucket],
    );
    return rows.map((row) => row.name);
  });
}

beforeAll(async () => {
  await truncateAll();
  [mine, theirs] = (await createTestUsers(2)) as [string, string];
  myAgent = await seedActiveAgent(mine);
  myExecutionId = (await seedExecutionWithStep(myAgent)).executionId;
  const theirAgent = await seedActiveAgent(theirs);
  theirExecutionId = (await seedExecutionWithStep(theirAgent, { businessKey: 'MSKU7654321' }))
    .executionId;

  for (const bucket of BUCKETS) {
    await putObject(bucket, `${myExecutionId}/intake:MSKU1234565/message.eml`);
    await putObject(bucket, `${theirExecutionId}/intake:MSKU7654321/message.eml`);
  }
});

afterAll(async () => {
  // Storage rows are left behind on purpose: the API refuses direct deletes, and `truncateAll`
  // removes the users these paths hang off, which makes every one of them unreachable anyway.
  await truncateAll();
  await closePool();
});

describe('storage policies', () => {
  it('declares the four evidence buckets, all private', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ id: string; public: boolean }>(
        `select id, public from storage.buckets where id = any($1) order by id`,
        [[...BUCKETS]],
      ),
    );
    expect(rows.map((row) => row.id)).toEqual([...BUCKETS].sort());
    expect(rows.every((row) => row.public === false)).toBe(true);
  });

  it('shows an owner the artifacts of their own execution', async () => {
    for (const bucket of BUCKETS) {
      expect(await visibleTo(mine, bucket), bucket).toEqual([
        `${myExecutionId}/intake:MSKU1234565/message.eml`,
      ]);
    }
  });

  it('hides another owner\u2019s artifacts even in the same bucket', async () => {
    for (const bucket of BUCKETS) {
      const names = await visibleTo(theirs, bucket);
      expect(names, bucket).toEqual([`${theirExecutionId}/intake:MSKU7654321/message.eml`]);
    }
  });

  it('hides a file whose first path segment is not an execution id', async () => {
    // The path convention is the authorization rule. A file dropped at the bucket root has no
    // lineage to check, so it belongs to nobody and is visible to nobody.
    // Unique per run: storage rows outlive the test, since direct deletes are refused.
    await putObject('emails', `stray-${randomUUID()}.eml`);
    await putObject('emails', `${randomUUID()}/intake:X/message.eml`);
    expect(await visibleTo(mine, 'emails')).toEqual([
      `${myExecutionId}/intake:MSKU1234565/message.eml`,
    ]);
  });

  it('shows nothing to an anonymous visitor', async () => {
    const { rows } = await asAnon(async (client) =>
      client.query<{ count: string }>(
        `select count(*) as count from storage.objects where bucket_id = any($1)`,
        [[...BUCKETS]],
      ),
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('gives browser roles read access only', async () => {
    const { rows } = await asPostgres(async (client) =>
      client.query<{ cmd: string; roles: string[] }>(
        `select cmd, roles::text[] as roles from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname like 'p_storage_%'`,
      ),
    );
    const writable = rows.filter(
      (row) =>
        row.cmd !== 'SELECT' &&
        row.roles.some((role) => role === 'authenticated' || role === 'anon'),
    );
    expect(writable).toEqual([]);
    expect(rows.some((row) => row.cmd === 'SELECT')).toBe(true);
  });

  it('keeps visibility tied to the board, so a re-owned agent moves its evidence with it', async () => {
    // Ownership is read through the join at query time rather than copied onto the object row.
    // The consequence is that there is no second copy of the answer to go stale.
    await asPostgres(async (client) => {
      await client.query('update public.whiteboards set owner_id = $1 where whiteboard_id = $2', [
        theirs,
        myAgent.boardId,
      ]);
    });
    expect(await visibleTo(mine, 'emails')).toEqual([]);
    expect(await visibleTo(theirs, 'emails')).toContain(
      `${myExecutionId}/intake:MSKU1234565/message.eml`,
    );
  });
});
