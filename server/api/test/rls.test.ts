import { Pool, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Local Supabase stack (must be running — these tests FAIL when it is down; loop rule 1).
const DB_URL =
  process.env.FUNMEM_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const pool = new Pool({ connectionString: DB_URL, max: 4 });

// Deterministic fixtures: two tenants, two archives, one member each.
const U1 = '00000000-0000-4000-8000-00000000aaa1';
const U2 = '00000000-0000-4000-8000-00000000aaa2';
const T1 = '00000000-0000-4000-8000-00000000bbb1';
const T2 = '00000000-0000-4000-8000-00000000bbb2';
const A1 = '00000000-0000-4000-8000-00000000ccc1';
const A2 = '00000000-0000-4000-8000-00000000ccc2';
const N1 = '00000000-0000-4000-8000-00000000ddd1';
const N2 = '00000000-0000-4000-8000-00000000ddd2';

type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;
interface Session {
  q: Q;
  /** Assert a statement is rejected, in a savepoint so the outer transaction survives. */
  rejects: (sql: string, params?: unknown[]) => Promise<Error>;
}

/** Run fn as a REAL authenticated session: policies evaluate, no service_role anywhere. */
async function asUser<T>(userId: string, fn: (s: Session) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
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
    return await fn({ q, rejects });
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

// Captured rather than thrown: a thrown beforeAll marks tests SKIPPED (numFailedTests=0),
// which pre-implementation reads as a false green. Re-throwing inside each test makes the
// red a real per-test failure (the honest pre-migration state).
let setupError: unknown = null;

beforeAll(async () => {
  try {
    const c = await pool.connect();
    await c.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4)
                   on conflict (id) do nothing`,
      [U1, 'u1@test.local', U2, 'u2@test.local'],
    );
    await c.query(
      `insert into public.tenants (id, kind, name) values
                   ($1, 'personal', 't1'), ($2, 'personal', 't2') on conflict (id) do nothing`,
      [T1, T2],
    );
    await c.query(
      `insert into public.archives (id, tenant_id, subject_name, jurisdiction) values
                   ($1, $2, 'Grandma Kim', 'KR'), ($3, $4, 'Someone Else', 'KR')
                   on conflict (id) do nothing`,
      [A1, T1, A2, T2],
    );
    await c.query(
      `insert into public.memberships (archive_id, user_id, role) values
                   ($1, $2, 'owner'), ($3, $4, 'owner') on conflict do nothing`,
      [A1, U1, A2, U2],
    );
    await c.query(
      `insert into public.notes (id, archive_id, title, type, body, created_by) values
                   ($1, $2, 'Beach Trip', 'event', 'We went with [[Mom]] to the sea.', $3),
                   ($4, $5, 'Secret Note', 'event', 'private of archive two', $6)
                   on conflict (id) do nothing`,
      [N1, A1, U1, N2, A2, U2],
    );
    await c.query(
      `insert into public.revisions (note_id, archive_id, author, title, body) values
                   ($1, $2, $3, 'Beach Trip', 'rev one') on conflict do nothing`,
      [N1, A1, U1],
    );
    c.release();
  } catch (e) {
    setupError = e;
  }
});

afterAll(async () => {
  await pool.end();
});

/** Fail the current test with the setup error if fixtures could not be seeded. */
function requireSetup(): void {
  if (setupError) throw setupError;
}

describe('FM-013 schema + RLS', () => {
  it('denies cross-archive and cross-tenant reads including snippets and counts', async () => {
    requireSetup();
    await asUser(U1, async ({ q, rejects }) => {
      const own = await q('select count(*)::int as n from public.notes where archive_id = $1', [
        A1,
      ]);
      expect(own.rows[0].n).toBeGreaterThan(0);
      // counts must not leak (FR-081)
      const foreignCount = await q(
        'select count(*)::int as n from public.notes where archive_id = $1',
        [A2],
      );
      expect(foreignCount.rows[0].n).toBe(0);
      // snippets/bodies must not leak
      const snippets = await q('select body from public.notes where archive_id = $1', [A2]);
      expect(snippets.rows).toEqual([]);
      const anyForeign = await q('select id from public.archives where id = $1', [A2]);
      expect(anyForeign.rows).toEqual([]);
      // writes into a foreign archive are refused outright (RLS with-check)
      await rejects(
        `insert into public.notes (archive_id, title, type, body) values ($1, 'sneak', 'event', 'x')`,
        [A2],
      );
    });
  });

  it('revision log is append-only under update and delete', async () => {
    requireSetup();
    // the trigger blocks EVERY role — including postgres — so this is honestly testable
    const c = await pool.connect();
    try {
      await expect(c.query(`update public.revisions set body = 'tampered'`)).rejects.toThrow(
        /append-only/i,
      );
      await expect(c.query(`delete from public.revisions`)).rejects.toThrow(/append-only/i);
    } finally {
      c.release();
    }
    await asUser(U1, async ({ rejects }) => {
      await rejects(`update public.revisions set body = 'tampered' where archive_id = $1`, [A1]);
    });
  });

  it('enforces case-insensitive title uniqueness per archive', async () => {
    requireSetup();
    await asUser(U1, async ({ q, rejects }) => {
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
    await asUser(U1, async ({ q, rejects }) => {
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
      // scope is constrained by the enum — anything else is rejected
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
