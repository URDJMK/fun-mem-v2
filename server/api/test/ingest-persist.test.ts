import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyError, IngestJobs } from '../src/ingest-jobs';
import { annotateImport } from '../src/ingest-save';
import { ingestParsed } from '../src/ingest-pipeline';
import { parseTranscript } from '../src/transcript';
import { ModelError, type ChatModel } from '../src/nim';
import { testContext, type RealSession } from './helpers';

/**
 * Saving, jobs, routes, undo and who may: the regressions of the persistence review.
 * Each describe names the finding it pins.
 */

// A reader that crashes on one marked input, and a pipeline that crashes on another: the
// input's words are in the error message, so they show whether a response or a log quotes
// what it was given. Everything else goes to the real module.
vi.mock('../src/transcript', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/transcript')>();
  return {
    ...orig,
    parseTranscript: (input: unknown) => {
      if (typeof input === 'string' && input.startsWith('READER-CRASH')) {
        throw new TypeError(`Cannot read properties of undefined (reading '${input.slice(13)}')`);
      }
      return orig.parseTranscript(input);
    },
  };
});
vi.mock('../src/ingest-pipeline', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/ingest-pipeline')>();
  return {
    ...orig,
    ingestParsed: (...args: Parameters<typeof orig.ingestParsed>) => {
      const crash = args[0].turns.find((t) => t.text.includes('PIPELINE-CRASH'));
      if (crash) return Promise.reject(new Error(`the pipeline broke on: ${crash.text}`));
      return orig.ingestParsed(...args);
    },
  };
});

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

/** every job's end, as `finish` logs it (content-free JSON): how a test knows a job is over without asking it */
const ended = new Map<string, Record<string, unknown>>();
const logged: string[] = [];
const realInfo = console.info.bind(console);
const realError = console.error.bind(console);
vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => {
  try {
    const x = JSON.parse(String(a[0])) as { evt?: string; job?: string };
    if (x.evt === 'ingest' && x.job) ended.set(x.job, x);
  } catch {
    /* not ours */
  }
  realInfo(...a);
});
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
  logged.push(a.map(String).join(' '));
  realError(...a);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await ctx.close();
});
afterEach(() => {
  ctx.deps.chat = null;
  delete process.env.INGEST_HARD_LIMIT_MS;
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
/** two memories; the second says 1982 where the first said 1984, so it is marked against the first */
const selfContra = (tag = '') => ({
  interviewee: 'A',
  segments: [
    seg(0, 'Q', 'When was the farm sold please?'),
    seg(
      1,
      'A',
      `We sold the farm in nineteen eighty-four because none of us could keep it going${tag}.`,
    ),
    seg(2, 'Q', 'And you are sure about the year?'),
    seg(
      3,
      'A',
      'Well we sold the farm in nineteen eighty-two right after the funeral, I remember it well.',
    ),
  ],
});

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`ip-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `IP ${label} ${RUN}`);
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
  const addMember = async (role: string) => {
    const m = await ctx.realSession(`ip-${role}-${label}-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
      [archive, m.userId, role],
    );
    return m;
  };
  const setRole = (s: RealSession, role: string) =>
    ctx.pool.query(
      `update public.memberships set role = $3 where archive_id = $1 and user_id = $2`,
      [archive, s.userId, role],
    );
  const undo = (s: RealSession, runId: string) =>
    ctx.api(s.token, 'POST', `/v1/archives/${archive}/ingest-runs/${runId}/undo`);
  const getJob = async (s: RealSession, id: string) =>
    (await (await ctx.api(s.token, 'GET', `/v1/archives/${archive}/ingest/${id}`)).json()) as {
      status: string;
      stage: string;
      canCancel: boolean;
      outcome?: Record<string, unknown> & {
        status: string;
        memories: Array<Record<string, unknown>>;
        saved?: unknown[];
      };
      error?: { code: string; reason?: string };
    };
  const pollJob = async (
    s: RealSession,
    id: string,
    until: (v: Awaited<ReturnType<typeof getJob>>) => boolean,
  ) => {
    for (let i = 0; i < 400; i++) {
      const v = await getJob(s, id);
      if (until(v)) return v;
      await sleep(25);
    }
    throw new Error('timed out waiting for the job');
  };
  return { owner, archive, post, noteCount, addMember, setRole, undo, getJob, pollJob };
}

/** waits until `finish` has logged this job */
async function jobEnd(id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 600 && !ended.has(id); i++) await sleep(25);
  const e = ended.get(id);
  if (!e) throw new Error('the job never ended');
  return e;
}

/** an AI that blocks until released (or stopped), then organises nothing */
const gated = () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((r) => (release = r));
  let markCalled: () => void = () => undefined;
  const called = new Promise<void>((r) => (markCalled = r));
  const chat: ChatModel = {
    id: 'gated',
    complete: async (_s, _u, o) => {
      markCalled();
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
  return { chat, release: () => release(), called };
};

/** organises nothing at once, and blocks the conflict judge until released */
const judgeGate = () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((r) => (release = r));
  let markAsked: () => void = () => undefined;
  const asked = new Promise<void>((r) => (markAsked = r));
  const chat: ChatModel = {
    id: 'judge-gate',
    complete: async (system) => {
      if (!system.includes('You check whether a NEW statement')) return '{"memories":[]}';
      markAsked();
      await opened;
      return '{"conflicts":[]}';
    },
  };
  return { chat, release: () => release(), asked };
};

/** the seeded note and the interview that the judge is asked about (the teller is named) */
const BORN = {
  interviewee: 'A',
  segments: [
    seg(0, 'Q', 'Where were you born, and when?'),
    seg(1, 'A', 'I was born in Busan in a little house near the harbour, in nineteen forty-six.'),
  ],
};
const seedSunja = async (s: RealSession, archive: string) => {
  const r = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title: 'Sunja Kim',
    type: 'person',
    body: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
  });
  expect(r.status).toBe(201);
};

/** holds the archive's write lock, so a save waits inside its stage */
async function holdArchiveLock(archive: string) {
  const client = await ctx.pool.connect();
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [archive]);
  return async () => {
    await client.query('commit');
    client.release();
  };
}

/* ── #1 + FR-100: who may write is checked again where the notes are written ── */

describe('#1 a member removed (or made read-only) while an import runs gets nothing written', () => {
  it('removed mid-import: nothing is written, and the job fails as forbidden', async () => {
    const { archive, addMember, noteCount } = await setup('removed');
    const member = await addMember('contributor');
    const g = gated();
    ctx.deps.chat = g.chat;
    const started = await ctx.api(member.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: interview(3),
      save: true,
      async: true,
    });
    expect(started.status).toBe(202);
    const job = (await started.json()) as { id: string };
    await g.called;
    await ctx.pool.query(`delete from public.memberships where archive_id = $1 and user_id = $2`, [
      archive,
      member.userId,
    ]);
    g.release();
    expect(await jobEnd(job.id)).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(await noteCount()).toBe(0);
    // a stranger now: their job is a plain 404 like everything else here
    expect(
      (await ctx.api(member.token, 'GET', `/v1/archives/${archive}/ingest/${job.id}`)).status,
    ).toBe(404);
  });

  it('removed while the save waits for the write lock: the check inside the transaction refuses it', async () => {
    const { archive, addMember, noteCount, pollJob } = await setup('removed-tx');
    const member = await addMember('contributor');
    const unlock = await holdArchiveLock(archive);
    let job: { id: string };
    try {
      job = (await (
        await ctx.api(member.token, 'POST', `/v1/archives/${archive}/ingest`, {
          transcript: interview(2),
          save: true,
          async: true,
        })
      ).json()) as { id: string };
      await pollJob(member, job.id, (v) => v.stage === 'saving');
      // let the quick check before the transaction pass: this is about the one inside it
      await sleep(400);
      await ctx.pool.query(
        `delete from public.memberships where archive_id = $1 and user_id = $2`,
        [archive, member.userId],
      );
    } finally {
      await unlock();
    }
    expect(await jobEnd(job.id)).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(await noteCount()).toBe(0);
  });

  it('made a viewer mid-import: nothing is written; the job says why', async () => {
    const { archive, addMember, setRole, noteCount, getJob } = await setup('demoted');
    const member = await addMember('contributor');
    const g = gated();
    ctx.deps.chat = g.chat;
    const job = (await (
      await ctx.api(member.token, 'POST', `/v1/archives/${archive}/ingest`, {
        transcript: interview(3),
        save: true,
        async: true,
      })
    ).json()) as { id: string };
    await g.called;
    await setRole(member, 'viewer');
    g.release();
    await jobEnd(job.id);
    expect(await getJob(member, job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'forbidden', reason: 'role' },
    });
    expect(await noteCount()).toBe(0);
  });

  it('a preview cannot be saved by someone who may no longer add memories, whatever their new role', async () => {
    const { archive, addMember, setRole, noteCount } = await setup('demoted-save');
    for (const role of ['viewer', 'minor_viewer', 'reviewer', 'gifter', 'sponsor_admin']) {
      const member = await addMember('contributor');
      const prev = (await (
        await ctx.api(member.token, 'POST', `/v1/archives/${archive}/ingest`, {
          transcript: interview(2, ` ${role}.`),
        })
      ).json()) as { jobId: string };
      await setRole(member, role);
      const res = await ctx.api(
        member.token,
        'POST',
        `/v1/archives/${archive}/ingest/${prev.jobId}/save`,
        {},
      );
      expect(res.status, role).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', reason: 'role' });
    }
    expect(await noteCount()).toBe(0);
  });
});

describe('FR-100 only owners, stewards and contributors import', () => {
  it('viewer, minor_viewer, reviewer, gifter and sponsor_admin are refused with 403 role, and nothing starts', async () => {
    const { archive, addMember, noteCount } = await setup('roles-no');
    for (const role of ['viewer', 'minor_viewer', 'reviewer', 'gifter', 'sponsor_admin']) {
      const m = await addMember(role);
      for (const body of [
        { transcript: interview(2, ` ${role}.`), save: true },
        { transcript: interview(2, ` ${role}.`) },
        { transcript: interview(2, ` ${role}.`), save: true, async: true },
      ]) {
        const r = await ctx.api(m.token, 'POST', `/v1/archives/${archive}/ingest`, body);
        expect(r.status, role).toBe(403);
        expect(await r.json()).toMatchObject({ code: 'forbidden', reason: 'role' });
      }
      // the archive's imports are still theirs to read
      expect((await ctx.api(m.token, 'GET', `/v1/archives/${archive}/ingest-runs`)).status).toBe(
        200,
      );
    }
    expect(await noteCount()).toBe(0);
    const runs = await ctx.pool.query(`select 1 from public.ingest_runs where archive_id = $1`, [
      archive,
    ]);
    expect(runs.rowCount).toBe(0);
  });

  it('owner, steward and contributor may', async () => {
    const { archive, owner, addMember } = await setup('roles-yes');
    const people = [owner, await addMember('steward'), await addMember('contributor')];
    for (const [i, s] of people.entries()) {
      const r = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/ingest`, {
        transcript: interview(2, ` person ${i}.`),
        save: true,
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe('saved');
    }
  });

  it("undo: your own import with a role that adds memories; someone else's only as owner or steward", async () => {
    const { owner, post, addMember, setRole, undo } = await setup('roles-undo');
    const steward = await addMember('steward');
    const contributor = await addMember('contributor');
    const viewer = await addMember('viewer');
    const ownersRun = async (tag: string) =>
      (
        (await (await post({ transcript: interview(2, tag), save: true })).json()) as {
          runId: string;
        }
      ).runId;

    const a = await ownersRun(' A.');
    const others = [contributor, viewer];
    for (const role of ['minor_viewer', 'reviewer', 'gifter', 'sponsor_admin']) {
      others.push(await addMember(role));
    }
    for (const s of others) {
      const r = await undo(s, a);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'forbidden', reason: 'role' });
    }
    expect((await undo(steward, a)).status).toBe(200);

    const mine = (await (
      await post({ transcript: interview(2, ' C.'), save: true }, contributor)
    ).json()) as { runId: string };
    expect((await undo(contributor, mine.runId)).status).toBe(200);

    // imported as a contributor, then made a viewer: may no longer undo even their own
    const later = (await (
      await post({ transcript: interview(2, ' D.'), save: true }, contributor)
    ).json()) as { runId: string };
    await setRole(contributor, 'viewer');
    const r = await undo(contributor, later.runId);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ reason: 'role' });
    void owner;
  });

  it('a stranger is answered 404, never 403', async () => {
    const { archive, post } = await setup('roles-stranger');
    const out = (await (await post({ transcript: interview(2), save: true })).json()) as {
      runId: string;
      jobId: string;
    };
    const stranger = await ctx.realSession(`ip-stranger-${RUN}-${n++}@test.local`);
    for (const [m, p] of [
      ['POST', `/v1/archives/${archive}/ingest`],
      ['POST', `/v1/archives/${archive}/ingest/${out.jobId}/save`],
      ['POST', `/v1/archives/${archive}/ingest/${out.jobId}/cancel`],
      ['GET', `/v1/archives/${archive}/ingest/${out.jobId}`],
      ['POST', `/v1/archives/${archive}/ingest-runs/${out.runId}/undo`],
      ['GET', `/v1/archives/${archive}/ingest-runs`],
    ] as const) {
      const r = await ctx.api(
        stranger.token,
        m,
        p,
        m === 'POST' ? { transcript: interview(2) } : undefined,
      );
      expect(r.status, p).toBe(404);
    }
  });
});

/* ── #2: a preview lives while somebody is looking at it ──────────────── */

describe('#2 a preview is kept while somebody is reviewing it, whatever anyone else does', () => {
  const realNow = Date.now;
  let offset = 0;
  beforeEach(() => {
    offset = 0;
    Date.now = () => realNow() + offset;
  });
  afterEach(() => {
    Date.now = realNow;
  });
  const tiny = (tag: string) => ({
    interviewee: 'A',
    segments: [
      seg(0, 'Q', 'What do you remember about that time?'),
      seg(1, 'A', `My father repaired boats and he had big hands, said ${tag}.`),
    ],
  });
  const preview = async (jobs: IngestJobs, user: string, tag: string) => {
    const j = await (await jobs.start(randomUUID(), user, { transcript: tiny(tag) })).done;
    expect(jobs.view(j).outcome?.status).toBe('previewed');
    return j;
  };
  const failed = async (jobs: IngestJobs, user: string) => {
    const j = await (await jobs.start(randomUUID(), user, { transcript: '   ' })).done;
    expect(jobs.view(j).status).toBe('failed');
    return j;
  };
  const has = async (jobs: IngestJobs, j: { id: string; archiveId: string; userId: string }) =>
    (await jobs.get(j.id, j.archiveId, j.userId)) !== null;
  /** a job store of its own, as each server process used to have: limits count only its jobs */
  const newJobs = () => new IngestJobs(ctx.deps, { scope: randomUUID(), sweepEveryMs: null });

  it('an unsaved preview lives 60 idle minutes, and every look at it starts the hour again; a finished job lives 15', async () => {
    const jobs = newJobs();
    const user = randomUUID();
    const p = await preview(jobs, user, 'one');
    const f = await failed(jobs, user);
    offset = 50 * 60_000;
    expect(await has(jobs, p)).toBe(true); // looked at after 50 minutes
    await preview(jobs, randomUUID(), 'tick'); // any start lets go of what has expired
    expect(await has(jobs, f)).toBe(false); // a failed job: 50 idle minutes is past its 15
    offset = (50 + 59) * 60_000;
    await preview(jobs, randomUUID(), 'tick2');
    expect(await has(jobs, p)).toBe(true); // 59 idle minutes
    offset = (50 + 59 + 61) * 60_000;
    await preview(jobs, randomUUID(), 'tick3');
    expect(await has(jobs, p)).toBe(false); // 61 idle minutes
  });

  it("a person's own finished jobs go before their previews when they are over their share", async () => {
    const jobs = newJobs();
    const user = randomUUID();
    const first = await preview(jobs, user, 'first');
    for (let i = 0; i < 9; i++) await preview(jobs, user, `more ${i}`);
    const f = await failed(jobs, user);
    await preview(jobs, user, 'twelfth');
    expect(await has(jobs, f)).toBe(false);
    expect(await has(jobs, first)).toBe(true);
  });

  it(
    'the server-wide cap lets go of finished jobs first, and never of a preview somebody looked at in the last 15 minutes',
    { timeout: 120_000 },
    async () => {
      const jobs = newJobs();
      const victim = randomUUID();
      const v = await preview(jobs, victim, 'the one being reviewed');
      const doer = randomUUID();
      for (let i = 0; i < 9; i++) await failed(jobs, doer);
      for (let u = 0; u < 49; u++) {
        const user = randomUUID();
        for (let k = 0; k < 10; k++) await preview(jobs, user, `u${u} k${k}`);
      }
      // 500 held: each new start makes room by letting a FINISHED job go, never a preview
      for (let i = 0; i < 9; i++) await preview(jobs, randomUUID(), `fill ${i}`);
      expect(await has(jobs, v)).toBe(true);
      // now all 500 are fresh previews: a new import waits rather than take anybody's
      await expect(
        jobs.start(randomUUID(), randomUUID(), { transcript: tiny('too many') }),
      ).rejects.toThrow(BusyError);
      expect(await has(jobs, v)).toBe(true);
      // 16 minutes on, the reviewer is still looking; previews nobody looked at may now go
      offset = 16 * 60_000;
      expect(await has(jobs, v)).toBe(true);
      await preview(jobs, randomUUID(), 'late');
      expect(await has(jobs, v)).toBe(true);
    },
  );
});

/* ── #3: undo keeps what somebody has built on ────────────────────────── */

describe('#3 undo keeps a memory somebody linked to since', () => {
  it('a note written since that links to a memory keeps it; a link that was already there does not', async () => {
    const { owner, archive, post, addMember, undo } = await setup('linked');
    const member = await addMember('contributor');
    // written BEFORE the import: its dangling link is claimed by the import, which is not "since"
    const before = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Earlier ${RUN}`,
      type: 'event',
      body: 'See [[My mother sold fish at the market and she came home]].',
    });
    expect(before.status).toBe(201);
    const out = (await (await post({ transcript: interview(2), save: true })).json()) as {
      runId: string;
      saved: Array<{ id: string; title: string }>;
    };
    expect(out.saved[1]!.title).toBe('My mother sold fish at the market and she came home');
    const since = await ctx.api(member.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `About father ${RUN}`,
      type: 'event',
      body: `I remember [[${out.saved[0]!.title}]] too.`,
    });
    expect(since.status).toBe(201);
    expect(await (await undo(owner, out.runId)).json()).toMatchObject({
      erased: 1,
      kept: [{ id: out.saved[0]!.id, reason: 'linked' }],
    });
  });
});

describe('#3 a link another import made by itself is not somebody building on a memory', () => {
  it('a later import that linked the earlier one`s titles does not stop the earlier one being undone', async () => {
    const { owner, archive, post, undo } = await setup('linked-by-import');
    const a = (await (await post({ transcript: interview(2), save: true })).json()) as {
      runId: string;
      saved: Array<{ id: string }>;
    };
    // the same stories told again later: the composer links the earlier memories by their titles
    const b = (await (await post({ transcript: interview(2, ' Later.'), save: true })).json()) as {
      saved: Array<{ id: string }>;
    };
    const links = await ctx.pool.query(
      `select resolved_id from public.links where source_id = any($1::uuid[])`,
      [b.saved.map((s) => s.id)],
    );
    expect(links.rows.map((r) => (r as { resolved_id: string }).resolved_id)).toContain(
      a.saved[0]!.id,
    );
    expect(await (await undo(owner, a.runId)).json()).toMatchObject({ erased: 2, kept: [] });
    void archive;
  });
});

/* ── #4: the duplicate guard after "import it again anyway" ───────────── */

describe('#4 any import of the same words that still has notes guards it', () => {
  it('import, import again anyway, undo the second copy: the first still guards', async () => {
    const { owner, archive, post, noteCount, undo } = await setup('force-undo');
    const first = (await (await post({ transcript: interview(2), save: true })).json()) as {
      runId: string;
    };
    const forced = (await (
      await post({ transcript: interview(2), save: true, force: true })
    ).json()) as { runId: string };
    expect(await (await undo(owner, forced.runId)).json()).toMatchObject({ erased: 2 });
    const again = await post({ transcript: interview(2), save: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: 'duplicate',
      duplicateOf: { runId: first.runId, noteCount: 2 },
    });
    expect(await noteCount()).toBe(2);
    const active = await ctx.pool.query(
      `select id from public.ingest_runs where archive_id = $1 and active`,
      [archive],
    );
    expect(active.rows).toEqual([{ id: first.runId }]);
  });

  it('import again anyway, then the second copy deleted by hand: the first still guards', async () => {
    const { owner, archive, post, noteCount } = await setup('force-delete');
    const first = (await (await post({ transcript: interview(2), save: true })).json()) as {
      runId: string;
    };
    const forced = (await (
      await post({ transcript: interview(2), save: true, force: true })
    ).json()) as { saved: Array<{ id: string }> };
    for (const s of forced.saved) {
      await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${s.id}`);
    }
    const again = await post({ transcript: interview(2), save: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ duplicateOf: { runId: first.runId } });
    expect(await noteCount()).toBe(2);
  });
});

/* ── #5: cancel, the hard limit, and a bounded check ──────────────────── */

describe('#5 a cancel is honoured until the import starts writing, and refused after', () => {
  it('cancel while checking: the job ends cancelled and nothing is written', async () => {
    const { owner, archive, post, noteCount, getJob, pollJob } = await setup('cancel-check');
    await seedSunja(owner, archive);
    const g = judgeGate();
    ctx.deps.chat = g.chat;
    const job = (await (
      await post({ transcript: BORN, save: true, async: true, teller: 'Grandma Sunja' })
    ).json()) as { id: string };
    await g.asked;
    expect(await getJob(owner, job.id)).toMatchObject({ stage: 'checking', canCancel: true });
    const c = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest/${job.id}/cancel`);
    expect(c.status).toBe(200);
    try {
      expect(await pollJob(owner, job.id, (v) => v.status !== 'running')).toMatchObject({
        status: 'cancelled',
        error: { code: 'cancelled' },
      });
    } finally {
      g.release();
    }
    await sleep(200);
    expect(await noteCount()).toBe(1); // the seeded note only
  });

  it('cancel while saving: 409 too_late, canCancel is false, and the import completes', async () => {
    const { owner, archive, post, noteCount, getJob, pollJob } = await setup('cancel-save');
    const unlock = await holdArchiveLock(archive);
    let job: { id: string };
    try {
      job = (await (await post({ transcript: interview(2), save: true, async: true })).json()) as {
        id: string;
      };
      await pollJob(owner, job.id, (v) => v.stage === 'saving');
      const c = await ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive}/ingest/${job.id}/cancel`,
      );
      expect(c.status).toBe(409);
      expect(await c.json()).toMatchObject({ code: 'too_late' });
      expect(await getJob(owner, job.id)).toMatchObject({ stage: 'saving', canCancel: false });
    } finally {
      await unlock();
    }
    expect(await pollJob(owner, job.id, (v) => v.status !== 'running')).toMatchObject({
      status: 'succeeded',
      canCancel: false,
      outcome: { status: 'saved' },
    });
    expect(await noteCount()).toBe(2);
    // a cancel on a finished job changes nothing and is not an error
    const again = await ctx.api(
      owner.token,
      'POST',
      `/v1/archives/${archive}/ingest/${job.id}/cancel`,
    );
    expect(again.status).toBe(200);
  });

  it('canCancel is true while the AI is organising', async () => {
    const { owner, post, getJob, pollJob } = await setup('can-cancel');
    const g = gated();
    ctx.deps.chat = g.chat;
    const job = (await (await post({ transcript: interview(2), async: true })).json()) as {
      id: string;
      canCancel: boolean;
    };
    expect(job.canCancel).toBe(true);
    await g.called;
    expect(await getJob(owner, job.id)).toMatchObject({ stage: 'organizing', canCancel: true });
    g.release();
    expect(await pollJob(owner, job.id, (v) => v.status !== 'running')).toMatchObject({
      canCancel: false,
    });
  });

  it('the hard time limit stops a job that is stuck checking: timeout, nothing written', async () => {
    const { owner, archive, post, noteCount } = await setup('limit-check');
    await seedSunja(owner, archive);
    const g = judgeGate();
    ctx.deps.chat = g.chat;
    process.env.INGEST_HARD_LIMIT_MS = '1500';
    try {
      const res = await post({ transcript: BORN, save: true, teller: 'Grandma Sunja' });
      expect(res.status).toBe(504);
      expect(await res.json()).toMatchObject({ code: 'timeout' });
    } finally {
      g.release();
    }
    await sleep(200);
    expect(await noteCount()).toBe(1);
  });

  it('the check against the archive is bounded: what the time limit cut short is counted, not waited for', async () => {
    const { owner, archive } = await setup('check-bounded');
    const result = await ingestParsed(
      parseTranscript(interview(5)),
      { interviewee: 'A' },
      { chat: null, titles: [] },
    );
    // every archive lookup takes 250 ms
    const slow = {
      query: async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('with allowed as materialized'))
          await sleep(250);
        return ctx.pool.query(sql, params);
      },
      connect: () => ctx.pool.connect(),
    } as unknown as Pool;
    const t0 = Date.now();
    const out = await annotateImport(
      { ...ctx.deps, pool: slow },
      archive,
      owner.userId,
      result,
      null,
      {
        deadlineMs: 600,
      },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.check.complete).toBe(false);
    expect(out.check.reason).toBe('time');
    expect(out.check.skipped).toBeGreaterThan(0);
    expect(out.check.skipped).toBeLessThan(5);
  });

  it('an ordinary import says its check was complete', async () => {
    const { post } = await setup('check-complete');
    const out = (await (await post({ transcript: interview(2) })).json()) as {
      check: { complete: boolean; skipped: number };
    };
    expect(out.check).toEqual({ complete: true, skipped: 0 });
  });
});

/* ── #6: markers follow titles; a skipped memory takes its markers ────── */

describe('#6 disagreement markers name the right memory, whatever happens between preview and save', () => {
  type Preview = {
    jobId: string;
    memories: Array<{
      id: string;
      title: string;
      body: string;
      conflicts?: Array<{ source: { id: string; title: string } | null }>;
    }>;
  };
  type Saved = {
    saved: Array<{ id: string; title: string }>;
    memories: Array<{ conflicts?: Array<{ source: { id: string } | null }> }>;
  };
  const linksOf = async (noteId: string) =>
    (
      await ctx.pool.query(`select target, resolved_id from public.links where source_id = $1`, [
        noteId,
      ])
    ).rows as Array<{ target: string; resolved_id: string | null }>;
  const bodyOf = async (noteId: string) =>
    (
      (await ctx.pool.query(`select body from public.notes where id = $1`, [noteId])).rows[0] as {
        body: string;
      }
    ).body;

  it('memories carry an id, and a marker names the memory by it', async () => {
    const { post } = await setup('ids');
    const prev = (await (await post({ transcript: selfContra() })).json()) as Preview;
    expect(prev.memories.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(prev.memories[1]!.conflicts?.[0]?.source?.id).toBe('run:m1');
  });

  it('(a) a newer note took the first memory`s title: the marker follows the memory, not the newcomer', async () => {
    const { owner, archive, post } = await setup('marker-collide');
    const prev = (await (await post({ transcript: selfContra() })).json()) as Preview;
    const a = prev.memories[0]!.title;
    const other = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: a,
        type: 'event',
        body: 'An unrelated note about selling a car.',
      })
    ).json()) as { id: string };
    const saved = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest/${prev.jobId}/save`, {})
    ).json()) as Saved;
    expect(saved.saved[0]!.title).not.toBe(a);
    const links = await linksOf(saved.saved[1]!.id);
    expect(links.map((l) => l.resolved_id)).toContain(saved.saved[0]!.id);
    expect(links.map((l) => l.resolved_id)).not.toContain(other.id);
    expect(saved.memories[1]!.conflicts?.[0]?.source?.id).toBe(saved.saved[0]!.id);
  });

  it('(b) the person retitled the first memory: the marker follows the new title', async () => {
    const { owner, archive, post } = await setup('marker-retitle');
    const prev = (await (await post({ transcript: selfContra() })).json()) as Preview;
    const saved = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest/${prev.jobId}/save`, {
        memories: [{ index: 0, title: `Selling the farm ${RUN}` }],
      })
    ).json()) as Saved;
    expect(saved.saved[0]!.title).toBe(`Selling the farm ${RUN}`);
    expect(await bodyOf(saved.saved[1]!.id)).toContain(`[[Selling the farm ${RUN}]]`);
    expect((await linksOf(saved.saved[1]!.id)).map((l) => l.resolved_id)).toContain(
      saved.saved[0]!.id,
    );
  });

  it('a memory renamed because the archive has a note of that title does not pull that note`s links over to itself', async () => {
    const { owner, archive, post } = await setup('marker-own-title');
    const busan = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: 'Busan',
        type: 'place',
        body: 'A city by the sea.',
      })
    ).json()) as { id: string };
    const words = 'I was born in Busan in a little house near the harbour, in nineteen forty-six.';
    // the AI titles the memory "Busan", the title of a note the archive already has
    ctx.deps.chat = {
      id: 'titles-busan',
      complete: async (system, user) =>
        system.includes('You check whether a NEW statement')
          ? '{"conflicts":[]}'
          : JSON.stringify({
              memories: [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => ({
                turns: [Number(m[1])],
                title: 'Busan',
                body: words,
              })),
            }),
    };
    const out = (await (
      await post({
        transcript: {
          interviewee: 'A',
          segments: [seg(0, 'Q', 'Where were you born, and when?'), seg(1, 'A', words)],
        },
        save: true,
      })
    ).json()) as { saved: Array<{ id: string; title: string }> };
    expect(out.saved[0]!.title).not.toBe('Busan');
    expect(await bodyOf(out.saved[0]!.id)).toContain('[[Busan]]');
    expect((await linksOf(out.saved[0]!.id)).map((l) => l.resolved_id)).toEqual([busan.id]);
  });

  it('(c) the person left the first memory out: its marker goes too, and nothing claims a memory disagrees with itself', async () => {
    const { owner, archive, post } = await setup('marker-skip');
    const prev = (await (await post({ transcript: selfContra() })).json()) as Preview;
    const a = prev.memories[0]!.title;
    expect(prev.memories[1]!.body).toContain(`[[${a}]]`);
    const saved = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest/${prev.jobId}/save`, {
        memories: [{ index: 0, skip: true }],
      })
    ).json()) as Saved;
    expect(saved.saved).toHaveLength(1);
    const body = await bodyOf(saved.saved[0]!.id);
    expect(body).not.toContain('⚠');
    expect(body).not.toContain(`[[${a}]]`);
    expect(body).toContain('From the interview transcript'); // the rest of the footer stays
    expect(await linksOf(saved.saved[0]!.id)).toEqual([]);
    expect(saved.memories[0]!.conflicts ?? []).toEqual([]);
  });
});

/* ── #7: a rename cascade is not somebody editing a memory ────────────── */

describe('#7 undo does not count a rename cascade as an edit', () => {
  it('renaming one memory keeps that one, not the one whose marker merely followed the rename', async () => {
    const { owner, archive, post, undo } = await setup('cascade');
    const out = (await (await post({ transcript: selfContra(), save: true })).json()) as {
      runId: string;
      saved: Array<{ id: string }>;
    };
    const ren = await ctx.api(
      owner.token,
      'PUT',
      `/v1/archives/${archive}/notes/${out.saved[0]!.id}`,
      { title: `The farm sale ${RUN}` },
    );
    expect(ren.status).toBe(200);
    expect(await (await undo(owner, out.runId)).json()).toMatchObject({
      erased: 1,
      kept: [{ id: out.saved[0]!.id, reason: 'edited' }],
    });
  });

  it('renaming a note an import disagreed with leaves the import undoable', async () => {
    const { owner, archive, post, undo } = await setup('cascade-ext');
    await seedSunja(owner, archive);
    const sunja = (
      await ctx.pool.query(`select id from public.notes where archive_id = $1 and title = $2`, [
        archive,
        'Sunja Kim',
      ])
    ).rows[0] as { id: string };
    // the judge finds the disagreement, quoting the note exactly as it is written
    ctx.deps.chat = {
      id: 'judge',
      complete: async (system, user) =>
        !system.includes('You check whether a NEW statement')
          ? '{"memories":[]}'
          : user.includes('[Sunja Kim]')
            ? JSON.stringify({
                conflicts: [
                  {
                    note: 'Sunja Kim',
                    about: 'birthplace',
                    existing:
                      'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
                  },
                ],
              })
            : '{"conflicts":[]}',
    };
    const out = (await (
      await post({ transcript: BORN, save: true, teller: 'Grandma Sunja' })
    ).json()) as { runId: string; saved: Array<{ id: string }> };
    const links = await ctx.pool.query(
      `select resolved_id from public.links where source_id = $1`,
      [out.saved[0]!.id],
    );
    expect(links.rows.map((r) => (r as { resolved_id: string }).resolved_id)).toContain(sunja.id);
    // someone renames the note: the cascade rewrites the marker in the imported memory
    await ctx.api(owner.token, 'PUT', `/v1/archives/${archive}/notes/${sunja.id}`, {
      title: `Kim Sunja ${RUN}`,
    });
    const reasons = await ctx.pool.query(
      `select reason from public.revisions where note_id = $1 order by seq`,
      [out.saved[0]!.id],
    );
    expect(reasons.rows.map((r) => (r as { reason: string }).reason)).toEqual([
      'ai-suggestion',
      'rename-cascade',
    ]);
    expect(await (await undo(owner, out.runId)).json()).toMatchObject({ erased: 1, kept: [] });
  });
});

/* ── #8: what an undone import leaves behind ──────────────────────────── */

describe('#8 an undone (or emptied) import keeps no file name, no hash, and no words', () => {
  it('after undo: the record has no file name or hash, and the job no longer holds the words', async () => {
    const { owner, post, undo, getJob } = await setup('erase');
    const out = (await (
      await post({ transcript: interview(2), save: true, source: 'grandma-diagnosis.txt' })
    ).json()) as { runId: string; jobId: string };
    expect((await undo(owner, out.runId)).status).toBe(200);
    const row = (
      await ctx.pool.query(
        `select source_label, source_hash, active, undone_at from public.ingest_runs where id = $1`,
        [out.runId],
      )
    ).rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ source_label: null, source_hash: null, active: false });
    expect(row.undone_at).not.toBeNull();
    const v = await getJob(owner, out.jobId);
    expect(v.outcome).toMatchObject({ undone: true, memories: [], saved: [] });
    expect(JSON.stringify(v)).not.toContain('repaired boats');
    expect(JSON.stringify(v)).not.toContain('grandma-diagnosis');
  });

  it('an import whose notes were all deleted by hand drops its file name and hash when it is next seen', async () => {
    const { owner, archive, post } = await setup('emptied');
    const out = (await (
      await post({ transcript: interview(2), save: true, source: 'tape-3.txt' })
    ).json()) as { runId: string; saved: Array<{ id: string }> };
    for (const s of out.saved) {
      await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${s.id}`);
    }
    const list = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/ingest-runs`)
    ).json()) as Array<{ id: string; source: string | null; notes: number }>;
    expect(list.find((r) => r.id === out.runId)).toMatchObject({ source: null, notes: 0 });
    const row = (
      await ctx.pool.query(
        `select source_label, source_hash from public.ingest_runs where id = $1`,
        [out.runId],
      )
    ).rows[0];
    expect(row).toEqual({ source_label: null, source_hash: null });
  });
});

/* ── #9: the same words, labelled differently ─────────────────────────── */

describe('#9 the same interview with its speakers named differently is the same interview', () => {
  it('a JSON with SPEAKER_00 and a text with names: the second is refused as a duplicate', async () => {
    const { post, noteCount } = await setup('labels');
    const lines = [
      ['SPEAKER_00', 'Interviewer', 'What do you remember about your father?'],
      ['SPEAKER_01', 'Grandma', STORIES[0]!],
      ['SPEAKER_00', 'Interviewer', 'And your mother?'],
      ['SPEAKER_01', 'Grandma', STORIES[1]!],
    ] as const;
    const json = {
      interviewee: 'SPEAKER_01',
      segments: lines.map(([id, , text], i) => seg(i, id, text)),
    };
    const text = lines.map(([, name, t]) => `${name}: ${t}`).join('\n');
    expect((await post({ transcript: json, save: true })).status).toBe(200);
    const again = await post({ transcript: text, interviewee: 'Grandma', save: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'duplicate' });
    expect(await noteCount()).toBe(2);
  });
});

/* ── #10: two undos at once ───────────────────────────────────────────── */

describe('#10 two undos at the same moment erase once, and the second is told it was already done', () => {
  it('one erases, the other answers alreadyUndone; the record is stamped once', async () => {
    const { owner, post, undo } = await setup('dbl-undo');
    const out = (await (await post({ transcript: interview(3), save: true })).json()) as {
      runId: string;
    };
    const [a, b] = (await Promise.all(
      [undo(owner, out.runId), undo(owner, out.runId)].map(async (p) => (await p).json()),
    )) as Array<{ erased: number; alreadyUndone: boolean }>;
    expect([a!.alreadyUndone, b!.alreadyUndone].sort()).toEqual([false, true]);
    expect(a!.erased + b!.erased).toBe(3);
    const stamp1 = (
      await ctx.pool.query(`select undone_at from public.ingest_runs where id = $1`, [out.runId])
    ).rows[0];
    expect(await (await undo(owner, out.runId)).json()).toMatchObject({ alreadyUndone: true });
    const stamp2 = (
      await ctx.pool.query(`select undone_at from public.ingest_runs where id = $1`, [out.runId])
    ).rows[0];
    expect(stamp2).toEqual(stamp1);
  });
});

/* ── #11: a reader failing is the file's problem; logs never quote it ─── */

describe('#11 a failure says what is wrong without repeating what it was given', () => {
  it('a reader that trips over the file answers 400 unreadable, and neither the answer nor the log quotes it', async () => {
    const { post } = await setup('reader');
    logged.length = 0;
    const res = await post({ transcript: 'READER-CRASH the secret words of grandma', save: true });
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('unreadable');
    expect(body).not.toContain('secret words');
    expect(logged.join('\n')).not.toContain('secret words');
  });

  it('a server fault answers 500, and the log names the fault without the words', async () => {
    const { post } = await setup('pipeline');
    logged.length = 0;
    const res = await post({
      transcript: {
        interviewee: 'A',
        segments: [
          seg(0, 'Q', 'What do you remember?'),
          seg(1, 'A', 'PIPELINE-CRASH my private memory of the hospital and the long night.'),
        ],
      },
      save: true,
    });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('hospital');
    expect(logged.some((l) => l.includes('[ingest] job'))).toBe(true);
    expect(logged.join('\n')).not.toContain('hospital');
  });
});

/* ── #12: one archive, one spelling ───────────────────────────────────── */

describe('#12 an upper-case archive id is the same archive', () => {
  it('the busy rule sees one archive, and the job is found under either spelling', async () => {
    const { owner, archive } = await setup('upper');
    const g = gated();
    ctx.deps.chat = g.chat;
    try {
      const one = (await (
        await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
          transcript: interview(2),
          async: true,
        })
      ).json()) as { id: string };
      const two = await ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive.toUpperCase()}/ingest`,
        {
          transcript: interview(2, ' Two.'),
          async: true,
        },
      );
      expect(two.status).toBe(429);
      expect(
        (
          await ctx.api(
            owner.token,
            'GET',
            `/v1/archives/${archive.toUpperCase()}/ingest/${one.id.toUpperCase()}`,
          )
        ).status,
      ).toBe(200);
    } finally {
      g.release();
    }
  });
});

/* ── a change the server does not understand is refused, never dropped ── */

describe('a save with a change it cannot read is refused, and nothing is saved', () => {
  it('a string, fractional or negative index, a non-list, a non-object body: 400 each', async () => {
    const { owner, archive, post, noteCount } = await setup('patches');
    const prev = (await (await post({ transcript: interview(2) })).json()) as { jobId: string };
    const save = (body: unknown) =>
      ctx.app.request(`/v1/archives/${archive}/ingest/${prev.jobId}/save`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const body of [
      { memories: [{ index: '0', skip: true }] },
      { memories: [{ index: 1.5, skip: true }] },
      { memories: [{ index: -1, skip: true }] },
      { memories: [{ index: 0, skip: 'yes' }] },
      { memories: [{ index: 0, title: 7 }] },
      { memories: [7] },
      { memories: { 0: { skip: true } } },
      [{ index: 0, skip: true }],
    ]) {
      const r = await save(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await noteCount()).toBe(0);
    expect((await save({ memories: [{ index: 0, skip: true }] })).status).toBe(200);
    expect(await noteCount()).toBe(1);
  });
});

/* ── an import never links a private note's title ─────────────────────── */

describe('an import, shared with every member, never links a note marked private', () => {
  it("the importer's own private note is not linked; a shared one is", async () => {
    const { owner, archive, post } = await setup('private-title');
    const priv = (await (
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: "Uncle Jae's drinking",
        type: 'event',
        body: 'Private.',
      })
    ).json()) as { id: string };
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
      [archive, priv.id],
    );
    expect(
      (
        await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
          title: 'Busan',
          type: 'place',
          body: 'A city.',
        })
      ).status,
    ).toBe(201);
    const out = (await (
      await post({
        transcript: {
          interviewee: 'A',
          segments: [
            seg(0, 'Q', 'Tell me about your brother please.'),
            seg(
              1,
              'A',
              "Nobody in the family ever talked about Uncle Jae's drinking, but we all knew about it in Busan and kept quiet.",
            ),
          ],
        },
        save: true,
      })
    ).json()) as { saved: Array<{ id: string }> };
    const body = (
      (await ctx.pool.query(`select body from public.notes where id = $1`, [out.saved[0]!.id]))
        .rows[0] as { body: string }
    ).body;
    expect(body).toContain('[[Busan]]');
    expect(body).not.toContain("[[Uncle Jae's drinking]]");
  });
});

/* ── what a person types into a card ──────────────────────────────────── */

describe('an edited memory: control characters are stripped, and a refusal says why in a code', () => {
  it('a NUL (or another control character) typed or pasted into a card is dropped, not a 500', async () => {
    const { owner, archive, post } = await setup('controls');
    const prev = (await (await post({ transcript: interview(2) })).json()) as {
      jobId: string;
      memories: Array<{ title: string }>;
    };
    const res = await ctx.app.request(`/v1/archives/${archive}/ingest/${prev.jobId}/save`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        memories: [
          {
            index: 0,
            title: 'My\u0000 father\u0007',
            body: 'He mended\u0000 boats.\u001b\nAnd more.',
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const rows = (
      await ctx.pool.query(
        `select title, body from public.notes where archive_id = $1 order by title`,
        [archive],
      )
    ).rows as Array<{ title: string; body: string }>;
    const mine = rows.find((r) => r.title === 'My father');
    expect(mine?.body).toBe('He mended boats.\nAnd more.');
    expect(
      rows.every((r) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(r.title + r.body)),
    ).toBe(true);
  });

  it('every refusal carries a stable reason and the position of the memory it is about', async () => {
    const { owner, archive, post, noteCount } = await setup('reasons');
    const prev = (await (await post({ transcript: interview(3) })).json()) as { jobId: string };
    const save = async (memories: unknown[]) => {
      const r = await ctx.app.request(`/v1/archives/${archive}/ingest/${prev.jobId}/save`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ memories }),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect(await save([{ index: 1, occurred: 'sometime back then' }])).toMatchObject({
      status: 400,
      body: { code: 'cannot_save', reason: 'date', index: 1 },
    });
    expect(await save([{ index: 2, title: 'a [broken] title' }])).toMatchObject({
      status: 400,
      body: { code: 'cannot_save', reason: 'title', index: 2 },
    });
    expect(await save([{ index: 0, type: 'spaceship' }])).toMatchObject({
      status: 400,
      body: { code: 'cannot_save', reason: 'type', index: 0 },
    });
    expect(await save([{ index: 0, body: 'x'.repeat(20_001) }])).toMatchObject({
      status: 400,
      body: { code: 'cannot_save', reason: 'body_too_long', index: 0 },
    });
    expect(await save([{ index: 9, skip: true }])).toMatchObject({
      status: 400,
      body: { code: 'cannot_save', reason: 'no_memory' },
    });
    expect(
      await save([
        { index: 0, skip: true },
        { index: 1, skip: true },
        { index: 2, skip: true },
      ]),
    ).toMatchObject({
      status: 400,
      body: { code: 'cannot_save', reason: 'nothing_selected' },
    });
    expect(await noteCount()).toBe(0);
    expect((await save([{ index: 0, skip: true }])).status).toBe(200);
    // and a second save of the same preview says there is nothing left to save
    expect(await save([])).toMatchObject({
      status: 409,
      body: { code: 'cannot_save', reason: 'nothing_to_save' },
    });
  });
});
