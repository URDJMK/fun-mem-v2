import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DB_URL, SUPABASE_URL, testContext } from './helpers';

/**
 * The Worker entry (src/worker.ts), run here in Node with the bindings faked: the queue is an
 * array, the execution context collects waitUntil. Each step that would land in another isolate
 * imports the module afresh, so nothing is shared between them but the database: an import
 * started in one, run by the queue consumer in a second, and followed and saved in a third.
 *
 * FUNMEM_POOLER_URL points the Worker at a transaction-mode pooler (PgBouncer locally, standing
 * in for Supabase's Supavisor on port 6543); without it, at the database directly.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

interface Message {
  body: { jobId: string };
  ack(): void;
  retry(): void;
}
type Handlers = {
  fetch(req: Request, env: unknown, ctx: unknown): Promise<Response>;
  scheduled(event: unknown, env: unknown, ctx: unknown): Promise<void>;
  queue(batch: { messages: Message[] }, env: unknown, ctx: unknown): Promise<void>;
};

const sent: Array<{ jobId: string }> = [];
const env = {
  FUNMEM_DB_URL: process.env.FUNMEM_POOLER_URL ?? DB_URL,
  FUNMEM_SUPABASE_URL: SUPABASE_URL,
  FUNMEM_EMBEDDING_PROVIDER: 'deterministic',
  INGEST_QUEUE: {
    send: async (body: { jobId: string }) => {
      sent.push(body);
    },
  },
};

/** a fresh isolate: the module loaded anew, with nothing cached from the last */
async function isolate(): Promise<Handlers> {
  vi.resetModules();
  return (await import('../src/worker')).default as Handlers;
}
const executionContext = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
};
const call = async (
  w: Handlers,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const ec = executionContext();
  const res = await w.fetch(
    new Request(`https://api.example${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ec,
  );
  await Promise.all(ec.pending);
  return res;
};

describe('the Worker', () => {
  it('serves health and readiness, and keeps /internal to itself', async () => {
    const w = await isolate();
    expect((await call(w, null, 'GET', '/health')).status).toBe(200);
    const ready = await call(w, null, 'GET', '/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, db: 'ok' });
    expect((await call(w, null, 'POST', '/internal/embeddings/drain')).status).toBe(404);
    expect((await call(w, null, 'GET', '/v1/archives')).status).toBe(401);
  });

  it('checks a real sign-in, and reads and writes notes', async () => {
    const s = await ctx.realSession(`worker-${RUN}@test.local`);
    const w = await isolate();
    const prov = await call(w, s.token, 'POST', '/v1/provision', {
      subjectName: `Worker ${RUN}`,
      jurisdiction: 'US',
    });
    expect(prov.status).toBe(201);
    const { archiveId } = (await prov.json()) as { archiveId: string };
    const made = await call(w, s.token, 'POST', `/v1/archives/${archiveId}/notes`, {
      title: `The river ${RUN}`,
      type: 'place',
      body: 'We swam in the river below the mill every July.',
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const read = await call(
      await isolate(),
      s.token,
      'GET',
      `/v1/archives/${archiveId}/notes/${id}`,
    );
    expect(read.status).toBe(200);
    expect(((await read.json()) as { body: string }).body).toContain('below the mill');
  });

  it('an import starts in one isolate, runs in the queue consumer, and is saved from a third', async () => {
    const s = await ctx.realSession(`worker-import-${RUN}@test.local`);
    const first = await isolate();
    const prov = await call(first, s.token, 'POST', '/v1/provision', {
      subjectName: `Worker import ${RUN}`,
      jurisdiction: 'US',
    });
    const { archiveId } = (await prov.json()) as { archiveId: string };
    sent.length = 0;
    const started = await call(first, s.token, 'POST', `/v1/archives/${archiveId}/ingest`, {
      async: true,
      transcript: {
        interviewee: 'A',
        segments: [
          { start: 0, end: 9, speaker: 'Q', text: 'What do you remember about the mill?' },
          { start: 10, end: 19, speaker: 'A', text: `We swam below the mill every July, ${RUN}.` },
        ],
      },
    });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    expect(sent).toEqual([{ jobId: id }]);

    const consumer = await isolate();
    const acked: string[] = [];
    await consumer.queue(
      {
        messages: [
          {
            body: sent[0]!,
            ack: () => void acked.push('ack'),
            retry: () => void acked.push('retry'),
          },
        ],
      },
      env,
      executionContext(),
    );
    expect(acked).toEqual(['ack']);

    const third = await isolate();
    const view = await call(third, s.token, 'GET', `/v1/archives/${archiveId}/ingest/${id}`);
    expect(await view.json()).toMatchObject({
      status: 'succeeded',
      outcome: { status: 'previewed' },
    });
    const saved = await call(
      third,
      s.token,
      'POST',
      `/v1/archives/${archiveId}/ingest/${id}/save`,
      {},
    );
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { status: string }).status).toBe('saved');
  });

  it('the cron drains embeddings', async () => {
    const s = await ctx.realSession(`worker-cron-${RUN}@test.local`);
    const w = await isolate();
    const prov = await call(w, s.token, 'POST', '/v1/provision', {
      subjectName: `Worker cron ${RUN}`,
      jurisdiction: 'US',
    });
    const { archiveId } = (await prov.json()) as { archiveId: string };
    const made = await call(w, s.token, 'POST', `/v1/archives/${archiveId}/notes`, {
      title: `The orchard ${RUN}`,
      type: 'place',
      body: 'The apple orchard behind the school, where we picked in October.',
    });
    const { id } = (await made.json()) as { id: string };
    await (await isolate()).scheduled({ cron: '* * * * *' }, env, executionContext());
    const rows = await ctx.pool.query(`select 1 from public.chunk_embeddings where note_id = $1`, [
      id,
    ]);
    expect(rows.rowCount).toBeGreaterThan(0);
  });
});
