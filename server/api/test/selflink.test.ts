import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-051 — a note's own self-link must survive its rename.
 *
 * The defect is only reachable when a client sends title AND body together; the
 * shipped web client sends `{body}` alone, so every fixture here does what a
 * form-style client does and sends the whole object.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function note(s: RealSession, archive: string, title: string, body: string): Promise<string> {
  const r = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'person',
    body,
  });
  if (r.status !== 201) throw new Error(`create '${title}': ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

const linksOf = async (archive: string, sourceId: string) =>
  (
    await ctx.pool.query<{ target: string; resolved_id: string | null }>(
      `select target, resolved_id from public.links
        where archive_id = $1 and source_id = $2 order by start_pos`,
      [archive, sourceId],
    )
  ).rows;

const bodyOf = async (id: string) =>
  (await ctx.pool.query<{ body: string }>(`select body from public.notes where id = $1`, [id]))
    .rows[0]!.body;

describe('FM-051 self-link rename', () => {
  it('a self-link is rewritten when the rename request also supplies the body', async () => {
    const s = await ctx.realSession(`sl1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `SL1 ${RUN}`);
    const old = `Mom ${RUN}`;
    const other = `Dad ${RUN}`;
    await note(s, archive, other, 'A separate note.');
    const body = `Known as [[${old}]] by the grandkids, and married to [[${other}]].`;
    const id = await note(s, archive, old, body);

    // a form-style client: sends the whole object, body unchanged
    const next = `Grandma Kim ${RUN}`;
    const put = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, {
      title: next,
      body,
    });
    expect(put.status, await put.text()).toBe(200);

    const after = await bodyOf(id);
    expect(after, 'the self-link was left pointing at the old title').toContain(`[[${next}]]`);
    expect(after).not.toContain(`[[${old}]]`);
    // ONLY the self-title occurrence changes — other prose and other notes'
    // links are the author's words and are stored byte-for-byte
    expect(after, "another note's link was rewritten").toContain(`[[${other}]]`);
    expect(after).toBe(body.replace(`[[${old}]]`, `[[${next}]]`));

    const rows = await linksOf(archive, id);
    const self = rows.find((r) => r.target.trim() === next);
    expect(self, 'the self-link is missing entirely').toBeDefined();
    expect(self!.resolved_id, 'the self-link did not resolve to its own note').toBe(id);
  });

  it("a later note with the old title cannot claim a renamed note's self-link", async () => {
    const s = await ctx.realSession(`sl2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `SL2 ${RUN}`);
    const old = `Grandma ${RUN}`;
    const PRIVATE = `ZZPRIVATE${RUN}`;
    const body = `She is [[${old}]] to us. ${PRIVATE}`;
    const id = await note(s, archive, old, body);

    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, {
      title: `Kim Sun-ja ${RUN}`,
      body,
    });

    // an unrelated note now takes the freed title
    const stranger = await note(s, archive, old, 'A different person entirely.');

    const rows = await linksOf(archive, id);
    // The pre-committed kill is "points at the note's OWN id", not merely "not
    // the stranger": a regression that leaves resolved_id NULL satisfies the
    // weaker form and still leaves the link claimable by the next note to take
    // the title.
    const self = rows.find((r) => r.target.trim() === `Kim Sun-ja ${RUN}`);
    expect(self, 'the self-link is missing entirely').toBeDefined();
    expect(self!.resolved_id, 'the self-link does not point at its own note').toBe(id);
    for (const r of rows) {
      expect(r.resolved_id, 'a stranger claimed the renamed note self-link').not.toBe(stranger);
      expect(r.resolved_id, 'a link was left dangling').not.toBeNull();
    }
    // the disclosure: the stranger's backlinks must not carry the renamed
    // note's own sentence
    const backs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${stranger}/backlinks`,
    );
    const payload = JSON.stringify(await backs.json());
    expect(payload, "the renamed note's body leaked onto a stranger's page").not.toContain(PRIVATE);
  });

  it('restoring a revision whose title differs rewrites its self-links', async () => {
    const s = await ctx.realSession(`sl3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `SL3 ${RUN}`);
    const old = `Dad ${RUN}`;
    const now = `Kim Jae-ho ${RUN}`;
    // the note is CURRENTLY at the old title; the revision carries the new one
    const id = await note(s, archive, old, `Called [[${old}]] at home.`);

    // A revision whose TITLE and BODY disagree — title already renamed, body
    // still linking the old one. Seeded directly because the fixed PUT path can
    // no longer produce one, but a database written before this fix holds them
    // and restore is the entrance that resurrects them.
    await ctx.pool.query(
      `insert into public.revisions (note_id, archive_id, author, title, body, reason, change_id)
       values ($1, $2, $3, $4, $5, 'edit', $6)`,
      [id, archive, s.userId, now, `Called [[${old}]] at home.`, randomUUID()],
    );
    const revs = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}/revisions`);
    const list = (await revs.json()) as Array<{ id: string; title: string }>;
    const target = list.find((r) => r.title === now)!;

    const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes/${id}/restore`, {
      revisionId: target.id,
    });
    expect(res.status, await res.text()).toBe(200);

    const title = (
      await ctx.pool.query<{ title: string }>(`select title from public.notes where id = $1`, [id])
    ).rows[0]!.title;
    const after = await bodyOf(id);
    expect(after, 'the restored body still references a title this note does not have').toContain(
      `[[${title}]]`,
    );
    expect(after).not.toContain(`[[${old}]]`);

    const rows = await linksOf(archive, id);
    expect(
      rows.every((r) => r.resolved_id === id),
      'a restored self-link did not resolve to its own note',
    ).toBe(true);

    // folded into the restore's own revision — never a rename-cascade row
    const reasons = await ctx.pool.query<{ reason: string }>(
      `select reason::text from public.revisions where note_id = $1 order by seq`,
      [id],
    );
    expect(reasons.rows.map((r) => r.reason)).not.toContain('rename-cascade');
  });

  // NOT a required test. It asserts a true invariant — one revision per rename —
  // but it does NOT kill the mutant it was written for. Verified: with the
  // self-rewrite now unconditional, the body is already correct by the time
  // rewriteReferrers runs, so `rewritten === body` makes the self pass a no-op
  // and dropping `source_id <> $2` changes nothing observable. That filter is
  // now belt-and-braces rather than load-bearing. Recorded here so nobody
  // mistakes this test for protection it does not provide.
  it('renaming does not append a duplicate revision for the note itself', async () => {
    const s = await ctx.realSession(`sl4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `SL4 ${RUN}`);
    const old = `Uncle ${RUN}`;
    const next = `Kim Min-su ${RUN}`;
    // a mixed body: one occurrence of the OLD title and one of the NEW title.
    const body = `Both [[${old}]] and [[${next}]] appear here.`;
    await note(s, archive, next, 'The note that already holds the new title.');
    const id = await note(s, archive, old, body);

    const before = await ctx.pool.query<{ n: string }>(
      `select count(*)::text n from public.revisions where note_id = $1`,
      [id],
    );
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, {
      title: `${old} renamed`,
      body,
    });
    const after = await ctx.pool.query<{ n: string }>(
      `select count(*)::text n from public.revisions where note_id = $1`,
      [id],
    );
    expect(
      Number(after.rows[0]!.n) - Number(before.rows[0]!.n),
      'the note appended more than one revision for its own rename',
    ).toBe(1);
  });
});
