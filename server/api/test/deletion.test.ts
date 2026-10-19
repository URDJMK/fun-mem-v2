import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

// Local Supabase stack must be running — these tests FAIL when it is down (loop rule 1).
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

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

  it('deletion is refused for strangers and the append only wall still holds', async () => {
    const owner = await ctx.realSession(`del4-${RUN}@test.local`);
    const stranger = await ctx.realSession(`del4s-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Del4 ${RUN}`);
    const note = await createNote(owner, archive, 'Guarded', 'content');

    // strangers: uniform 404; nothing was deleted, and no tombstone was written
    expect(
      (await ctx.api(stranger.token, 'DELETE', `/v1/archives/${archive}/notes/${note.id}`)).status,
    ).toBe(404);
    expect(
      (await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/notes/${note.id}`)).status,
    ).toBe(200);
    const noStone = await ctx.pool.query(
      `select count(*)::int as n from public.tombstones where subject_id = $1`,
      [note.id],
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
