import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { persistImport, resolveTitles } from '../src/ingest-save';
import type { IngestResult } from '../src/ingest-pipeline';
import { ModelError, type ChatModel } from '../src/nim';
import { testContext, type RealSession } from './helpers';

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  ctx.deps.chat = null;
});

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
  'I only finished fifth grade but my teacher said I had the most beautiful handwriting.',
  'At eighteen I started at a textile factory and I gave my whole pay to my mother.',
];
const interview = (n = 5, tag = '') => ({
  interviewee: 'A',
  segments: Array.from({ length: n * 2 }, (_, i) =>
    i % 2 === 0
      ? seg(i, 'Q', 'And what do you remember about that time?')
      : seg(i, 'A', `${STORIES[((i - 1) / 2) % STORIES.length]!}${tag}`),
  ),
});

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`is-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `IS ${label} ${RUN}`);
  const post = (body: object, s: RealSession = owner) =>
    ctx.api(s.token, 'POST', `/v1/archives/${archive}/ingest`, body);
  const noteCount = async () =>
    (
      (
        await ctx.pool.query(`select count(*)::int as n from public.notes where archive_id = $1`, [
          archive,
        ])
      ).rows[0] as { n: number }
    ).n;
  return { owner, archive, post, noteCount };
}

describe('titles are unique and no memory is ever dropped', () => {
  it('twelve memories with the same title all land, told apart by their time and then a number', async () => {
    const { archive, owner, post, noteCount } = await setup('titles');
    const same = {
      interviewee: 'A',
      segments: Array.from({ length: 24 }, (_, i) =>
        i % 2 === 0
          ? seg(i, 'Q', 'Tell me more about that day please.')
          : seg(i, 'A', 'The wedding was in the spring and everybody came to the church that day.'),
      ),
    };
    const res = await post({ transcript: same, save: true });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { memories: unknown[]; saved: Array<{ title: string }> };
    expect(out.memories).toHaveLength(12);
    expect(out.saved).toHaveLength(12);
    expect(await noteCount()).toBe(12);
    const titles = out.saved.map((s) => s.title);
    expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(12);
    expect(titles[0]).toBe('The wedding was in the spring');
    expect(titles[1]).toMatch(/\(\d+:\d{2}\)$/);
    void archive;
    void owner;
  });

  it('avoids titles the archive already has, whatever their case', async () => {
    const { archive, owner, pool_ } = { ...(await setup('titles2')), pool_: ctx.pool };
    await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'MY FATHER REPAIRED BOATS AND HE HAD BIG HANDS AND HE DID NOT',
      type: 'event',
      body: 'x',
    });
    const titles = await resolveTitles(pool_, archive, [
      { title: 'My father repaired boats and he had big hands and he did not', hint: '1:05' },
    ]);
    expect(titles[0]).toBe('My father repaired boats and he had big hands and he did not (1:05)');
  });
});

describe('the same interview is never filed twice', () => {
  it('uploading it again is refused, with the date and size of the first import', async () => {
    const { post, noteCount } = await setup('dup');
    expect(
      (await post({ transcript: interview(), save: true, source: 'grandma.json' })).status,
    ).toBe(200);
    const again = await post({ transcript: interview(), save: true });
    expect(again.status).toBe(409);
    const body = (await again.json()) as {
      code: string;
      duplicateOf: { noteCount: number; source: string; createdAt: string };
    };
    expect(body.code).toBe('duplicate');
    expect(body.duplicateOf).toMatchObject({ noteCount: 5, source: 'grandma.json' });
    expect(await noteCount()).toBe(5);
  });

  it('the same words in a different file format are the same interview', async () => {
    const { post, noteCount } = await setup('dupfmt');
    await post({ transcript: interview(3), save: true });
    const txt = interview(3)
      .segments.map((s) => `[${s.speaker}]: ${s.text}`)
      .join('\n');
    expect((await post({ transcript: txt, interviewee: 'A', save: true })).status).toBe(409);
    expect(await noteCount()).toBe(3);
  });

  it('a double-click: two simultaneous requests file it once', async () => {
    const { post, noteCount } = await setup('dbl');
    const [a, b] = await Promise.all([
      post({ transcript: interview(), save: true }),
      post({ transcript: interview(), save: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 429]); // one wins; the other is told another import is running
    expect(await noteCount()).toBe(5);
  });

  it('a preview warns that it was already imported, without blocking', async () => {
    const { post } = await setup('dupprev');
    await post({ transcript: interview(), save: true });
    const prev = await post({ transcript: interview() });
    expect(prev.status).toBe(200);
    expect(
      ((await prev.json()) as { status: string; duplicateOf?: unknown }).duplicateOf,
    ).toBeTruthy();
  });

  it('"import it again anyway" does, and from then on guards against the newest import', async () => {
    const { post, noteCount } = await setup('force');
    await post({ transcript: interview(2), save: true });
    expect((await post({ transcript: interview(2), save: true, force: true })).status).toBe(200);
    expect(await noteCount()).toBe(4);
    expect((await post({ transcript: interview(2), save: true })).status).toBe(409);
  });

  it('a different interview is not a duplicate, and a record whose notes were all deleted no longer guards', async () => {
    const { post, owner, archive, noteCount } = await setup('stale');
    const first = (await (await post({ transcript: interview(2), save: true })).json()) as {
      saved: Array<{ id: string }>;
    };
    expect((await post({ transcript: interview(2, ' Again.'), save: true })).status).toBe(200);
    for (const s of first.saved)
      await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${s.id}`);
    expect(await noteCount()).toBe(2);
    expect((await post({ transcript: interview(2), save: true })).status).toBe(200); // the stale record retired itself
    expect(await noteCount()).toBe(4);
  });
});

describe('a save is all or nothing', () => {
  it('a failure in the middle of the batch leaves no notes and no import record', async () => {
    const { archive, owner, noteCount } = await setup('atomic');
    const bad = (body: string) => ({
      title: 'T',
      type: 'event',
      occurred: null,
      body,
      notes: [],
      turns: [0],
      startSec: null,
      endSec: null,
      method: 'verbatim',
      speaker: 'A',
    });
    const result = {
      sourceHash: randomUUID(),
      language: 'en',
      memories: [
        { ...bad('first fine'), title: 'One' },
        { ...bad('second fine'), title: 'Two' },
        { ...bad('has a NUL \u0000 byte'), title: 'Three' },
        { ...bad('fourth fine'), title: 'Four' },
      ],
    } as unknown as IngestResult;
    await expect(persistImport(ctx.deps, archive, owner.userId, result)).rejects.toThrow();
    expect(await noteCount()).toBe(0);
    const runs = await ctx.pool.query(
      `select count(*)::int as n from public.ingest_runs where archive_id = $1`,
      [archive],
    );
    expect((runs.rows[0] as { n: number }).n).toBe(0);
  });

  it('every note of an import shares one change id, which is how it is found again', async () => {
    const { post, archive } = await setup('change');
    const out = (await (await post({ transcript: interview(4), save: true })).json()) as {
      saved: Array<{ id: string }>;
      runId: string;
    };
    const ids = (
      await ctx.pool.query(
        `select distinct change_id from public.revisions where archive_id = $1`,
        [archive],
      )
    ).rows;
    expect(ids).toHaveLength(1);
    const run = (
      await ctx.pool.query(`select change_id, note_count from public.ingest_runs where id = $1`, [
        out.runId,
      ])
    ).rows[0] as { change_id: string; note_count: number };
    expect(run.change_id).toBe((ids[0] as { change_id: string }).change_id);
    expect(run.note_count).toBe(4);
    const reasons = await ctx.pool.query(
      `select distinct reason from public.revisions where archive_id = $1`,
      [archive],
    );
    expect(reasons.rows).toEqual([{ reason: 'ai-suggestion' }]);
  });
});

describe('undo', () => {
  it('erases exactly the notes of that import, with tombstones, and the interview can be imported again', async () => {
    const { post, owner, archive, noteCount } = await setup('undo');
    await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Mine',
      type: 'event',
      body: 'untouched',
    });
    const out = (await (await post({ transcript: interview(), save: true })).json()) as {
      runId: string;
    };
    expect(await noteCount()).toBe(6);
    const res = await ctx.api(
      owner.token,
      'POST',
      `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ erased: 5, kept: [], alreadyUndone: false });
    expect(await noteCount()).toBe(1);
    const stones = await ctx.pool.query(
      `select count(*)::int as n from public.tombstones where archive_id = $1 and kind = 'note'`,
      [archive],
    );
    expect((stones.rows[0] as { n: number }).n).toBe(5);
    const revs = await ctx.pool.query(
      `select count(*)::int as n from public.revisions where archive_id = $1`,
      [archive],
    );
    expect((revs.rows[0] as { n: number }).n).toBe(1); // the erased notes' revisions are gone, content and all
    expect((await post({ transcript: interview(), save: true })).status).toBe(200); // no longer a duplicate
  });

  it('never erases a note somebody has edited since, and says which it kept', async () => {
    const { post, owner, archive, noteCount } = await setup('undo2');
    const out = (await (await post({ transcript: interview(3), save: true })).json()) as {
      runId: string;
      saved: Array<{ id: string; title: string }>;
    };
    await ctx.api(owner.token, 'PUT', `/v1/archives/${archive}/notes/${out.saved[1]!.id}`, {
      body: 'I added my own memory to this one.',
    });
    const res = await ctx.api(
      owner.token,
      'POST',
      `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`,
    );
    expect(await res.json()).toMatchObject({
      erased: 2,
      kept: [{ id: out.saved[1]!.id, reason: 'edited' }],
    });
    expect(await noteCount()).toBe(1);
  });

  it('only whoever imported it, or an owner, may undo; a second undo does nothing; a stranger learns nothing', async () => {
    const { post, owner, archive } = await setup('undo3');
    const out = (await (await post({ transcript: interview(2), save: true })).json()) as {
      runId: string;
    };
    const member = await ctx.realSession(`is-member-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, member.userId],
    );
    const forbidden = await ctx.api(
      member.token,
      'POST',
      `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`,
    );
    expect(forbidden.status).toBe(403);
    const stranger = await ctx.realSession(`is-stranger-${RUN}-${n++}@test.local`);
    expect(
      (
        await ctx.api(
          stranger.token,
          'POST',
          `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`))
        .status,
    ).toBe(200);
    expect(
      await (
        await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`)
      ).json(),
    ).toMatchObject({ alreadyUndone: true, erased: 0 });
    expect(
      (
        await ctx.api(
          owner.token,
          'POST',
          `/v1/archives/${archive}/ingest-runs/${randomUUID()}/undo`,
        )
      ).status,
    ).toBe(404);
  });

  it("lists the archive's imports, newest first, with what is left of each (an undone one keeps no file name)", async () => {
    const { post, owner, archive } = await setup('list');
    const a = (await (
      await post({ transcript: interview(2), save: true, source: 'a.json' })
    ).json()) as { runId: string };
    await post({ transcript: interview(3, ' Later.'), save: true, source: 'b.json' });
    await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest-runs/${a.runId}/undo`);
    const list = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/ingest-runs`)
    ).json()) as Array<{ source: string; notes: number; undone: boolean; mine: boolean }>;
    // FR-143: the undone import's file name went with its notes (this test used to expect it kept)
    expect(list.map((r) => [r.source, r.notes, r.undone, r.mine])).toEqual([
      ['b.json', 3, false, true],
      [null, 0, true, true],
    ]);
  });
});

describe('preview, edit, then save', () => {
  it("a preview writes nothing; saving it applies the person's edits atomically, once", async () => {
    const { post, owner, archive, noteCount } = await setup('prev');
    const prev = (await (await post({ transcript: interview(4) })).json()) as {
      status: string;
      jobId: string;
      memories: Array<{ title: string }>;
    };
    expect(prev.status).toBe('previewed');
    expect(await noteCount()).toBe(0);

    const save = (body: object) =>
      ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest/${prev.jobId}/save`, body);
    const bad = await save({ memories: [{ index: 99, skip: true }] });
    expect(bad.status).toBe(400);
    expect((await save({ memories: [{ index: 0, title: 'has [brackets]' }] })).status).toBe(400);
    expect((await save({ memories: [{ index: 0, occurred: 'sometime' }] })).status).toBe(400);
    expect(await noteCount()).toBe(0); // a rejected edit saves nothing

    const ok = await save({
      memories: [
        { index: 0, skip: true },
        {
          index: 1,
          title: 'My mother at the market',
          body: 'My own edited words about my mother.',
          occurred: '1952',
        },
      ],
    });
    expect(ok.status).toBe(200);
    const out = (await ok.json()) as { status: string; saved: Array<{ title: string }> };
    expect(out.status).toBe('saved');
    expect(out.saved).toHaveLength(3);
    expect(out.saved[0]!.title).toBe('My mother at the market');
    const row = (
      await ctx.pool.query(
        `select body, occurred from public.notes where archive_id = $1 and title = 'My mother at the market'`,
        [archive],
      )
    ).rows[0] as { body: string; occurred: string };
    expect(row).toEqual({ body: 'My own edited words about my mother.', occurred: '1952' });
    expect((await save({})).status).toBe(409); // already saved
    expect(await noteCount()).toBe(3);
  });

  it('saving an empty selection is refused rather than creating an empty import', async () => {
    const { post, owner, archive } = await setup('prev2');
    const prev = (await (await post({ transcript: interview(2) })).json()) as { jobId: string };
    const res = await ctx.api(
      owner.token,
      'POST',
      `/v1/archives/${archive}/ingest/${prev.jobId}/save`,
      {
        memories: [
          { index: 0, skip: true },
          { index: 1, skip: true },
        ],
      },
    );
    expect(res.status).toBe(400);
  });
});

describe('an uncertain interviewee is never saved without a person looking', () => {
  const closeCall = {
    segments: Array.from({ length: 8 }, (_, i) =>
      seg(i, i % 2 ? 'B' : 'A', STORIES[i % STORIES.length]!),
    ),
  };

  it('needs confirmation first; confirming saves the same preview without asking the AI again', async () => {
    const { post, owner, archive, noteCount } = await setup('conf');
    const res = await post({ transcript: closeCall, save: true });
    const first = (await res.json()) as {
      status: string;
      jobId: string;
      roles: { confidence: string; needsConfirmation: boolean };
      saved?: unknown;
    };
    expect(first).toMatchObject({
      status: 'needs_confirmation',
      roles: { confidence: 'low', needsConfirmation: true },
    });
    expect(first.saved).toBeUndefined();
    expect(await noteCount()).toBe(0);
    const done = await ctx.api(
      owner.token,
      'POST',
      `/v1/archives/${archive}/ingest/${first.jobId}/save`,
      {},
    );
    expect(done.status).toBe(200);
    expect(await noteCount()).toBeGreaterThan(0);
  });

  it('naming the speakers (or confirming) saves at once', async () => {
    const a = await setup('conf2');
    expect(
      (
        (await (
          await a.post({ transcript: closeCall, save: true, interviewees: ['A'] })
        ).json()) as { status: string }
      ).status,
    ).toBe('saved');
    const b = await setup('conf3');
    expect(
      (
        (await (await b.post({ transcript: closeCall, save: true, confirm: true })).json()) as {
          status: string;
        }
      ).status,
    ).toBe('saved');
  });
});

describe('jobs: progress, cancel, ownership and limits', () => {
  const slowChat = (gate: { release: () => void }): ChatModel => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((r) => (open = r));
    gate.release = open;
    return {
      id: 'slow',
      complete: async (_s, _u, o) => {
        await Promise.race([
          opened,
          new Promise((_r, rej) =>
            o?.signal?.addEventListener('abort', () =>
              rej(new ModelError('cancelled', 'cancelled', false)),
            ),
          ),
        ]);
        return '{"memories":[]}';
      },
    };
  };
  const poll = async (
    s: RealSession,
    archive: string,
    id: string,
    until: (v: { status: string }) => boolean,
  ) => {
    for (let i = 0; i < 100; i++) {
      const v = (await (
        await ctx.api(s.token, 'GET', `/v1/archives/${archive}/ingest/${id}`)
      ).json()) as { status: string; stage: string; outcome?: { status: string } };
      if (until(v)) return v;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('timed out waiting for the job');
  };

  it('async: starts at once with 202, reports its stage, and finishes with the outcome', async () => {
    const { post, owner, archive } = await setup('async');
    const gate = { release: () => undefined };
    ctx.deps.chat = slowChat(gate);
    const started = await post({ transcript: interview(3), save: true, async: true });
    expect(started.status).toBe(202);
    const job = (await started.json()) as { id: string; status: string };
    const mid = await poll(owner, archive, job.id, (v) => v.status === 'running');
    expect(mid.status).toBe('running');
    gate.release();
    const done = await poll(owner, archive, job.id, (v) => v.status !== 'running');
    expect(done).toMatchObject({
      status: 'succeeded',
      stage: 'done',
      outcome: { status: 'saved' },
    });
  });

  it('a second import into an archive that is busy is told so, and told how long to wait', async () => {
    const { post, owner, archive } = await setup('busy');
    const gate = { release: () => undefined };
    ctx.deps.chat = slowChat(gate);
    const first = (await (await post({ transcript: interview(3), async: true })).json()) as {
      id: string;
    };
    const second = await post({ transcript: interview(3, ' Other.') });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    expect(await second.json()).toMatchObject({ code: 'busy', reason: 'archive', jobId: first.id });
    gate.release();
    await poll(owner, archive, first.id, (v) => v.status !== 'running');
    expect((await post({ transcript: interview(3, ' Other.') })).status).toBe(200); // free again
  });

  it('a busy answer names the job only to the person who started it; another member is just told to wait', async () => {
    const { post, owner, archive } = await setup('busy2');
    const gate = { release: () => undefined };
    ctx.deps.chat = slowChat(gate);
    const mine = (await (await post({ transcript: interview(3), async: true })).json()) as {
      id: string;
    };
    const member = await ctx.realSession(`is-bm-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, member.userId],
    );
    const theirs = await ctx.api(member.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: interview(3, ' Other.'),
    });
    expect(theirs.status).toBe(429);
    expect(await theirs.json()).toMatchObject({ code: 'busy', reason: 'archive', jobId: null });
    const again = await post({ transcript: interview(3, ' Third.') });
    expect(await again.json()).toMatchObject({ code: 'busy', jobId: mine.id });
    gate.release();
    await poll(owner, archive, mine.id, (v) => v.status !== 'running');
  });

  it('a job reports how long it has run by the server clock, and keeps that when it ends', async () => {
    const { post, owner, archive } = await setup('elapsed');
    const gate = { release: () => undefined };
    ctx.deps.chat = slowChat(gate);
    const job = (await (await post({ transcript: interview(3), async: true })).json()) as {
      id: string;
      elapsedMs: number;
    };
    expect(job.elapsedMs).toBeGreaterThanOrEqual(0);
    await new Promise((r) => setTimeout(r, 120));
    const mid = (await poll(owner, archive, job.id, (v) => v.status === 'running')) as {
      elapsedMs?: number;
    };
    expect(mid.elapsedMs).toBeGreaterThanOrEqual(100);
    gate.release();
    const done = (await poll(owner, archive, job.id, (v) => v.status !== 'running')) as {
      elapsedMs?: number;
    };
    const a = done.elapsedMs!;
    await new Promise((r) => setTimeout(r, 80));
    const later = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/ingest/${job.id}`)
    ).json()) as { elapsedMs: number };
    expect(later.elapsedMs).toBe(a); // a finished job's time stops
  });

  it('finished jobs are not kept without limit: only the newest few per person', async () => {
    const { post, owner, archive } = await setup('evict');
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      const r = (await (
        await post({ transcript: interview(2, ` Run ${i}.`), async: true })
      ).json()) as { id: string };
      ids.push(r.id);
      await poll(owner, archive, r.id, (v) => v.status !== 'running');
    }
    const status = async (id: string) =>
      (await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/ingest/${id}`)).status;
    expect(await status(ids[0]!)).toBe(404); // the oldest were let go ...
    expect(await status(ids[12]!)).toBe(200); // ... the newest are still there
  });

  it('cancel stops the job, and nothing is saved', async () => {
    const { post, owner, archive, noteCount } = await setup('cancel');
    ctx.deps.chat = slowChat({ release: () => undefined });
    const job = (await (
      await post({ transcript: interview(3), save: true, async: true })
    ).json()) as { id: string };
    await poll(owner, archive, job.id, (v) => v.status === 'running');
    const res = await ctx.api(
      owner.token,
      'POST',
      `/v1/archives/${archive}/ingest/${job.id}/cancel`,
    );
    expect(res.status).toBe(200);
    expect(await poll(owner, archive, job.id, (v) => v.status !== 'running')).toMatchObject({
      status: 'cancelled',
    });
    expect(await noteCount()).toBe(0);
  });

  it('a job that runs past its hard limit is stopped, nothing is saved, and the person is told it timed out', async () => {
    const { post, owner, archive, noteCount } = await setup('limit');
    ctx.deps.chat = slowChat({ release: () => undefined });
    process.env.INGEST_HARD_LIMIT_MS = '200';
    try {
      const sync = await post({ transcript: interview(3), save: true });
      expect(sync.status).toBe(504);
      expect(await sync.json()).toMatchObject({ code: 'timeout' });

      const job = (await (
        await post({ transcript: interview(3, ' Again.'), save: true, async: true })
      ).json()) as { id: string };
      const done = (await poll(owner, archive, job.id, (v) => v.status !== 'running')) as {
        status: string;
        error?: { code: string };
      };
      expect(done.status).toBe('failed');
      expect(done.error?.code).toBe('timeout');
    } finally {
      delete process.env.INGEST_HARD_LIMIT_MS;
    }
    expect(await noteCount()).toBe(0);
    ctx.deps.chat = null;
    expect((await post({ transcript: interview(2, ' Third.') })).status).toBe(200); // not stuck busy
  });

  it('only the person who started a job can see it; a stranger gets 404 for everything', async () => {
    const { post, owner, archive } = await setup('own');
    const job = (await (await post({ transcript: interview(2), async: true })).json()) as {
      id: string;
    };
    await poll(owner, archive, job.id, (v) => v.status !== 'running');
    const member = await ctx.realSession(`is-m-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, member.userId],
    );
    expect(
      (await ctx.api(member.token, 'GET', `/v1/archives/${archive}/ingest/${job.id}`)).status,
    ).toBe(404);
    const stranger = await ctx.realSession(`is-s-${RUN}-${n++}@test.local`);
    for (const [m, p] of [
      ['GET', `ingest/${job.id}`],
      ['POST', `ingest/${job.id}/cancel`],
      ['POST', `ingest/${job.id}/save`],
      ['GET', 'ingest-runs'],
    ] as const) {
      expect(
        (
          await ctx.api(
            stranger.token,
            m,
            `/v1/archives/${archive}/${p}`,
            m === 'POST' ? {} : undefined,
          )
        ).status,
      ).toBe(404);
    }
    expect(
      (await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/ingest/not-a-uuid`)).status,
    ).toBe(404);
  });

  it('refuses an oversized body, a non-object body, a missing transcript and nonsense, each with a code', async () => {
    const { post, owner, archive } = await setup('limits');
    const huge = await ctx.app.request(`/v1/archives/${archive}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: 'x'.repeat(13 * 1024 * 1024) }),
    });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: 'too_large' });
    const arr = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, [1, 2]);
    expect(arr.status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(await (await post({ transcript: '   ' })).json()).toMatchObject({ code: 'empty' });
    expect(await (await post({ transcript: { nothing: 1 } })).json()).toMatchObject({
      code: 'unreadable',
    });
    expect(await (await post({ transcript: '[Music]\n[Applause]' })).json()).toMatchObject({
      code: 'no_speech',
    });
    expect((await post({ transcript: 'x'.repeat(850_000) })).status).toBe(413);
    // a 10 MB request is inside the body limit (a 6 MB file grows when it is escaped into JSON), so
    // it is refused for what it says (too long, and how to fix it), not as "too large to send"
    const ten = await post({ transcript: 'x'.repeat(10 * 1024 * 1024) });
    expect(ten.status).toBe(413);
    expect(await ten.json()).toMatchObject({ code: 'too_long' });
  });
});

describe('when the AI service fails, the person is told and the interview is still imported', () => {
  it("reports the degradation, and every memory is still saved as the speaker's own words", async () => {
    const { post, noteCount } = await setup('degr');
    ctx.deps.chat = {
      id: 'down',
      complete: async () => {
        throw new ModelError('x', 'rate_limited', true);
      },
    };
    const out = (await (await post({ transcript: interview(3), save: true })).json()) as {
      status: string;
      degraded: { windows: number; reasons: string[] };
      saved: unknown[];
    };
    expect(out.status).toBe('saved');
    expect(out.degraded).toMatchObject({ reasons: ['rate_limited'] });
    expect(out.degraded.windows).toBeGreaterThan(0);
    expect(await noteCount()).toBe(3);
  });
});

describe('disagreements, within an interview and with what is already there', () => {
  it('a speaker who contradicts herself gets the second memory marked, linked to the first', async () => {
    const { post, archive } = await setup('self');
    const t = {
      interviewee: 'A',
      segments: [
        seg(0, 'Q', 'When was the farm sold please?'),
        seg(
          1,
          'A',
          'We sold the farm in nineteen eighty-four because none of us could keep it going.',
        ),
        seg(2, 'Q', 'And you are sure about the year?'),
        seg(
          3,
          'A',
          'Well we sold the farm in nineteen eighty-two right after the funeral, I remember it well.',
        ),
      ],
    };
    const out = (await (await post({ transcript: t, save: true })).json()) as {
      saved: Array<{ id: string; title: string }>;
      memories: Array<{ conflicts?: Array<{ source: { id: string; title: string } | null }> }>;
    };
    expect(out.saved).toHaveLength(2);
    const second = out.memories[1]!.conflicts![0]!;
    expect(second.source).toEqual({ id: out.saved[0]!.id, title: out.saved[0]!.title }); // the position was replaced by the real note
    const body = (
      await ctx.pool.query(`select body from public.notes where id = $1`, [out.saved[1]!.id])
    ).rows[0] as { body: string };
    expect(body.body).toContain(`> ⚠ May disagree with [[${out.saved[0]!.title}]]`);
    const links = await ctx.pool.query(
      `select source_id from public.links where resolved_id = $1`,
      [out.saved[0]!.id],
    );
    expect(links.rows.map((r) => (r as { source_id: string }).source_id)).toContain(
      out.saved[1]!.id,
    );
    void archive;
  });
});

describe('who told it', () => {
  it('several tellers, named, are written into the notes and the markers', async () => {
    const { post, archive } = await setup('tellers');
    const t = {
      segments: [
        seg(0, 'Q', 'Tell me about the farm please.'),
        seg(
          1,
          'A',
          'We sold the farm in nineteen eighty-four because none of us could keep it going.',
        ),
        seg(2, 'B', 'We lived by the water and the boats came in every morning of the year.'),
      ],
    };
    const out = (await (
      await post({
        transcript: t,
        save: true,
        interviewees: ['A', 'B'],
        speakerNames: { A: 'Aunt Mae', B: 'Uncle Joon' },
        source: 'family.srt',
      })
    ).json()) as { saved: Array<{ id: string }>; interviewees: string[] };
    expect(out.interviewees).toEqual(['A', 'B']);
    const bodies = (
      await ctx.pool.query(
        `select body from public.notes where archive_id = $1 order by created_at, id`,
        [archive],
      )
    ).rows.map((r) => (r as { body: string }).body);
    expect(bodies.some((b) => b.includes('From “family.srt” · told by Aunt Mae'))).toBe(true);
    expect(bodies.some((b) => b.includes('told by Uncle Joon'))).toBe(true);
  });
});

describe('an import is checked against what the archive already says about the teller', () => {
  /** organises nothing (so every memory is the speaker's own words) and answers the judge from the passage it is shown */
  const judgeOnly = (calls: { n: number }): ChatModel => ({
    id: 'judge-only',
    complete: async (system, user) => {
      if (!system.includes('You check whether a NEW statement')) return '{"memories":[]}';
      calls.n++;
      return user.includes('[Sunja Kim]')
        ? JSON.stringify({
            conflicts: [
              {
                note: 'Sunja Kim',
                about: 'birthplace',
                existing: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
              },
            ],
          })
        : '{"conflicts":[]}';
    },
  });
  const t = {
    interviewee: 'A',
    segments: [
      seg(0, 'Q', 'Where were you born, and when?'),
      seg(1, 'A', 'I was born in Busan in a little house near the harbour, in nineteen forty-six.'),
    ],
  };
  const seed = async (label: string) => {
    const s = await setup(label);
    const made = await ctx.api(s.owner.token, 'POST', `/v1/archives/${s.archive}/notes`, {
      title: 'Sunja Kim',
      type: 'person',
      body: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
    });
    expect(made.status).toBe(201);
    return s;
  };

  it('"I was born in Busan" is marked against a note that says Sunja was born in Daegu, when the teller is named', async () => {
    const { post } = await seed('subject');
    const calls = { n: 0 };
    ctx.deps.chat = judgeOnly(calls);
    const out = (await (
      await post({ transcript: t, save: true, teller: 'Grandma Sunja' })
    ).json()) as {
      memories: Array<{ conflicts?: Array<{ source: { title: string } | null }> }>;
      saved: Array<{ id: string }>;
    };
    expect(calls.n).toBe(1);
    expect(out.memories[0]!.conflicts?.[0]?.source?.title).toBe('Sunja Kim');
    const body = (
      await ctx.pool.query(`select body from public.notes where id = $1`, [out.saved[0]!.id])
    ).rows[0]!.body as string;
    expect(body).toContain('May disagree with [[Sunja Kim]]');
  });

  it('a judge that answers leaves the check complete', async () => {
    const { post } = await seed('judgeok');
    ctx.deps.chat = judgeOnly({ n: 0 });
    const out = (await (await post({ transcript: t, teller: 'Grandma Sunja' })).json()) as {
      check?: { complete: boolean; skipped: number };
    };
    expect(out.check).toEqual({ complete: true, skipped: 0 });
  });

  it('a judge that fails or times out leaves the check INCOMPLETE and says so: a slow minute at the AI service must not look like "nothing disagrees"', async () => {
    const { post } = await seed('judgefails');
    ctx.deps.chat = {
      id: 'judge-down',
      complete: async (system) => {
        if (system.includes('You check whether a NEW statement')) {
          throw new ModelError('x', 'timeout', true);
        }
        return '{"memories":[]}';
      },
    };
    const out = (await (await post({ transcript: t, teller: 'Grandma Sunja' })).json()) as {
      check?: { complete: boolean; skipped: number; reason?: string };
      memories: Array<{ conflicts?: unknown[] }>;
    };
    expect(out.memories[0]!.conflicts ?? []).toHaveLength(0);
    // and why, so the page can say the AI service was the trouble, not the time
    expect(out.check).toEqual({ complete: false, skipped: 0, reason: 'ai' });
  });

  it('with nobody named there is no way to know that "I" is Sunja: the judge is not asked, and nothing is marked', async () => {
    const { post } = await seed('subject2');
    const calls = { n: 0 };
    ctx.deps.chat = judgeOnly(calls);
    const out = (await (await post({ transcript: t, save: true })).json()) as {
      memories: Array<{ conflicts?: unknown[] }>;
    };
    expect(calls.n).toBe(0);
    expect(out.memories[0]!.conflicts ?? []).toEqual([]);
  });

  it('an interview with itself is never put to the judge: only what the archive already held', async () => {
    const { post, archive } = await setup('own');
    const calls = { n: 0 };
    ctx.deps.chat = judgeOnly(calls);
    const two = {
      interviewee: 'A',
      segments: [
        seg(0, 'Q', 'Where were you born?'),
        seg(
          1,
          'A',
          'I was born in Busan in a little house near the harbour, in nineteen forty-six.',
        ),
        seg(2, 'Q', 'And your mother?'),
        seg(3, 'A', 'My mother was born in Daegu and grew up on a farm there, near the river.'),
      ],
    };
    expect((await post({ transcript: two, save: true, teller: 'Grandma Sunja' })).status).toBe(200);
    expect(calls.n).toBe(0);
    void archive;
  });
});
