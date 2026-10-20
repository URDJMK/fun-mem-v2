import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase } from '../lib/supabase';
import { DEMO_NAME, setDemoSignedIn, SKIP_LOGIN } from '../lib/demo';

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

export function Brand({ to = '/', small = false }: { to?: string; small?: boolean }) {
  return (
    <Link to={to} className="brand">
      <svg aria-hidden="true" width={small ? 22 : 30} height={small ? 22 : 30} viewBox="0 0 32 32">
        <rect width="32" height="32" rx="10" fill="var(--sage)" />
        <path d="M10 10h12v9a3 3 0 0 1-3 3h-5l-4 3.5z" fill="var(--paper)" />
      </svg>
      <span className="brand-name" style={small ? { fontSize: 19 } : undefined}>
        Varve
      </span>
    </Link>
  );
}

/** The handoff's avatar tints; a name always gets the same one. */
const TINTS = [
  ['var(--sage-avatar)', 'var(--sage-ink)'],
  ['var(--sand-avatar)', 'var(--sand-ink)'],
  ['var(--family)', 'var(--family-ink)'],
  ['var(--wonder)', 'var(--wonder-ink)'],
  ['var(--keep)', 'var(--keep-ink)'],
] as const;

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const [bg, fg] = TINTS[h % TINTS.length]!;
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden="true"
      className="avatar"
      style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.46 }}
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

/** The person's own name and a way to sign out. */
export function Account({ withName = false }: { withName?: boolean }) {
  const name = useAccountName();
  const navigate = useNavigate();

  async function signOut() {
    // to the front page FIRST: a page that loses its session on its own address says
    // "you were signed out" and offers to come back, which is not what a sign-out means
    void navigate('/', { replace: true });
    if (SKIP_LOGIN) return setDemoSignedIn(false);
    await supabase.auth.signOut();
  }

  return (
    <div className="row" style={{ gap: 6 }}>
      {name && <Avatar name={name} size={withName ? 24 : 28} />}
      {withName && name && (
        <span
          className="small"
          style={{
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
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
    <p className="muted" role="status">
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
