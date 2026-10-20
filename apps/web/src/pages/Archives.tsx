import { Link, Navigate } from 'react-router';
import { inArchive, useArchives } from '../lib/archive';
import { Avatar, Failed, Icon, TopBar, useAccountName } from '../components/ui';

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const ROLE_LINE: Record<string, string> = {
  owner: 'Your archive',
  steward: 'You help look after it',
  contributor: 'You can add memories',
};

/** The front door for someone signed in: whose stories they keep, and a way to start another. */
export function Archives() {
  const { archives } = useArchives();
  const name = useAccountName();
  const first = name.includes('@') ? '' : name.split(' ')[0];

  if (archives === null) return null;
  // someone who belongs to no archive yet is asked whose memories to gather
  if (archives !== 'failed' && archives.length === 0) return <Navigate to="/new-archive" replace />;

  return (
    <>
      <title>Your archives · Varve</title>
      <TopBar />
      <main className="page">
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ fontSize: 24 }}>
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="muted" style={{ fontSize: 15 }}>
            Whose stories would you like to spend time with?
          </p>
        </div>

        {archives === 'failed' ? (
          <Failed>Could not load your archives. Reload the page.</Failed>
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
                    <span className="muted">{ROLE_LINE[a.role] ?? 'Shared with you'}</span>
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
                  border: '1.5px dashed var(--dashed)',
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
                    background: 'var(--sage-tint)',
                    color: 'var(--sage)',
                  }}
                >
                  <Icon name="plus" size={24} stroke={2.2} />
                </span>
                <span className="title" style={{ fontSize: 15 }}>
                  Start a new archive
                </span>
                <span className="small muted">For a grandparent, parent, or old friend</span>
              </Link>
            </li>
          </ul>
        )}
      </main>
    </>
  );
}
