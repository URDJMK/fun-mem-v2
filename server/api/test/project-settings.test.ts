import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext } from './helpers';

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

/** a project with its owner, plus a second person joined by invite with `role` */
async function projectWith(tag: string, role: string) {
  const owner = await ctx.realSession(`ps-owner-${tag}-${RUN}@test.local`);
  const other = await ctx.realSession(`ps-other-${tag}-${RUN}@test.local`);
  const archive = await ctx.provisionArchive(owner, `Nell ${tag} ${RUN}`);
  const made = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
    role,
    userId: other.userId,
  });
  const { id } = (await made.json()) as { id: string };
  expect((await ctx.api(other.token, 'POST', `/v1/invites/${id}/accept`)).status).toBe(200);
  return { owner, other, archive };
}

describe('renaming and the kind', () => {
  it('lets the owner or a steward rename; a contributor cannot', async () => {
    const { owner, other, archive } = await projectWith('ren', 'contributor');
    const res = await ctx.api(owner.token, 'PATCH', `/v1/archives/${archive}`, {
      subjectName: `  Grandma Nell ${RUN} `,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subjectName: string }).subjectName).toBe(`Grandma Nell ${RUN}`);
    const list = (await (await ctx.api(owner.token, 'GET', '/v1/archives')).json()) as Array<{
      subjectName: string;
      jurisdiction: string;
    }>;
    expect(list[0]).toMatchObject({ subjectName: `Grandma Nell ${RUN}`, jurisdiction: 'US' });

    const no = await ctx.api(other.token, 'PATCH', `/v1/archives/${archive}`, {
      subjectName: 'Mine now',
    });
    expect(no.status).toBe(403);
    const empty = await ctx.api(owner.token, 'PATCH', `/v1/archives/${archive}`, {
      subjectName: '   ',
    });
    expect(empty.status).toBe(400);
  });

  it('grows a personal project into a family one, never back', async () => {
    const { owner, other, archive } = await projectWith('kind', 'steward');
    expect(
      (await ctx.api(other.token, 'PATCH', `/v1/archives/${archive}`, { kind: 'family' })).status,
    ).toBe(403);
    const res = await ctx.api(owner.token, 'PATCH', `/v1/archives/${archive}`, {
      kind: 'family',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe('family');
    expect(
      (await ctx.api(owner.token, 'PATCH', `/v1/archives/${archive}`, { kind: 'personal' })).status,
    ).toBe(400);
  });

  it('answers 404 to someone outside the project', async () => {
    const { archive } = await projectWith('out', 'viewer');
    const stranger = await ctx.realSession(`ps-stranger-${RUN}@test.local`);
    expect(
      (await ctx.api(stranger.token, 'PATCH', `/v1/archives/${archive}`, { subjectName: 'X' }))
        .status,
    ).toBe(404);
    expect((await ctx.api(stranger.token, 'DELETE', `/v1/archives/${archive}`)).status).toBe(404);
  });
});

describe('roles and leaving', () => {
  it('lets the owner change a role, never their own and never to owner', async () => {
    const { owner, other, archive } = await projectWith('role', 'contributor');
    const path = `/v1/archives/${archive}/members/${other.userId}`;
    const res = await ctx.api(owner.token, 'PATCH', path, { role: 'viewer' });
    expect(res.status).toBe(200);
    const row = await ctx.pool.query(
      `select role::text from public.memberships where archive_id = $1 and user_id = $2`,
      [archive, other.userId],
    );
    expect(row.rows[0].role).toBe('viewer');

    expect((await ctx.api(owner.token, 'PATCH', path, { role: 'owner' })).status).toBe(400);
    expect(
      (
        await ctx.api(owner.token, 'PATCH', `/v1/archives/${archive}/members/${owner.userId}`, {
          role: 'viewer',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx.api(other.token, 'PATCH', `/v1/archives/${archive}/members/${owner.userId}`, {
          role: 'viewer',
        })
      ).status,
    ).toBe(403);
  });

  it('lets anyone but the owner leave', async () => {
    const { owner, other, archive } = await projectWith('leave', 'steward');
    expect(
      (await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/members/${owner.userId}`))
        .status,
    ).toBe(400);
    // a steward cannot remove the owner
    expect(
      (await ctx.api(other.token, 'DELETE', `/v1/archives/${archive}/members/${owner.userId}`))
        .status,
    ).toBe(403);
    expect(
      (await ctx.api(other.token, 'DELETE', `/v1/archives/${archive}/members/${other.userId}`))
        .status,
    ).toBe(200);
    expect(await (await ctx.api(other.token, 'GET', '/v1/archives')).json()).toEqual([]);
  });
});

describe('deleting a project', () => {
  it('is the owner’s alone, with the name typed out, and erases everything', async () => {
    const { owner, other, archive } = await projectWith('del', 'steward');
    await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Lake house ${RUN}`,
      type: 'event',
      body: 'Summers at the lake.',
      occurred: null,
    });
    // an import read but not saved: its preview (the family's words) waits in an import job
    const preview = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: {
        interviewee: 'A',
        segments: [
          { start: 0, end: 9, speaker: 'Q', text: 'What do you remember about the lake?' },
          { start: 10, end: 19, speaker: 'A', text: 'We rowed out to the island every morning.' },
        ],
      },
    });
    expect(preview.status).toBe(200);

    expect((await ctx.api(other.token, 'DELETE', `/v1/archives/${archive}`)).status).toBe(403);
    const wrong = await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}`, {
      confirm: 'Nell',
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe('confirm_mismatch');

    const tenant = (
      await ctx.pool.query(`select tenant_id from public.archives where id = $1`, [archive])
    ).rows[0].tenant_id as string;
    const res = await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}`, {
      confirm: `Nell del ${RUN}`,
    });
    expect(res.status).toBe(200);

    for (const [table, col, id] of [
      ['archives', 'id', archive],
      ['memberships', 'archive_id', archive],
      ['notes', 'archive_id', archive],
      ['invites', 'archive_id', archive],
      ['ingest_jobs', 'archive_id', archive],
      ['tenants', 'id', tenant],
    ] as const) {
      const left = await ctx.pool.query(`select 1 from public.${table} where ${col} = $1`, [id]);
      expect(left.rowCount, table).toBe(0);
    }
    expect(await (await ctx.api(other.token, 'GET', '/v1/archives')).json()).toEqual([]);
  });
});
