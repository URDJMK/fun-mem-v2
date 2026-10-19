import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';
import { mediaVisibleSql } from '../src/views';

/**
 * FM-064 — a photograph's audience is its home note's audience.
 *
 * These assert the CONTRACT'S PROPERTIES, not `media.note_id`. FM-057's DoD
 * named a MECHANISM and five review rounds went into discovering no version of
 * that mechanism was safe. This contract names properties, so the tests do too:
 * any implementation satisfying them passes.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function makeNote(s: RealSession, archive: string, title: string, body = '') {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Upload attached to a note, through the real route. */
async function upload(s: RealSession, archive: string, bytes: Buffer, note?: string) {
  const q = note ? `?note=${note}` : '';
  const r = await ctx.app.request(`/v1/archives/${archive}/media${q}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'image/png' },
    body: new Uint8Array(bytes),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, string> };
}

const addMember = (archive: string, userId: string) =>
  ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );

const restrict = (archive: string, noteId: string) =>
  ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );

const readByHash = (s: RealSession, archive: string, hash: string) =>
  ctx.app.request(`/v1/archives/${archive}/media/by-hash/${hash}`, {
    headers: { authorization: `Bearer ${s.token}` },
  });

/** Attach a media row to a note server-side (FM-065 owns the ?note= write path). */
async function home(mediaId: string, noteId: string) {
  await ctx.pool.query(`update public.media set note_id = $2 where id = $1`, [mediaId, noteId]);
}

describe('FM-064 a photograph belongs to a memory', () => {
  it('a photograph is visible to everyone who can read the memory it belongs to', async () => {
    /**
     * P1, and the function this whole line of work exists to restore. Under
     * FM-057's uploader rule this was 404: a member could not see a photograph
     * another member attached to a memory they could read. That was a real
     * loss, accepted deliberately because no safe derivation existed yet.
     */
    const owner = await ctx.realSession(`p1a-${RUN}@test.local`);
    const member = await ctx.realSession(`p1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `P1 ${RUN}`);
    await addMember(archive, member.userId);

    const note = await makeNote(owner, archive, `가족 사진 ${RUN}`);
    const up = await upload(owner, archive, Buffer.from(`ZZVISIBLE${RUN}\n`));
    expect(up.status).toBe(201);
    await home(up.body.id!, note);

    const r = await readByHash(member, archive, up.body.contentHash!);
    expect(r.status, 'a co-member cannot read a photograph in a memory they CAN read').toBe(200);
    expect(await r.text()).toContain(`ZZVISIBLE${RUN}`);
  });

  it('restricting the memory hides its photograph', async () => {
    /**
     * P2. The audience is READ OFF THE NOTE, not captured at attach time. If
     * anything cached or copied it, restricting the note afterwards would leave
     * the photograph readable.
     */
    const owner = await ctx.realSession(`p2a-${RUN}@test.local`);
    const member = await ctx.realSession(`p2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `P2 ${RUN}`);
    await addMember(archive, member.userId);

    const note = await makeNote(owner, archive, `비공개 예정 ${RUN}`);
    const up = await upload(owner, archive, Buffer.from(`ZZHIDE${RUN}\n`));
    await home(up.body.id!, note);

    expect((await readByHash(member, archive, up.body.contentHash!)).status).toBe(200);
    await restrict(archive, note);
    const after = await readByHash(member, archive, up.body.contentHash!);
    expect(after.status, 'restricting the memory left its photograph readable').toBe(404);
    expect(await after.text()).not.toContain(`ZZHIDE${RUN}`);
  });

  it('nothing a member writes gives them a photograph they could not already see', async () => {
    /**
     * P3, and the whole FM-057 saga in one test. Four derived rules failed
     * because `links` and `revisions` are CALLER-WRITABLE: `PUT /notes/:noteId`
     * lets any member edit any visible note with no author check. So the
     * attacker here does the two things that broke every earlier rule --
     * embeds the hash in their OWN note, and edits SOMEONE ELSE'S note to
     * embed it -- and must still be refused.
     */
    const owner = await ctx.realSession(`p3a-${RUN}@test.local`);
    const attacker = await ctx.realSession(`p3b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `P3 ${RUN}`);
    await addMember(archive, attacker.userId);

    const priv = await makeNote(owner, archive, `비공개 ${RUN}`);
    const up = await upload(owner, archive, Buffer.from(`ZZESCALATE${RUN}\n`));
    await home(up.body.id!, priv);
    await restrict(archive, priv);
    const hash = up.body.contentHash!;
    expect((await readByHash(attacker, archive, hash)).status).toBe(404);

    // (a) embed it in the attacker's own note
    await makeNote(attacker, archive, `내 노트 ${RUN}`, `![[${hash}]] 이건 내 노트야`);
    expect(
      (await readByHash(attacker, archive, hash)).status,
      'embedding the hash in your own note granted access — derivation is back',
    ).toBe(404);

    // (b) edit a note the attacker did NOT author, which is where the
    //     authorship-based rules died
    const host = await makeNote(owner, archive, `가족 이야기 ${RUN}`, '평범한 이야기');
    const edit = await ctx.api(attacker.token, 'PUT', `/v1/archives/${archive}/notes/${host}`, {
      body: `평범한 이야기\n\n![[${hash}]] 사진`,
    });
    expect(edit.status, 'fixture failed: the edit was refused, so nothing is proven').toBe(200);
    const after = await readByHash(attacker, archive, hash);
    expect(after.status, 'editing someone else s note granted access').toBe(404);
    expect(await after.text()).not.toContain(`ZZESCALATE${RUN}`);
  });

  it('a photograph with no memory is visible only to its uploader', async () => {
    /**
     * P4 — the NULL branch, and it FAILS CLOSED WITHOUT A NULL TEST.
     * `n.id = media.note_id` is unknown when `note_id` is NULL, so the `exists`
     * finds nothing and only `created_by` can match.
     *
     * This is a required test rather than a comment because FM-057's A6 shipped
     * `is not distinct from` here, which makes NULL MATCH NULL and fails OPEN:
     * a row with no home note became visible to a caller with no uploader.
     * Never reintroduce a NULL-tolerant comparison in this predicate.
     */
    const owner = await ctx.realSession(`p4a-${RUN}@test.local`);
    const member = await ctx.realSession(`p4b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `P4 ${RUN}`);
    await addMember(archive, member.userId);

    // A VISIBLE NOTE THE PHOTOGRAPH DOES NOT BELONG TO. Without it this test
    // cannot fail: a predicate that treats NULL `note_id` as "matches any
    // visible note" has nothing to match, so the leak stays invisible.
    // Verified by mutation -- `(n.id = m.note_id or m.note_id is null)` passed
    // this test until this note existed.
    await makeNote(owner, archive, `무관한 메모 ${RUN}`);

    const up = await upload(owner, archive, Buffer.from(`ZZLEGACY${RUN}\n`));
    await ctx.pool.query(`update public.media set note_id = null where id = $1`, [up.body.id]);

    expect(
      (await readByHash(owner, archive, up.body.contentHash!)).status,
      'the uploader lost their own unhomed photograph',
    ).toBe(200);
    expect(
      (await readByHash(member, archive, up.body.contentHash!)).status,
      'an unhomed photograph leaked to a co-member — the NULL branch failed open',
    ).toBe(404);
  });

  it('the RLS policy and the app predicate answer identically', async () => {
    /**
     * P5. The policy is a hand-rolled twin of `mediaVisibleSql` + `visibleSql`,
     * in SQL no TypeScript reads. Two copies of one authorization rule drift
     * unless something asserts they do not — so compare them BEHAVIOURALLY over
     * a fixture hitting every branch, for two different callers.
     */
    const owner = await ctx.realSession(`p5a-${RUN}@test.local`);
    const member = await ctx.realSession(`p5b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `P5 ${RUN}`);
    await addMember(archive, member.userId);

    const privNote = await makeNote(owner, archive, `비공개 트윈 ${RUN}`);
    const priv = await upload(owner, archive, Buffer.from(`ZZTWINPRIV${RUN}\n`));
    await home(priv.body.id!, privNote);
    await restrict(archive, privNote);

    const openNote = await makeNote(owner, archive, `공개 트윈 ${RUN}`);
    const open = await upload(owner, archive, Buffer.from(`ZZTWINOPEN${RUN}\n`));
    await home(open.body.id!, openNote);

    const theirs = await upload(member, archive, Buffer.from(`ZZTWINMINE${RUN}\n`));
    const legacy = await upload(owner, archive, Buffer.from(`ZZTWINLEGACY${RUN}\n`));
    await ctx.pool.query(`update public.media set note_id = null where id = $1`, [legacy.body.id]);

    for (const who of [owner, member]) {
      const app = await ctx.pool.query<{ id: string }>(
        `select m.id from public.media m
          where m.archive_id = $1 and ${mediaVisibleSql('m', '$1', '$2')}
          order by m.id`,
        [archive, who.userId],
      );
      const client = await ctx.pool.connect();
      let rls: string[];
      try {
        await client.query('begin');
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: who.userId, role: 'authenticated' }),
        ]);
        await client.query('set local role authenticated');
        const r = await client.query<{ id: string }>(
          `select id from public.media where archive_id = $1 order by id`,
          [archive],
        );
        rls = r.rows.map((x) => x.id);
      } finally {
        await client.query('rollback').catch(() => {});
        client.release();
      }
      expect(rls, `RLS and mediaVisibleSql disagree for ${who.userId}`).toEqual(
        app.rows.map((x) => x.id),
      );
    }

    // non-vacuity: an all-true or all-false predicate would satisfy the
    // equality above, so the two callers must see DIFFERENT sets
    const seen = async (u: RealSession) => {
      const r = await ctx.pool.query<{ id: string }>(
        `select m.id from public.media m where m.archive_id = $1 and ${mediaVisibleSql('m', '$1', '$2')}`,
        [archive, u.userId],
      );
      return r.rows.map((x) => x.id).sort();
    };
    const ownerSees = await seen(owner);
    const memberSees = await seen(member);
    expect(ownerSees, 'the fixture is vacuous: both callers see the same rows').not.toEqual(
      memberSees,
    );
    expect(memberSees, 'a co-member cannot see a photo in a visible memory').toContain(
      open.body.id!,
    );
    expect(memberSees, 'a co-member saw a photo in a private memory').not.toContain(priv.body.id!);
    expect(memberSees, 'a co-member cannot see their own upload').toContain(theirs.body.id!);
    expect(memberSees, 'a co-member saw someone else s unhomed row').not.toContain(legacy.body.id!);
  });

  it('reading a memory does not confer the right to erase its photographs', async () => {
    /**
     * FM-064 widened READS and deliberately did not widen erasure.
     *
     * The delete gate composed `mediaVisibleSql` while that predicate was
     * `created_by = caller`, which made it uploader-or-owner and kept
     * `media.ts`'s own sentence -- ERASURE AUTHORITY IS NOT READ AUTHORITY --
     * true. Widening the predicate would have silently handed every member who
     * can READ a memory the power to permanently destroy another member's
     * photograph and its bytes. Both panel models caught it; the gate now
     * spells out the uploader clause instead of composing it.
     *
     * If erasure should follow reads, that is FM-066's decision to make on
     * purpose. This test exists so it cannot happen by accident.
     */
    const owner = await ctx.realSession(`p6a-${RUN}@test.local`);
    const member = await ctx.realSession(`p6b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `P6 ${RUN}`);
    await addMember(archive, member.userId);

    const note = await makeNote(owner, archive, `공유 기억 ${RUN}`);
    const up = await upload(owner, archive, Buffer.from(`ZZERASE${RUN}\n`));
    await home(up.body.id!, note);

    // the member CAN read it -- that is FM-064 working
    expect(
      (await readByHash(member, archive, up.body.contentHash!)).status,
      'fixture: the member cannot read the photograph, so erasure proves nothing',
    ).toBe(200);

    // ...and still cannot destroy it
    const del = await ctx.app.request(`/v1/archives/${archive}/media/${up.body.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(del.status, 'reading a memory conferred the right to erase its photograph').toBe(404);
    expect(
      (await readByHash(owner, archive, up.body.contentHash!)).status,
      'the refused delete destroyed the photograph anyway',
    ).toBe(200);
  });
});
