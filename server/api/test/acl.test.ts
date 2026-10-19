import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-032 — FR-081 read-path visibility (audit §2.1, register #1).
 *
 * The audit mutation-tested the suite and found that deleting the audience ACL
 * entirely was caught by only 2 of 33 tests: the suite covered exactly the two
 * surfaces that were already correct. This file sweeps EVERY by-id surface, so
 * a future endpoint that forgets the predicate reds here.
 *
 * Real Postgres, real GoTrue ES256 sessions, real app.request. The service key
 * is a fixture mechanism only and never appears in an access-control oracle.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const MARKER = `PRIVATEZZ${RUN}`; // a string that exists nowhere else in the DB

afterAll(async () => {
  await ctx.close();
});

async function addMember(archive: string, userId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );
}

async function restrict(archive: string, noteId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );
}

async function makeNote(s: RealSession, archive: string, title: string, body: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Every surface that takes a note id. A new one belongs in this table. */
const SURFACES: Array<{
  name: string;
  method: string;
  /** revisionId is passed so a surface can address a revision, not just a note */
  path: (a: string, n: string, revisionId: string) => string;
  /** built per-note, so `restore` can send a REAL revision id */
  body?: (noteId: string, revisionId: string) => unknown;
}> = [
  { name: 'note by id', method: 'GET', path: (a, n) => `/v1/archives/${a}/notes/${n}` },
  {
    name: 'revision history',
    method: 'GET',
    path: (a, n) => `/v1/archives/${a}/notes/${n}/revisions`,
  },
  { name: 'backlinks', method: 'GET', path: (a, n) => `/v1/archives/${a}/notes/${n}/backlinks` },
  {
    name: 'update',
    method: 'PUT',
    path: (a, n) => `/v1/archives/${a}/notes/${n}`,
    body: () => ({ body: 'overwritten by a non-author' }),
  },
  {
    name: 'restore',
    method: 'POST',
    path: (a, n) => `/v1/archives/${a}/notes/${n}/restore`,
    // a REAL revision id: sending a malformed body would 404 before the
    // visibility check runs, making the private case pass for the wrong reason
    body: (_n, revisionId) => ({ revisionId }),
  },
  // FM-039 added a SEVENTH by-id surface. Registering it here — rather than
  // only in provenance.test.ts — is what stops it drifting to a weaker gate:
  // narrowing this route to `created_by = $user` passes a creator-token test
  // and reds here, because the caller below is a co-member.
  {
    name: 'revision by id',
    method: 'GET',
    path: (a, n, revisionId) => `/v1/archives/${a}/notes/${n}/revisions/${revisionId}`,
  },
  // `delete` stays LAST: its negative control removes the open note, so any
  // surface after it 404s for a reason that has nothing to do with visibility.
  { name: 'delete', method: 'DELETE', path: (a, n) => `/v1/archives/${a}/notes/${n}` },
];

describe('FM-032 FR-081 read-path visibility', () => {
  it('a private note is unreachable by a co-member on every by-id surface', async () => {
    const owner = await ctx.realSession(`aclown-${RUN}@test.local`);
    const member = await ctx.realSession(`aclmem-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Acl ${RUN}`);
    await addMember(archive, member.userId);

    // TWO revisions: a fix that gates only the head row would pass a
    // one-revision fixture while still leaking the superseded body.
    const priv = await makeNote(owner, archive, `Private ${RUN}`, `${MARKER} v1`);
    const put = await ctx.api(owner.token, 'PUT', `/v1/archives/${archive}/notes/${priv}`, {
      body: `${MARKER} v2`,
    });
    expect(put.status).toBe(200);
    const revs = await ctx.pool.query(
      `select count(*)::int as n from public.revisions where note_id = $1`,
      [priv],
    );
    expect(revs.rows[0].n).toBe(2); // the fixture's own precondition
    await restrict(archive, priv);

    // NEGATIVE CONTROL: an unrestricted note by the same owner. If these also
    // 404 the fix is over-broad (it would mean membership, not audience, is
    // being tested) and the test must fail.
    const open = await makeNote(owner, archive, `Open ${RUN}`, 'ordinary shared memory');

    const revOf = async (noteId: string) =>
      (
        await ctx.pool.query<{ id: string }>(
          `select id from public.revisions where note_id = $1 order by seq desc limit 1`,
          [noteId],
        )
      ).rows[0]!.id;
    const privRev = await revOf(priv);
    const openRev = await revOf(open);

    for (const s of SURFACES) {
      const res = await ctx.api(
        member.token,
        s.method,
        s.path(archive, priv, privRev),
        s.body?.(priv, privRev),
      );
      expect(res.status, `${s.name} must 404 for a co-member`).toBe(404);
      const text = await res.text();
      // never 403: that would confirm the note exists
      expect(text, `${s.name} leaked the marker`).not.toContain(MARKER);

      // NEGATIVE CONTROL: the identical request against an UNRESTRICTED note
      // must succeed. Without this, a request that 404s for an unrelated reason
      // (a malformed body, say) would make the assertion above pass for the
      // wrong reason — which is exactly what it caught during development.
      const ctrl = await ctx.api(
        member.token,
        s.method,
        s.path(archive, open, openRev),
        s.body?.(open, openRev),
      );
      expect(ctrl.status, `${s.name} must still work on an unrestricted note`).toBeLessThan(300);
    }

    // the private note survived every write attempt above, byte-identical
    const after = await ctx.pool.query(`select body from public.notes where id = $1`, [priv]);
    expect(after.rows.length).toBe(1); // not deleted
    expect(after.rows[0].body).toBe(`${MARKER} v2`); // not overwritten

    // and the author still reaches all of it
    const asOwner = await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/notes/${priv}`);
    expect(asOwner.status).toBe(200);
    expect(await asOwner.text()).toContain(MARKER);
  });

  it('no role outside the write allow-list holds truncate on any public table', async () => {
    // TRUNCATE ignores row-level security, so a role holding it can empty every
    // archive while being unable to read a single row. Enumerate the catalog
    // rather than a hardcoded table list, so a NEW table is covered the moment
    // it exists.
    // postgres = table owner the app connects as; service_role = server-side
    // fixture/admin path, never handed to a user agent; supabase_admin = the
    // platform superuser that owns the Supabase stack itself. Any role OUTSIDE
    // this list holding TRUNCATE is the defect (audit register #2).
    const ALLOWED = ['postgres', 'supabase_admin', 'service_role'];
    const holders = await ctx.pool.query<{ tbl: string; grantee: string }>(
      `select c.relname as tbl, a.grantee
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) x
         join lateral (select pg_get_userbyid(x.grantee) as grantee) a on true
        where n.nspname = 'public' and c.relkind = 'r'
          and x.privilege_type = 'TRUNCATE'
        order by c.relname, a.grantee`,
    );
    const offenders = holders.rows.filter((r) => !ALLOWED.includes(r.grantee));
    expect(
      offenders.map((r) => `${r.grantee} can TRUNCATE ${r.tbl}`),
      'roles outside the allow-list hold TRUNCATE',
    ).toEqual([]);

    // the table set is non-empty — otherwise the assertion above is vacuous
    const tables = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from pg_class c join pg_namespace nsp on nsp.oid = c.relnamespace
        where nsp.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(tables.rows[0]!.n).toBeGreaterThanOrEqual(12);
  });
});
