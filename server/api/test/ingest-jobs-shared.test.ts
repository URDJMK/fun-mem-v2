import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { BusyError, IngestJobs, type IngestJobsOptions } from '../src/ingest-jobs';
import { ModelError, type ChatModel } from '../src/ingest';
import { testContext, type RealSession } from './helpers';

/**
 * An import job lives in the database, not in one process's memory. A Cloudflare Worker runs
 * as many isolates, and the request that starts a job, the ones that poll, cancel and save it,
 * and the queue consumer that runs it may each land in a different one; a Node server that
 * restarts must not leave a job "running" forever. Each IngestJobs below is one such instance:
 * two that share a scope share their jobs, as every isolate of a deployment does.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

const seg = (i: number, speaker: string, text: string) => ({
  start: i * 10,
  end: i * 10 + 9,
  speaker,
  text,
});
const interview = (tag: string) => ({
  interviewee: 'A',
  segments: [
    seg(0, 'Q', 'And what do you remember about that time?'),
    seg(1, 'A', `My father repaired boats and he had big hands, said ${tag}.`),
    seg(2, 'Q', 'And your mother?'),
    seg(3, 'A', `My mother sold fish at the market every single day, said ${tag}.`),
  ],
});

/** two instances of the server over one database */
function pair(opts: IngestJobsOptions = {}, deps = ctx.deps): [IngestJobs, IngestJobs] {
  const scope = randomUUID();
  return [
    new IngestJobs(deps, { scope, sweepEveryMs: null, ...opts }),
    new IngestJobs(deps, { scope, sweepEveryMs: null, ...opts }),
  ];
}

let n = 0;
async function owner(): Promise<{ s: RealSession; archive: string }> {
  const s = await ctx.realSession(`shared-${RUN}-${n++}@test.local`);
  return { s, archive: await ctx.provisionArchive(s, `Shared ${RUN} ${n}`) };
}

/** a model that holds every call until released (or the call is aborted) */
function heldChat(): { chat: ChatModel; release: () => void; calls: () => number } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((r) => (open = r));
  let count = 0;
  return {
    release: () => open(),
    calls: () => count,
    chat: {
      id: 'held',
      complete: async (_s, _u, o) => {
        count++;
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
    },
  };
}

const row = async (id: string) =>
  (
    await ctx.pool.query(
      `select status, request is not null as holds_request, coalesce(request::text, '') as request
         from public.ingest_jobs where id = $1`,
      [id],
    )
  ).rows[0] as { status: string; holds_request: boolean; request: string } | undefined;

describe('one instance starts a job, another carries it on', () => {
  it('a preview made on one instance is read and saved on another', async () => {
    const { s, archive } = await owner();
    const [a, b] = pair();
    const started = await a.start(archive, s.userId, { transcript: interview('shared') });
    await started.done;
    const there = await b.get(started.id, archive, s.userId);
    expect(there).not.toBeNull();
    expect(b.view(there!).outcome?.status).toBe('previewed');
    const saved = await b.save(there!, []);
    expect(saved.status).toBe('saved');
    const back = await a.get(started.id, archive, s.userId);
    expect(a.view(back!).outcome?.status).toBe('saved');
  });

  it('a cancel that reaches another instance stops the run there; nothing is saved', async () => {
    const { s, archive } = await owner();
    const held = heldChat();
    const [a, b] = pair({}, { ...ctx.deps, chat: held.chat });
    const started = await a.start(archive, s.userId, {
      transcript: interview('cancelled elsewhere'),
      save: true,
    });
    for (let i = 0; i < 50 && held.calls() === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const there = await b.get(started.id, archive, s.userId);
    expect(await b.cancel(there!)).toBe('stopping');
    const finished = await started.done;
    expect(a.view(finished).status).toBe('cancelled');
    const notes = await ctx.pool.query(`select 1 from public.notes where archive_id = $1`, [
      archive,
    ]);
    expect(notes.rowCount).toBe(0);
    held.release();
  });

  it('the routes of two app instances share jobs: start on one, poll and save on the other', async () => {
    const { s, archive } = await owner();
    const scope = randomUUID();
    const one = createApp({ ...ctx.deps, ingestJobs: { scope, sweepEveryMs: null } });
    const two = createApp({ ...ctx.deps, ingestJobs: { scope, sweepEveryMs: null } });
    const call = (app: typeof one, method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${s.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const started = await call(one, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: interview('two apps'),
      async: true,
    });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    let view: { status: string; outcome?: { status: string } } = { status: 'running' };
    for (let i = 0; i < 100 && view.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      view = (await (await call(two, 'GET', `/v1/archives/${archive}/ingest/${id}`)).json()) as {
        status: string;
      };
    }
    expect(view).toMatchObject({ status: 'succeeded', outcome: { status: 'previewed' } });
    const saved = await call(two, 'POST', `/v1/archives/${archive}/ingest/${id}/save`, {});
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { status: string }).status).toBe('saved');
  });
});

describe('a job handed to a queue', () => {
  it('runs in the consumer, and the transcript is not kept once it has been read', async () => {
    const { s, archive } = await owner();
    const queued: string[] = [];
    const [web, consumer] = pair({
      enqueue: async (id) => {
        queued.push(id);
      },
    });
    const tag = `queued words ${RUN}`;
    const started = await web.start(archive, s.userId, { transcript: interview(tag) });
    expect(queued).toEqual([started.id]);
    expect(web.view(started).status).toBe('running');
    // until the consumer picks it up, the request (and so the transcript) waits with the job
    expect((await row(started.id))?.request).toContain(tag);

    await consumer.runQueued(started.id);
    const after = await row(started.id);
    expect(after).toMatchObject({ status: 'succeeded', holds_request: false });
    const seen = await web.get(started.id, archive, s.userId);
    expect(web.view(seen!).outcome?.status).toBe('previewed');
  });

  it('a message delivered twice runs the job once', async () => {
    const { s, archive } = await owner();
    const held = heldChat();
    held.release();
    const [web, consumer] = pair(
      { enqueue: async () => undefined },
      { ...ctx.deps, chat: held.chat },
    );
    const started = await web.start(archive, s.userId, { transcript: interview('twice') });
    await consumer.runQueued(started.id);
    const calls = held.calls();
    expect(calls).toBeGreaterThan(0);
    await consumer.runQueued(started.id);
    expect(held.calls()).toBe(calls);
    expect((await row(started.id))?.status).toBe('succeeded');
  });
});

describe('a job whose runner died', () => {
  const realNow = Date.now;
  let offset = 0;
  beforeEach(() => {
    offset = 0;
    Date.now = () => realNow() + offset;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it('is reported failed once it has gone quiet, and no longer blocks its archive', async () => {
    const { s, archive } = await owner();
    // handed to a queue that never delivers: nothing will ever run it
    const [lost, other] = pair({ enqueue: async () => undefined });
    const dead = await lost.start(archive, s.userId, { transcript: interview('lost') });
    await expect(
      other.start(archive, s.userId, { transcript: interview('blocked') }),
    ).rejects.toBeInstanceOf(BusyError);

    offset = 3 * 60_000;
    const next = await other.start(
      archive,
      s.userId,
      { transcript: interview('next') },
      { wait: true },
    );
    await next.done;
    const gone = await other.get(dead.id, archive, s.userId);
    expect(other.view(gone!)).toMatchObject({
      status: 'failed',
      error: { code: 'interrupted' },
    });
  });
});
