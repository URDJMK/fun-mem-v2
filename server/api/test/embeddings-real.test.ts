import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drainOnce } from '../src/embeddings';
import { createBgeM3Provider, type RealProvider } from '../src/embeddings-real';
import { testContext, type TestContext } from './helpers';

/**
 * Env-gated REAL-MODEL smoke (FM-022, D-30). NOT a gate test: it downloads
 * 568MB on first run and ONNX inference is not bit-reproducible, so assertions
 * are wide-margin semantic ones (top-3 containment, similarity margins), never
 * exact scores or exact orders. Run with:
 *   FUNMEM_RUN_MODEL_SMOKE=1 pnpm --filter @funmem/api exec vitest run embeddings-real
 */
const RUN_SMOKE = process.env.FUNMEM_RUN_MODEL_SMOKE === '1';
const RUN = randomUUID().slice(0, 8);
let provider: RealProvider | null = null;
let ctx: TestContext | null = null;

afterAll(async () => {
  await ctx?.close();
  await provider?.dispose();
});

describe.skipIf(!RUN_SMOKE)('FM-035 real provider respawn smoke', () => {
  it('the shipped provider respawns its own worker after a death', async () => {
    // The ONLY coverage of the production spawn path. The default tier cannot
    // reach it — createBgeM3Provider loads a 568MB model — so a regression to a
    // closure over one boot-time Worker (the G8-caught defect) is invisible
    // outside this env-gated run. Kept here rather than faked, because faking
    // the factory is exactly what hid the defect the first time.
    const p = await createBgeM3Provider();
    const first = await p.embed(['before']);
    expect(first).toHaveLength(1);

    await p.dispose(); // kills the worker; the provider object survives
    const second = await p.embed(['after']);
    expect(second, 'the provider did not respawn its worker').toHaveLength(1);
    expect(second[0]).toHaveLength(1024);

    await p.dispose();
  });
});

describe.skipIf(!RUN_SMOKE)('FM-022 bge-m3 real provider smoke', () => {
  it('real model serves paraphrase retrieval through the full stack', async () => {
    provider = await createBgeM3Provider();
    expect(provider.dims).toBe(1024);
    expect(provider.modelVersion).toContain('bge-m3');

    // provider-level semantics: a paraphrase that shares no content word with
    // the original beats an unrelated passage by a wide margin (meaning beyond
    // the words is the vector leg's whole job — the keyword legs only match
    // words). Measured with this model: 0.74 against 0.41.
    const [original, paraphrase, noise] = await provider.embed([
      'We went to the sea together',
      'The whole family spent the day at the beach',
      'The quarterly budget meeting agenda',
    ]);
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(Math.abs(Math.sqrt(cos(original!, original!)) - 1)).toBeLessThan(1e-3); // normalized
    expect(cos(original!, paraphrase!)).toBeGreaterThan(cos(original!, noise!) + 0.15);

    // full stack: the standard test app wiring with the REAL provider injected
    ctx = testContext({ embeddings: provider });
    const s = await ctx.realSession(`smoke-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Smoke ${RUN}`);
    const mk = async (title: string, body: string) => {
      const r = await ctx!.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
        title,
        type: 'event',
        body,
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { id: string }).id;
    };
    // target + lexically-overlapping-but-wrong distractors
    const walk = await mk('Walk', 'We strolled along the seaside');
    await mk('Notice', 'Notice: we are closing the path along the river for repairs');
    await mk('Meeting', 'Quarterly budget meeting agenda');
    await mk('Recipe', "Grandma's recipe for baking bread");
    expect(await drainOnce(ctx.pool, provider, archive)).toBeGreaterThan(0);

    // paraphrase query: ZERO token overlap with the target body (negative
    // control asserts the keyword legs cannot see it) — the real vector leg
    // must still put it in the top 3
    const q = 'Sunny afternoon on a sandy beach';
    const miss = await ctx.pool.query(
      `select 1 from public.chunks c
        where c.note_id = $1
          and (c.fts @@ websearch_to_tsquery('simple', $2) or c.content &@~ pgroonga_query_escape($2))`,
      [walk, q],
    );
    expect(miss.rowCount).toBe(0);
    const res = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/search?q=${encodeURIComponent(q)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ noteId: string }> };
    expect(body.results.slice(0, 3).map((r) => r.noteId)).toContain(walk);
  }, 360_000);
});
