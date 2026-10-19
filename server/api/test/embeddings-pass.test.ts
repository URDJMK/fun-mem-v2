import { randomUUID } from 'node:crypto';
import { DeterministicEmbeddingProvider, type EmbeddingProvider } from '@funmem/core';
import { afterAll, describe, expect, it } from 'vitest';
import { drainOnce, startEmbeddingLoop } from '../src/embeddings';
import { testContext } from './helpers';

/**
 * The embedding pass: a shutdown must not wait for the whole backlog (round-3 review D3: SIGTERM waited
 * 26 s for 4,600 chunks, minutes with the real model). The drain stops BETWEEN batches; the
 * batch in hand finishes.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const MODEL = `test-stop-${RUN}`;
afterAll(async () => {
  await ctx.pool.query(`delete from public.chunk_embeddings where model_version = $1`, [MODEL]);
  await ctx.pool.query(`delete from public.chunk_embedding_failures where model_version = $1`, [
    MODEL,
  ]);
  await ctx.close();
});

/** a provider that takes `ms` per batch, and says when it is first asked */
function slowProvider(ms: number) {
  const inner = new DeterministicEmbeddingProvider();
  let calls = 0;
  let first: () => void = () => undefined;
  const asked = new Promise<void>((r) => (first = r));
  const provider: EmbeddingProvider = {
    modelVersion: MODEL,
    dims: inner.dims,
    embed: async (texts) => {
      calls++;
      first();
      await new Promise((r) => setTimeout(r, ms));
      return inner.embed(texts);
    },
  };
  return { provider, asked, calls: () => calls };
}

async function backlog(label: string, notes: number) {
  const owner = await ctx.realSession(`es-${label}-${RUN}@test.local`);
  const archive = await ctx.provisionArchive(owner, `ES ${label} ${RUN}`);
  for (let i = 0; i < notes; i++) {
    const r = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Backlog ${i} ${RUN}`,
      type: 'event',
      body: `# A\n\nblock one of note ${i} ${RUN}.\n\n# B\n\nblock two of note ${i} ${RUN}.`,
    });
    expect(r.status).toBe(201);
  }
  const embedded = async () =>
    Number(
      (
        await ctx.pool.query(
          `select count(*) as n from public.chunk_embeddings where archive_id = $1 and model_version = $2`,
          [archive, MODEL],
        )
      ).rows[0].n,
    );
  const chunks = Number(
    (
      await ctx.pool.query(`select count(*) as n from public.chunks where archive_id = $1`, [
        archive,
      ])
    ).rows[0].n,
  );
  return { archive, embedded, chunks };
}

describe('D3 stopping the embedding loop ends the pass after the batch in hand', () => {
  it('drainOnce, signalled while it embeds a batch, finishes that batch and stops', async () => {
    const { archive, embedded, chunks } = await backlog('drain', 60);
    expect(chunks).toBeGreaterThan(96); // more than three batches
    const slow = slowProvider(300);
    const ac = new AbortController();
    const pass = drainOnce(ctx.pool, slow.provider, archive, ac.signal);
    await slow.asked;
    ac.abort();
    const written = await pass;
    expect(slow.calls()).toBe(1);
    expect(written).toBeLessThanOrEqual(32);
    expect(await embedded()).toBeLessThan(chunks);
  });

  it("the loop's stop function returns within about one batch, not the whole backlog", async () => {
    const { archive, embedded, chunks } = await backlog('loop', 60);
    const slow = slowProvider(600);
    const stop = startEmbeddingLoop(ctx.pool, slow.provider, 60_000, archive);
    await slow.asked;
    const t0 = Date.now();
    await stop();
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1500); // the whole backlog: 4 batches of 600 ms
    expect(await embedded()).toBeLessThan(chunks);
  });
});

describe('D8 an undo running beside an embedding pass does not make the pass fail', () => {
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
  const interview = (n: number, tag: string) => ({
    interviewee: 'A',
    segments: Array.from({ length: n * 2 }, (_, i) =>
      i % 2 === 0
        ? seg(i, 'Q', 'And what do you remember about that time?')
        : seg(i, 'A', `${STORIES[((i - 1) / 2) % STORIES.length]!} Memory ${(i - 1) / 2} ${tag}`),
    ),
  });

  it('the notes vanish while the pass writes their vectors: those rows are skipped, the pass ends normally', async () => {
    const provider = new DeterministicEmbeddingProvider();
    for (let run = 0; run < 2; run++) {
      const owner = await ctx.realSession(`es-undo-${run}-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(owner, `ES undo ${run} ${RUN}`);
      const saved = (await (
        await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
          transcript: interview(300, `${run} ${RUN}`),
          save: true,
        })
      ).json()) as { runId: string };
      const pass = drainOnce(ctx.pool, provider, archive).then(
        () => 'ok',
        (e: unknown) => `failed ${String((e as { code?: string }).code)}`,
      );
      await new Promise((r) => setTimeout(r, 150 + run * 100));
      const undo = await ctx.api(
        owner.token,
        'POST',
        `/v1/archives/${archive}/ingest-runs/${saved.runId}/undo`,
      );
      expect(undo.status).toBe(200);
      expect(await pass).toBe('ok');
    }
  });
});
