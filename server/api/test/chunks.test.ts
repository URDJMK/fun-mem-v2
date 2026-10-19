import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

// FM-021 chunk/FTS index. Local Supabase stack must be running.
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

describe('FM-021 chunks and FTS', () => {
  it('chunks are reindexed on every note save with revision provenance', async () => {
    const s = await ctx.realSession(`chk-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Chk ${RUN}`);
    const noteId = await note(
      s,
      archive,
      'Diary',
      '# Day One\n\nWe sailed out. ^d1\n\n# Day Two\n\nWe came home.',
    );

    // create indexed chunks tied to the create-time revision
    const c1 = await ctx.pool.query(
      `select chunk_index, heading, anchor, content, revision_id
         from public.chunks where note_id = $1 order by chunk_index`,
      [noteId],
    );
    expect(c1.rows.length).toBe(2);
    expect(c1.rows[0].heading).toBe('Day One');
    expect(c1.rows[0].anchor).toBe('d1');
    expect(c1.rows[1].heading).toBe('Day Two');
    // provenance points at the note's latest revision at index time
    const rev1 = await ctx.pool.query(
      `select id from public.revisions where note_id = $1 order by seq desc limit 1`,
      [noteId],
    );
    for (const row of c1.rows) expect(row.revision_id).toBe(rev1.rows[0].id);

    // editing re-chunks in the same save: old chunks gone, new ones tied to the
    // new revision (delete-and-reinsert, not stale accumulation)
    const put = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${noteId}`, {
      body: '# Only Section\n\nRewritten entirely.',
    });
    expect(put.status).toBe(200);
    const c2 = await ctx.pool.query(
      `select chunk_index, heading, content, revision_id
         from public.chunks where note_id = $1 order by chunk_index`,
      [noteId],
    );
    expect(c2.rows.length).toBe(1);
    expect(c2.rows[0].heading).toBe('Only Section');
    expect(c2.rows[0].content).toContain('Rewritten entirely');
    const rev2 = await ctx.pool.query(
      `select id from public.revisions where note_id = $1 order by seq desc limit 1`,
      [noteId],
    );
    expect(rev2.rows[0].id).not.toBe(rev1.rows[0].id);
    expect(c2.rows[0].revision_id).toBe(rev2.rows[0].id);

    // rebuild regenerates an identical index (content projection; ids are fresh)
    const proj = async () =>
      (
        await ctx.pool.query(
          `select note_id, revision_id, chunk_index, heading, heading_path, anchor,
                  start_pos, end_pos, content, fts::text as fts
             from public.chunks where archive_id = $1
            order by note_id, chunk_index`,
          [archive],
        )
      ).rows;
    const before = await proj();
    const rebuilt = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/chunks/rebuild`);
    expect(rebuilt.status).toBe(200);
    expect(await proj()).toEqual(before);

    // deleting the note cascades its chunks away (erasure forward-rule)
    await ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/notes/${noteId}`);
    const c3 = await ctx.pool.query(`select 1 from public.chunks where note_id = $1`, [noteId]);
    expect(c3.rowCount).toBe(0);
  });

  it('english exact word and phrase queries return the chunk with its anchor', async () => {
    const s = await ctx.realSession(`en-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `En ${RUN}`);
    const noteId = await note(
      s,
      archive,
      'Voyage',
      '# Setting Out\n\nThe wooden sailboat left the harbor. ^set\n\n# Storm\n\nThe waves grew tall.',
    );

    // exact word: 'harbor' returns exactly the anchored chunk
    const word = await ctx.pool.query(
      `select anchor, content from public.chunks
        where archive_id = $1 and fts @@ websearch_to_tsquery('simple', $2)`,
      [archive, 'harbor'],
    );
    expect(word.rows.length).toBe(1);
    expect(word.rows[0].anchor).toBe('set');
    expect(word.rows[0].content).toContain('wooden sailboat');

    // exact phrase (order matters): 'wooden sailboat' matches, 'sailboat wooden' does not
    const phrase = await ctx.pool.query(
      `select content from public.chunks
        where archive_id = $1 and fts @@ phraseto_tsquery('simple', $2)`,
      [archive, 'wooden sailboat'],
    );
    expect(phrase.rows.length).toBe(1);
    const reversed = await ctx.pool.query(
      `select content from public.chunks
        where archive_id = $1 and fts @@ phraseto_tsquery('simple', $2)`,
      [archive, 'sailboat wooden'],
    );
    expect(reversed.rows.length).toBe(0);
    void noteId;
  });

  it('korean tokenization matches particle variants and quoted phrases', async () => {
    const s = await ctx.realSession(`ko-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Ko ${RUN}`);
    await note(
      s,
      archive,
      '바다 이야기',
      '# 동해\n\n우리는 바다에 갔다. ^sea\n\n# 산\n\n산으로 등산했다.',
    );

    // '바다' (noun stem) matches the chunk containing '바다에' (noun+particle) —
    // the built-in simple analyzer cannot do this; pgroonga bigram can
    const stem = await ctx.pool.query(
      `select anchor, content from public.chunks
        where archive_id = $1 and content &@ $2`,
      [archive, '바다'],
    );
    expect(stem.rows.length).toBe(1);
    expect(stem.rows[0].anchor).toBe('sea');
    expect(stem.rows[0].content).toContain('바다에');

    // quoted Korean phrase query
    const phrase = await ctx.pool.query(
      `select content from public.chunks
        where archive_id = $1 and content &@~ $2`,
      [archive, '"바다에 갔다"'],
    );
    expect(phrase.rows.length).toBe(1);

    // a Korean word only in the other section does not match the first
    const other = await ctx.pool.query(
      `select content from public.chunks where archive_id = $1 and content &@ $2`,
      [archive, '등산'],
    );
    expect(other.rows.length).toBe(1);
    expect(other.rows[0].content).toContain('산으로');
  });
});
