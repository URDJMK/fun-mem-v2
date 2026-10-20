import { Pool, type PoolClient, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANON_KEY, SUPABASE_URL, retryFetch, testContext } from './helpers';

/**
 * The database's own walls. The API is the only door to the data: it connects as the table
 * owner and applies membership, roles and private notes itself. The Supabase Data API
 * (PostgREST, GraphQL) runs as `anon` or `authenticated`, and those roles may read and write
 * NOTHING here (see the header of the initial migration). These tests pin that, and the
 * constraints that hold for every role: the append-only revision log, unique titles, the
 * consent ledger's scopes.
 *
 * Local Supabase stack must be running: these tests FAIL when it is down.
 */
const DB_URL =
  process.env.FUNMEM_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ctx = testContext();

// Deterministic fixtures: one tenant, one archive, one member, one note.
const U1 = '00000000-0000-4000-8000-00000000aaa1';
const T1 = '00000000-0000-4000-8000-00000000bbb1';
const A1 = '00000000-0000-4000-8000-00000000ccc1';
const N1 = '00000000-0000-4000-8000-00000000ddd1';

type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;
interface Session {
  q: Q;
  /** Assert a statement is rejected, in a savepoint so the outer transaction survives. */
  rejects: (sql: string, params?: unknown[]) => Promise<Error>;
}

function session(client: PoolClient): Session {
  const q: Q = (sql, params) => client.query(sql, params);
  const rejects = async (sql: string, params?: unknown[]): Promise<Error> => {
    await client.query('savepoint sp');
    try {
      await client.query(sql, params);
    } catch (e) {
      await client.query('rollback to savepoint sp');
      return e as Error;
    }
    await client.query('release savepoint sp');
    throw new Error(`expected rejection but statement succeeded: ${sql}`);
  };
  return { q, rejects };
}

/** Run fn in a transaction that is always rolled back, as `role` (a real Data API session) or as the owner. */
async function inRolledBack<T>(
  as: { role: 'authenticated'; userId: string } | { role: 'owner' },
  fn: (s: Session) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (as.role === 'authenticated') {
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: as.userId, role: 'authenticated' }),
      ]);
      await client.query('set local role authenticated');
    }
    return await fn(session(client));
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

// Captured rather than thrown: a thrown beforeAll marks tests SKIPPED, which reads as green.
let setupError: unknown = null;

beforeAll(async () => {
  try {
    await pool.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [U1, 'u1@test.local'],
    );
    await pool.query(
      `insert into public.tenants (id, kind, name) values ($1, 'personal', 't1')
       on conflict (id) do nothing`,
      [T1],
    );
    await pool.query(
      `insert into public.archives (id, tenant_id, subject_name, jurisdiction)
       values ($1, $2, 'Grandma Kim', 'US') on conflict (id) do nothing`,
      [A1, T1],
    );
    await pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'owner')
       on conflict do nothing`,
      [A1, U1],
    );
    await pool.query(
      `insert into public.notes (id, archive_id, title, type, body, created_by)
       values ($1, $2, 'Beach Trip', 'event', 'We went with [[Mom]] to the sea.', $3)
       on conflict (id) do nothing`,
      [N1, A1, U1],
    );
  } catch (e) {
    setupError = e;
  }
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

function requireSetup(): void {
  if (setupError) throw setupError;
}

describe('the Data API reaches nothing', () => {
  it('every public table has row-level security on, and anon and authenticated hold no privilege on any', async () => {
    requireSetup();
    const tables = await pool.query<{ name: string; rls: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by 1`,
    );
    // every table of the schema, so a table added later is covered the moment it exists
    expect(tables.rows.length).toBeGreaterThanOrEqual(13);
    expect(tables.rows.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);

    const granted = await pool.query<{ role: string; object: string; privilege: string }>(
      `select r.role, c.relname as object, p.privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('anon'), ('authenticated')) as r(role)
         cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                            ('references'), ('trigger')) as p(privilege)
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and has_table_privilege(r.role, c.oid, p.privilege)
       union all
       select r.role, c.relname, p.privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('anon'), ('authenticated')) as r(role)
         cross join (values ('usage'), ('select'), ('update')) as p(privilege)
        where n.nspname = 'public' and c.relkind = 'S'
          and has_sequence_privilege(r.role, c.oid, p.privilege)
       union all
       select r.role, f.proname, 'execute'
         from pg_proc f
         join pg_namespace n on n.oid = f.pronamespace
         cross join (values ('anon'), ('authenticated')) as r(role)
        where n.nspname in ('public', 'private')
          and has_function_privilege(r.role, f.oid, 'execute')`,
    );
    expect(granted.rows).toEqual([]);
  });

  it('a signed-in session in the database reads and writes nothing, even in its own archive', async () => {
    requireSetup();
    await inRolledBack({ role: 'authenticated', userId: U1 }, async ({ rejects }) => {
      for (const table of ['notes', 'archives', 'memberships', 'revisions', 'links', 'chunks']) {
        const err = await rejects(`select count(*) from public.${table}`);
        expect(err.message, table).toMatch(/permission denied/i);
      }
      const err = await rejects(
        `insert into public.notes (archive_id, title, type, body) values ($1, 'sneak', 'event', 'x')`,
        [A1],
      );
      expect(err.message).toMatch(/permission denied/i);
    });
  });

  it("through Supabase's REST API, a member's own token gets no table", async () => {
    requireSetup();
    const s = await ctx.realSession(`rest-${Date.now()}@test.local`);
    await ctx.provisionArchive(s, 'REST wall');
    for (const table of ['notes', 'archives', 'memberships', 'revisions']) {
      const res = await retryFetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
        headers: { apikey: ANON_KEY, authorization: `Bearer ${s.token}` },
      });
      // refused outright: never a 200 with rows, and never a 200 with an empty list either
      expect(res.status, table).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('constraints that hold for every role', () => {
  it('revision log is append-only under update and delete', async () => {
    requireSetup();
    await pool.query(
      `insert into public.revisions (note_id, archive_id, author, title, body)
       values ($1, $2, $3, 'Beach Trip', 'rev one')`,
      [N1, A1, U1],
    );
    // the trigger blocks EVERY role, the owner included, so this is honestly testable
    await expect(pool.query(`update public.revisions set body = 'tampered'`)).rejects.toThrow(
      /append-only/i,
    );
    await expect(pool.query(`delete from public.revisions`)).rejects.toThrow(/append-only/i);
  });

  it('enforces case-insensitive title uniqueness per archive', async () => {
    requireSetup();
    await inRolledBack({ role: 'owner' }, async ({ q, rejects }) => {
      const err = await rejects(
        `insert into public.notes (archive_id, title, type, body) values ($1, '  BEACH TRIP ', 'event', 'dup')`,
        [A1],
      );
      expect(String(err.message)).toMatch(/unique|duplicate/i);
      // the outer transaction survived the savepoint rollback
      const alive = await q(`select 1 as ok`);
      expect(alive.rows[0].ok).toBe(1);
    });
  });

  it('consent rows carry the eight independent scopes with withdrawal state', async () => {
    requireSetup();
    const SCOPES = [
      'storage',
      'ai_processing',
      'family_sharing',
      'persona',
      'voice',
      'likeness',
      'public_sharing',
      'commercial_use',
    ];
    await inRolledBack({ role: 'owner' }, async ({ q, rejects }) => {
      for (const scope of SCOPES) {
        await q(
          `insert into public.consents (archive_id, person, scope, audience, purpose, version)
           values ($1, $2, $3, 'archive-members', 'test', 1)`,
          [A1, U1, scope],
        );
      }
      const n = await q(`select count(*)::int as n from public.consents where archive_id = $1`, [
        A1,
      ]);
      expect(n.rows[0].n).toBe(SCOPES.length);
      // scope is constrained by the enum: anything else is rejected
      await rejects(
        `insert into public.consents (archive_id, person, scope, audience, purpose, version)
         values ($1, $2, 'telepathy', 'archive-members', 'test', 1)`,
        [A1, U1],
      );
      // withdrawal is a state change, recorded
      await q(
        `update public.consents set state = 'withdrawn' where archive_id = $1 and scope = 'voice'`,
        [A1],
      );
      const w = await q(
        `select count(*)::int as n from public.consents where archive_id = $1 and state = 'withdrawn'`,
        [A1],
      );
      expect(w.rows[0].n).toBe(1);
    });
  });
});
