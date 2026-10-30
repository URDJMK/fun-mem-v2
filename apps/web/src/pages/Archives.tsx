import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import {
  answerInvite,
  ApiError,
  deleteProject,
  listMembers,
  myInvites,
  removeMember,
  type ArchiveSummary,
  type MyInvite,
} from '../lib/api';
import { inArchive, useArchives } from '../lib/archive';
import { writeDraft } from '../lib/interview';
import { storeArchiveId } from '../lib/supabase';
import {
  Avatar,
  Failed,
  Icon,
  Loading,
  TopBar,
  useAccountName,
  useDismiss,
} from '../components/ui';

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
 * keep (each with its own menu: open it, its members or settings, delete or leave it), and a way to
 * start another.
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
      <main className="page projects">
        <div className="stack" style={{ gap: 2 }}>
          <h1 className="t-title">
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
        </div>

        {invites.length > 0 && (
          <section className="stack" style={{ gap: 8 }} aria-label="Invitations">
            {invites.map((inv) => (
              <div key={inv.id} className="card invite-waiting" data-testid="invitation">
                <Avatar name={inv.projectName} size={32} />
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
          <section className="stack" style={{ gap: 12 }} aria-labelledby="projects-h">
            <div className="projects-head">
              <h2 id="projects-h" className="t-small muted">
                Your projects
              </h2>
              <Link to="/new-archive" className="btn btn-primary btn-sm" data-testid="new-archive">
                <Icon name="plus" size={16} stroke={2.2} />
                New project
              </Link>
            </div>
            <ul data-testid="archive-list" className="project-grid">
              {archives.map((a) => (
                <ProjectCard key={a.id} archive={a} onGone={() => void reload()} />
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

/** one project: opens it; its own menu holds the rest */
function ProjectCard({ archive: a, onGone }: { archive: ArchiveSummary; onGone: () => void }) {
  const [asking, setAsking] = useState<'delete' | 'leave' | null>(null);
  return (
    <li className="project-card">
      <Link to={inArchive(a.id)} className="project-link">
        <Avatar name={a.subjectName} size={32} />
        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
          <span className="project-name t-small">{a.subjectName}</span>
          <span className="muted t-small">{ROLE_LINE[a.role] ?? 'Shared with you'}</span>
        </span>
        {a.kind === 'family' && <span className="pill t-small">Family</span>}
      </Link>
      <ProjectActions archive={a} onAsk={setAsking} />
      {asking === 'delete' && (
        <DeleteDialog archive={a} onClose={() => setAsking(null)} onDone={onGone} />
      )}
      {asking === 'leave' && (
        <LeaveDialog archive={a} onClose={() => setAsking(null)} onDone={onGone} />
      )}
    </li>
  );
}

/** the three dots on a project: a small menu of what can be done with it */
function ProjectActions({
  archive: a,
  onAsk,
}: {
  archive: ArchiveSummary;
  onAsk: (what: 'delete' | 'leave') => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    root,
    trigger,
  );
  const owner = a.role === 'owner';
  const panel = `project-actions-${a.id}`;

  return (
    <div className="project-actions" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="project-more"
        aria-label={`More for ${a.subjectName}`}
        aria-expanded={open}
        aria-controls={panel}
        data-testid="project-more"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={22} stroke={3} />
      </button>
      {open && (
        <div id={panel} className="project-menu-panel project-actions-panel">
          <Link to={inArchive(a.id)} className="menu-item">
            <Icon name="home" size={20} stroke={1.8} />
            Open
          </Link>
          <Link to={inArchive(a.id, '/members')} className="menu-item">
            <Icon name="people" size={20} stroke={1.8} />
            Members
          </Link>
          <Link to={inArchive(a.id, '/settings')} className="menu-item">
            <Icon name="gear" size={20} stroke={1.8} />
            Settings
          </Link>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item menu-danger"
            onClick={() => {
              setOpen(false);
              onAsk(owner ? 'delete' : 'leave');
            }}
          >
            <Icon name={owner ? 'trash' : 'leave'} size={20} stroke={1.8} />
            {owner ? 'Delete project…' : 'Leave project…'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A confirmation that has to be answered before anything else (the native modal dialog: focus held
 * inside, Escape cancels). Opens as soon as it is drawn; `onClose` runs however it closes.
 */
function Confirm({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog ref={ref} className="confirm" aria-label={title} onClose={onClose}>
      <h2 className="t-heading">{title}</h2>
      {children(close)}
    </dialog>
  );
}

/** the owner deletes the project: the same check as in Settings, its name typed out */
function DeleteDialog({
  archive: a,
  onClose,
  onDone,
}: {
  archive: ArchiveSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const matches = typed.trim() === a.subjectName;

  return (
    <Confirm title={`Delete ${a.subjectName}?`} onClose={onClose}>
      {(close) => (
        <form
          className="stack"
          style={{ gap: 16 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!matches) return;
            setBusy(true);
            setFailed(null);
            try {
              await deleteProject(a.id, typed.trim());
              // everything of it is erased, the unfinished interview in this browser too
              writeDraft(a.id, null);
              close();
              onDone();
            } catch (err) {
              setFailed(
                err instanceof ApiError && err.code === 'confirm_mismatch'
                  ? 'The name doesn’t match.'
                  : 'Could not delete it. Try again in a moment.',
              );
              setBusy(false);
            }
          }}
        >
          <p className="muted t-small">
            Every interview, story, person and place in it is erased, for everyone in it. This can’t
            be undone.
          </p>
          <label className="field" htmlFor={`delete-${a.id}`}>
            <span className="small">
              Type <strong>{a.subjectName}</strong> to confirm
            </span>
            <input
              id={`delete-${a.id}`}
              className="input"
              autoComplete="off"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          {failed && <Failed>{failed}</Failed>}
          <div className="row confirm-actions">
            <button type="button" className="btn btn-quiet" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-danger-solid"
              disabled={!matches || busy}
              data-testid="delete-project"
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </form>
      )}
    </Confirm>
  );
}

/** someone who isn't the owner leaves it; what they added stays */
function LeaveDialog({
  archive: a,
  onClose,
  onDone,
}: {
  archive: ArchiveSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <Confirm title={`Leave ${a.subjectName}?`} onClose={onClose}>
      {(close) => (
        <div className="stack" style={{ gap: 16 }}>
          <p className="muted t-small">
            What you added stays in the project. To come back you’ll need a new invite.
          </p>
          {failed && <Failed>Could not leave just now. Try again in a moment.</Failed>}
          <div className="row confirm-actions">
            <button type="button" className="btn btn-quiet" onClick={close} autoFocus>
              Stay
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailed(false);
                try {
                  const you = (await listMembers(a.id)).find((m) => m.you);
                  if (!you) throw new Error('not in it');
                  await removeMember(a.id, you.userId);
                  close();
                  onDone();
                } catch {
                  setFailed(true);
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Leaving…' : 'Leave'}
            </button>
          </div>
        </div>
      )}
    </Confirm>
  );
}
