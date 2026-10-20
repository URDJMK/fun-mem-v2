import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sharedTitles } from '../src/ingest-save';
import { DB_URL, testContext } from './helpers';

/**
 * The largest interview a person can send, and many saves into one archive at once, must
 * not hold the server: round-2 persistence review #2 (a save that retitled 2,300 memories
 * stalled every request for 32 s), #10 (in a large archive the short titles were never
 * offered for linking), and the pool check (saves waiting on one archive held every
 * connection, and most of them then failed).
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

/** the longest gap between ticks of a 10 ms timer while `run` runs: how long the server stalled */
async function stallOf<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; gap: number }> {
  let gap = 0;
  let last = Date.now();
  const probe = setInterval(() => {
    const now = Date.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 10);
  const t0 = Date.now();
  try {
    const value = await run();
    return { value, ms: Date.now() - t0, gap: Math.max(gap, Date.now() - last) };
  } finally {
    clearInterval(probe);
  }
}

const WORDS = [
  'harbour',
  'market',
  'boats',
  'winter',
  'factory',
  'teacher',
  'mother',
  'father',
  'sister',
  'church',
  'wedding',
  'village',
  'river',
  'mountain',
  'school',
  'train',
  'letter',
  'garden',
  'kitchen',
  'festival',
];

describe('#2 a 2,300-memory interview: preview, a save that retitles every memory, and an undo', () => {
  it('finish in seconds and never stall the server', { timeout: 300_000 }, async () => {
    const owner = await ctx.realSession(`sc-big-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `SC big ${RUN}`);
    const K = 2300;
    const segments: unknown[] = [];
    for (let i = 0; i < K; i++) {
      const w = (j: number) => WORDS[(i * 7 + j * 3) % WORDS.length];
      segments.push({
        start: i * 20,
        end: i * 20 + 9,
        speaker: 'Q',
        text: `What do you remember about the ${w(1)} in ${1900 + (i % 100)}?`,
      });
      segments.push({
        start: i * 20 + 10,
        end: i * 20 + 19,
        speaker: 'A',
        text: `I remember the ${w(2)} number ${i} near the ${w(3)} where my ${w(4)} worked, and we walked there every ${w(5)} morning ${RUN}.`,
      });
    }
    const prev = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
        transcript: { interviewee: 'A', segments },
      })
    ).json()) as { jobId: string; memories: Array<{ title: string }> };
    expect(prev.memories.length).toBeGreaterThan(2000);

    const patches = prev.memories.map((m, index) => ({ index, title: `${m.title} edited` }));
    const save = await stallOf(async () => {
      const r = await ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive}/ingest/${prev.jobId}/save`,
        {
          memories: patches,
        },
      );
      return {
        status: r.status,
        body: (await r.json()) as { runId: string; saved: Array<{ title: string }> },
      };
    });
    console.info(
      `[scale] save of ${prev.memories.length} retitled memories: ${save.ms} ms, longest stall ${save.gap} ms`,
    );
    expect(save.value.status).toBe(200);
    expect(save.value.body.saved).toHaveLength(prev.memories.length);
    expect(save.value.body.saved.every((s) => s.title.includes(' edited'))).toBe(true);
    expect(save.gap).toBeLessThan(1000);
    expect(save.ms).toBeLessThan(60_000);

    const undo = await stallOf(async () => {
      const r = await ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive}/ingest-runs/${save.value.body.runId}/undo`,
      );
      return { status: r.status, body: (await r.json()) as { erased: number } };
    });
    console.info(
      `[scale] undo of ${prev.memories.length} memories: ${undo.ms} ms, longest stall ${undo.gap} ms`,
    );
    expect(undo.value).toMatchObject({ status: 200, body: { erased: prev.memories.length } });
    expect(undo.gap).toBeLessThan(1000);
    expect(undo.ms).toBeLessThan(60_000);
  });
});

describe('#10 in an archive with more than 500 titles, the ones the interview mentions are offered first', () => {
  it('a short title the interview mentions ("Busan", "Одесса") is offered, though 600 longer ones exist', async () => {
    const owner = await ctx.realSession(`sc-titles-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `SC titles ${RUN}`);
    await ctx.pool.query(
      `insert into public.notes (archive_id, title, type, body, created_by)
       select $1, 'A long title about the village festival number ' || g, 'event', '', $2
         from generate_series(1, 600) g`,
      [archive, owner.userId],
    );
    await ctx.pool.query(
      `insert into public.notes (archive_id, title, type, body, created_by)
       values ($1, 'Busan', 'place', '', $2), ($1, 'Одесса', 'place', '', $2), ($1, 'Mom', 'person', '', $2)`,
      [archive, owner.userId],
    );
    // a title in another script is found as the whole word it is, compared exactly
    const text =
      'We lived in Busan near the harbour. Later we moved to Одесса. My father repaired boats.';
    const offered = await sharedTitles(ctx.pool, archive, text);
    expect(offered).toHaveLength(500);
    expect(offered).toEqual(expect.arrayContaining(['Busan', 'Одесса']));
    expect(offered).not.toContain('Mom'); // not mentioned, and shorter than the 500 longest
    // without a transcript the longest come first, as before
    expect(await sharedTitles(ctx.pool, archive)).not.toContain('Busan');
  });

  it('ranking 600 titles against a 400,000-character transcript is quick and linear', async () => {
    const owner = await ctx.realSession(`sc-timing-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `SC timing ${RUN}`);
    await ctx.pool.query(
      `insert into public.notes (archive_id, title, type, body, created_by)
       select $1, 'The old ' || g || ' harbour story', 'event', '', $2 from generate_series(1, 600) g`,
      [archive, owner.userId],
    );
    const sentence =
      'and then we walked down to the old harbour where the boats came in, потом в Одессе ';
    const big = sentence.repeat(Math.ceil(400_000 / sentence.length)).slice(0, 400_000);
    const half = big.slice(0, 200_000);
    const time = async (t: string) => {
      const t0 = Date.now();
      await sharedTitles(ctx.pool, archive, t);
      return Date.now() - t0;
    };
    await time(half); // warm
    const a = await time(half);
    const b = await time(big);
    console.info(`[scale] title ranking: 200k chars ${a} ms, 400k chars ${b} ms`);
    expect(b).toBeLessThan(2000);
    expect(b).toBeLessThan(Math.max(4 * a, 200));
  });
});

describe('many saves into one archive at once', () => {
  it(
    'waiters on one archive do not hold the connections other archives need, and every save lands',
    { timeout: 120_000 },
    async () => {
      // a pool of 10, as the server builds it
      const pool10 = new Pool({ connectionString: DB_URL, max: 10 });
      const app10 = createApp({ ...ctx.deps, pool: pool10 });
      const api = async (t: string, m: string, p: string, b?: unknown): Promise<Response> =>
        app10.request(p, {
          method: m,
          headers: {
            authorization: `Bearer ${t}`,
            ...(b ? { 'content-type': 'application/json' } : {}),
          },
          ...(b ? { body: JSON.stringify(b) } : {}),
        });
      try {
        const a = await ctx.realSession(`sc-pa-${RUN}@test.local`);
        const b = await ctx.realSession(`sc-pb-${RUN}@test.local`);
        const elsewhere = await ctx.realSession(`sc-po-${RUN}@test.local`);
        const A = await ctx.provisionArchive(a, `SC pool A ${RUN}`);
        const B = await ctx.provisionArchive(elsewhere, `SC pool B ${RUN}`);
        await ctx.pool.query(
          `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
          [A, b.userId],
        );
        // twelve previews of different stories that all get the SAME title
        const jobs: Array<[string, string]> = [];
        for (let k = 0; k < 12; k++) {
          const s = k < 6 ? a : b;
          const r = (await (
            await api(s.token, 'POST', `/v1/archives/${A}/ingest`, {
              transcript: {
                interviewee: 'A',
                segments: [
                  { start: 0, end: 9, speaker: 'Q', text: 'What do you remember?' },
                  {
                    start: 10,
                    end: 19,
                    speaker: 'A',
                    text: `My father repaired boats and he had big hands, story ${k} ${RUN}.`,
                  },
                ],
              },
            })
          ).json()) as { jobId: string };
          jobs.push([s.token, r.jobId]);
        }
        // hold archive A's write lock, as a long save would, and send all twelve saves
        const lock = await ctx.pool.connect();
        await lock.query('begin');
        await lock.query('select pg_advisory_xact_lock(hashtext(lower($1))::bigint)', [A]);
        let saves: Promise<number[]>;
        let elsewhereMs = 0;
        try {
          saves = Promise.all(
            jobs.map(([t, id]) =>
              api(t, 'POST', `/v1/archives/${A}/ingest/${id}/save`, { force: true }).then(
                (r) => r.status,
              ),
            ),
          );
          await new Promise((r) => setTimeout(r, 1000));
          const t0 = Date.now();
          expect((await api(elsewhere.token, 'GET', `/v1/archives/${B}/notes`)).status).toBe(200);
          elsewhereMs = Date.now() - t0;
        } finally {
          await lock.query('commit');
          lock.release();
        }
        console.info(`[scale] a read in another archive while 12 saves wait: ${elsewhereMs} ms`);
        expect(elsewhereMs).toBeLessThan(1000);
        expect(await saves).toEqual(new Array(12).fill(200));
        const titles = await ctx.pool.query(
          `select title from public.notes where archive_id = $1`,
          [A],
        );
        expect(titles.rowCount).toBe(12);
        expect(
          new Set(titles.rows.map((r) => (r as { title: string }).title.toLowerCase())).size,
        ).toBe(12);
      } finally {
        await pool10.end();
      }
    },
  );
});
