import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { answerInvite, myInvites, type MyInvite } from '../lib/api';
import { inArchive, useArchives } from '../lib/archive';
import { storeArchiveId } from '../lib/supabase';
import { Avatar, Failed, Icon, Loading, TopBar, useAccountName } from '../components/ui';

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const AS: Record<string, string> = {
  steward: 'to help look after it',
  contributor: 'to add interviews and memories',
  viewer: 'to read it',
};

const ROLE_LINE: Record<string, string> = {
  owner: 'Your project',
  steward: 'You help look after it',
  contributor: 'You can add memories',
  viewer: 'You can read it',
};

/**
 * The front door for someone signed in: invitations waiting for an answer, whose stories they
 * keep, and a way to start another.
 */
export function Archives() {
  const { archives, reload } = useArchives();
  const navigate = useNavigate();
  const name = useAccountName();
  const first = name.includes('@') ? '' : name.split(' ')[0];
  // null: still asking. A failure shows no invitations rather than blocking the page.
  const [invites, setInvites] = useState<MyInvite[] | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    myInvites()
      .then((r) => live && setInvites(r))
      .catch(() => live && setInvites([]));
    return () => {
      live = false;
    };
  }, []);

  async function answer(inv: MyInvite, a: 'accept' | 'decline') {
    setAnswering(inv.id);
    try {
      const r = await answerInvite(inv.id, a);
      setInvites((xs) => (xs ?? []).filter((x) => x.id !== inv.id));
      if (r.archiveId) {
        await reload();
        storeArchiveId(r.archiveId);
        void navigate(inArchive(r.archiveId));
      }
    } catch {
      // gone already (withdrawn, or answered elsewhere): drop it from the list
      setInvites((xs) => (xs ?? []).filter((x) => x.id !== inv.id));
    } finally {
      setAnswering(null);
    }
  }

  if (archives === null || invites === null)
    return (
      <>
        <title>Your projects · Firepit</title>
        <TopBar />
        <main className="page">
          <Loading what="Opening your projects…" />
        </main>
      </>
    );
  // someone who belongs to no project and has no invitation is asked whose memories to gather
  if (archives !== 'failed' && archives.length === 0 && invites.length === 0)
    return <Navigate to="/new-archive" replace />;

  return (
    <>
      <title>Your projects · Firepit</title>
      <TopBar />
      <main className="page">
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ fontSize: 24 }}>
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="muted" style={{ fontSize: 16 }}>
            Whose stories would you like to spend time with?
          </p>
        </div>

        {invites.length > 0 && (
          <section className="stack" style={{ gap: 8 }} aria-label="Invitations">
            {invites.map((inv) => (
              <div key={inv.id} className="card invite-waiting" data-testid="invitation">
                <Avatar name={inv.projectName} size={36} />
                <span className="stack" style={{ flex: '1 1 240px', gap: 2, minWidth: 0 }}>
                  <span className="row-title">
                    {inv.invitedBy} invited you to {inv.projectName}
                  </span>
                  <span className="small muted">
                    {inv.kind === 'family' ? 'A family project, ' : ''}
                    {AS[inv.role] ?? ''}
                  </span>
                </span>
                <span className="row">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={answering === inv.id}
                    onClick={() => void answer(inv, 'accept')}
                  >
                    Join
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    disabled={answering === inv.id}
                    onClick={() => void answer(inv, 'decline')}
                  >
                    Decline
                  </button>
                </span>
              </div>
            ))}
          </section>
        )}

        {archives === 'failed' ? (
          <Failed>Could not load your projects. Reload the page.</Failed>
        ) : (
          <ul
            data-testid="archive-list"
            className="grid-auto"
            style={{
              margin: 0,
              padding: 2,
              listStyle: 'none',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))',
            }}
          >
            {archives.map((a) => (
              <li key={a.id}>
                <Link
                  to={inArchive(a.id)}
                  className="card card-link stack"
                  style={{ gap: 10, height: '100%' }}
                >
                  <Avatar name={a.subjectName} size={36} />
                  <span className="stack" style={{ gap: 2 }}>
                    <span className="title" style={{ fontSize: 16, lineHeight: 1.15 }}>
                      {a.subjectName}
                    </span>
                    <span className="muted">
                      {a.kind === 'family' ? 'Family · ' : ''}
                      {ROLE_LINE[a.role] ?? 'Shared with you'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            <li>
              <Link
                to="/new-archive"
                className="card-link stack"
                data-testid="new-archive"
                style={{
                  gap: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  border: '1.5px dashed var(--line)',
                  borderRadius: 8,
                  padding: 16,
                  minHeight: 140,
                  height: '100%',
                }}
              >
                <span
                  aria-hidden="true"
                  className="avatar"
                  style={{
                    width: 32,
                    height: 32,
                    background: 'var(--canvas)',
                    color: 'var(--ink)',
                  }}
                >
                  <Icon name="plus" size={24} stroke={2.2} />
                </span>
                <span className="title" style={{ fontSize: 16 }}>
                  Start a new project
                </span>
                <span className="small muted">For one person, or a whole family</span>
              </Link>
            </li>
          </ul>
        )}
      </main>
    </>
  );
}
