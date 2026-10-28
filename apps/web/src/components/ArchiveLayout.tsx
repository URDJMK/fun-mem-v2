import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { listImports, type ImportRun } from '../lib/api';
import { inArchive, useArchive } from '../lib/archive';
import { SKIP_LOGIN } from '../lib/demo';
import { Account, Avatar, Brand, Icon, type IconName } from './ui';

const NAV: Array<{ path: string; label: string; icon: IconName; end?: boolean }> = [
  { path: '', label: 'Home', icon: 'home', end: true },
  { path: '/interviews', label: 'Interviews', icon: 'mic', end: true },
  { path: '/stories', label: 'Stories', icon: 'book' },
  { path: '/people', label: 'People & places', icon: 'person' },
  { path: '/timeline', label: 'Timeline', icon: 'timeline' },
  { path: '/ask', label: 'Ask', icon: 'search' },
  { path: '/members', label: 'Members', icon: 'people' },
  { path: '/settings', label: 'Settings', icon: 'gear' },
];

/** Every page inside one archive: the sidebar, and the page itself beside it. */
export function ArchiveLayout({
  title,
  wide = false,
  focus = false,
  children,
}: {
  /** the browser tab's title, before the archive's name */
  title: string;
  wide?: boolean;
  /** during an interview: the sidebar slides away so nothing pulls you off the page */
  focus?: boolean;
  children: ReactNode;
}) {
  const archive = useArchive();
  const [recent, setRecent] = useState<ImportRun[]>([]);

  useEffect(() => {
    let live = true;
    listImports(archive.id)
      .then((runs) => live && setRecent(runs.filter((r) => !r.undone && r.source).slice(0, 4)))
      .catch(() => {
        /* the sidebar's shortcuts are a convenience: the Interviews page says when it fails */
      });
    return () => {
      live = false;
    };
  }, [archive.id]);

  return (
    <div className={focus ? 'app app-focus' : 'app'}>
      <title>{`${title} · ${archive.subjectName} · Firepit`}</title>
      <aside aria-label="Sidebar" className="sidebar" inert={focus}>
        <div style={{ padding: '0 5px', minHeight: 32, display: 'flex', alignItems: 'center' }}>
          <Brand small />
        </div>
        <Link to="/" className="switcher" aria-label={`${archive.subjectName}. Switch project`}>
          <Avatar name={archive.subjectName} size={24} />
          <span className="stack" style={{ lineHeight: 1.25, flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{archive.subjectName}</span>
            <span className="muted" style={{ fontSize: 13 }}>
              Switch project
            </span>
          </span>
          <Icon name="updown" size={16} />
        </Link>

        <nav aria-label="Project" className="side-nav">
          {NAV.map((n) =>
            n.path === '/interviews' ? (
              <div key={n.path} className="side-nav-row">
                <NavLink to={inArchive(archive.id, n.path)} end={n.end ?? false}>
                  <Icon name={n.icon} stroke={1.8} />
                  {n.label}
                </NavLink>
                {archive.writer && (
                  <Link
                    to={inArchive(archive.id, '/interviews/new')}
                    className="side-nav-plus"
                    aria-label="Add an interview manually"
                    title="Add an interview manually"
                    data-testid="nav-import"
                  >
                    <Icon name="plus" size={13} stroke={3} />
                  </Link>
                )}
              </div>
            ) : (
              <NavLink key={n.path} to={inArchive(archive.id, n.path)} end={n.end ?? false}>
                <Icon name={n.icon} stroke={1.8} />
                {n.label}
              </NavLink>
            ),
          )}
        </nav>

        {recent.length > 0 && (
          <section aria-labelledby="recents-h" className="stack side-recents" style={{ gap: 2 }}>
            <h2 id="recents-h" className="side-heading">
              Recent interviews
            </h2>
            {recent.map((r) => (
              <Link key={r.id} to={inArchive(archive.id, '/interviews')} className="side-recent">
                {r.source}
              </Link>
            ))}
          </section>
        )}

        <div className="side-spacer" style={{ flex: 1, minHeight: 24 }} />
        {SKIP_LOGIN && (
          <div className="notice notice-wonder small" style={{ margin: '0 4px' }}>
            Demo mode: sign-in skipped, sample data.{' '}
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              style={{ padding: 0, minHeight: 0, textDecoration: 'underline' }}
              onClick={() =>
                void import('../lib/demo-api').then(({ resetDemo }) => {
                  resetDemo();
                  window.location.assign('/');
                })
              }
            >
              Reset
            </button>
          </div>
        )}
        <div className="side-account">
          <Account withName />
        </div>
      </aside>
      <main className="main">
        <div className={wide ? 'main-inner main-wide' : 'main-inner'}>{children}</div>
      </main>
    </div>
  );
}
