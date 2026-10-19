import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-056 — the rename cascade was a live FR-081 leak.
 *
 * Two queries in notes.ts carried no visibility predicate. `promoteUnresolved`
 * built the relationship (a member's dangling `[[title]]` silently resolved to
 * another member's private note) and `rewriteReferrers` fired it (renaming that
 * note rewrote the new title into the first member's body, with a permanent,
 * exported `rename-cascade` revision).
 *
 * The victim learns the title of a note they may not read, and their own words
 * are edited by a machine. Both halves are asserted here.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function makeNote(s: RealSession, archive: string, title: string, body: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'person',
    body,
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Fixture mechanism only — never an access-control oracle. */
async function restrict(archive: string, noteId: string) {
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );
}

async function addMember(archive: string, userId: string) {
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );
}

const rename = (s: RealSession, archive: string, noteId: string, title: string) =>
  ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${noteId}`, { title });

const bodyOf = async (noteId: string) =>
  (await ctx.pool.query<{ body: string }>(`select body from public.notes where id = $1`, [noteId]))
    .rows[0]!.body;

describe('FM-056 rename cascade visibility', () => {
  it("renaming a private note never rewrites another member's body", async () => {
    const owner = await ctx.realSession(`ra1a-${RUN}@test.local`);
    const other = await ctx.realSession(`ra1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `RA1 ${RUN}`);
    await addMember(archive, other.userId);

    const secretTitle = `비밀 ${RUN}`;
    const secret = await makeNote(owner, archive, secretTitle, '아무도 못 보는 이야기');
    await restrict(archive, secret);

    // the other member's own note happens to mention that title
    const theirs = await makeNote(other, archive, `내 노트 ${RUN}`, `[[${secretTitle}]] 이야기`);

    // POSITIVE CONTROL FIRST: an ORDINARY rename must still cascade, or this
    // test is satisfied by a fix that simply disables the feature.
    const openTitle = `공개 ${RUN}`;
    const open = await makeNote(owner, archive, openTitle, '누구나 보는 이야기');
    const refOpen = await makeNote(other, archive, `참조 ${RUN}`, `[[${openTitle}]] 참조`);
    expect((await rename(owner, archive, open, `공개수정 ${RUN}`)).status).toBe(200);
    expect(await bodyOf(refOpen), 'FM-016 ordinary rename stopped cascading').toContain(
      `공개수정 ${RUN}`,
    );

    // now the private one
    const newSecret = `비밀수정 ${RUN}`;
    expect((await rename(owner, archive, secret, newSecret)).status).toBe(200);

    const after = await bodyOf(theirs);
    expect(
      after,
      "a private note's new title was written into another member's body",
    ).not.toContain(newSecret);
    expect(after, 'the body was edited at all').toBe(`[[${secretTitle}]] 이야기`);
  });

  it("renaming a private note writes no revision into another member's note", async () => {
    const owner = await ctx.realSession(`ra2a-${RUN}@test.local`);
    const other = await ctx.realSession(`ra2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `RA2 ${RUN}`);
    await addMember(archive, other.userId);

    const t = `숨김 ${RUN}`;
    const secret = await makeNote(owner, archive, t, '비공개');
    await restrict(archive, secret);
    const theirs = await makeNote(other, archive, `기록 ${RUN}`, `[[${t}]] 참조`);

    const before = await ctx.pool.query(
      `select count(*) from public.revisions where note_id = $1`,
      [theirs],
    );
    await rename(owner, archive, secret, `숨김수정 ${RUN}`);
    const after = await ctx.pool.query<{ count: string; reason: string }>(
      `select count(*) as count, max(reason) as reason from public.revisions where note_id = $1`,
      [theirs],
    );

    // a rename-cascade revision is permanent and exported — a leak recorded
    // there cannot be undone by fixing the body afterwards
    expect(after.rows[0]!.count, 'a revision was appended to another member note').toBe(
      before.rows[0]!.count,
    );
    const leaked = await ctx.pool.query(
      `select 1 from public.revisions where note_id = $1 and body like $2`,
      [theirs, `%숨김수정 ${RUN}%`],
    );
    expect(leaked.rowCount, 'the private title leaked into the revision log').toBe(0);
  });

  it('an unresolved occurrence is never claimed by a note its author cannot see', async () => {
    const owner = await ctx.realSession(`ra3a-${RUN}@test.local`);
    const other = await ctx.realSession(`ra3b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `RA3 ${RUN}`);
    await addMember(archive, other.userId);

    // the dangling occurrence exists BEFORE the target does
    const t = `미래 ${RUN}`;
    const theirs = await makeNote(other, archive, `먼저 ${RUN}`, `[[${t}]] 언젠가`);
    const mine = await makeNote(owner, archive, `내것 ${RUN}`, `[[${t}]] 나도`);

    const target = await makeNote(owner, archive, t, '이제 생겼다');
    await restrict(archive, target);

    // Saving the SOURCE is what recomputes its links — reindexLinks is the
    // primary resolution site and the one this invariant most has to hold at.
    // (Saving the target would recompute the target's own outgoing links, not
    // these. An earlier draft of this test did exactly that and was asserting
    // against a path the product cannot take.)
    await ctx.api(other.token, 'PUT', `/v1/archives/${archive}/notes/${theirs}`, {
      body: `[[${t}]] 언젠가 그리고 더`,
    });
    await ctx.api(owner.token, 'PUT', `/v1/archives/${archive}/notes/${mine}`, {
      body: `[[${t}]] 나도 그리고 더`,
    });

    const theirLink = await ctx.pool.query<{ resolved_id: string | null }>(
      `select resolved_id from public.links where source_id = $1`,
      [theirs],
    );
    expect(
      theirLink.rows[0]!.resolved_id,
      'a private note claimed an occurrence in a note whose author cannot see it',
    ).toBeNull();

    // POSITIVE CONTROL: the OWNER's own occurrence does resolve — they can see it
    const myLink = await ctx.pool.query<{ resolved_id: string | null }>(
      `select resolved_id from public.links where source_id = $1`,
      [mine],
    );
    expect(myLink.rows[0]!.resolved_id, "the author's own occurrence failed to resolve").toBe(
      target,
    );

    // SYMMETRIC: the boundary holds in the other direction too. The owner's
    // note must not resolve to a private note authored by the other member.
    const theirSecret = await makeNote(other, archive, `그들비밀 ${RUN}`, '남의 비공개');
    await restrict(archive, theirSecret);
    const mineToTheirs = await makeNote(
      owner,
      archive,
      `역방향 ${RUN}`,
      `[[그들비밀 ${RUN}]] 참조`,
    );
    const rev = await ctx.pool.query<{ resolved_id: string | null }>(
      `select resolved_id from public.links where source_id = $1`,
      [mineToTheirs],
    );
    expect(
      rev.rows[0]!.resolved_id,
      'resolved across the audience boundary in the owner->other direction',
    ).toBeNull();
  });

  it('an occurrence that cannot be rewritten demotes to unresolved', async () => {
    const owner = await ctx.realSession(`ra4a-${RUN}@test.local`);
    const other = await ctx.realSession(`ra4b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `RA4 ${RUN}`);
    await addMember(archive, other.userId);

    // resolved while the target is visible to everyone
    const t = `전환 ${RUN}`;
    const target = await makeNote(owner, archive, t, '처음엔 공개');
    const theirs = await makeNote(other, archive, `가리킴 ${RUN}`, `[[${t}]] 가리킨다`);
    const linked = await ctx.pool.query<{ resolved_id: string | null }>(
      `select resolved_id from public.links where source_id = $1`,
      [theirs],
    );
    expect(linked.rows[0]!.resolved_id, 'the fixture never resolved in the first place').toBe(
      target,
    );

    // ...then it becomes private and is renamed
    await restrict(archive, target);
    await rename(owner, archive, target, `전환수정 ${RUN}`);

    const after = await ctx.pool.query<{ resolved_id: string | null }>(
      `select resolved_id from public.links where source_id = $1`,
      [theirs],
    );
    expect(
      after.rows[0]!.resolved_id,
      'a stale resolved_id still points at a note the source author cannot see',
    ).toBeNull();

    // AND the body and revision log, which resolved_id alone does not pin.
    // Review found that dropping the visibility join from the referrer SELECT
    // passed every test: the rewrite happened, the victim's body was edited and
    // a rename-cascade revision appended, and the demotion then re-nulled
    // resolved_id afterwards — so the only assertion looked identical either
    // way. The leak is the BODY and the REVISION; those are what must be checked.
    expect(await bodyOf(theirs), "the referrer's body was rewritten anyway").toBe(
      `[[${t}]] 가리킨다`,
    );
    const revs = await ctx.pool.query(
      `select 1 from public.revisions where note_id = $1 and reason = 'rename-cascade'`,
      [theirs],
    );
    expect(revs.rowCount, 'a rename-cascade revision was appended anyway').toBe(0);
  });

  it('renaming a restricted note onto a dangling title never claims it', async () => {
    // Pins `promoteUnresolved` ON ITS OWN. Every earlier test creates the target
    // BEFORE restricting it, so the claim happens while the note is still
    // visible and the archive-wide version behaves identically — review found a
    // mutant reverting promoteUnresolved alone passed the whole suite.
    //
    // Here the note is ALREADY restricted when it acquires the title, so the
    // claim is the only thing that can resolve the occurrence.
    {
      const owner = await ctx.realSession(`ra5a-${RUN}@test.local`);
      const other = await ctx.realSession(`ra5b-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(owner, `RA5 ${RUN}`);
      await addMember(archive, other.userId);

      const wanted = `나중이름 ${RUN}`;
      const theirs = await makeNote(other, archive, `대기 ${RUN}`, `[[${wanted}]] 기다린다`);
      const mine = await makeNote(owner, archive, `내대기 ${RUN}`, `[[${wanted}]] 나도`);

      const secret = await makeNote(owner, archive, `임시 ${RUN}`, '비공개 내용');
      await restrict(archive, secret);
      // the rename is what calls promoteUnresolved with the new title
      expect((await rename(owner, archive, secret, wanted)).status).toBe(200);

      const theirLink = await ctx.pool.query<{ resolved_id: string | null }>(
        `select resolved_id from public.links where source_id = $1`,
        [theirs],
      );
      expect(
        theirLink.rows[0]!.resolved_id,
        'a restricted note claimed a dangling occurrence in a note whose author cannot see it',
      ).toBeNull();

      // POSITIVE CONTROL: the owner's own dangling occurrence IS claimed
      const myLink = await ctx.pool.query<{ resolved_id: string | null }>(
        `select resolved_id from public.links where source_id = $1`,
        [mine],
      );
      expect(myLink.rows[0]!.resolved_id, "the author's own occurrence was not claimed").toBe(
        secret,
      );
    }
  });
});
