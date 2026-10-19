import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext } from './helpers';

/**
 * FR-100 on photo upload: a photograph belongs to a memory, so adding one is writing. The note routes
 * were gated in round 2 (notes-write-roles.test.ts); the upload route still checked membership only,
 * so a viewer could attach a photo to an imported memory and so make it "worked on" (no longer
 * erasable by undo). A stranger still learns nothing (404).
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

// a 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(token: string, archive: string) {
  return ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'image/png',
      'x-filename': 'dot.png',
    },
    body: PNG,
  });
}

describe('who may add a photograph', () => {
  it('read-only roles are refused (403 role), writing roles are not, a stranger gets 404', async () => {
    const owner = await ctx.realSession(`mw-owner-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `MW ${RUN}`);
    for (const role of ['viewer', 'minor_viewer', 'reviewer', 'gifter', 'sponsor_admin']) {
      const m = await ctx.realSession(`mw-${role}-${RUN}@test.local`);
      await ctx.pool.query(
        `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
        [archive, m.userId, role],
      );
      const r = await upload(m.token, archive);
      expect(r.status, role).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'forbidden', reason: 'role' });
    }
    const stranger = await ctx.realSession(`mw-stranger-${RUN}@test.local`);
    expect((await upload(stranger.token, archive)).status).toBe(404);
    for (const role of ['steward', 'contributor']) {
      const m = await ctx.realSession(`mw-${role}-${RUN}@test.local`);
      await ctx.pool.query(
        `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
        [archive, m.userId, role],
      );
      expect((await upload(m.token, archive)).status, role).not.toBe(403);
    }
    expect((await upload(owner.token, archive)).status).not.toBe(403);
    const left = await ctx.pool.query(
      `select count(*)::int as n from public.media where archive_id = $1`,
      [archive],
    );
    expect(left.rows[0].n).toBeLessThanOrEqual(1); // the identical bytes are stored once
  }, 60_000);
});

describe('D9 a photo for a memory that is erased while the photo uploads', () => {
  it('answers the uniform 404, not a 500, and leaves no photo row', async () => {
    const owner = await ctx.realSession(`mw-race-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `MW race ${RUN}`);
    const made = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Harbour ${RUN}`,
      type: 'place',
      body: 'Boats.',
    });
    const note = ((await made.json()) as { id: string }).id;
    // hold the note's row, so the upload passes its check and then waits at the photo row's
    // foreign key; erase the note in that same hold, as an undo or a delete would
    const holder = await ctx.pool.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from public.notes where id = $1 for update`, [note]);
      const upload = Promise.resolve(
        ctx.app.request(`/v1/archives/${archive}/media?note=${note}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'image/png' },
          body: Buffer.concat([PNG, Buffer.from(`race ${RUN}`)]),
        }),
      );
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 50));
        waiting =
          ((
            await ctx.pool.query(
              `select 1 from pg_stat_activity
                where wait_event_type = 'Lock' and query like 'insert into public.media%'`,
            )
          ).rowCount ?? 0) > 0;
      }
      expect(waiting, 'the upload reached the photo row').toBe(true);
      await holder.query(`select set_config('funmem.erasure', 'on', true)`);
      await holder.query(`delete from public.notes where id = $1`, [note]);
      await holder.query('commit');
      const r = await upload;
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not found' });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    const rows = await ctx.pool.query(`select 1 from public.media where archive_id = $1`, [
      archive,
    ]);
    expect(rows.rowCount).toBe(0);
  }, 60_000);
});
