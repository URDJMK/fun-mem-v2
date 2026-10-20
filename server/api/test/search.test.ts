import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drainOnce } from '../src/embeddings';
import { testContext, type RealSession } from './helpers';

// FM-022 hybrid search: RRF fusion + pre-retrieval ACL + FR-080 query classes.
// Local Supabase stack must be running.
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const RRF_K = 60;

afterAll(async () => {
  await ctx.close();
});

interface SearchResult {
  noteId: string;
  chunkId: string | null;
  anchor: string | null;
  heading: string;
  headingPath: string[];
  snippet: string;
  score: number;
}

async function note(
  s: RealSession,
  archive: string,
  title: string,
  body: string,
  extra?: { type?: string; occurred?: string },
): Promise<string> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: extra?.type ?? 'event',
    body,
    ...(extra?.occurred ? { occurred: extra.occurred } : {}),
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function search(
  token: string,
  archive: string,
  q: string,
): Promise<{ results: SearchResult[]; total: number }> {
  const res = await ctx.api(
    token,
    'GET',
    `/v1/archives/${archive}/search?q=${encodeURIComponent(q)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { results: SearchResult[]; total: number };
}

async function restrict(archive: string, noteId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );
}

async function addMember(archive: string, userId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

describe('FM-022 hybrid search', () => {
  it('rrf fused ordering on the fixture corpus differs from and combines both channels', async () => {
    const s = await ctx.realSession(`rrf-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Rrf ${RUN}`);
    // one chunk per note; D matches no channel and must never appear
    const a = await note(s, archive, 'A', 'harbor harbor story');
    // `simple` keeps harbor/pier as ONE word, so tsvector cannot find 'harbor' in
    // it; pgroonga splits at the slash and can
    const b = await note(s, archive, 'B', 'we walked the harbor/pier at dusk');
    const c = await note(
      s,
      archive,
      'C',
      'we took harbor photos for the album and filed them in the archive for safekeeping',
    );
    const d = await note(s, archive, 'D', 'budget meeting schedule review');
    await drainOnce(ctx.pool, ctx.embeddings, archive);
    const q = 'harbor';

    // independently derive each channel's ranking (same rank expressions and
    // id tie-break the endpoint is contracted to use)
    const ts = await ctx.pool.query(
      `select c.id from public.chunks c
        where c.archive_id = $1 and c.fts @@ websearch_to_tsquery('simple', $2)
        order by ts_rank(c.fts, websearch_to_tsquery('simple', $2)) desc, c.id`,
      [archive, q],
    );
    const pg = await ctx.pool.query(
      `select c.id from public.chunks c
        where c.archive_id = $1 and c.content &@ $2
        order by pgroonga_score(c.tableoid, c.ctid) desc, c.id`,
      [archive, q],
    );
    const chunks = await ctx.pool.query(
      `select c.id, c.content from public.chunks c where c.archive_id = $1 order by c.id`,
      [archive],
    );
    const [qv] = await ctx.embeddings.embed([q]);
    const vecs = await ctx.embeddings.embed(chunks.rows.map((r) => r.content as string));
    const vec = chunks.rows
      .map((r, i) => ({ id: r.id as string, sim: cosine(qv!, vecs[i]!) }))
      .sort((x, y) => y.sim - x.sim || (x.id < y.id ? -1 : 1))
      .map((r) => r.id);

    // expected fusion: score(chunk) = Σ_legs 1/(60 + rank), weights 1.0
    const fusedScore = new Map<string, number>();
    for (const leg of [
      ts.rows.map((r) => r.id as string),
      pg.rows.map((r) => r.id as string),
      vec,
    ]) {
      leg.forEach((id, i) => fusedScore.set(id, (fusedScore.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
    }
    const dChunk = chunks.rows.find((r) => (r.content as string).includes('meeting'))!.id as string;
    fusedScore.delete(dChunk); // no keyword match; a pure-noise vector rank must not fuse it in
    const expected = [...fusedScore.entries()]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .map(([id]) => id);

    const res = await search(s.token, archive, q);
    // the WHOLE fused order — top-1-only is the ledger's named forbidden shortcut
    expect(res.results.map((r) => r.chunkId)).toEqual(expected);
    const noteIds = res.results.map((r) => r.noteId);
    expect(noteIds).toContain(b); // combines: pgroonga-only hit fused in
    expect(noteIds).toContain(a);
    expect(noteIds).toContain(c);
    expect(noteIds).not.toContain(d);
    expect(res.total).toBe(res.results.length);
    // differs from the single keyword channel: tsvector alone cannot see B
    expect(ts.rows.map((r) => r.id)).not.toContain(res.results[noteIds.indexOf(b)]!.chunkId);
    // deterministic: identical query, identical full ordering
    const again = await search(s.token, archive, q);
    expect(again.results.map((r) => r.chunkId)).toEqual(expected);
  });

  it('restricted notes are absent from hybrid results snippets and counts', async () => {
    const owner = await ctx.realSession(`aclo-${RUN}@test.local`);
    const member = await ctx.realSession(`aclm-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Acl ${RUN}`);
    await addMember(archive, member.userId);
    const secretKey = `XSECRETKEY${RUN}`;
    const pub = await note(owner, archive, 'Picnic', 'a picnic by the harbor that Sunday');
    const secret = await note(owner, archive, 'Secret', `a harbor secret and ${secretKey}`);
    await restrict(archive, secret);
    await drainOnce(ctx.pool, ctx.embeddings, archive);

    // the member sees only the public note: results, snippets, AND the count
    const asMember = await search(member.token, archive, 'harbor');
    expect(asMember.total).toBe(1);
    expect(asMember.results.length).toBe(1);
    expect(asMember.results[0]!.noteId).toBe(pub);
    const raw = JSON.stringify(asMember);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(secretKey);

    // the author still finds their own restricted note
    const asOwner = await search(owner.token, archive, 'harbor');
    expect(asOwner.total).toBe(2);
    expect(asOwner.results.map((r) => r.noteId).sort()).toEqual([pub, secret].sort());

    // the restricted chunk IS embedded (drain is ACL-blind storage) — absence
    // above is the pre-retrieval filter, not missing data
    const embedded = await ctx.pool.query(
      `select 1 from public.chunk_embeddings where note_id = $1`,
      [secret],
    );
    expect(embedded.rowCount).toBe(1);
  });

  it('search covers exact alias date person and semantic query classes', async () => {
    const s = await ctx.realSession(`cls-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Cls ${RUN}`);
    const voyage = await note(
      s,
      archive,
      'Voyage',
      '# Voyage out\n\nWe went to the sea. ^v1\n\n# Homecoming\n\nWe came back home.',
    );
    const alias = await note(s, archive, 'Recipes', "[[Margaret|Peg]] grandma's recipe collection");
    const person = await note(s, archive, 'Margaret Kim', 'Grandma was a wonderful cook', {
      type: 'person',
    });
    const summer = await note(s, archive, 'Summer', 'memories of the long summer', {
      occurred: '1987-06',
    });
    const walk = await note(s, archive, 'Walk', 'We walked along the seaside');
    await drainOnce(ctx.pool, ctx.embeddings, archive);

    // exact: a quoted phrase matches in order, not reversed
    const exact = await search(s.token, archive, '"went to the sea"');
    const hit = exact.results.find((r) => r.noteId === voyage);
    expect(hit).toBeDefined();
    expect(hit!.anchor).toBe('v1');
    const reversed = await search(s.token, archive, '"sea the to went"');
    expect(reversed.results.map((r) => r.noteId)).not.toContain(voyage);

    // alias: wikilink display text is searchable content
    const peg = await search(s.token, archive, 'Peg');
    expect(peg.results.map((r) => r.noteId)).toContain(alias);

    // person: a person note surfaces by TITLE even when the body never says it
    const who = await search(s.token, archive, 'Margaret');
    expect(who.results.map((r) => r.noteId)).toContain(person);
    // ...including a chunk-less stub (empty body — the create-first-fill-later
    // wiki pattern; panel finding): the note itself stands in for chunk 0
    const stub = await note(s, archive, 'Margaret Stub', '', { type: 'person' });
    const who2 = await search(s.token, archive, 'Margaret');
    const stubHit = who2.results.find((r) => r.noteId === stub);
    expect(stubHit).toBeDefined();
    expect(stubHit!.chunkId).toBeNull();
    expect(stubHit!.snippet).toBe('Margaret Stub');

    // date: an occurred-dated note surfaces for a year query its body lacks
    const when = await search(s.token, archive, '1987');
    expect(when.results.map((r) => r.noteId)).toContain(summer);
    // ...and a chunk-less dated stub is still findable by year (panel finding)
    const datedStub = await note(s, archive, 'August', '', { occurred: '1987-08' });
    const when2 = await search(s.token, archive, '1987');
    expect(when2.results.map((r) => r.noteId)).toContain(datedStub);

    // ILIKE metacharacters are literals (panel finding): '%' matches nothing
    // here instead of turning the title leg into match-every-note
    const pct = await search(s.token, archive, '%');
    expect(pct.total).toBe(0);

    // semantic: no full keyword match exists (negative control below), the
    // vector leg still surfaces the related chunk in the top 3
    const sem = await search(s.token, archive, 'seaside walking scenery photos');
    expect(sem.results.slice(0, 3).map((r) => r.noteId)).toContain(walk);
    const tsMiss = await ctx.pool.query(
      `select 1 from public.chunks c
        where c.note_id = $1 and c.fts @@ websearch_to_tsquery('simple', $2)`,
      [walk, 'seaside walking scenery photos'],
    );
    expect(tsMiss.rowCount).toBe(0);
  });

  it('only a year, month or day is a date query; other numbers and words are not', async () => {
    const s = await ctx.realSession(`dts-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Dts ${RUN}`);
    // two notes dated a month apart, whose bodies never say the date
    const june = await note(s, archive, 'June trip', 'we drove to the coast', {
      occurred: '1987-06',
    });
    const august = await note(s, archive, 'August trip', 'we drove to the hills', {
      occurred: '1987-08',
    });

    const ids = async (q: string) =>
      (await search(s.token, archive, q)).results.map((r) => r.noteId);
    // a year, a year-month and a full date are dates and match by prefix
    expect(await ids('1987')).toEqual(expect.arrayContaining([june, august]));
    expect(await ids('1987-06')).toContain(june);
    expect(await ids('1987-06')).not.toContain(august);
    // a trailing word is not part of a date, so the query is plain keywords
    expect(await ids('1987th')).not.toContain(june);
    // neither is anything that merely starts with digits
    expect(await ids('19870')).not.toContain(june);
  });

  it('rebuild restores hybrid search after an index wipe', async () => {
    const s = await ctx.realSession(`rbd-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Rbd ${RUN}`);
    await note(s, archive, 'Fishing', '# Log\n\nSea fishing log. ^f1');
    await note(s, archive, 'Camping', 'We camped in the mountains');
    await drainOnce(ctx.pool, ctx.embeddings, archive);

    const proj = (r: { results: SearchResult[]; total: number }) => ({
      total: r.total,
      rows: r.results.map((x) => ({
        noteId: x.noteId,
        anchor: x.anchor,
        heading: x.heading,
        snippet: x.snippet,
      })),
    });
    const before = proj(await search(s.token, archive, 'sea'));
    expect(before.total).toBeGreaterThan(0);

    // wipe the ENTIRE derived layer (chunks + vectors) out from under search
    await ctx.pool.query(`delete from public.chunk_embeddings where archive_id = $1`, [archive]);
    await ctx.pool.query(`delete from public.chunks where archive_id = $1`, [archive]);
    const wiped = await search(s.token, archive, 'sea');
    expect(wiped.total).toBe(0);

    // derived-layer law: rebuild + drain restore identical search results
    const rebuilt = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/chunks/rebuild`);
    expect(rebuilt.status).toBe(200);
    await drainOnce(ctx.pool, ctx.embeddings, archive);
    expect(proj(await search(s.token, archive, 'sea'))).toEqual(before);
  });
});
