import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_BUCKET, listAllUnderPrefix, mediaPrefix } from '../src/media';
import { testContext, type RealSession } from './helpers';

// Local Supabase stack must be running — these tests FAIL when it is down (loop rule 1).
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

let setupError: unknown = null;

beforeAll(async () => {
  try {
    const made = await ctx.admin.storage.createBucket(MEDIA_BUCKET, { public: false });
    if (made.error && !/already exist/i.test(made.error.message)) throw made.error;
  } catch (e) {
    setupError = e;
  }
});

afterAll(async () => {
  await ctx.close();
});

function requireSetup(): void {
  if (setupError) throw setupError;
}

interface NoteResponse {
  id: string;
  title: string;
  body: string;
}

async function createNote(
  s: RealSession,
  archive: string,
  title: string,
  body: string,
): Promise<NoteResponse> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return (await res.json()) as NoteResponse;
}

describe('FM-017 deletion cascade with deletion log', () => {
  it('deleting a note cascades revisions links and audiences and writes a content free deletion log', async () => {
    requireSetup();
    const s = await ctx.realSession(`del1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Del1 ${RUN}`);
    await createNote(s, archive, 'Ref One', 'I stay behind.');
    const target = await createNote(s, archive, 'Target One', 'Links out to [[Ref One]]. ^b1');
    const referrer = await createNote(s, archive, 'Referrer One', 'See [[Target One]] here.');
    // second revision on the target + a fixture audiences row (no API yet)
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${target.id}`, {
      body: 'Edited. Still links [[Ref One]]. ^b1',
    });
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id) values ($1, $2)
       on conflict (note_id) do nothing`,
      [archive, target.id],
    );

    const del = await ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/notes/${target.id}`);
    expect(del.status).toBe(200);
    const deleted = (await del.json()) as { id: string; deletedAt: string };
    expect(deleted.id).toBe(target.id);
    // contract-pinned response shape: the timestamp is real, not just typed
    expect(Number.isNaN(Date.parse(deleted.deletedAt))).toBe(false);

    // cascade proof, straight from the database
    const q = async (sql: string, params: unknown[]) =>
      (await ctx.pool.query(sql, params)).rows[0].n as number;
    expect(await q(`select count(*)::int as n from public.notes where id = $1`, [target.id])).toBe(
      0,
    );
    expect(
      await q(`select count(*)::int as n from public.revisions where note_id = $1`, [target.id]),
    ).toBe(0);
    expect(
      await q(`select count(*)::int as n from public.links where source_id = $1`, [target.id]),
    ).toBe(0);
    expect(
      await q(`select count(*)::int as n from public.audiences where note_id = $1`, [target.id]),
    ).toBe(0);

    // incoming occurrence survives UNRESOLVED; referrer text is never rewritten
    const incoming = await ctx.pool.query(
      `select target, resolved_id from public.links where source_id = $1`,
      [referrer.id],
    );
    expect(incoming.rows).toEqual([{ target: 'Target One', resolved_id: null }]);
    const refBody = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes/${referrer.id}`);
    expect(((await refBody.json()) as { body: string }).body).toBe('See [[Target One]] here.');

    // the deletion log: one row, ids and timestamps ONLY — the column set itself
    // proves no content field exists
    const stone = await ctx.pool.query(`select * from public.tombstones where subject_id = $1`, [
      target.id,
    ]);
    expect(stone.rows).toHaveLength(1);
    expect(stone.rows[0].kind).toBe('note');
    expect(stone.rows[0].archive_id).toBe(archive);
    expect(stone.rows[0].deleted_by).toBe(s.userId);
    expect(stone.rows[0].deleted_at).toBeTruthy();
    expect(Object.keys(stone.rows[0]).sort()).toEqual([
      'archive_id',
      'deleted_at',
      'deleted_by',
      'id',
      'kind',
      'subject_id',
    ]);
  });

  it('deleted note vanishes from every read surface and frees its title', async () => {
    requireSetup();
    const s = await ctx.realSession(`del2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Del2 ${RUN}`);
    const phoenix = await createNote(s, archive, 'Phoenix', 'First life. ^p1');
    const referrer = await createNote(s, archive, 'Watcher', 'Sees [[Phoenix]] rise.');

    const del = await ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/notes/${phoenix.id}`);
    expect(del.status).toBe(200);

    // every read surface: gone
    const base = `/v1/archives/${archive}/notes/${phoenix.id}`;
    expect((await ctx.api(s.token, 'GET', base)).status).toBe(404);
    expect((await ctx.api(s.token, 'GET', `${base}/revisions`)).status).toBe(404);
    expect((await ctx.api(s.token, 'GET', `${base}/backlinks`)).status).toBe(404);

    // the CI-unique title is freed; the new note reclaims the unresolved occurrence
    const reborn = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Phoenix',
      type: 'event',
      body: 'Second life.',
    });
    expect(reborn.status).toBe(201);
    const rebornId = ((await reborn.json()) as { id: string }).id;
    expect(rebornId).not.toBe(phoenix.id);
    const backs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${rebornId}/backlinks`,
    );
    const rows = (
      (await backs.json()) as {
        occurrences: Array<{ sourceId: string; target: string }>;
      }
    ).occurrences;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceId: referrer.id, target: 'Phoenix' });
  });

  it('media hard delete removes the blob and writes a tombstone', async () => {
    requireSetup();
    const s = await ctx.realSession(`del3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Del3 ${RUN}`);
    const bytes = Buffer.from(`erasable payload ${RUN}`);
    const hash = createHash('sha256').update(bytes).digest('hex');

    const upload = () =>
      ctx.app.request(`/v1/archives/${archive}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/pdf' },
        body: bytes,
      });
    const first = await upload();
    expect(first.status).toBe(201);
    const media = (await first.json()) as { id: string };

    const del = await ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/media/${media.id}`);
    expect(del.status).toBe(200);

    // row gone, blob gone
    const count = await ctx.pool.query(
      `select count(*)::int as n from public.media where archive_id = $1`,
      [archive],
    );
    expect(count.rows[0].n).toBe(0);
    // FM-040: assert the whole prefix is empty, not that one key 404s. Downloading
    // the pre-FM-040 flat key would pass VACUOUSLY now that nothing is written
    // there — the object under test lives at <archive>/<hash>/original.
    expect(await listAllUnderPrefix(ctx.admin, MEDIA_BUCKET, mediaPrefix(archive, hash))).toEqual(
      [],
    );

    // tombstone references the ROW id, never the content hash
    const stone = await ctx.pool.query(
      `select kind, subject_id, deleted_by from public.tombstones
        where archive_id = $1 and kind = 'media'`,
      [archive],
    );
    expect(stone.rows).toEqual([{ kind: 'media', subject_id: media.id, deleted_by: s.userId }]);

    // identical bytes upload FRESH afterwards: hard delete, not a soft flag
    const again = await upload();
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).not.toBe(media.id);
  });

  it('deletion is refused for strangers and the append only wall still holds', async () => {
    requireSetup();
    const owner = await ctx.realSession(`del4-${RUN}@test.local`);
    const stranger = await ctx.realSession(`del4s-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Del4 ${RUN}`);
    const note = await createNote(owner, archive, 'Guarded', 'content');
    const bytes = Buffer.from(`guarded payload ${RUN}`);
    const up = await ctx.app.request(`/v1/archives/${archive}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'text/plain' },
      body: bytes,
    });
    const mediaId = ((await up.json()) as { id: string }).id;

    // strangers: uniform 404 on both delete routes; nothing was deleted
    expect(
      (await ctx.api(stranger.token, 'DELETE', `/v1/archives/${archive}/notes/${note.id}`)).status,
    ).toBe(404);
    expect(
      (await ctx.api(stranger.token, 'DELETE', `/v1/archives/${archive}/media/${mediaId}`)).status,
    ).toBe(404);
    expect(
      (await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/notes/${note.id}`)).status,
    ).toBe(200);
    // "nothing was deleted" holds for the MEDIA too: row intact, no tombstone
    const mediaSurvived = await ctx.pool.query(
      `select count(*)::int as n from public.media where id = $1`,
      [mediaId],
    );
    expect(mediaSurvived.rows[0].n).toBe(1);
    const noStone = await ctx.pool.query(
      `select count(*)::int as n from public.tombstones where subject_id = $1`,
      [mediaId],
    );
    expect(noStone.rows[0].n).toBe(0);

    // owner double-delete: second call 404s and writes NO duplicate tombstone
    expect(
      (await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${note.id}`)).status,
    ).toBe(200);
    expect(
      (await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/notes/${note.id}`)).status,
    ).toBe(404);
    const stones = await ctx.pool.query(
      `select count(*)::int as n from public.tombstones where subject_id = $1`,
      [note.id],
    );
    expect(stones.rows[0].n).toBe(1);

    // the append-only wall stands outside the erasure door: a bare revision
    // delete (no GUC) still raises, even for the pool role
    const other = await createNote(owner, archive, 'Still Guarded', 'more content');
    await expect(
      ctx.pool.query(`delete from public.revisions where note_id = $1`, [other.id]),
    ).rejects.toThrow(/append-only/i);
  });
});
