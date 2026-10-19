import { createHash } from 'node:crypto';
import { chunkNote } from '@funmem/core';
import type { PoolClient } from 'pg';
import type { App, AppDeps } from './app';
import { memberRole, WRITE_ROLES } from './membership';
import { inTransaction, rowsJson } from './notes';

/** sha256 hex of UTF-8 content — must equal the migration backfill's SQL form. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * FTS chunk maintenance (FM-021). Mirrors reindexLinks: delete-and-reinsert this
 * note's chunk rows from the pure core chunker, inside the caller's advisory-
 * locked transaction, threading the revision appended in that same transaction
 * as (note UUID, revision) provenance (FR-044). Note deletion rides the FK
 * cascade — no explicit chunk delete needed. Deterministic input (chunkNote)
 * makes on-save indexing and a full rebuild produce byte-identical rows.
 */
export async function reindexChunks(
  client: PoolClient,
  archiveId: string,
  noteId: string,
  revisionId: string | null,
  body: string,
): Promise<void> {
  await client.query(`delete from public.chunks where note_id = $1`, [noteId]);
  const chunks = chunkNote(body);
  // ONE statement for all of a note's chunks: a statement per chunk kept a long note's save
  // (and the archive's write lock) waiting on thousands of round trips (round-3 review D7)
  if (chunks.length > 0) {
    await client.query(
      `insert into public.chunks
         (archive_id, note_id, revision_id, chunk_index, heading, heading_path,
          anchor, start_pos, end_pos, content, content_hash)
       select $1, $2, $3, r.chunk_index, r.heading,
              array(select h.e from jsonb_array_elements_text(r.heading_path)
                                      with ordinality as h(e, o) order by h.o),
              r.anchor, r.start_pos, r.end_pos, r.content, r.content_hash
         from jsonb_to_recordset($4::jsonb) as r(
                chunk_index int, heading text, heading_path jsonb, anchor text,
                start_pos int, end_pos int, content text, content_hash text)`,
      [
        archiveId,
        noteId,
        revisionId,
        rowsJson(
          chunks.map((c) => ({
            chunk_index: c.index,
            heading: c.heading,
            heading_path: c.headingPath,
            anchor: c.anchor,
            start_pos: c.start,
            end_pos: c.end,
            content: c.content,
            content_hash: contentHash(c.content),
          })),
        ),
      ],
    );
  }
  // erasure hygiene: content the author removed loses its derived vector in
  // the SAME save transaction (embedding of NEW content is NOT done here — the
  // drain runs outside the save txn and its archive advisory lock)
  await client.query(
    `delete from public.chunk_embeddings e
      where e.note_id = $1
        and not exists (select 1 from public.chunks c
                         where c.note_id = e.note_id and c.content_hash = e.content_hash)`,
    [noteId],
  );
}

/** Notes rebuilt per transaction: the archive's write lock is let go between batches. */
const REBUILD_BATCH = 200;

/**
 * POST /v1/archives/:archiveId/chunks/rebuild — regenerate every note's chunks.
 *
 * It rewrites derived data for the whole archive, so it is a WRITE: only the roles that change
 * memories may start it (any member could, and twelve rebuilds at once by a viewer held every
 * database connection; round-3 review D4). It runs through `inTransaction`, so rebuilds of one
 * archive wait their turn in this process rather than holding connections while they wait, and
 * in batches, so a large archive does not hold its write lock for seconds at a stretch. Each
 * note's chunks come from its body alone: a note saved between two batches is indexed by its
 * own save, and one erased meanwhile is simply not there.
 */
export function registerChunkRoutes(app: App, deps: AppDeps): void {
  app.post('/v1/archives/:archiveId/chunks/rebuild', async (c) => {
    const archiveId = c.req.param('archiveId') ?? '';
    const role = await memberRole(deps.pool, c.get('userId'), archiveId);
    if (role === null) return c.json({ error: 'not found' }, 404);
    if (!WRITE_ROLES.includes(role)) {
      return c.json(
        {
          error: 'only an owner, steward or contributor can rebuild the index',
          code: 'forbidden',
          reason: 'role',
        },
        403,
      );
    }
    try {
      const ids = (
        await deps.pool.query(`select id from public.notes where archive_id = $1 order by id`, [
          archiveId,
        ])
      ).rows.map((r) => (r as { id: string }).id);
      let rebuilt = 0;
      for (let i = 0; i < ids.length; i += REBUILD_BATCH) {
        rebuilt += await inTransaction(deps, archiveId, async (client) => {
          const notes = await client.query(
            `select n.id, n.body,
                    (select r.id from public.revisions r
                      where r.note_id = n.id order by r.seq desc limit 1) as revision_id
               from public.notes n
              where n.archive_id = $1 and n.id = any($2::uuid[])`,
            [archiveId, ids.slice(i, i + REBUILD_BATCH)],
          );
          for (const n of notes.rows) {
            await reindexChunks(client, archiveId, n.id, n.revision_id ?? null, n.body);
          }
          return notes.rowCount ?? 0;
        });
      }
      return c.json({ rebuilt });
    } catch {
      return c.json({ error: 'rebuild failed' }, 500);
    }
  });
}
