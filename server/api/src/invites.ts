/**
 * Who is in a project, and how someone joins: invited by name, found by searching, or by an email
 * address that has no account yet. The invitation waits in Firepit for that person, who accepts
 * or declines it; nobody is put into a project without saying yes.
 *
 * Search is only for people who look after a project (owner, steward), and only for inviting: it
 * needs three characters, shows a handful of people, hides most of each email and is
 * rate-limited, so it cannot be used to list who is on Firepit. Nobody can hand out more than they
 * have: only the owner can invite a steward, and accepting never lowers the role of someone
 * already in.
 *
 * People recorded in a project (the narrators, their family) are notes, not members: they never
 * need an account. Members are the collaborators.
 */
import type { App, AppDeps } from './app';
import { memberRole, UUID_RE } from './membership';

export const INVITABLE = ['steward', 'contributor', 'viewer'] as const;
export type InviteRole = (typeof INVITABLE)[number];

const DAYS = 30;
const SEARCH_MIN = 3;
const SEARCH_MAX = 6;
/** searches per person per minute */
const SEARCH_RATE = 20;
/** who may invite, and the roles each may give */
const MAY_GIVE: Record<string, readonly InviteRole[]> = {
  owner: ['steward', 'contributor', 'viewer'],
  steward: ['contributor', 'viewer'],
};
/** higher wins when someone already in the project accepts another invite */
const RANK: Record<string, number> = {
  owner: 6,
  steward: 5,
  contributor: 4,
  reviewer: 3,
  gifter: 3,
  viewer: 2,
  minor_viewer: 1,
  sponsor_admin: 0,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** theo.marsh@gmail.com → the•••@gmail.com: enough to tell two Theos apart, not to collect */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  return `${email.slice(0, Math.min(3, at))}•••${email.slice(at)}`;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** A person's name as an account shows it: their name if they gave one, else their email. */
const nameSql = (u: string) =>
  `coalesce(nullif(${u}.raw_user_meta_data->>'full_name', ''), nullif(${u}.raw_user_meta_data->>'name', ''), ${u}.email)`;
const NAME_SQL = nameSql('u');

export function registerInviteRoutes(app: App, deps: AppDeps): void {
  const notFound = { error: 'not found' };

  /* ── members ─────────────────────────────────────────── */
  app.get('/v1/archives/:archiveId/members', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const userId = c.get('userId');
    if ((await memberRole(deps.pool, userId, archiveId)) === null) return c.json(notFound, 404);
    const r = await deps.pool.query(
      `select m.user_id as "userId", m.role::text as role, m.created_at as "joinedAt",
              ${NAME_SQL} as name
         from public.memberships m join auth.users u on u.id = m.user_id
        where m.archive_id = $1
        order by m.created_at`,
      [archiveId],
    );
    return c.json(r.rows.map((m) => ({ ...m, you: m.userId === userId })));
  });

  /** the owner removes someone; anyone but the owner may remove themselves, which is leaving */
  app.delete('/v1/archives/:archiveId/members/:userId', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const target = (c.req.param('userId') ?? '').toLowerCase();
    const userId = c.get('userId');
    const role = await memberRole(deps.pool, userId, archiveId);
    if (role === null) return c.json(notFound, 404);
    if (target === userId) {
      if (role === 'owner')
        return c.json(
          { error: 'the owner cannot leave; delete the project instead', code: 'bad_request' },
          400,
        );
    } else if (role !== 'owner')
      return c.json({ error: 'only the owner can remove people', code: 'forbidden' }, 403);
    if (!UUID_RE.test(target)) return c.json(notFound, 404);
    const r = await deps.pool.query(
      `delete from public.memberships where archive_id = $1 and user_id = $2 and role <> 'owner'`,
      [archiveId, target],
    );
    if (!r.rowCount) return c.json(notFound, 404);
    return c.json({ removed: true });
  });

  /** the owner changes what someone can do; never to or from owner */
  app.patch('/v1/archives/:archiveId/members/:userId', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const target = (c.req.param('userId') ?? '').toLowerCase();
    const userId = c.get('userId');
    const role = await memberRole(deps.pool, userId, archiveId);
    if (role === null) return c.json(notFound, 404);
    if (role !== 'owner')
      return c.json({ error: 'only the owner can change roles', code: 'forbidden' }, 403);
    if (target === userId)
      return c.json({ error: 'the owner keeps their own role', code: 'bad_request' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    const give = body.role as InviteRole;
    if (!INVITABLE.includes(give))
      return c.json(
        { error: 'role must be steward, contributor or viewer', code: 'bad_request' },
        400,
      );
    if (!UUID_RE.test(target)) return c.json(notFound, 404);
    const r = await deps.pool.query(
      `update public.memberships set role = $3
        where archive_id = $1 and user_id = $2 and role <> 'owner'
        returning role::text as role`,
      [archiveId, target, give],
    );
    if (!r.rowCount) return c.json(notFound, 404);
    return c.json({ userId: target, role: r.rows[0].role });
  });

  /* ── finding someone to invite ───────────────────────── */
  const searches = new Map<string, number[]>();
  app.get('/v1/archives/:archiveId/people-search', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const userId = c.get('userId');
    const role = await memberRole(deps.pool, userId, archiveId);
    if (role === null) return c.json(notFound, 404);
    if (!MAY_GIVE[role])
      return c.json({ error: 'only an owner or steward can invite', code: 'forbidden' }, 403);
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    if (q.length < SEARCH_MIN) return c.json([]);

    const now = Date.now();
    const recent = (searches.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= SEARCH_RATE)
      return c.json({ error: 'too many searches; wait a minute', code: 'rate_limited' }, 429);
    recent.push(now);
    searches.set(userId, recent);

    // an email matches from its start; a name from the start of any of its words
    const r = await deps.pool.query(
      `select u.id as "userId", ${NAME_SQL} as name, lower(u.email) as email,
              exists (select 1 from public.memberships m
                       where m.archive_id = $2 and m.user_id = u.id) as member,
              exists (select 1 from public.invites i
                       where i.archive_id = $2 and i.invitee_id = u.id
                         and i.answered_at is null and i.revoked_at is null
                         and i.expires_at > now()) as invited
         from auth.users u
        where u.id <> $1
          and (lower(u.email) like $3 || '%'
               or lower(${NAME_SQL}) like $3 || '%'
               or lower(${NAME_SQL}) like '% ' || $3 || '%')
        order by (lower(u.email) = $4) desc, name
        limit ${SEARCH_MAX}`,
      [userId, archiveId, likeEscape(q), q],
    );
    return c.json(
      r.rows.map((p) => ({
        userId: p.userId,
        // the name, unless the account has none and the name would be the email itself
        name: p.name.toLowerCase() === p.email ? maskEmail(p.email) : p.name,
        // whoever typed the whole address already knows it
        email: p.email === q ? p.email : maskEmail(p.email),
        member: p.member,
        invited: p.invited,
      })),
    );
  });

  /* ── invites, for those who manage the project ───────── */
  app.post('/v1/archives/:archiveId/invites', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const userId = c.get('userId');
    const role = await memberRole(deps.pool, userId, archiveId);
    if (role === null) return c.json(notFound, 404);
    const allowed = MAY_GIVE[role] ?? [];
    if (allowed.length === 0)
      return c.json({ error: 'only an owner or steward can invite', code: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      role?: unknown;
      userId?: unknown;
      email?: unknown;
    };
    const give = body.role as InviteRole;
    if (!INVITABLE.includes(give))
      return c.json(
        { error: 'role must be steward, contributor or viewer', code: 'bad_request' },
        400,
      );
    if (!allowed.includes(give))
      return c.json({ error: `a ${role} cannot invite a ${give}`, code: 'forbidden' }, 403);

    // who: an account by id, or an email, which is that account if there is one
    let inviteeId: string | null = null;
    let inviteeEmail: string | null = null;
    if (typeof body.userId === 'string' && UUID_RE.test(body.userId)) {
      const u = await deps.pool.query(`select id from auth.users where id = $1`, [
        body.userId.toLowerCase(),
      ]);
      if (!u.rowCount) return c.json(notFound, 404);
      inviteeId = u.rows[0].id as string;
    } else if (typeof body.email === 'string' && EMAIL_RE.test(body.email.trim())) {
      const email = body.email.trim().toLowerCase();
      const u = await deps.pool.query(`select id from auth.users where lower(email) = $1`, [email]);
      if (u.rowCount) inviteeId = u.rows[0].id as string;
      else inviteeEmail = email;
    } else {
      return c.json({ error: 'say who: a person or an email address', code: 'bad_request' }, 400);
    }
    if (inviteeId) {
      const m = await deps.pool.query(
        `select 1 from public.memberships where archive_id = $1 and user_id = $2`,
        [archiveId, inviteeId],
      );
      if (m.rowCount) return c.json({ error: 'already in the project', code: 'member' }, 409);
    }

    // an earlier invitation that ran out does not stand in the way of a new one
    await deps.pool.query(
      `update public.invites set revoked_at = now()
        where archive_id = $1 and coalesce(invitee_id::text, invitee_email) = $2
          and answered_at is null and revoked_at is null and expires_at <= now()`,
      [archiveId, inviteeId ?? inviteeEmail],
    );
    try {
      const r = await deps.pool.query(
        `insert into public.invites
           (archive_id, invitee_id, invitee_email, role, created_by, expires_at)
         values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
         returning id, role::text as role, created_at as "createdAt", expires_at as "expiresAt"`,
        [archiveId, inviteeId, inviteeEmail, give, userId, DAYS],
      );
      return c.json({ ...r.rows[0], hasAccount: inviteeId !== null }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        return c.json({ error: 'already invited', code: 'invited' }, 409);
      throw e;
    }
  });

  app.get('/v1/archives/:archiveId/invites', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const role = await memberRole(deps.pool, c.get('userId'), archiveId);
    if (role === null) return c.json(notFound, 404);
    if (!MAY_GIVE[role])
      return c.json({ error: 'only an owner or steward can see invites', code: 'forbidden' }, 403);
    const r = await deps.pool.query(
      `select i.id, i.role::text as role, i.created_at as "createdAt", i.expires_at as "expiresAt",
              ${NAME_SQL} as "invitedBy", ${nameSql('w')} as "accountName",
              lower(w.email) as "accountEmail", i.invitee_email as "email"
         from public.invites i
         join auth.users u on u.id = i.created_by
         left join auth.users w on w.id = i.invitee_id
        where i.archive_id = $1 and i.answered_at is null and i.revoked_at is null
          and i.expires_at > now()
        order by i.created_at desc`,
      [archiveId],
    );
    return c.json(
      r.rows.map((i) => {
        // an account found by search keeps its email mostly hidden; a typed address was known
        const masked = maskEmail(i.accountEmail);
        const named = i.accountName && i.accountName.toLowerCase() !== i.accountEmail;
        return {
          id: i.id,
          role: i.role,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
          invitedBy: i.invitedBy,
          hasAccount: i.accountEmail !== null,
          inviteeName: i.accountEmail ? (named ? i.accountName : masked) : i.email,
          inviteeEmail: i.accountEmail ? masked : i.email,
        };
      }),
    );
  });

  app.delete('/v1/archives/:archiveId/invites/:inviteId', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const inviteId = (c.req.param('inviteId') ?? '').toLowerCase();
    const role = await memberRole(deps.pool, c.get('userId'), archiveId);
    if (role === null) return c.json(notFound, 404);
    if (!MAY_GIVE[role])
      return c.json(
        { error: 'only an owner or steward can revoke invites', code: 'forbidden' },
        403,
      );
    if (!UUID_RE.test(inviteId)) return c.json(notFound, 404);
    const r = await deps.pool.query(
      `update public.invites set revoked_at = now()
        where id = $1 and archive_id = $2 and answered_at is null and revoked_at is null`,
      [inviteId, archiveId],
    );
    if (!r.rowCount) return c.json(notFound, 404);
    return c.json({ revoked: true });
  });

  /* ── invites, for the person invited ─────────────────── */
  /** this person's open invitations: to their account, or to its email from before it existed */
  const MINE = `(i.invitee_id = $1
      or (i.invitee_id is null
          and i.invitee_email = (select lower(email) from auth.users where id = $1)))
    and i.answered_at is null and i.revoked_at is null and i.expires_at > now()`;

  app.get('/v1/invites', async (c) => {
    const r = await deps.pool.query(
      `select i.id, i.role::text as role, i.created_at as "createdAt",
              a.subject_name as "projectName", a.kind, ${NAME_SQL} as "invitedBy"
         from public.invites i
         join public.archives a on a.id = i.archive_id
         join auth.users u on u.id = i.created_by
        where ${MINE}
        order by i.created_at desc`,
      [c.get('userId')],
    );
    return c.json(r.rows);
  });

  app.post('/v1/invites/:inviteId/:answer', async (c) => {
    const inviteId = (c.req.param('inviteId') ?? '').toLowerCase();
    const answer = c.req.param('answer');
    if (!UUID_RE.test(inviteId) || (answer !== 'accept' && answer !== 'decline'))
      return c.json(notFound, 404);
    const userId = c.get('userId');
    const client = await deps.pool.connect();
    try {
      await client.query('begin');
      const r = await client.query(
        `select i.id, i.archive_id as "archiveId", i.role::text as role
           from public.invites i where i.id = $2 and ${MINE} for update`,
        [userId, inviteId],
      );
      const i = r.rows[0] as { id: string; archiveId: string; role: string } | undefined;
      if (!i) {
        await client.query('rollback');
        return c.json(notFound, 404);
      }
      await client.query(
        `update public.invites set invitee_id = $2, answer = $3, answered_at = now()
          where id = $1`,
        [i.id, userId, answer === 'accept' ? 'accepted' : 'declined'],
      );
      if (answer === 'decline') {
        await client.query('commit');
        return c.json({ declined: true });
      }
      const had = await client.query(
        `select role::text as role from public.memberships
          where archive_id = $1 and user_id = $2 for update`,
        [i.archiveId, userId],
      );
      const current = (had.rows[0] as { role: string } | undefined)?.role;
      if (!current) {
        await client.query(
          `insert into public.memberships (archive_id, user_id, role) values ($1, $2, $3)`,
          [i.archiveId, userId, i.role],
        );
      } else if ((RANK[i.role] ?? 0) > (RANK[current] ?? 0)) {
        await client.query(
          `update public.memberships set role = $3 where archive_id = $1 and user_id = $2`,
          [i.archiveId, userId, i.role],
        );
      }
      await client.query('commit');
      return c.json({
        archiveId: i.archiveId,
        role: current && (RANK[current] ?? 0) >= (RANK[i.role] ?? 0) ? current : i.role,
      });
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  });
}
