import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase } from '../lib/supabase';
import { DEMO_NAME, setDemoSignedIn, SKIP_LOGIN } from '../lib/demo';
import { clearDrafts } from '../lib/interview';

/** Line icons from the handoff, drawn in the current text colour. */
const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M15 6l-6 6 6 6" />,
  next: <path d="M9 6l6 6-6 6" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  home: <path d="M4 11l8-7 8 7v9H4z M10 20v-5h4v5" />,
  book: (
    <>
      <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
      <path d="M5 17a3 3 0 0 1 3-3h11" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  timeline: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M7 12h3M14 12h3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  updown: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  pen: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  pause: <path d="M9 5v14M15 5v14" />,
  up: <path d="M6 15l6-6 6 6" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M17 14.5c2.2 0 3.8 1.5 4.5 4" />
    </>
  ),
  down: <path d="M6 9l6 6 6-6" />,
  play: <path d="M8 5l11 7-11 7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  phone: (
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  ),
  /* three dots in a row: a thing's own actions */
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  leave: <path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h9" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  stroke = 2,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * The mark: a hand-cut glow held in a hand-cut bowl. Two drawings of it: the full one, and a
 * rounder, heavier cut for 24 px and below so it still reads at favicon size (public/favicon.svg).
 * In the app it is drawn in Ink alone, black and white; the favicon is the mark lit, its glow in
 * Rose, as the landing page leaves it.
 */
const MARK = {
  full: {
    glow: 'M188.9 106.6C186.5 119.8 174.4 134.5 162.9 142.4C151.4 150.3 133.9 155.3 119.8 153.9C105.7 152.6 86.7 144.9 78.1 134.3C69.5 123.7 65.5 103.7 68.1 90.5C70.6 77.2 82 63.2 93.4 54.9C104.8 46.7 122.5 39.7 136.5 41C150.5 42.4 168.8 52 177.5 63C186.3 73.9 191.3 93.4 188.9 106.6Z',
    bowl: 'M29 147C30.6 151.5 34.7 161.8 39.2 168.3C43.6 174.7 49.4 180.7 55.7 185.7C62.1 190.8 69.5 195.1 77.2 198.5C84.8 202 93.3 204.6 101.8 206.3C110.3 208.1 119.3 209 128 209C136.7 209 145.7 208.1 154.2 206.3C162.7 204.6 171.2 202 178.8 198.5C186.5 195.1 193.9 190.8 200.3 185.7C206.6 180.7 212.4 174.7 216.8 168.3C221.3 161.8 225.4 151.5 227 147C228.7 142.5 227.5 142.9 226.8 141.3C226 139.7 224.2 138 222.6 137.4C220.9 136.8 218.4 136.9 216.8 137.7C215.2 138.4 215.3 138.8 213 141.9C210.6 145 206.7 152.2 202.5 156.3C198.3 160.4 193.1 163.7 187.6 166.6C182.1 169.5 176 171.7 169.6 173.6C163.2 175.4 156.3 176.7 149.3 177.6C142.4 178.5 135.1 179 128 179C120.9 179 113.6 178.5 106.7 177.6C99.7 176.7 92.8 175.4 86.4 173.6C80 171.7 73.9 169.5 68.4 166.6C62.9 163.7 57.7 160.4 53.5 156.3C49.3 152.2 45.4 145 43 141.9C40.7 138.8 40.8 138.4 39.2 137.7C37.6 136.9 35.1 136.8 33.4 137.4C31.8 138 30 139.7 29.2 141.3C28.5 142.9 27.3 142.5 29 147Z',
  },
  small: {
    glow: 'M192.4 106C190 120.4 178.1 137.1 165.9 145.9C153.7 154.7 134.1 160.3 119.1 158.6C104.1 156.8 84.8 147.1 75.7 135.4C66.6 123.7 62.2 103 64.6 88.6C67.1 74.1 78.3 57.8 90.4 48.9C102.4 40 122.1 33.6 137 35.3C151.9 37 170.7 47.5 179.9 59.3C189.1 71.1 194.7 91.5 192.4 106Z',
    bowl: 'M25.7 149C27.4 154.1 31.6 164.6 36.2 171.5C40.8 178.3 46.8 184.7 53.4 190C59.9 195.4 67.6 200 75.5 203.6C83.5 207.3 92.2 210.1 101 211.9C109.7 213.8 119 214.7 128 214.7C137 214.7 146.3 213.8 155 211.9C163.8 210.1 172.5 207.3 180.5 203.6C188.4 200 196.1 195.4 202.6 190C209.2 184.7 215.2 178.3 219.8 171.5C224.4 164.6 228.6 154.1 230.3 149C232 143.8 231.1 142.9 230 140.5C228.9 138.2 226.2 135.7 223.8 134.9C221.3 134 217.7 134.1 215.3 135.2C213 136.3 212.3 138.2 209.7 141.4C207 144.7 203.6 150.8 199.5 154.5C195.5 158.3 190.5 161.2 185.3 163.7C180 166.3 174.1 168.3 167.9 169.9C161.8 171.6 155.2 172.7 148.5 173.5C141.9 174.3 134.8 174.7 128 174.7C121.2 174.7 114.1 174.3 107.5 173.5C100.8 172.7 94.2 171.6 88.1 169.9C81.9 168.3 76 166.3 70.7 163.7C65.5 161.2 60.5 158.3 56.5 154.5C52.4 150.8 49 144.7 46.3 141.4C43.7 138.2 43 136.3 40.7 135.2C38.3 134.1 34.7 134 32.2 134.9C29.8 135.7 27.1 138.2 26 140.5C24.9 142.9 24 143.8 25.7 149Z',
  },
} as const;

export function FirepitMark({ size = 28 }: { size?: number }) {
  const cut = size <= 24 ? MARK.small : MARK.full;
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 256 256" className="mark">
      <path d={cut.glow} fill="var(--brand-mark)" />
      <path d={cut.bowl} fill="var(--ink)" />
    </svg>
  );
}

export function Brand({ to = '/', small = false }: { to?: string; small?: boolean }) {
  return (
    <Link to={to} className="brand" aria-label="Firepit, home">
      <FirepitMark size={small ? 26 : 32} />
      <span className="brand-name">Firepit</span>
    </Link>
  );
}

/** A person's initial, in Ink on Canvas: colour is kept for the teller's voice (DESIGN.md). */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden="true"
      className="avatar t-small"
      style={{
        width: size,
        height: size,
        background: 'var(--canvas)',
        color: 'var(--ink)',
        border: '1px solid var(--line)',
      }}
    >
      {initial}
    </span>
  );
}

/** Who is signed in, in the words Google gave: a display name when there is one, else the email. */
export function useAccountName(): string {
  const [name, setName] = useState(SKIP_LOGIN ? DEMO_NAME : '');
  useEffect(() => {
    if (SKIP_LOGIN) return;
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      const meta = (u?.user_metadata ?? {}) as { full_name?: unknown; name?: unknown };
      const display = [meta.full_name, meta.name].find((v) => typeof v === 'string' && v.trim());
      if (live) setName((display as string | undefined) ?? u?.email ?? '');
    });
    return () => {
      live = false;
    };
  }, []);
  return name;
}

/** Signing out, from wherever it is offered. */
/**
 * A menu that is open closes on Escape (focus going back to what opened it) or a press anywhere
 * outside it. `root` holds the trigger and the panel.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close, root, trigger]);
}

export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  return async function signOut() {
    // to the front page FIRST: a page that loses its session on its own address says
    // "you were signed out" and offers to come back, which is not what a sign-out means
    void navigate('/', { replace: true });
    // an unfinished interview is the family's words: none stays for whoever uses this browser next
    clearDrafts();
    if (SKIP_LOGIN) return setDemoSignedIn(false);
    await supabase.auth.signOut();
  };
}

/** The person's own name and a way to sign out. */
export function Account({ withName = false }: { withName?: boolean }) {
  const name = useAccountName();
  const signOut = useSignOut();

  return (
    <div className="row" style={{ gap: 6 }}>
      {name && <Avatar name={name} size={withName ? 24 : 28} />}
      {withName && name && (
        <span
          className="small"
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {name}
        </span>
      )}
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        data-testid="sign-out"
        onClick={() => void signOut()}
      >
        Sign out
      </button>
    </div>
  );
}

/** The bar on signed-in pages that are not inside one archive. */
export function TopBar({ left }: { left?: ReactNode }) {
  return (
    <header className="topbar">
      {left ?? <Brand />}
      <Account />
    </header>
  );
}

/** Loading, failure and nothing-there, said the same way everywhere. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="muted loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {what}
    </p>
  );
}

export function Failed({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="notice notice-error">
      {children}
    </p>
  );
}

/** "Around 1959", "1987", "March 1987": a fuzzy date read the way a person would say it. */
export function whenLabel(occurred: string | null): string {
  if (!occurred || occurred === 'unknown') return '';
  const around = occurred.startsWith('~');
  const raw = around ? occurred.slice(1) : occurred;
  const [y, m, d] = raw.split('-');
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const month = m ? months[Number(m) - 1] : undefined;
  const text = month ? (d ? `${Number(d)} ${month} ${y}` : `${month} ${y}`) : (y ?? raw);
  return around ? `Around ${text}` : text;
}

/** A plural said in full: "1 story", "3 stories". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
