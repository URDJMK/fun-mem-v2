import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { testContext, ANON_KEY, SUPABASE_URL, type RealSession } from './helpers';

/**
 * FM-068 — three holes that predate the photo-as-note work, all reachable when
 * this unit started, all verified live before being fixed.
 *
 * These are not feature tests. Two of them drive PostgREST directly with a real
 * user JWT, because the hole is in what the DATABASE allows a member to do, not
 * in what the API offers them.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

/** A PostgREST client bound to a real member's JWT — RLS applies, no service role. */
function asMember(s: RealSession) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${s.token}` } },
  });
}

const addMember = (archive: string, userId: string) =>
  ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );

async function upload(s: RealSession, archive: string, bytes: Buffer, mime = 'image/png') {
  const r = await ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': mime },
    body: new Uint8Array(bytes),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

describe('FM-068 media hardening', () => {
  it('a member cannot forge a media row through PostgREST', async () => {
    /**
     * P1. Both read routes stream from Storage BY HASH, so a media row is not a
     * record of access -- it is a KEY. `authenticated` held INSERT/UPDATE/DELETE
     * under a membership-only WITH CHECK, so a member could write a row naming
     * a hash they had learned with their own `created_by`, and the ACL check
     * would pass on their own forged row while someone else's bytes came back.
     */
    const owner = await ctx.realSession(`forge-a-${RUN}@test.local`);
    const attacker = await ctx.realSession(`forge-b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `FORGE ${RUN}`);
    await addMember(archive, attacker.userId);

    const secret = await upload(owner, archive, Buffer.from(`ZZFORGE${RUN}\n`, 'utf8'));
    expect(secret.status, 'fixture: owner upload failed').toBe(201);

    const db = asMember(attacker);
    const forged = await db
      .from('media')
      .insert({
        archive_id: archive,
        content_hash: secret.body.contentHash,
        mime: 'image/png',
        bytes: 32,
        created_by: attacker.userId,
      })
      .select();

    expect(forged.error, 'a member forged a media row through PostgREST').not.toBeNull();

    const rows = await ctx.pool.query<{ n: string }>(
      `select count(*)::int as n from public.media
        where archive_id = $1 and content_hash = $2 and created_by = $3`,
      [archive, secret.body.contentHash, attacker.userId],
    );
    expect(Number(rows.rows[0]!.n), 'the forged row exists in the database').toBe(0);
  });

  it("a co-member cannot read another member's media row through PostgREST", async () => {
    /**
     * FM-057's R1, its oldest residual. The policy was membership-only, so any
     * co-member could read every row's hash, mime, size and uploader -- and a
     * hash is the only hard part of the forgery above. The two holes compose,
     * which is why they close in one unit.
     */
    const owner = await ctx.realSession(`r1-a-${RUN}@test.local`);
    const other = await ctx.realSession(`r1-b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `R1 ${RUN}`);
    await addMember(archive, other.userId);

    const mine = await upload(owner, archive, Buffer.from(`ZZR1${RUN}\n`, 'utf8'));
    expect(mine.status).toBe(201);

    // the uploader still sees their own row: without this a policy of `false`
    // would satisfy the assertion below
    const own = await asMember(owner)
      .from('media')
      .select('content_hash')
      .eq('archive_id', archive);
    expect(own.error).toBeNull();
    expect(
      (own.data ?? []).map((r) => r.content_hash),
      'the uploader lost sight of their own row',
    ).toContain(mine.body.contentHash);

    const theirs = await asMember(other)
      .from('media')
      .select('content_hash,mime,bytes,created_by')
      .eq('archive_id', archive);
    expect(theirs.error).toBeNull();
    expect(
      (theirs.data ?? []).map((r) => r.content_hash),
      'R1 is open: a co-member enumerated another member s media',
    ).not.toContain(mine.body.contentHash);
  });

  it('a caller-chosen type is never served inline', async () => {
    /**
     * The trap FM-060 fell into twice: it "fixed" this with ordering, which
     * only protects a caller who OWNS a row for that hash. Here the caller owns
     * the only row and STILL must not get their declared type inline, because
     * the control is the allowlist, not the ordering.
     */
    const owner = await ctx.realSession(`mime-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `MIME ${RUN}`);
    const bytes = Buffer.from(`\x89PNG\r\n\x1a\n<script>ZZX${RUN}</script>`, 'binary');

    const up = await upload(owner, archive, bytes, 'text/html');
    expect(up.status).toBe(201);

    const served = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${up.body.contentHash}`,
      { headers: { authorization: `Bearer ${owner.token}` } },
    );
    expect(served.status).toBe(200);
    expect(
      served.headers.get('content-type') ?? '',
      'a caller-declared type was echoed back',
    ).not.toContain('text/html');
    expect(
      served.headers.get('content-disposition') ?? '',
      'a non-allowlisted type was served inline',
    ).toContain('attachment');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a legacy row with no uploader cannot win the mime for a shared hash', async () => {
    /**
     * TWO PROPERTIES, AND ONLY ONE OF THEM CAN FAIL TODAY. Stated plainly
     * because a required test that cannot fail is worse than no test, and this
     * contract froze this name before that was noticed.
     *
     * The `is true` in the ORDER BY is real and correct: `created_by` is NULL on
     * legacy and imported rows, `(NULL = $3)` is NULL, and DESC sorts NULLS
     * FIRST, so a bare `desc` puts an uploaderless row ahead of the caller's
     * own. But it is INERT under FM-068's predicate, which is
     * `created_by = caller` -- an uploaderless row is visible to nobody, so it
     * can never reach the ordering at all. It becomes load-bearing at FM-064,
     * when a row is visible through its home note rather than its uploader.
     * Verified rather than assumed: removing `is true` leaves this file green.
     *
     * What IS falsifiable today is determinism, and that is what the live half
     * asserts -- two visible rows sharing a hash must resolve to the SAME one
     * every time, the caller's oldest, not an arbitrary row.
     */
    const owner = await ctx.realSession(`nullord-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `NULLORD ${RUN}`);
    const bytes = Buffer.from(`ZZNULLORD${RUN}\n`, 'utf8');

    const first = await upload(owner, archive, bytes, 'image/png');
    expect(first.status).toBe(201);

    // a SECOND visible row on the same hash, newer, with a different
    // allowlisted type. Both are the caller's, so both pass the predicate.
    await ctx.pool.query(
      `insert into public.media (archive_id, content_hash, mime, bytes, created_by, created_at)
       values ($1, $2, 'image/gif', 10, $3, now() + interval '1 hour')`,
      [archive, first.body.contentHash, owner.userId],
    );
    // and an uploaderless row, which must not win -- trivially true now
    // (invisible), and kept honest by `is true` once FM-064 lands
    await ctx.pool.query(
      `insert into public.media (archive_id, content_hash, mime, bytes, created_by)
       values ($1, $2, 'text/html', 10, null)`,
      [archive, first.body.contentHash],
    );

    const served = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${first.body.contentHash}`,
      { headers: { authorization: `Bearer ${owner.token}` } },
    );
    expect(served.status).toBe(200);
    const type = served.headers.get('content-type') ?? '';
    expect(type, 'an uploaderless row won the ordering').not.toContain('text/html');
    expect(type, 'the ordering is not deterministic: the newer row won').toContain('image/png');
  });
});
