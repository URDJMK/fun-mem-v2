import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { IngestJobs } from '../src/ingest-jobs';
import { testContext } from './helpers';

/**
 * The work a Node server does on timers (the embedding drain, letting go of expired import
 * jobs) and in the background (running an import) is, on a Worker, started by a cron and a
 * queue. They reach it through /internal routes, which exist only when the app is given a
 * secret, and answer only a request that carries it: the Worker makes one per isolate and
 * sends it only from its own scheduled and queue handlers.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const SECRET = `secret-${RUN}`;
afterAll(() => ctx.close());

const scope = randomUUID();
const app = createApp({
  ...ctx.deps,
  internalSecret: SECRET,
  ingestJobs: { scope, sweepEveryMs: null },
});
const internal = (path: string, secret: string | null = SECRET) =>
  app.request(path, {
    method: 'POST',
    headers: secret === null ? {} : { 'x-funmem-internal': secret },
  });

describe('/internal', () => {
  it('does not exist without a secret, and answers nobody who lacks it', async () => {
    const plain = createApp({ ...ctx.deps, ingestJobs: { scope, sweepEveryMs: null } });
    expect((await plain.request('/internal/embeddings/drain', { method: 'POST' })).status).toBe(
      404,
    );
    expect((await internal('/internal/embeddings/drain', null)).status).toBe(404);
    expect((await internal('/internal/embeddings/drain', 'not-it')).status).toBe(404);
  });

  it('drain: embeds the chunks still waiting for a vector, in the one archive it is given', async () => {
    // scoped, as every test's drain is: a drain of everything would embed other files'
    // archives too (boot.test.ts counts on one of them staying unembedded)
    const s = await ctx.realSession(`internal-${RUN}@test.local`);
    const note = async (archive: string, title: string) => {
      const created = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
        title,
        type: 'place',
        body: 'My father repaired boats in the yard by the river every summer.',
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { id: string }).id;
    };
    const here = await ctx.provisionArchive(s, `Internal ${RUN}`);
    const elsewhere = await ctx.provisionArchive(s, `Internal elsewhere ${RUN}`);
    const id = await note(here, `The boat yard ${RUN}`);
    const other = await note(elsewhere, `The other yard ${RUN}`);
    const res = await internal(`/internal/embeddings/drain?archive=${here}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { written: number }).written).toBeGreaterThan(0);
    const embedded = async (noteId: string) =>
      (
        await ctx.pool.query(
          `select model_version from public.chunk_embeddings where note_id = $1`,
          [noteId],
        )
      ).rows.map((r: { model_version: string }) => r.model_version);
    expect(await embedded(id)).toContain(ctx.embeddings.modelVersion);
    expect(await embedded(other)).toEqual([]);
    expect((await internal('/internal/embeddings/drain?archive=not-an-id')).status).toBe(400);
  });

  it('drain: without an embedding provider there is nothing it can do', async () => {
    const none = createApp({ ...ctx.deps, embeddings: null, internalSecret: SECRET });
    const res = await none.request(`/internal/embeddings/drain?archive=${randomUUID()}`, {
      method: 'POST',
      headers: { 'x-funmem-internal': SECRET },
    });
    expect(res.status).toBe(503);
  });

  it('sweep: lets go of import jobs past their time', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const r = await ctx.pool.query(
      `insert into public.ingest_jobs
         (scope, archive_id, user_id, status, stage, started_at, finished_at, touched_at, heartbeat_at)
       values ($1, $2, $3, 'failed', 'done', $4, $4, $4, $4) returning id`,
      [scope, randomUUID(), randomUUID(), old],
    );
    const res = await internal('/internal/ingest/sweep');
    expect(res.status).toBe(200);
    const left = await ctx.pool.query(`select 1 from public.ingest_jobs where id = $1`, [
      r.rows[0].id,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('run: runs an import that was handed to the queue', async () => {
    const s = await ctx.realSession(`internal-run-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Internal run ${RUN}`);
    const web = new IngestJobs(ctx.deps, {
      scope,
      sweepEveryMs: null,
      enqueue: async () => undefined,
    });
    const job = await web.start(archive, s.userId, {
      transcript: {
        interviewee: 'A',
        segments: [
          { start: 0, end: 9, speaker: 'Q', text: 'What do you remember?' },
          { start: 10, end: 19, speaker: 'A', text: 'My mother sold fish at the market.' },
        ],
      },
    });
    const res = await internal(`/internal/ingest/run/${job.id}`);
    expect(res.status).toBe(200);
    const after = await web.get(job.id, archive, s.userId);
    expect(web.view(after!)).toMatchObject({
      status: 'succeeded',
      outcome: { status: 'previewed' },
    });
  });
});
