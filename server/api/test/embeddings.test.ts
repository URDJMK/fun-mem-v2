import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drainOnce } from '../src/embeddings';
import { testContext, type RealSession } from './helpers';

// FM-022 embedding drain. Local Supabase stack must be running.
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

describe('FM-022 embedding drain', () => {
  it('embedding drain writes pgvector rows keyed by content hash and model version', async () => {
    const s = await ctx.realSession(`emb-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Emb ${RUN}`);
    const noteId = await note(
      s,
      archive,
      'Diary',
      '# 하나\n\n첫 문단 이야기.\n\n# 둘\n\n둘째 문단 기록.',
    );

    // save indexed 2 chunks but embedded nothing (embedding never runs inside
    // the save transaction); the pending set drains exactly those 2
    expect(await drainOnce(ctx.pool, ctx.embeddings, archive)).toBe(2);
    const rows = await ctx.pool.query(
      `select id, content_hash, model_version, extensions.vector_dims(embedding) as dims
         from public.chunk_embeddings where note_id = $1 order by content_hash`,
      [noteId],
    );
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows) {
      expect(r.model_version).toBe(ctx.embeddings.modelVersion);
      expect(r.dims).toBe(1024);
    }
    // keyed by the chunks' own generated content hashes
    const chunkHashes = await ctx.pool.query(
      `select content_hash from public.chunks where note_id = $1 order by content_hash`,
      [noteId],
    );
    expect(rows.rows.map((r) => r.content_hash)).toEqual(
      chunkHashes.rows.map((r) => r.content_hash),
    );

    // idempotent: nothing pending, nothing re-embedded
    expect(await drainOnce(ctx.pool, ctx.embeddings, archive)).toBe(0);

    // edit only section two: the unchanged chunk's embedding row survives
    // byte-identically (same id — hash cache, no re-embed), the stale hash is
    // removed by the save itself (erasure hygiene), the new content drains
    const keptId = rows.rows.find((r) => r.content_hash === chunkHashes.rows[0]!.content_hash)!
      .id as string;
    const hash1 = (
      await ctx.pool.query(
        `select content_hash from public.chunks where note_id = $1 and chunk_index = 0`,
        [noteId],
      )
    ).rows[0]!.content_hash as string;
    const put = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${noteId}`, {
      body: '# 하나\n\n첫 문단 이야기.\n\n# 둘\n\n완전히 새로운 내용.',
    });
    expect(put.status).toBe(200);
    const afterSave = await ctx.pool.query(
      `select id, content_hash from public.chunk_embeddings where note_id = $1`,
      [noteId],
    );
    expect(afterSave.rows.length).toBe(1); // stale hash gone, unchanged kept
    expect(afterSave.rows[0]!.content_hash).toBe(hash1);
    expect(afterSave.rows[0]!.id).toBe(keptId);

    // the drain pass itself also sweeps orphaned vectors of content no longer
    // in the note (edit-race window; panel finding): seed an orphan AFTER the
    // save's cleanup ran, then the pending-work pass removes it
    await ctx.pool.query(
      `insert into public.chunk_embeddings (archive_id, note_id, content_hash, model_version, embedding)
         values ($1, $2, 'deadbeef', $3, (select embedding from public.chunk_embeddings limit 1))`,
      [archive, noteId, ctx.embeddings.modelVersion],
    );
    expect(await drainOnce(ctx.pool, ctx.embeddings, archive)).toBe(1);
    const swept = await ctx.pool.query(
      `select content_hash from public.chunk_embeddings where note_id = $1 order by content_hash`,
      [noteId],
    );
    expect(swept.rows.map((r) => r.content_hash)).not.toContain('deadbeef');
    expect(swept.rows.length).toBe(2);

    // erasure forward-rule: deleting the note cascades its vectors away
    await ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/notes/${noteId}`);
    const gone = await ctx.pool.query(`select 1 from public.chunk_embeddings where note_id = $1`, [
      noteId,
    ]);
    expect(gone.rowCount).toBe(0);
  });
});
