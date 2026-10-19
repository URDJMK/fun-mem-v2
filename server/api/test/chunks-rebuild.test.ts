import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DB_URL, testContext, type RealSession } from './helpers';

/**
 * The index rebuild rewrites derived data for a whole archive: only the roles that change
 * memories may start it, and rebuilds waiting on one archive must not hold the connections
 * other families need (round-3 review D4). It runs in batches, and the index it leaves is the
 * same one the notes' own saves would have written.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`cr-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `CR ${label} ${RUN}`);
  const member = async (role: string): Promise<RealSession> => {
    const m = await ctx.realSession(`cr-${role}-${label}-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
      [archive, m.userId, role],
    );
    return m;
  };
  return { owner, archive, member };
}

describe('D4 who may rebuild the index', () => {
  it('viewer, minor_viewer, reviewer, gifter and sponsor_admin are refused (403 role); writers may; a stranger gets 404', async () => {
    const { owner, archive, member } = await setup('roles');
    for (const role of ['viewer', 'minor_viewer', 'reviewer', 'gifter', 'sponsor_admin']) {
      const r = await ctx.api(
        (await member(role)).token,
        'POST',
        `/v1/archives/${archive}/chunks/rebuild`,
      );
      expect(r.status, role).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'forbidden', reason: 'role' });
    }
    for (const s of [owner, await member('steward'), await member('contributor')]) {
      expect(
        (await ctx.api(s.token, 'POST', `/v1/archives/${archive}/chunks/rebuild`)).status,
      ).toBe(200);
    }
    const stranger = await ctx.realSession(`cr-stranger-${RUN}@test.local`);
    expect(
      (await ctx.api(stranger.token, 'POST', `/v1/archives/${archive}/chunks/rebuild`)).status,
    ).toBe(404);
  });
});

describe('D4 rebuilds waiting on one archive', () => {
  it('do not hold the connections another archive needs', { timeout: 120_000 }, async () => {
    const pool10 = new Pool({ connectionString: DB_URL, max: 10 }); // as the server builds it
    const app10 = createApp({ ...ctx.deps, pool: pool10 });
    const api = async (t: string, p: string, m = 'POST'): Promise<Response> =>
      app10.request(p, { method: m, headers: { authorization: `Bearer ${t}` } });
    try {
      const a = await setup('pool-a');
      const b = await setup('pool-b');
      const lock = await ctx.pool.connect();
      await lock.query('begin');
      await lock.query('select pg_advisory_xact_lock(hashtext(lower($1))::bigint)', [a.archive]);
      let rebuilds: Promise<number[]>;
      let elsewhereMs = 0;
      try {
        rebuilds = Promise.all(
          Array.from({ length: 12 }, () =>
            api(a.owner.token, `/v1/archives/${a.archive}/chunks/rebuild`).then((r) => r.status),
          ),
        );
        await new Promise((r) => setTimeout(r, 1000));
        const t0 = Date.now();
        expect((await api(b.owner.token, `/v1/archives/${b.archive}/notes`, 'GET')).status).toBe(
          200,
        );
        elsewhereMs = Date.now() - t0;
      } finally {
        await lock.query('commit');
        lock.release();
      }
      expect(elsewhereMs).toBeLessThan(1000);
      expect(await rebuilds).toEqual(new Array(12).fill(200));
    } finally {
      await pool10.end();
    }
  });
});

describe('D4 a rebuild in batches leaves the index the notes would have', () => {
  it(
    '450 notes (three batches): every note rebuilt, chunks identical to what their saves wrote',
    { timeout: 120_000 },
    async () => {
      const { owner, archive } = await setup('batches');
      await ctx.pool.query(
        `insert into public.notes (archive_id, title, type, body, created_by)
       select $1, 'Note ' || g, 'event', '# A' || chr(10) || chr(10) || 'one ' || g || chr(10) || chr(10) || '# B' || chr(10) || chr(10) || 'two ' || g, $2
         from generate_series(1, 450) g`,
        [archive, owner.userId],
      );
      const first = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/chunks/rebuild`);
      expect(await first.json()).toEqual({ rebuilt: 450 });
      const snapshot = async () =>
        (
          await ctx.pool.query(
            `select note_id, chunk_index, heading, heading_path, anchor, start_pos, end_pos, content, content_hash
             from public.chunks where archive_id = $1 order by note_id, chunk_index`,
            [archive],
          )
        ).rows;
      const once = await snapshot();
      expect(once.length).toBe(900);
      expect(once[0]).toMatchObject({ heading_path: ['A'], heading: 'A' });
      const again = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/chunks/rebuild`);
      expect(await again.json()).toEqual({ rebuilt: 450 });
      expect(await snapshot()).toEqual(once);
    },
  );
});
