import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createInvite,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  searchPeople,
  setMemberRole,
  type Invite,
  type InviteRole,
  type Member,
  type PersonFound,
} from '../lib/api';
import { canManage, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Avatar, Failed, Loading } from '../components/ui';

export const ROLE_TEXT: Record<string, { label: string; text: string }> = {
  owner: { label: 'Owner', text: 'Started the project and decides who is in it' },
  steward: { label: 'Steward', text: 'Records and edits, and invites people' },
  contributor: { label: 'Contributor', text: 'Records interviews and adds memories' },
  viewer: { label: 'Viewer', text: 'Reads the stories, the timeline and the people' },
};

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * Who can open this project, and inviting more. Members are the people with accounts who work on
 * it together; the people it records (the narrators, their family) never need one.
 */
export function Members() {
  const archive = useArchive();
  const manage = canManage(archive.role);
  const [members, setMembers] = useState<Member[] | null | 'failed'>(null);
  const [invites, setInvites] = useState<Invite[]>([]);

  const load = useCallback(async () => {
    try {
      setMembers(await listMembers(archive.id));
      if (manage) setInvites(await listInvites(archive.id));
    } catch {
      setMembers('failed');
    }
  }, [archive.id, manage]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ArchiveLayout title="Members">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Members</h1>
        <p className="muted">
          The people who can open {archive.subjectName}. The people it records don’t need an
          account.
        </p>
      </div>

      {members === null ? (
        <Loading what="Finding who’s in…" />
      ) : members === 'failed' ? (
        <Failed>Could not load the members. Reload the page.</Failed>
      ) : (
        <ul className="list" data-testid="member-list">
          {members.map((m) => (
            <li key={m.userId}>
              <div className="list-row">
                <Avatar name={m.name} size={32} />
                <span className="stack" style={{ flex: '1 1 220px', gap: 1 }}>
                  <span className="row-title">
                    {m.name}
                    {m.you && <span className="muted"> (you)</span>}
                  </span>
                  <span className="small muted">
                    {archive.role === 'owner' && !m.you && m.role !== 'owner'
                      ? ROLE_TEXT[m.role]?.text
                      : `${ROLE_TEXT[m.role]?.label ?? m.role} · ${ROLE_TEXT[m.role]?.text ?? ''}`}
                  </span>
                </span>
                {archive.role === 'owner' && !m.you && m.role !== 'owner' && (
                  <select
                    className="input member-role"
                    aria-label={`What ${m.name} can do`}
                    value={m.role}
                    onChange={async (e) => {
                      await setMemberRole(archive.id, m.userId, e.target.value as InviteRole).catch(
                        () => undefined,
                      );
                      void load();
                    }}
                  >
                    {(['steward', 'contributor', 'viewer'] as const).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_TEXT[r]!.label}
                      </option>
                    ))}
                  </select>
                )}
                {archive.role === 'owner' && !m.you && m.role !== 'owner' && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!window.confirm(`Remove ${m.name} from ${archive.subjectName}?`)) return;
                      await removeMember(archive.id, m.userId).catch(() => undefined);
                      void load();
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {manage ? (
        <InviteCard
          archiveId={archive.id}
          owner={archive.role === 'owner'}
          invites={invites}
          onChange={load}
        />
      ) : (
        <p className="small muted">Only the owner or a steward can invite people.</p>
      )}
    </ArchiveLayout>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** who to invite: someone found by search, or an email address with no account behind it yet */
type Pick = { userId: string; name: string; email: string } | { email: string };

/**
 * Inviting someone: find them by name or email, choose what they can do, and send. They see the
 * invitation in Firepit and accept or decline it. Someone not on Firepit yet is invited by their
 * full email address; it waits for them to sign in with it.
 */
function InviteCard({
  archiveId,
  owner,
  invites,
  onChange,
}: {
  archiveId: string;
  owner: boolean;
  invites: Invite[];
  onChange: () => Promise<void>;
}) {
  const roles: InviteRole[] = owner
    ? ['contributor', 'viewer', 'steward']
    : ['contributor', 'viewer'];
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PersonFound[] | null>(null);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [role, setRole] = useState<InviteRole>('contributor');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const q = query.trim();
  useEffect(() => {
    if (picked || q.length < 3) {
      setFound(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      searchPeople(archiveId, q, ac.signal)
        .then((r) => {
          setFound(r);
          setFailed(null);
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return;
          setFound([]);
          if (e instanceof ApiError && e.status === 429)
            setFailed('That’s a lot of searching. Wait a minute, then try again.');
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [archiveId, q, picked]);

  const typedEmail = EMAIL_RE.test(q) ? q.toLowerCase() : null;
  const emailHasAccount = !!found?.some((p) => p.email === typedEmail);
  const pickedName = picked ? ('name' in picked ? picked.name : picked.email) : '';

  async function send() {
    if (!picked) return;
    setBusy(true);
    setFailed(null);
    try {
      await createInvite(
        archiveId,
        role,
        'userId' in picked ? { userId: picked.userId } : { email: picked.email },
      );
      setSent(pickedName);
      setPicked(null);
      setQuery('');
      await onChange();
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.code === 'member'
          ? `${pickedName} is already in the project.`
          : e instanceof ApiError && e.code === 'invited'
            ? `${pickedName} already has an invitation waiting.`
            : e instanceof ApiError && e.status === 403
              ? 'You can’t invite someone with that role.'
              : 'Could not send the invitation. Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack invite-card" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 2 }}>
        <h2 style={{ fontSize: 16 }}>Invite someone</h2>
        <p className="small muted">
          They’ll find the invitation in Firepit and choose whether to join.
        </p>
      </div>

      {sent && (
        <div className="notice notice-wonder" role="status">
          Invited {sent}. It’s waiting for them next time they open Firepit, so let them know.
        </div>
      )}

      {picked ? (
        <div className="invite-picked">
          <Avatar name={pickedName} size={32} />
          <span className="stack" style={{ flex: '1 1 auto', gap: 1, minWidth: 0 }}>
            <span className="row-title">{pickedName}</span>
            <span className="small muted">
              {'userId' in picked
                ? picked.email
                : 'Not on Firepit yet. The invitation waits for them to sign in with this email.'}
            </span>
          </span>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => {
              setPicked(null);
              setFailed(null);
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <div className="stack invite-search">
          <input
            className="input"
            type="search"
            placeholder="Name or email"
            aria-label="Find someone by name or email"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSent(null);
            }}
          />
          {q.length > 0 && q.length < 3 && (
            <span className="small muted">Keep typing: three letters at least.</span>
          )}
          {found && (
            <ul className="invite-results" aria-label="People found">
              {found.map((p) => (
                <li key={p.userId}>
                  <button
                    type="button"
                    className="invite-result"
                    disabled={p.member || p.invited}
                    onClick={() => {
                      setPicked({ userId: p.userId, name: p.name, email: p.email });
                      setFailed(null);
                    }}
                  >
                    <Avatar name={p.name} size={28} />
                    <span className="stack" style={{ flex: '1 1 auto', gap: 0, minWidth: 0 }}>
                      <span className="row-title">{p.name}</span>
                      <span className="small muted">{p.email}</span>
                    </span>
                    {(p.member || p.invited) && (
                      <span className="small muted">{p.member ? 'Already in' : 'Invited'}</span>
                    )}
                  </button>
                </li>
              ))}
              {typedEmail && !emailHasAccount && (
                <li>
                  <button
                    type="button"
                    className="invite-result"
                    onClick={() => setPicked({ email: typedEmail })}
                  >
                    <span className="avatar invite-mail" aria-hidden="true">
                      @
                    </span>
                    <span className="stack" style={{ flex: '1 1 auto', gap: 0, minWidth: 0 }}>
                      <span className="row-title">Invite {typedEmail}</span>
                      <span className="small muted">
                        Not on Firepit yet? It’ll wait until they sign in with this email.
                      </span>
                    </span>
                  </button>
                </li>
              )}
              {found.length === 0 && !typedEmail && (
                <li className="small muted invite-none">
                  Nobody by that name. Try their full email address instead.
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {picked && (
        <>
          <div className="invite-roles" role="radiogroup" aria-label="What they can do">
            {roles.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={role === r}
                className="live-mode"
                onClick={() => setRole(r)}
              >
                <span className="stack" style={{ gap: 2 }}>
                  <span className="row-title">{ROLE_TEXT[r]!.label}</span>
                  <span className="small muted">{ROLE_TEXT[r]!.text}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void send()}
            >
              {busy
                ? 'Inviting…'
                : `Invite ${'name' in picked ? picked.name.split(' ')[0] : 'them'} as a ${ROLE_TEXT[role]!.label.toLowerCase()}`}
            </button>
          </div>
        </>
      )}
      {failed && <Failed>{failed}</Failed>}

      {invites.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h3 className="label-heading">Waiting for an answer</h3>
          <ul className="list">
            {invites.map((i) => (
              <li key={i.id}>
                <div className="list-row">
                  <Avatar name={i.inviteeName} size={28} />
                  <span className="stack" style={{ flex: '1 1 220px', gap: 1 }}>
                    <span className="row-title">{i.inviteeName}</span>
                    <span className="small muted">
                      {ROLE_TEXT[i.role]?.label ?? i.role}
                      {i.hasAccount ? ` · ${i.inviteeEmail}` : ' · not on Firepit yet'} · invited{' '}
                      {when(i.createdAt)}
                      {i.invitedBy ? ` by ${i.invitedBy}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={async () => {
                      await revokeInvite(archiveId, i.id).catch(() => undefined);
                      await onChange();
                    }}
                  >
                    Withdraw
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
