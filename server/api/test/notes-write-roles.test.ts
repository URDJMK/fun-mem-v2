import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { NOT_PROTAGONIST, type RealSession, testContext } from './helpers';

/**
 * FR-100 on the note routes: only owners, stewards and contributors add, change, delete or
 * restore memories; everyone who belongs to the archive may read them; a stranger learns
 * nothing (404, never 403). Round-2 persistence review #6: the routes checked membership
 * only, so a viewer could write and a minor viewer could delete an imported memory.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

const READERS = ['viewer', 'minor_viewer', 'reviewer', 'gifter', 'sponsor_admin'];
const WRITERS = ['steward', 'contributor'];

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`nw-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `NW ${label} ${RUN}`);
  const member = async (role: string): Promise<RealSession> => {
    const m = await ctx.realSession(`nw-${role}-${label}-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
      [archive, m.userId, role],
    );
    return m;
  };
  const made = (await (
    await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Grandma's kitchen ${RUN}`,
      type: 'place',
      body: 'She cooked for everyone on Sundays.',
    })
  ).json()) as { id: string };
  const revision = (
    (await ctx.pool.query(`select id from public.revisions where note_id = $1`, [made.id]))
      .rows[0] as { id: string }
  ).id;
  return { owner, archive, member, note: made.id, revision };
}

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('#6 the note routes: who may write, who may read', () => {
  it('viewer, minor_viewer, reviewer, gifter and sponsor_admin are refused every write (403 role), and nothing changes', async () => {
    const { archive, member, note, revision } = await setup('readers');
    for (const role of READERS) {
      const m = await member(role);
      const writes: Array<[string, string, object | undefined]> = [
        [
          'POST',
          `/v1/archives/${archive}/notes`,
          { title: `By a ${role} ${RUN}`, type: 'event', body: 'x' },
        ],
        ['PUT', `/v1/archives/${archive}/notes/${note}`, { body: `overwritten by a ${role}` }],
        ['POST', `/v1/archives/${archive}/notes/${note}/restore`, { revisionId: revision }],
        ['DELETE', `/v1/archives/${archive}/notes/${note}`, undefined],
      ];
      for (const [method, path, payload] of writes) {
        const r = await ctx.api(m.token, method, path, payload);
        expect(r.status, `${role} ${method} ${path}`).toBe(403);
        expect(await body(r)).toMatchObject({ code: 'forbidden', reason: 'role' });
      }
      // reading is for every member
      for (const path of [
        `/v1/archives/${archive}/notes`,
        `/v1/archives/${archive}/notes/${note}`,
        `/v1/archives/${archive}/notes/${note}/revisions`,
        `/v1/archives/${archive}/notes/${note}/backlinks`,
      ]) {
        expect((await ctx.api(m.token, 'GET', path)).status, `${role} GET ${path}`).toBe(200);
      }
    }
    const left = await ctx.pool.query(
      `select body from public.notes where archive_id = $1 and ${NOT_PROTAGONIST}`,
      [archive],
    );
    expect(left.rows).toEqual([{ body: 'She cooked for everyone on Sundays.' }]);
  });

  it('steward and contributor may write, as the owner may', async () => {
    const { archive, member, note } = await setup('writers');
    for (const role of WRITERS) {
      const m = await member(role);
      const c = await ctx.api(m.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: `By a ${role} ${RUN}`,
        type: 'event',
        body: 'written by a member who may write',
      });
      expect(c.status, role).toBe(201);
      const e = await ctx.api(m.token, 'PUT', `/v1/archives/${archive}/notes/${note}`, {
        body: `edited by a ${role}`,
      });
      expect(e.status, role).toBe(200);
    }
  });

  it('a stranger is answered 404 for every route, read or write, never 403', async () => {
    const { archive, note, revision } = await setup('stranger');
    const s = await ctx.realSession(`nw-stranger-${RUN}-${n++}@test.local`);
    const calls: Array<[string, string, object | undefined]> = [
      ['POST', `/v1/archives/${archive}/notes`, { title: 'x', type: 'event', body: 'x' }],
      ['PUT', `/v1/archives/${archive}/notes/${note}`, { body: 'x' }],
      ['POST', `/v1/archives/${archive}/notes/${note}/restore`, { revisionId: revision }],
      ['DELETE', `/v1/archives/${archive}/notes/${note}`, undefined],
      ['GET', `/v1/archives/${archive}/notes/${note}`, undefined],
    ];
    for (const [method, path, payload] of calls) {
      expect((await ctx.api(s.token, method, path, payload)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('a member who may read is told 404 (not 403) for a malformed note id, like everyone else', async () => {
    const { archive, member } = await setup('malformed');
    const v = await member('viewer');
    expect(
      (await ctx.api(v.token, 'PUT', `/v1/archives/${archive}/notes/not-a-uuid`, { body: 'x' }))
        .status,
    ).toBe(404);
  });
});

describe('D6 the role is checked again inside the write, not only before it waits its turn', () => {
  const hold = async (archive: string) => {
    const lock = await ctx.pool.connect();
    await lock.query('begin');
    await lock.query('select pg_advisory_xact_lock(hashtext(lower($1))::bigint)', [archive]);
    return async () => {
      await lock.query('commit');
      lock.release();
    };
  };

  it('a contributor made a viewer, or removed, while each write waits: refused, nothing written', async () => {
    const { archive, member, note, revision } = await setup('demoted');
    const writes: Array<[string, (a: string) => string, object | undefined]> = [
      [
        'POST',
        (a) => `/v1/archives/${a}/notes`,
        { title: `Late ${RUN}`, type: 'event', body: 'x' },
      ],
      ['PUT', (a) => `/v1/archives/${a}/notes/${note}`, { body: 'written after the demotion' }],
      ['POST', (a) => `/v1/archives/${a}/notes/${note}/restore`, { revisionId: revision }],
      ['DELETE', (a) => `/v1/archives/${a}/notes/${note}`, undefined],
    ];
    for (const [then, expected] of [
      ['viewer', 403],
      ['removed', 404],
    ] as const) {
      for (const [method, path, payload] of writes) {
        const m = await member('contributor');
        const release = await hold(archive);
        let status: number;
        try {
          const pending = ctx.api(m.token, method, path(archive), payload).then((r) => r.status);
          await new Promise((r) => setTimeout(r, 400)); // it passed the gate and waits for the lock
          if (then === 'viewer') {
            await ctx.pool.query(
              `update public.memberships set role = 'viewer' where archive_id = $1 and user_id = $2`,
              [archive, m.userId],
            );
          } else {
            await ctx.pool.query(
              `delete from public.memberships where archive_id = $1 and user_id = $2`,
              [archive, m.userId],
            );
          }
          await release();
          status = await pending;
        } catch (e) {
          await release().catch(() => undefined);
          throw e;
        }
        expect(status, `${then} ${method} ${path('A')}`).toBe(expected);
      }
    }
    const left = await ctx.pool.query(
      `select body from public.notes where archive_id = $1 and ${NOT_PROTAGONIST}`,
      [archive],
    );
    expect(left.rows).toEqual([{ body: 'She cooked for everyone on Sundays.' }]);
  });
});
