import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyError, IngestJobs } from '../src/ingest-jobs';
import { testContext, type RealSession } from './helpers';

/**
 * What the job store holds and for how long, what a cancel says while a preview is being
 * saved, what an undo takes out of OTHER jobs, and what the import list and intake do with
 * errors and names. Round-2 persistence review #7, #8, #9, listRuns note; e2e review #13.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const logged: string[] = [];
const realError = console.error.bind(console);
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
  logged.push(a.map(String).join(' '));
  realError(...a);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await ctx.close();
});
afterEach(() => {
  delete process.env.INGEST_USER_BYTES;
  delete process.env.INGEST_TOTAL_BYTES;
});

/** a job store of its own, as each server process used to have: limits count only its jobs */
const newJobs = () => new IngestJobs(ctx.deps, { scope: randomUUID(), sweepEveryMs: null });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seg = (i: number, speaker: string, text: string) => ({
  start: i * 10,
  end: i * 10 + 9,
  speaker,
  text,
});
const interview = (tag = '') => ({
  interviewee: 'A',
  segments: [
    seg(0, 'Q', 'And what do you remember about that time?'),
    seg(1, 'A', `My father repaired boats and he had big hands, said ${tag}.`),
    seg(2, 'Q', 'And your mother?'),
    seg(3, 'A', `My mother sold fish at the market every single day, said ${tag}.`),
  ],
});

/* ── #7 the job store: an absolute lifetime, and caps in bytes ──────────── */

describe('#7 previews are bounded in time and in bytes, and nobody else takes one being reviewed', () => {
  const realNow = Date.now;
  let offset = 0;
  beforeEach(() => {
    offset = 0;
    Date.now = () => realNow() + offset;
  });
  afterEach(() => {
    Date.now = realNow;
  });
  const preview = async (jobs: IngestJobs, user: string, tag: string, archive = randomUUID()) => {
    const j = await (await jobs.start(archive, user, { transcript: interview(tag) })).done;
    expect(jobs.view(j).outcome?.status).toBe('previewed');
    return j;
  };
  const has = async (jobs: IngestJobs, j: { id: string; archiveId: string; userId: string }) =>
    (await jobs.get(j.id, j.archiveId, j.userId)) !== null;
  const sizeOf = (jobs: IngestJobs, j: Parameters<IngestJobs['view']>[0]) =>
    JSON.stringify(jobs.view(j).outcome).length;

  it('a preview goes 3 hours after it was made, however often it is looked at', async () => {
    const jobs = newJobs();
    const p = await preview(jobs, randomUUID(), 'kept alive by polling');
    for (const minutes of [50, 100, 150, 175]) {
      offset = minutes * 60_000;
      await preview(jobs, randomUUID(), `tick ${minutes}`); // any start sweeps
      expect(await has(jobs, p), `at ${minutes} min`).toBe(true); // looked at: idle time starts again
    }
    offset = 185 * 60_000;
    await preview(jobs, randomUUID(), 'tick 185');
    expect(await has(jobs, p)).toBe(false);
  });

  it("one person's jobs are capped in bytes: past it their own oldest go, nobody else's", async () => {
    const jobs = newJobs();
    const user = randomUUID();
    const other = await preview(jobs, randomUUID(), 'somebody else');
    const first = await preview(jobs, user, 'mine 1');
    process.env.INGEST_USER_BYTES = String(Math.floor(sizeOf(jobs, first) * 2.5));
    const second = await preview(jobs, user, 'mine 2');
    const third = await preview(jobs, user, 'mine 3');
    await preview(jobs, user, 'mine 4'); // three held is over 2.5 previews' worth: HIS oldest goes
    expect(await has(jobs, first)).toBe(false);
    expect(await has(jobs, second)).toBe(true);
    expect(await has(jobs, third)).toBe(true);
    expect(await has(jobs, other)).toBe(true);
  });

  it("an archive holds at most 20 unsaved previews: a 21st waits, unless one is unwatched or the starter's own", async () => {
    const jobs = newJobs();
    const archive = randomUUID();
    const held: Array<Awaited<ReturnType<typeof preview>>> = [];
    for (let i = 0; i < 20; i++) held.push(await preview(jobs, randomUUID(), `p${i}`, archive));
    let refused: unknown;
    try {
      await jobs.start(archive, randomUUID(), { transcript: interview('one too many') });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(BusyError);
    expect((refused as BusyError).why).toBe('previews');
    // somebody who already holds one there makes room with their own
    const own = await preview(jobs, held[3]!.userId, 'mine instead', archive);
    expect(await has(jobs, held[3]!)).toBe(false);
    expect(await has(jobs, own)).toBe(true);
    // a quarter of an hour on, previews nobody is looking at may go; one still watched stays
    offset = 16 * 60_000;
    expect(await has(jobs, held[0]!)).toBe(true); // looked at: watched again
    await preview(jobs, randomUUID(), 'after a while', archive);
    expect(await has(jobs, held[0]!)).toBe(true);
    expect(await has(jobs, held[1]!)).toBe(false);
  });

  it('the whole server is capped in bytes: finished work goes first, a preview being reviewed never', async () => {
    const jobs = newJobs();
    const victim = await preview(jobs, randomUUID(), 'being reviewed');
    process.env.INGEST_TOTAL_BYTES = String(Math.floor(sizeOf(jobs, victim) * 3.5));
    await preview(jobs, randomUUID(), 'b');
    await preview(jobs, randomUUID(), 'c');
    await preview(jobs, randomUUID(), 'd'); // four held: over 3.5 previews' worth
    await expect(
      jobs.start(randomUUID(), randomUUID(), { transcript: interview('e') }),
    ).rejects.toThrow(BusyError);
    expect(await has(jobs, victim)).toBe(true);
    offset = 16 * 60_000;
    expect(await has(jobs, victim)).toBe(true); // still being reviewed
    await preview(jobs, randomUUID(), 'room now'); // an unwatched one goes, not the victim
    expect(await has(jobs, victim)).toBe(true);
  });
});

/* ── #8 #9 #11 through the routes ─────────────────────────────────────── */

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`jl-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `JL ${label} ${RUN}`);
  const post = (body: object, s: RealSession = owner) =>
    ctx.api(s.token, 'POST', `/v1/archives/${archive}/ingest`, body);
  const member = async (role: string) => {
    const m = await ctx.realSession(`jl-${role}-${label}-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
      [archive, m.userId, role],
    );
    return m;
  };
  const getJob = async (s: RealSession, id: string) =>
    (await (await ctx.api(s.token, 'GET', `/v1/archives/${archive}/ingest/${id}`)).json()) as {
      status: string;
      outcome?: Record<string, unknown>;
    };
  return { owner, archive, post, member, getJob };
}

describe('#8 an undo takes its file name out of every job that mentions it', () => {
  it('a job refused as a duplicate, and a preview warned about it, no longer carry the file name', async () => {
    const { owner, archive, post, member, getJob } = await setup('forget');
    const label = `grandma-diagnosis-${RUN}.txt`;
    const out = (await (
      await post({ transcript: interview('dup'), save: true, source: label })
    ).json()) as { runId: string };
    const m = await member('contributor');
    const dup = await post({ transcript: interview('dup'), save: true }, m);
    expect(dup.status).toBe(409);
    const dupJob = ((await dup.json()) as { jobId: string }).jobId;
    const prev = (await (await post({ transcript: interview('dup') }, m)).json()) as {
      jobId: string;
      duplicateOf?: { source: string };
    };
    expect(prev.duplicateOf?.source).toBe(label);
    expect(
      (await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`))
        .status,
    ).toBe(200);
    const d = await getJob(m, dupJob);
    expect(JSON.stringify(d)).not.toContain(label);
    expect(d.outcome).toMatchObject({ status: 'duplicate', duplicateOf: { source: null } });
    const p = await getJob(m, prev.jobId);
    expect(JSON.stringify(p)).not.toContain(label);
    expect(p.outcome?.duplicateOf).toBeUndefined();
  });
});

describe('#9 cancelling a preview while it is being saved is answered "too late"', () => {
  it('409 too_late, and the save completes', async () => {
    const { owner, archive, post } = await setup('cancel-saving');
    const prev = (await (await post({ transcript: interview('cancel') })).json()) as {
      jobId: string;
    };
    const client = await ctx.pool.connect();
    let saving: Promise<Response>;
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext(lower($1))::bigint)', [archive]);
      saving = ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive}/ingest/${prev.jobId}/save`,
        {},
      );
      await sleep(400);
      const c = await ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive}/ingest/${prev.jobId}/cancel`,
      );
      expect(c.status).toBe(409);
      expect(await c.json()).toMatchObject({ code: 'too_late' });
    } finally {
      await client.query('commit');
      client.release();
    }
    const s = await saving;
    expect(s.status).toBe(200);
    expect(((await s.json()) as { status: string }).status).toBe('saved');
  });
});

describe('the list of imports, and the names an import is given', () => {
  it('a database error while listing is answered 500 without repeating what the database said', async () => {
    const { owner, archive } = await setup('list-error');
    const real = ctx.deps.pool;
    ctx.deps.pool = {
      query: (sql: string, p?: unknown[]) =>
        typeof sql === 'string' && sql.includes('from public.ingest_runs r where r.archive_id')
          ? Promise.reject(
              Object.assign(new Error('value "grandma-diagnosis.txt" violates something'), {
                code: '22P02',
                detail: 'Key (source_label)=(grandma-diagnosis.txt)',
              }),
            )
          : real.query(sql, p),
      connect: () => real.connect(),
    } as unknown as Pool;
    logged.length = 0;
    let res: Response;
    try {
      res = await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/ingest-runs`);
    } finally {
      ctx.deps.pool = real;
    }
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('internal');
    expect(text).not.toContain('grandma');
    expect(logged.join('\n')).not.toContain('grandma');
    expect(logged.join('\n')).toContain('[ingest] listing imports failed: pg 22P02');
  });

  it('a file name that arrives decomposed (macOS) is written composed, in the notes and in the record', async () => {
    const { owner, archive, post } = await setup('nfc');
    const nfd = `José and Grand-mère Zoë recording ${RUN}.txt`.normalize('NFD');
    const nfc = nfd.normalize('NFC');
    expect(nfd).not.toBe(nfc);
    const out = (await (
      await post({ transcript: interview('nfc'), save: true, source: nfd })
    ).json()) as { runId: string; saved: Array<{ id: string }> };
    const body = (
      (await ctx.pool.query(`select body from public.notes where id = $1`, [out.saved[0]!.id]))
        .rows[0] as { body: string }
    ).body;
    expect(body).toContain(nfc);
    expect(body).not.toContain(nfd);
    const run = (
      await ctx.pool.query(`select source_label from public.ingest_runs where id = $1`, [out.runId])
    ).rows[0] as { source_label: string };
    expect(run.source_label).toBe(nfc);
    void owner;
    void archive;
  });
});
