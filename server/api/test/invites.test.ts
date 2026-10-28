import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { maskEmail } from '../src/invites';
import { testContext } from './helpers';

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
type Found = { userId: string; name: string; email: string; member: boolean; invited: boolean };
type Mine = { id: string; projectName: string; role: string; invitedBy: string };

/** someone who signed in with Google (the app's only sign-in), under a name of their own */
async function named(email: string, name: string) {
  const s = await ctx.realSession(email);
  await ctx.signInWithGoogle(s, email);
  await ctx.pool.query(
    `update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('full_name', $2::text) where id = $1`,
    [s.userId, name],
  );
  return s;
}

describe('project kinds', () => {
  it('makes a family project, and lists each project with its kind', async () => {
    const s = await ctx.realSession(`kind-${RUN}@test.local`);
    const res = await ctx.api(s.token, 'POST', '/v1/provision', {
      subjectName: `The Marsh family ${RUN}`,
      jurisdiction: 'GB',
      kind: 'family',
    });
    expect(res.status).toBe(201);
    await ctx.provisionArchive(s, `Nell ${RUN}`);
    const list = (await (await ctx.api(s.token, 'GET', '/v1/archives')).json()) as Array<{
      kind: string;
    }>;
    expect(list.map((a) => a.kind).sort()).toEqual(['family', 'personal']);

    const bad = await ctx.api(s.token, 'POST', '/v1/provision', {
      subjectName: 'X',
      jurisdiction: 'US',
      kind: 'club',
    });
    expect(bad.status).toBe(400);
  });
});

describe('finding someone', () => {
  it('finds people by the start of a name or email, with the email mostly hidden', async () => {
    const owner = await ctx.realSession(`find-owner-${RUN}@test.local`);
    const june = await named(`june-${RUN}@test.local`, `June Okafor${RUN}`);
    const archive = await ctx.provisionArchive(owner, `Grandma ${RUN}`);
    const search = async (q: string) =>
      (await (
        await ctx.api(
          owner.token,
          'GET',
          `/v1/archives/${archive}/people-search?q=${encodeURIComponent(q)}`,
        )
      ).json()) as Found[];

    // by a word of the name
    const byName = await search(`okafor${RUN}`);
    expect(byName).toEqual([
      {
        userId: june.userId,
        name: `June Okafor${RUN}`,
        email: maskEmail(`june-${RUN}@test.local`),
        member: false,
        invited: false,
      },
    ]);
    // the whole address, typed, comes back whole
    expect((await search(`june-${RUN}@test.local`))[0]?.email).toBe(`june-${RUN}@test.local`);
    // too short to search; the middle of an email does not match
    expect(await search('ju')).toEqual([]);
    expect(await search(`${RUN}@test`)).toEqual([]);
    // wildcards are taken literally
    expect(await search('%%%')).toEqual([]);
  });

  it('is only for those who can invite, and only inside their project', async () => {
    const owner = await ctx.realSession(`find-o2-${RUN}@test.local`);
    const viewer = await ctx.realSession(`find-v-${RUN}@test.local`);
    const stranger = await ctx.realSession(`find-s-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Walter ${RUN}`);
    const made = await json(
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
        role: 'viewer',
        userId: viewer.userId,
      }),
    );
    await ctx.api(viewer.token, 'POST', `/v1/invites/${made.id}/accept`);
    const path = `/v1/archives/${archive}/people-search?q=find`;
    expect((await ctx.api(viewer.token, 'GET', path)).status).toBe(403);
    expect((await ctx.api(stranger.token, 'GET', path)).status).toBe(404);
  });
});

describe('invites', () => {
  it('invites an account; it shows up for them; they accept and are in', async () => {
    const owner = await named(`inv-owner-${RUN}@test.local`, 'Theo Marsh');
    const guest = await ctx.realSession(`inv-guest-${RUN}@test.local`);
    const other = await ctx.realSession(`inv-other-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Grandma ${RUN}`);

    const made = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
      role: 'contributor',
      userId: guest.userId,
    });
    expect(made.status).toBe(201);
    const { id } = await json(made);
    // twice is once
    const again = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
      role: 'viewer',
      userId: guest.userId,
    });
    expect(again.status).toBe(409);

    const pending = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/invites`)
    ).json()) as Array<{ inviteeName: string; inviteeEmail: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.inviteeEmail).toBe(maskEmail(`inv-guest-${RUN}@test.local`));

    const mine = (await (await ctx.api(guest.token, 'GET', '/v1/invites')).json()) as Mine[];
    expect(mine).toEqual([
      expect.objectContaining({
        id,
        projectName: `Grandma ${RUN}`,
        role: 'contributor',
        invitedBy: 'Theo Marsh',
      }),
    ]);
    // nobody else sees it, or can answer it
    expect(await (await ctx.api(other.token, 'GET', '/v1/invites')).json()).toEqual([]);
    expect((await ctx.api(other.token, 'POST', `/v1/invites/${id}/accept`)).status).toBe(404);

    const ok = await ctx.api(guest.token, 'POST', `/v1/invites/${id}/accept`);
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ archiveId: archive, role: 'contributor' });
    // answered once
    expect((await ctx.api(guest.token, 'POST', `/v1/invites/${id}/accept`)).status).toBe(404);
    expect(await (await ctx.api(guest.token, 'GET', '/v1/invites')).json()).toEqual([]);

    // a member cannot be invited again
    const dup = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
      role: 'viewer',
      userId: guest.userId,
    });
    expect(dup.status).toBe(409);
    expect((await json(dup)).code).toBe('member');
  });

  it('waits for an email with no account, and finds them once they sign in', async () => {
    const owner = await ctx.realSession(`em-owner-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Aunt ${RUN}`);
    const email = `em-later-${RUN}@test.local`;
    const made = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
      role: 'viewer',
      email: `  ${email.toUpperCase()} `,
    });
    expect(made.status).toBe(201);
    expect((await json(made)).hasAccount).toBe(false);
    const pending = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/invites`)
    ).json()) as Array<{ inviteeEmail: string; hasAccount: boolean }>;
    expect(pending[0]).toMatchObject({ inviteeEmail: email, hasAccount: false });

    const later = await ctx.realSession(email);
    await ctx.signInWithGoogle(later, email);
    const mine = (await (await ctx.api(later.token, 'GET', '/v1/invites')).json()) as Mine[];
    expect(mine).toHaveLength(1);
    expect((await ctx.api(later.token, 'POST', `/v1/invites/${mine[0]!.id}/accept`)).status).toBe(
      200,
    );
    const list = (await (await ctx.api(later.token, 'GET', '/v1/archives')).json()) as Array<{
      id: string;
    }>;
    expect(list.map((a) => a.id)).toEqual([archive]);

    expect(
      (
        await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
          role: 'viewer',
          email: 'not an email',
        })
      ).status,
    ).toBe(400);
  });

  it('lets them decline, and the owner withdraw', async () => {
    const owner = await ctx.realSession(`dec-owner-${RUN}@test.local`);
    const a = await ctx.realSession(`dec-a-${RUN}@test.local`);
    const b = await ctx.realSession(`dec-b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Nell ${RUN}`);
    const inv = async (userId: string) =>
      (await json(
        await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
          role: 'viewer',
          userId,
        }),
      )) as { id: string };

    const toA = await inv(a.userId);
    expect((await ctx.api(a.token, 'POST', `/v1/invites/${toA.id}/decline`)).status).toBe(200);
    expect(await (await ctx.api(a.token, 'GET', '/v1/archives')).json()).toEqual([]);
    // declined, so a new invitation can be sent
    expect((await inv(a.userId)).id).toBeTruthy();

    const toB = await inv(b.userId);
    expect(
      (await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/invites/${toB.id}`)).status,
    ).toBe(200);
    expect(await (await ctx.api(b.token, 'GET', '/v1/invites')).json()).toEqual([]);
    expect((await ctx.api(b.token, 'POST', `/v1/invites/${toB.id}/accept`)).status).toBe(404);

    // past its date it is gone
    const toB2 = await inv(b.userId);
    await ctx.pool.query(
      `update public.invites set expires_at = now() - interval '1 minute' where id = $1`,
      [toB2.id],
    );
    expect(await (await ctx.api(b.token, 'GET', '/v1/invites')).json()).toEqual([]);
    // and a fresh one can replace it
    expect((await inv(b.userId)).id).not.toBe(toB2.id);
  });

  it('never gives more than the inviter has, and never lowers a member', async () => {
    const owner = await ctx.realSession(`cap-owner-${RUN}@test.local`);
    const steward = await ctx.realSession(`cap-steward-${RUN}@test.local`);
    const guest = await ctx.realSession(`cap-guest-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Walter ${RUN}`);
    const invite = async (token: string, role: string, userId: string) =>
      ctx.api(token, 'POST', `/v1/archives/${archive}/invites`, { role, userId });

    const s = await json(await invite(owner.token, 'steward', steward.userId));
    await ctx.api(steward.token, 'POST', `/v1/invites/${s.id}/accept`);

    expect((await invite(steward.token, 'steward', guest.userId)).status).toBe(403);
    expect((await invite(steward.token, 'owner', guest.userId)).status).toBe(400);
    const v = await invite(steward.token, 'viewer', guest.userId);
    expect(v.status).toBe(201);

    // a viewer cannot invite at all
    const vid = (await json(v)).id;
    await ctx.api(guest.token, 'POST', `/v1/invites/${vid}/accept`);
    expect((await invite(guest.token, 'viewer', owner.userId)).status).toBe(403);
  });
});

describe('an email address is trusted only once Google has verified it', () => {
  // Supabase's email sign-up (on unless turned off, and unconfirmed when confirmations are off)
  // lets anyone open an account under any address: it must not be handed what was sent there.
  it('an invitation to an address is not given to an account that never proved it', async () => {
    const owner = await ctx.realSession(`pr-owner-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Proof ${RUN}`);
    const email = `pr-aunt-${RUN}@test.local`;
    const made = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
      role: 'steward',
      email,
    });
    expect(made.status).toBe(201);
    const { id } = (await json(made)) as { id: string };

    const stranger = await ctx.unprovenSession(email);
    expect(await (await ctx.api(stranger.token, 'GET', '/v1/invites')).json()).toEqual([]);
    expect((await ctx.api(stranger.token, 'POST', `/v1/invites/${id}/accept`)).status).toBe(404);
    expect(await (await ctx.api(stranger.token, 'GET', '/v1/archives')).json()).toEqual([]);

    // whoever does sign in with Google under that address finds it waiting
    await ctx.signInWithGoogle(stranger, email);
    const mine = (await (await ctx.api(stranger.token, 'GET', '/v1/invites')).json()) as Mine[];
    expect(mine.map((m) => m.id)).toEqual([id]);
  });

  it('inviting an address whose only account never proved it waits for the address', async () => {
    const owner = await ctx.realSession(`pr2-owner-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Proof two ${RUN}`);
    const email = `pr2-uncle-${RUN}@test.local`;
    await ctx.unprovenSession(email);
    const made = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
      role: 'viewer',
      email,
    });
    expect(made.status).toBe(201);
    expect((await json(made)).hasAccount).toBe(false);
  });

  it('search offers only people Google has verified', async () => {
    const owner = await ctx.realSession(`pr3-owner-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Proof three ${RUN}`);
    const email = `zelda-${RUN}@test.local`;
    const claimant = await ctx.unprovenSession(email);
    const search = async () =>
      (await (
        await ctx.api(
          owner.token,
          'GET',
          `/v1/archives/${archive}/people-search?q=${encodeURIComponent(email)}`,
        )
      ).json()) as Found[];
    expect(await search()).toEqual([]);
    await ctx.signInWithGoogle(claimant, email);
    expect((await search()).map((f) => f.userId)).toEqual([claimant.userId]);
  });
});

describe('one person, one invitation', () => {
  it('search shows someone invited by address as invited, and accepting one invitation withdraws the rest', async () => {
    const owner = await ctx.realSession(`one-owner-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `One ${RUN}`);
    const email = `one-carol-${RUN}@test.local`;
    const byAddress = (await json(
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
        role: 'viewer',
        email,
      }),
    )) as { id: string };
    const carol = await named(email, `Carol One${RUN}`);
    const found = (await (
      await ctx.api(
        owner.token,
        'GET',
        `/v1/archives/${archive}/people-search?q=${encodeURIComponent(email)}`,
      )
    ).json()) as Found[];
    expect(found).toEqual([expect.objectContaining({ userId: carol.userId, invited: true })]);

    // a second invitation, to the account, can still be made (the API does not refuse it)
    const byAccount = (await json(
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
        role: 'contributor',
        userId: carol.userId,
      }),
    )) as { id: string };
    const mine = (await (await ctx.api(carol.token, 'GET', '/v1/invites')).json()) as Mine[];
    expect(mine.map((m) => m.id).sort()).toEqual([byAddress.id, byAccount.id].sort());

    expect((await ctx.api(carol.token, 'POST', `/v1/invites/${byAddress.id}/accept`)).status).toBe(
      200,
    );
    expect(await (await ctx.api(carol.token, 'GET', '/v1/invites')).json()).toEqual([]);
    expect((await ctx.api(carol.token, 'POST', `/v1/invites/${byAccount.id}/accept`)).status).toBe(
      404,
    );
    const pending = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/invites`)
    ).json()) as unknown[];
    expect(pending).toEqual([]);
  });
});

describe('members', () => {
  it('lists members with names; only the owner removes, and never themselves', async () => {
    const owner = await ctx.realSession(`mem-owner-${RUN}@test.local`);
    const guest = await ctx.realSession(`mem-guest-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Nell ${RUN}`);
    const made = await json(
      await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/invites`, {
        role: 'contributor',
        userId: guest.userId,
      }),
    );
    await ctx.api(guest.token, 'POST', `/v1/invites/${made.id}/accept`);

    const members = (await (
      await ctx.api(guest.token, 'GET', `/v1/archives/${archive}/members`)
    ).json()) as Array<{ userId: string; role: string; you: boolean }>;
    expect(members.map((m) => [m.role, m.you])).toEqual([
      ['owner', false],
      ['contributor', true],
    ]);

    expect(
      (await ctx.api(guest.token, 'DELETE', `/v1/archives/${archive}/members/${owner.userId}`))
        .status,
    ).toBe(403);
    expect(
      (await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/members/${owner.userId}`))
        .status,
    ).toBe(400);
    expect(
      (await ctx.api(owner.token, 'DELETE', `/v1/archives/${archive}/members/${guest.userId}`))
        .status,
    ).toBe(200);
    expect(await (await ctx.api(guest.token, 'GET', '/v1/archives')).json()).toEqual([]);
  });
});
