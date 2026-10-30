import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { inArchive, useArchive, type Archive } from '../lib/archive';
import { SKIP_LOGIN } from '../lib/demo';
import { Avatar, Brand, Icon, useAccountName, useDismiss, useSignOut, type IconName } from './ui';

/** The five places a family goes most: the rail on a computer, the tabs on a phone. */
const NAV: Array<{ path: string; label: string; icon: IconName; end?: boolean }> = [
  { path: '', label: 'Home', icon: 'home', end: true },
  { path: '/stories', label: 'Stories', icon: 'book' },
  { path: '/people', label: 'People', icon: 'person' },
  { path: '/timeline', label: 'Timeline', icon: 'timeline' },
  { path: '/ask', label: 'Ask', icon: 'search' },
];

/** Everything else about the project, in its menu. */
const MORE: Array<{ path: string; label: string; icon: IconName; writer?: boolean }> = [
  { path: '/interviews', label: 'Interviews', icon: 'mic' },
  { path: '/interviews/new', label: 'Add an interview', icon: 'plus', writer: true },
  { path: '/members', label: 'Members', icon: 'people' },
  { path: '/settings', label: 'Settings', icon: 'gear' },
];

/**
 * Every page inside one project (DESIGN.md). On a computer, a rail down the left: the mark, the
 * five places as icons, and the project's menu at the bottom; it widens to show their names while
 * the pointer or the keyboard is in it. On a phone, a slim top bar (the project's menu, the mark)
 * and the five places as tabs along the bottom.
 */
export function ArchiveLayout({
  title,
  wide = false,
  focus = false,
  children,
}: {
  /** the browser tab's title, before the archive's name */
  title: string;
  wide?: boolean;
  /** during an interview: the bars give way, so nothing pulls you off the conversation */
  focus?: boolean;
  children: ReactNode;
}) {
  const archive = useArchive();

  return (
    <div className={focus ? 'app app-focus' : 'app'}>
      <title>{`${title} · ${archive.subjectName} · Firepit`}</title>
      <header className="appbar" inert={focus}>
        <Brand small />
        <nav aria-label="Project" className="appnav">
          {NAV.map((n) => (
            <NavLink key={n.path} to={inArchive(archive.id, n.path)} end={n.end ?? false}>
              <Icon name={n.icon} size={22} stroke={1.8} />
              <span className="appnav-label">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <ProjectMenu archive={archive} />
      </header>
      <main className="main">
        <div className={wide ? 'main-inner main-wide' : 'main-inner'}>{children}</div>
      </main>
      <nav aria-label="Project, tabs" className="tabbar" inert={focus}>
        {NAV.map((n) => (
          <NavLink key={n.path} to={inArchive(archive.id, n.path)} end={n.end ?? false}>
            <Icon name={n.icon} size={22} stroke={1.8} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/**
 * The project's name, which opens its menu: the pages that are not among the five, switching
 * project, and the account. A plain disclosure: Escape, a click outside, or going anywhere closes it.
 */
function ProjectMenu({ archive }: { archive: Archive }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const name = useAccountName();
  const signOut = useSignOut();

  useEffect(() => setOpen(false), [pathname]);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    root,
    trigger,
  );

  return (
    <div className="project-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="project-menu-trigger"
        aria-expanded={open}
        aria-controls="project-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={archive.subjectName} size={30} />
        <span className="project-menu-name">{archive.subjectName}</span>
        <Icon name="down" size={18} />
      </button>
      {open && (
        <div id="project-menu" className="project-menu-panel">
          <nav aria-label="More of this project" className="stack">
            {MORE.filter((m) => !m.writer || archive.writer).map((m) => (
              <NavLink key={m.path} to={inArchive(archive.id, m.path)} end className="menu-item">
                <Icon name={m.icon} size={20} stroke={1.8} />
                {m.label}
              </NavLink>
            ))}
          </nav>
          <div className="menu-sep" />
          <Link to="/" className="menu-item">
            <Icon name="updown" size={20} stroke={1.8} />
            Switch project
          </Link>
          <div className="menu-sep" />
          {name && <p className="menu-note">Signed in as {name}</p>}
          <button type="button" className="menu-item" onClick={() => void signOut()}>
            Sign out
          </button>
          {SKIP_LOGIN && (
            <>
              <div className="menu-sep" />
              <p className="menu-note">Demo mode: sign-in skipped, sample data.</p>
              <button
                type="button"
                className="menu-item"
                onClick={() =>
                  void import('../lib/demo-api').then(({ resetDemo }) => {
                    resetDemo();
                    window.location.assign('/');
                  })
                }
              >
                Reset the demo
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
