import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-050 — Unicode NFC normalization across identity and links.
 *
 * Every fixture builds its NFD form with `.normalize('NFD')` and asserts the
 * BYTE LENGTH in the setup, not the assertion. A pasted "NFD" string that some
 * editor silently recomposed would otherwise make these tests pass while
 * testing nothing.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

/** Café — 5 bytes composed (the é is two), 6 decomposed (an e plus a two-byte accent). */
const NFC_T = (r: string) => `Caf\u{E9} ${r}`.normalize('NFC');
const NFD_T = (r: string) => `Caf\u{E9} ${r}`.normalize('NFD');

afterAll(async () => {
  await ctx.close();
});

async function post(s: RealSession, archive: string, title: string, body = 'x') {
  return ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, { title, type: 'event', body });
}

describe('FM-050 unicode title normalization', () => {
  it('an NFD title collides with an existing NFC title in the same archive', async () => {
    const s = await ctx.realSession(`n1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N1 ${RUN}`);
    const nfc = NFC_T(RUN);
    const nfd = NFD_T(RUN);
    // the fixture proves itself: same glyphs, different bytes
    expect(nfc).not.toBe(nfd);
    expect(Buffer.byteLength(nfc, 'utf8')).toBeLessThan(Buffer.byteLength(nfd, 'utf8'));

    // NFD FIRST, deliberately. Posting the composed form first lets a
    // non-canonicalizing write path store canonical bytes by luck; posting the
    // decomposed form first means only real canonicalization can satisfy the
    // stored-bytes assertion below.
    expect((await post(s, archive, nfd)).status).toBe(201);
    const second = await post(s, archive, nfc);
    expect(
      second.status,
      'two composition forms of one title were accepted as distinct notes',
    ).not.toBe(201);
    expect(second.status).toBeGreaterThanOrEqual(400);

    // and only one row exists, under the canonical form
    const rows = await ctx.pool.query<{ title: string }>(
      `select title from public.notes where archive_id = $1`,
      [archive],
    );
    expect(rows.rows).toHaveLength(1);
    // the row was WRITTEN decomposed and must have been canonicalized at the door
    expect(rows.rows[0]!.title, 'the stored title is not canonical').toBe(nfc);
    expect(Buffer.byteLength(rows.rows[0]!.title, 'utf8')).toBe(Buffer.byteLength(nfc, 'utf8'));
  });

  it('a wikilink typed in NFD resolves to an NFC-titled note', async () => {
    const s = await ctx.realSession(`n2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N2 ${RUN}`);
    const nfc = NFC_T(`t${RUN}`);
    const nfd = NFD_T(`t${RUN}`);
    expect(Buffer.byteLength(nfd, 'utf8')).toBeGreaterThan(Buffer.byteLength(nfc, 'utf8'));

    const target = await post(s, archive, nfc);
    const targetId = ((await target.json()) as { id: string }).id;
    // the REFERRER types the decomposed form, as a macOS file name or a pasted-in text carries it
    await post(s, archive, `Ref ${RUN}`, `see [[${nfd}]] here.`);

    const link = await ctx.pool.query<{ resolved_id: string | null; target: string }>(
      `select resolved_id, target from public.links
        where archive_id = $1 and target <> '' order by start_pos limit 1`,
      [archive],
    );
    expect(link.rows[0]!.resolved_id, 'an NFD-authored wikilink did not resolve').toBe(targetId);
    // body bytes are NEVER rewritten — only the comparison is normalized
    expect(
      Buffer.byteLength(link.rows[0]!.target, 'utf8'),
      'the stored link target was rewritten',
    ).toBe(Buffer.byteLength(nfd, 'utf8'));
  });

  it('title resolution uses an index scan, not a sequential scan', async () => {
    const s = await ctx.realSession(`n5-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N5 ${RUN}`);
    // A plan is only meaningful once the planner has a reason to prefer an
    // index, so seed enough rows and ANALYZE — the contract asks for proof, not
    // for an assertion that happens to hold on an empty table.
    await ctx.pool.query(
      `insert into public.notes (archive_id, title, type, body, created_by)
       select $1, 'Seed ' || g || ' ' || $2, 'event', 'b', $3 from generate_series(1, 2000) g`,
      [archive, RUN, s.userId],
    );
    await ctx.pool.query('analyze public.notes');

    // the production shape reindexLinks issues: archive_id equality AND the
    // normalized key, both spelled exactly as the index expression
    const plan = await ctx.pool.query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers)
       select id, normalize(lower(btrim(title)), NFC) as norm from public.notes
        where archive_id = $1 and normalize(lower(btrim(title)), NFC) = any($2)`,
      [archive, [`seed 7 ${RUN}`.toLowerCase()]],
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text, `title resolution did not use the title index:\n${text}`).toContain(
      'notes_archive_title_ci',
    );
    expect(text, `title resolution fell back to a scan:\n${text}`).not.toMatch(/Seq Scan on notes/);

    // Plans depend on statistics; operand TEXT does not. Keep both: this is the
    // assertion that actually fails when a comparison site drifts.
    const src = readFileSync(path.resolve(__dirname, '../src/notes.ts'), 'utf8');
    const bare = src.match(/(?<!normalize\()lower\(btrim\(/g) ?? [];
    expect(bare, `${bare.length} un-normalized lower(btrim( site(s) remain`).toEqual([]);
  });
});
