import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * Undo never erases what somebody has built on, whatever the timing and however the
 * archive id is spelled; and an import whose notes are all gone keeps no trace of what it
 * was. The round-2 persistence review's findings #1, #3, #4 and #5.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seg = (i: number, speaker: string, text: string) => ({
  start: i * 10,
  end: i * 10 + 9,
  speaker,
  text,
});
const STORIES = [
  'My father repaired boats and he had big hands and he did not talk much at all.',
  'My mother sold fish at the market and she came home after sunset every single day.',
  'We lived in a shack made of scrap boards and the wind came through the walls in winter.',
];
const interview = (n = 3, tag = '') => ({
  interviewee: 'A',
  segments: Array.from({ length: n * 2 }, (_, i) =>
    i % 2 === 0
      ? seg(i, 'Q', 'And what do you remember about that time?')
      : seg(i, 'A', `${STORIES[((i - 1) / 2) % STORIES.length]!}${tag}`),
  ),
});

type Saved = { runId: string; jobId: string; saved: Array<{ id: string; title: string }> };
type Undone = {
  erased: number;
  kept: Array<{ id: string; title: string; reason: string }>;
  alreadyUndone: boolean;
};

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`iu-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `IU ${label} ${RUN}`);
  const post = (body: object, s: RealSession = owner) =>
    ctx.api(s.token, 'POST', `/v1/archives/${archive}/ingest`, body);
  const save = async (body: object) => (await (await post(body)).json()) as Saved;
  const undo = async (runId: string, s: RealSession = owner) =>
    (await (
      await ctx.api(s.token, 'POST', `/v1/archives/${archive}/ingest-runs/${runId}/undo`)
    ).json()) as Undone;
  const q = async (sql: string, p: unknown[]) => (await ctx.pool.query(sql, p)).rows;
  const bodyOf = async (id: string) =>
    ((await q(`select body from public.notes where id = $1`, [id]))[0] as { body: string }).body;
  const exists = async (id: string) =>
    (await q(`select 1 from public.notes where id = $1`, [id])).length === 1;
  return { owner, archive, post, save, undo, q, bodyOf, exists };
}

describe('#1 undo keeps a memory a person linked to from another memory of the same import', () => {
  it('a person edits memory A to link memory B: undo keeps A (edited) and B (linked)', async () => {
    const { owner, archive, save, undo, bodyOf, exists, q } = await setup('link-own');
    const out = await save({ transcript: interview(3), save: true });
    const [A, B, C] = out.saved;
    const put = await ctx.api(owner.token, 'PUT', `/v1/archives/${archive}/notes/${A!.id}`, {
      body: `${await bodyOf(A!.id)}\n\nSee also [[${B!.title}]].`,
    });
    expect(put.status).toBe(200);
    const u = await undo(out.runId);
    expect(u.erased).toBe(1);
    expect(u.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: A!.id, reason: 'edited' }),
        expect.objectContaining({ id: B!.id, reason: 'linked' }),
      ]),
    );
    expect(await exists(B!.id)).toBe(true);
    expect(await exists(C!.id)).toBe(false);
    // A's link to B still points at B
    const links = await q(`select resolved_id from public.links where source_id = $1`, [A!.id]);
    expect(links.map((r) => (r as { resolved_id: string }).resolved_id)).toContain(B!.id);
  });

  it('a link written between two memories while reviewing, which nobody touched since, does not hold the undo back', async () => {
    const { owner, archive, post, undo, exists } = await setup('link-review');
    const prev = (await (await post({ transcript: interview(2) })).json()) as {
      jobId: string;
      memories: Array<{ title: string; body: string }>;
    };
    const saved = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest/${prev.jobId}/save`, {
        memories: [
          { index: 1, body: `${prev.memories[1]!.body}\n\nSee [[${prev.memories[0]!.title}]].` },
        ],
      })
    ).json()) as Saved;
    const u = await undo(saved.runId);
    expect(u).toMatchObject({ erased: 2, kept: [] });
    for (const s of saved.saved) expect(await exists(s.id)).toBe(false);
  });
});

describe('#3 an edit that got 200 is never erased by an undo, however the archive id is spelled', () => {
  it('an edit sent with an UPPER-CASE archive id, still running when the undo starts: the undo waits and keeps it', async () => {
    const { owner, archive, save, undo, exists, q } = await setup('upper');
    const out = await save({ transcript: interview(2), save: true });
    const A = out.saved[0]!;
    // the edit is still writing when the undo arrives: it waits on the note's row, held here
    // (a body of 4,000 links did this until a note was capped at 1,000; round-3 review D7)
    const holder = await ctx.pool.connect();
    await holder.query('begin');
    await holder.query('select 1 from public.notes where id = $1 for update', [A.id]);
    const put = ctx.api(owner.token, 'PUT', `/v1/archives/${archive.toUpperCase()}/notes/${A.id}`, {
      body: 'My own correction to this memory, typed by hand.',
    });
    await sleep(250);
    const undone = undo(out.runId);
    await sleep(250);
    await holder.query('commit');
    holder.release();
    const [p, u] = await Promise.all([put, undone]);
    expect(p.status).toBe(200);
    expect(u.kept).toEqual([expect.objectContaining({ id: A.id, reason: 'edited' })]);
    expect(await exists(A.id)).toBe(true);
    expect(await q(`select 1 from public.tombstones where subject_id = $1`, [A.id])).toEqual([]);
  });

  it('a rename (UPPER-CASE id) and an undo of the import it renames, at once: no deadlock, nothing half-done', async () => {
    const { owner, archive, save, undo, exists } = await setup('rename-race');
    const out = await save({ transcript: interview(3), save: true });
    const A = out.saved[0]!;
    const [r, u] = await Promise.all([
      ctx.api(owner.token, 'PUT', `/v1/archives/${archive.toUpperCase()}/notes/${A.id}`, {
        title: `Renamed ${RUN}`,
      }),
      undo(out.runId),
    ]);
    // whichever went first, the other saw it: renamed and kept, or erased and the rename 404
    if (r.status === 200) {
      expect(await exists(A.id)).toBe(true);
      expect(u.kept.map((k) => k.id)).toContain(A.id);
    } else {
      expect(r.status).toBe(404);
      expect(await exists(A.id)).toBe(false);
    }
  });
});

describe('#4 an import whose notes are all gone keeps no file name, no hash and no guard, at once', () => {
  it('every note deleted by hand: the record is scrubbed by the delete itself, however old it is', async () => {
    const { owner, archive, save, q } = await setup('scrub');
    const out = await save({ transcript: interview(2), save: true, source: `old-tape-${RUN}.txt` });
    const row = async () =>
      (
        await q(
          `select source_label, source_hash is not null as has_hash, active
             from public.ingest_runs where id = $1`,
          [out.runId],
        )
      )[0];
    await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${out.saved[0]!.id}`);
    // one note left: still what it was
    expect(await row()).toEqual({
      source_label: `old-tape-${RUN}.txt`,
      has_hash: true,
      active: true,
    });
    await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${out.saved[1]!.id}`);
    // the last one gone: nothing left of what it was, without anyone listing the imports
    expect(await row()).toEqual({ source_label: null, has_hash: false, active: false });
  });

  it('the same interview can then be imported again, and the old record does not guard it', async () => {
    const { owner, archive, post, save } = await setup('scrub-again');
    const out = await save({ transcript: interview(2), save: true });
    for (const s of out.saved) {
      await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${s.id}`);
    }
    expect((await post({ transcript: interview(2), save: true })).status).toBe(200);
  });
});
