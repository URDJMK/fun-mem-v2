import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drainOnce } from '../src/embeddings';
import { EmbeddingContentError, EmbeddingWorkerError } from '../src/embeddings-real';
import { testContext, type RealSession } from './helpers';
import type { EmbeddingProvider } from '@funmem/core';

/**
 * FM-046 — D1 poison-chunk isolation.
 *
 * `embed()` answers per BATCH, so one unembeddable chunk fails all 32 of its
 * co-batch. The unguarded call in drainOnce then propagates, the pending set is
 * recomputed identically every 15s, and the loop logs it once per process — so a
 * single bad chunk stalls the GLOBAL queue forever, across restarts, silently.
 *
 * These drive the real drainOnce against real Postgres. Bisection is internal to
 * it deliberately: exporting a helper for a test to call would hide the defect
 * the way FM-035's seam did.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function note(s: RealSession, archive: string, title: string, body: string): Promise<string> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Rejects any batch containing `marker`; embeds everything else normally. */
function poisonProvider(base: EmbeddingProvider, marker: string): EmbeddingProvider {
  return {
    modelVersion: base.modelVersion,
    dims: base.dims,
    embed: (texts: string[]) =>
      texts.some((t) => t.includes(marker))
        ? Promise.reject(new EmbeddingContentError('cannot embed this batch'))
        : base.embed(texts),
  };
}

const embeddedHashes = async (archive: string): Promise<Set<string>> => {
  const r = await ctx.pool.query<{ content_hash: string }>(
    `select content_hash from public.chunk_embeddings where archive_id = $1`,
    [archive],
  );
  return new Set(r.rows.map((x) => x.content_hash));
};

const failureRows = async (archive: string) =>
  (
    await ctx.pool.query(
      `select fail_count, reason_code from public.chunk_embedding_failures where archive_id = $1`,
      [archive],
    )
  ).rows;

describe('FM-046 poison-chunk isolation', () => {
  it('one poison chunk does not stall its archive', async () => {
    const s = await ctx.realSession(`poison1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Poison1 ${RUN}`);
    const POISON = `ZZPOISON${RUN}`;

    // two chunks in one note: one always rejects, one is healthy. They co-batch.
    await note(s, archive, `Mixed ${RUN}`, `# A\n\n${POISON} bad block.\n\n# B\n\nhealthy block.`);

    const provider = poisonProvider(ctx.embeddings, POISON);

    // ONE call. A backoff scheme only helps on a LATER tick, so it cannot pass.
    await expect(drainOnce(ctx.pool, provider, archive)).resolves.toBeGreaterThanOrEqual(1);

    const hashes = await embeddedHashes(archive);
    const chunks = await ctx.pool.query<{ content_hash: string; content: string }>(
      `select content_hash, content from public.chunks where archive_id = $1`,
      [archive],
    );
    const healthy = chunks.rows.filter((c) => !c.content.includes(POISON));
    const poisoned = chunks.rows.filter((c) => c.content.includes(POISON));
    expect(healthy.length).toBeGreaterThan(0);
    expect(poisoned.length).toBeGreaterThan(0);

    for (const c of healthy) {
      expect(hashes.has(c.content_hash), 'a healthy co-batched chunk was not embedded').toBe(true);
    }
    for (const c of poisoned) {
      expect(hashes.has(c.content_hash), 'the poison chunk was embedded anyway').toBe(false);
    }

    // and blame was attributed, content-only
    const fails = await failureRows(archive);
    expect(fails).toHaveLength(poisoned.length);
    expect(Number(fails[0]!.fail_count)).toBe(1); // never 0 — the formula yields 15s at 0
  });

  it('a worker outage never parks a chunk', async () => {
    const s = await ctx.realSession(`poison2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Poison2 ${RUN}`);
    await note(s, archive, `Outage ${RUN}`, 'a perfectly good block.');

    const down: EmbeddingProvider = {
      modelVersion: ctx.embeddings.modelVersion,
      dims: ctx.embeddings.dims,
      embed: () => Promise.reject(new EmbeddingWorkerError('worker died')),
    };

    await drainOnce(ctx.pool, down, archive).catch(() => {});

    // a retryable failure is the WORKER's fault, not the content's. Counting it
    // would park the entire backlog after ~90 minutes of downtime.
    expect(await failureRows(archive), 'a worker outage attributed blame to content').toHaveLength(
      0,
    );
    // and the chunk is still pending, so it drains once the worker returns
    expect(await drainOnce(ctx.pool, ctx.embeddings, archive)).toBeGreaterThan(0);
  });

  it('a length-mismatched batch writes nothing and the pending set is unchanged', async () => {
    const s = await ctx.realSession(`poison3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Poison3 ${RUN}`);
    await note(s, archive, `Mismatch ${RUN}`, '# A\n\nfirst block.\n\n# B\n\nsecond block.');

    const short: EmbeddingProvider = {
      modelVersion: ctx.embeddings.modelVersion,
      dims: ctx.embeddings.dims,
      // one vector for N texts: zipping by index would misattribute a vector to
      // the wrong chunk, which is worse than writing nothing
      embed: async (texts: string[]) => (await ctx.embeddings.embed(texts)).slice(0, 1),
    };

    await drainOnce(ctx.pool, short, archive).catch(() => {});
    expect(await embeddedHashes(archive), 'a misaligned vector was written').toEqual(new Set());
    // a miscounting provider is broken; the content is innocent and must not be
    // blamed. Without this, a regression that both aborts AND records passes.
    expect(await failureRows(archive), 'a provider fault was blamed on content').toHaveLength(0);

    // the pending set is untouched, so a healthy provider still drains it
    expect(await drainOnce(ctx.pool, ctx.embeddings, archive)).toBeGreaterThan(0);
  });

  it('a parked chunk is unparked when it embeds, when it changes, and when its note goes', async () => {
    const s = await ctx.realSession(`poison5-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Poison5 ${RUN}`);
    const POISON = `ZZUNPARK${RUN}`;

    // (1) finally embeds -> the row must GO, not merely stop matching
    const n1 = await note(s, archive, `Heals ${RUN}`, `${POISON} block.`);
    await drainOnce(ctx.pool, poisonProvider(ctx.embeddings, POISON), archive);
    expect(await failureRows(archive)).toHaveLength(1);
    // fail_count=1 defers this chunk 30s, so a healthy pass would not even select
    // it. Back-date rather than sleep — the backoff itself is covered by its own
    // required test, and waiting 30s in CI to prove unparking would be theatre.
    await ctx.pool.query(
      `update public.chunk_embedding_failures set last_tried = now() - interval '1 hour'
        where archive_id = $1`,
      [archive],
    );
    await drainOnce(ctx.pool, ctx.embeddings, archive); // healthy provider now
    expect(await failureRows(archive), 'a chunk that embedded is still parked').toHaveLength(0);

    // (2) content changes -> content_hash rotates, the old row can never match
    // the join again, so leaving it would accumulate dead rows forever
    const n2 = await note(s, archive, `Edited ${RUN}`, `${POISON} original.`);
    await drainOnce(ctx.pool, poisonProvider(ctx.embeddings, POISON), archive);
    expect(await failureRows(archive)).toHaveLength(1);
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${n2}`, {
      body: 'rewritten, perfectly embeddable now.',
    });
    await drainOnce(ctx.pool, ctx.embeddings, archive);
    expect(await failureRows(archive), 'an edited chunk left a dead failure row').toHaveLength(0);

    // (3) note deleted -> FK cascade
    const n3 = await note(s, archive, `Doomed ${RUN}`, `${POISON} doomed.`);
    await drainOnce(ctx.pool, poisonProvider(ctx.embeddings, POISON), archive);
    expect(await failureRows(archive)).toHaveLength(1);
    const del = await ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/notes/${n3}`);
    expect(del.status).toBe(200);
    expect(await failureRows(archive), 'a deleted note left its failure row').toHaveLength(0);

    void n1;
  });

  it('backoff defers a failed chunk without dropping never-failed ones', async () => {
    const s = await ctx.realSession(`poison4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Poison4 ${RUN}`);
    const POISON = `ZZDEFER${RUN}`;
    await note(s, archive, `Defer ${RUN}`, `${POISON} bad block.`);

    const provider = poisonProvider(ctx.embeddings, POISON);
    await drainOnce(ctx.pool, provider, archive);
    expect(await failureRows(archive)).toHaveLength(1);

    // a SECOND note, never failed, must still be selected — a predicate with no
    // `f.note_id is null` arm evaluates NULL and filters every fresh row out
    await note(s, archive, `Fresh ${RUN}`, 'a brand new healthy block.');
    const wrote = await drainOnce(ctx.pool, provider, archive);
    expect(wrote, 'a never-failed chunk was dropped by the backoff predicate').toBeGreaterThan(0);

    // and the failed one is still deferred, not retried in the same window
    const fails = await failureRows(archive);
    expect(fails).toHaveLength(1);

    // the 8-attempt cap: a chunk at the cap is skipped even once its backoff has
    // long elapsed, so it stops consuming a queue slot forever. Set directly
    // rather than by 8 real passes — the increment is covered above.
    await ctx.pool.query(
      `update public.chunk_embedding_failures
          set fail_count = 8, last_tried = now() - interval '30 days'
        where archive_id = $1`,
      [archive],
    );
    const capped = await drainOnce(ctx.pool, ctx.embeddings, archive);
    expect(capped, 'a chunk at the attempt cap was still selected').toBe(0);
    expect(Number(fails[0]!.fail_count), 'the deferred chunk was retried inside its backoff').toBe(
      1,
    );
  });
});
