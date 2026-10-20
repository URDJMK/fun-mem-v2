import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';
import { WEDDING } from '../../../packages/persona/test/testimony-fixtures';

/**
 * FM-027 — the contradictory-testimony fixture (FR-083), end to end.
 *
 * Two relatives remember the same event differently. The archive must return
 * BOTH, separately cited, so a reader can see it disagrees with itself. It must
 * not average them, pick a winner, or silently return only the higher-scoring
 * note — spec §2.3 forbids the first and the ledger names it as a shortcut.
 *
 * The system never claims to know which account is right. Detecting
 * contradiction is not possible here: two chunks stating opposite facts about
 * one event are semantically SIMILAR, so the repo's own embeddings cannot
 * separate agreement from disagreement, and no NLI model is available (D-47).
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function makeNote(s: RealSession, archive: string, title: string, body: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

const ask = (s: RealSession, archive: string, question: string) =>
  ctx.app.request(`/v1/archives/${archive}/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ question, turn: 0 }),
  });

interface AskBody {
  abstained: boolean;
  reason: string;
  sources?: number;
  claims: Array<{ text: string; citation: { noteId: string } }>;
}

describe('FM-027 disagreeing testimony', () => {
  it('disagreeing testimony is returned as separate cited claims', async () => {
    const s = await ctx.realSession(`dis1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `DIS1 ${RUN}`);

    // FR-083's fixture: same wedding, two relatives, materially different on
    // the year AND the place. Realistic transcribed testimony — dialect, a
    // spelled-out year, no capitals, no terminal punctuation.
    //
    // BOTH NOTES ARE SHORT ON PURPOSE. An earlier version made the mother's
    // account verbose to force budget pressure, and that made this test 37-50%
    // FLAKY: whether the uncle's single chunk reached the top-K depended on a
    // pgroonga rank tie broken by chunk UUID, which reindexChunks re-mints on
    // every save. Kept small, every chunk is retrieved every run.
    //
    // The interleave property is NOT asserted here — it is proven
    // deterministically in packages/persona/test/diversity.test.ts, where the
    // budget can be derived rather than raced for. What this test proves is the
    // DoD-1 RESPONSE SHAPE: two accounts, separately cited, never merged.
    const motherNote = await makeNote(s, archive, `Mother's account ${RUN}`, WEDDING.mother);
    const uncleNote = await makeNote(s, archive, `Uncle's account ${RUN}`, WEDDING.uncle);

    const res = await ask(s, archive, "Grandma's wedding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskBody;

    expect(body.abstained, `abstained on answerable evidence: ${body.reason}`).toBe(false);

    // BOTH accounts survive, each carrying its own citation
    const cited = new Set(body.claims.map((c) => c.citation.noteId));
    expect(cited.has(motherNote), "the mother's account was dropped").toBe(true);
    expect(cited.has(uncleNote), "the uncle's account was dropped").toBe(true);
    expect(body.sources, 'the response does not report distinct sources').toBeGreaterThanOrEqual(2);

    // and they are SEPARATE claims — not one merged sentence. A claim carrying
    // both years is the averaging spec §2.3 forbids.
    for (const c of body.claims) {
      const both = c.text.includes('1965') && c.text.includes('1967');
      expect(both, 'two accounts were merged into one claim').toBe(false);
    }
    // each distinct year appears, so neither account was silently discarded
    const all = body.claims.map((c) => c.text).join(' ');
    expect(all).toContain('1965');
    expect(all).toContain('1967');
  });

  it('the diversity admission never reaches outside the allowed set', async () => {
    const owner = await ctx.realSession(`dis2a-${RUN}@test.local`);
    const member = await ctx.realSession(`dis2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `DIS2 ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [archive, member.userId],
    );

    const open = await makeNote(
      owner,
      archive,
      `Public wedding ${RUN}`,
      "Grandma's wedding was held in Lisbon in 1965.",
    );
    const secret = `ZZSECRET${RUN}`;
    const hidden = await makeNote(
      owner,
      archive,
      `Private wedding ${RUN}`,
      `Grandma's wedding was held in Porto in 1967. ${secret}`,
    );

    // POSITIVE CONTROL: while both are visible, diversity DOES surface two
    // sources. Without this, "the restricted note is absent" is satisfied by an
    // interleaver that never returns a second source at all.
    const before = (await (await ask(member, archive, "Grandma's wedding")).json()) as AskBody;
    expect(before.sources, 'diversity never produced two sources even unrestricted').toBe(2);

    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind)
       values ($1, $2, 'private-to-author')
       on conflict (note_id) do update set kind = excluded.kind`,
      [archive, hidden],
    );

    const res = await ask(member, archive, "Grandma's wedding");
    const text = await res.text();
    expect(text, 'restricted content reached the answer').not.toContain(secret);
    const body = JSON.parse(text) as AskBody;
    const cited = new Set(body.claims.map((c) => c.citation.noteId));
    expect(cited.has(hidden), 'a restricted note was cited through the diversity path').toBe(false);
    expect(cited.has(open) || body.abstained).toBe(true);
    // the source COUNT must not disclose the hidden note's existence either
    expect(body.sources ?? 0).toBeLessThanOrEqual(1);
  });

  it('the pipeline preserves source order into the answer', async () => {
    // The e2e above is deliberately de-pressurized so it cannot race the
    // ranker, which means deleting interleaveBySource from ask.ts would not
    // fail it. Review named that gap, and it is the exact failure that already
    // happened once: the interleave was decorative because a later layer
    // re-sorted. This asserts the WIRING deterministically — many chunks from
    // one note, one from another, and the answer must still speak from both.
    const s2 = await ctx.realSession(`dis3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s2, `DIS3 ${RUN}`);

    // one note with many chunks, ranked strongly; one with a single chunk
    const many = Array.from(
      { length: 12 },
      (_, i) =>
        `## Memory ${i + 1}\n\nGrandma's wedding story, number ${i + 1}, the one told at dinner`,
    ).join('\n\n');
    const loud = await makeNote(s2, archive, `Mother's record ${RUN}`, many);
    const quiet = await makeNote(
      s2,
      archive,
      `Uncle's record ${RUN}`,
      "Grandma's wedding was in Porto, so it was",
    );

    const body = (await (await ask(s2, archive, "Grandma's wedding")).json()) as AskBody;
    expect(body.abstained, `abstained: ${body.reason}`).toBe(false);
    const cited = new Set(body.claims.map((c) => c.citation.noteId));
    expect(cited.has(loud), 'the many-chunk note was dropped').toBe(true);
    expect(
      cited.has(quiet),
      'the single-chunk note was crowded out — source order did not survive the pipeline',
    ).toBe(true);
  });
});
