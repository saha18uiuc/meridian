import type { Database } from '@meridian/core/database';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A tiny in-memory stand-in for the subset of PostgREST the recorder uses.
 *
 * It exists so the recorder's own logic — instance-key reuse, replay handling, oversize payload
 * offloading — can be tested without a database. It deliberately implements only the operations
 * the recorder actually performs; anything broader would drift from the real client and start
 * proving things about the fake instead of about the code.
 *
 * The transactional guarantees are NOT modelled here. Those are asserted against real PostgreSQL
 * in `packages/core/test/db/*`, which is the only place they mean anything.
 */

interface Row {
  [column: string]: unknown;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  uniques: Record<string, string[][]>;
  sequences: Record<string, number>;
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  rpcHandlers: Record<string, (args: Record<string, unknown>, db: FakeDb) => unknown>;
  storage: Record<string, { body: string; contentType: string }>;
}

export function createFakeDb(): FakeDb {
  return {
    tables: { execution_steps: [], execution_events: [], execution_actions: [] },
    uniques: {
      execution_steps: [['execution_id', 'step_instance_key', 'attempt_no']],
      execution_events: [['execution_id', 'idempotency_key']],
      execution_actions: [['idempotency_key']],
    },
    sequences: { event_id: 0 },
    rpcCalls: [],
    rpcHandlers: {},
    storage: {},
  };
}

class Query {
  private filters: [string, unknown][] = [];
  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
    private readonly mode: 'select' | 'insert' | 'update',
    private readonly payload?: Row,
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private run(): { data: Row | null; error: { message: string; code?: string } | null } {
    const rows = this.db.tables[this.table] ?? [];
    if (this.mode === 'insert') {
      const payload = { ...(this.payload ?? {}) };
      for (const columns of this.db.uniques[this.table] ?? []) {
        const conflicting = rows.some(
          (row) =>
            columns.every((column) => row[column] === payload[column]) &&
            columns.every((column) => payload[column] !== undefined && payload[column] !== null),
        );
        if (conflicting) {
          return { data: null, error: { message: 'duplicate key value', code: '23505' } };
        }
      }
      if (this.table === 'execution_steps') {
        payload.step_execution_id ??= `step-${String(rows.length + 1).padStart(4, '0')}`;
        payload.output_summary_json ??= {};
        payload.error_json ??= null;
        payload.completed_at ??= null;
      }
      if (this.table === 'execution_events') {
        this.db.sequences.event_id = (this.db.sequences.event_id ?? 0) + 1;
        payload.event_id = this.db.sequences.event_id;
        payload.created_at ??= '2026-01-01T00:00:00.000Z';
      }
      rows.push(payload);
      this.db.tables[this.table] = rows;
      return { data: payload, error: null };
    }

    if (this.mode === 'update') {
      const target = rows.find((row) => this.matches(row));
      if (target === undefined) return { data: null, error: null };
      Object.assign(target, this.payload ?? {});
      return { data: target, error: null };
    }

    return { data: rows.find((row) => this.matches(row)) ?? null, error: null };
  }

  async maybeSingle(): Promise<{
    data: Row | null;
    error: { message: string; code?: string } | null;
  }> {
    return this.run();
  }

  then<TResult>(resolve: (value: { data: Row[]; error: null }) => TResult): Promise<TResult> {
    const rows = (this.db.tables[this.table] ?? []).filter((row) => this.matches(row));
    return Promise.resolve(resolve({ data: rows, error: null }));
  }
}

export function createFakeSupabase(db: FakeDb): SupabaseClient<Database> {
  const client = {
    from(table: string) {
      return {
        select: () => new Query(db, table, 'select'),
        insert: (payload: Row) => new Query(db, table, 'insert', payload),
        update: (payload: Row) => new Query(db, table, 'update', payload),
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      db.rpcCalls.push({ name, args });
      const handler = db.rpcHandlers[name];
      if (handler === undefined)
        return { data: null, error: { message: `no handler for ${name}` } };
      return { data: handler(args, db), error: null };
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: ArrayBuffer, options: { contentType: string }) {
            db.storage[`${bucket}/${path}`] = {
              body: new TextDecoder().decode(body),
              contentType: options.contentType,
            };
            return { error: null };
          },
          async download(path: string) {
            const entry = db.storage[`${bucket}/${path}`];
            if (entry === undefined) return { data: null, error: { message: 'not found' } };
            return {
              data: { arrayBuffer: async () => new TextEncoder().encode(entry.body).buffer },
              error: null,
            };
          },
          async createSignedUrl(path: string) {
            return { data: { signedUrl: `https://signed.test/${bucket}/${path}` }, error: null };
          },
        };
      },
    },
  };
  return client as unknown as SupabaseClient<Database>;
}
