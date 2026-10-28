import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, deleteProject, listMembers, removeMember, updateProject } from '../lib/api';
import { canManage, inArchive, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { countryName } from '../components/CountryPicker';
import { writeDraft } from '../lib/interview';
import { Failed } from '../components/ui';

/**
 * The project itself: its name, its kind, the country whose law it follows, and leaving or
 * deleting it. What each person sees depends on their role; the server checks every change.
 */
export function ProjectSettings() {
  const archive = useArchive();
  const owner = archive.role === 'owner';
  const family = archive.kind === 'family';

  return (
    <ArchiveLayout title="Settings">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Settings</h1>
        <p className="muted">
          {canManage(archive.role)
            ? 'The project’s name and kind. Who’s in it is on the '
            : 'About this project. Who’s in it is on the '}
          <Link to={inArchive(archive.id, '/members')}>Members</Link> page.
        </p>
      </div>

      <section className="card stack settings-card">
        <ProjectName />

        <div className="settings-row">
          <div className="stack settings-what">
            <span className="row-title">Kind</span>
            <span className="small muted">
              {family
                ? 'Family: everyone in it. Each person is added the first time they are interviewed.'
                : 'Personal: one person’s life.'}
            </span>
          </div>
          {owner && !family && <MakeFamily />}
        </div>

        <div className="settings-row">
          <div className="stack settings-what">
            <span className="row-title">Country</span>
            <span className="small muted">
              {countryName(archive.jurisdiction)}. Its privacy law applies to everything here, so
              it’s set once, when the project is made.
            </span>
          </div>
        </div>
      </section>

      {owner ? <DeleteProject /> : <LeaveProject />}
    </ArchiveLayout>
  );
}

function ProjectName() {
  const archive = useArchive();
  const [name, setName] = useState(archive.subjectName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const changed = name.trim() !== archive.subjectName && name.trim() !== '';

  if (!canManage(archive.role))
    return (
      <div className="settings-row">
        <div className="stack settings-what">
          <span className="row-title">Name</span>
          <span className="small muted">{archive.subjectName}</span>
        </div>
      </div>
    );

  return (
    <form
      className="settings-row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!changed) return;
        setSaving(true);
        setFailed(null);
        try {
          await updateProject(archive.id, { subjectName: name.trim() });
          await archive.reload();
          setSaved(true);
        } catch {
          setFailed('Could not rename it. Try again in a moment.');
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="stack settings-what" htmlFor="project-name">
        <span className="row-title">Name</span>
        <span className="small muted">
          {archive.kind === 'family'
            ? 'What the family is called, e.g. The Marsh family.'
            : 'How their name shows up around the project.'}
        </span>
      </label>
      <div className="row settings-control">
        <input
          id="project-name"
          className="input"
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" className="btn btn-outline" disabled={!changed || saving}>
          {saving ? 'Saving…' : saved && !changed ? 'Saved' : 'Save'}
        </button>
      </div>
      {failed && <Failed>{failed}</Failed>}
    </form>
  );
}

function MakeFamily() {
  const archive = useArchive();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!asking)
    return (
      <button type="button" className="btn btn-outline btn-sm" onClick={() => setAsking(true)}>
        Make it a family project
      </button>
    );
  return (
    <div className="stack settings-confirm">
      <span className="small">
        Interviews will start by asking who you’re talking with, and anyone new joins the project’s
        people. You can’t make it personal again.
      </span>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await updateProject(archive.id, { kind: 'family' });
              await archive.reload();
            } catch {
              setFailed(true);
              setBusy(false);
            }
          }}
        >
          {busy ? 'Changing…' : 'Make it a family project'}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
      {failed && <Failed>Could not change it. Try again in a moment.</Failed>}
    </div>
  );
}

function LeaveProject() {
  const archive = useArchive();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <section className="card stack settings-card settings-danger">
      <div className="settings-row">
        <div className="stack settings-what">
          <span className="row-title">Leave {archive.subjectName}</span>
          <span className="small muted">
            What you added stays in the project. To come back you’ll need a new invite.
          </span>
        </div>
        {!asking && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAsking(true)}>
            Leave
          </button>
        )}
      </div>
      {asking && (
        <div className="row">
          <button
            type="button"
            className="btn btn-danger-solid btn-sm"
            onClick={async () => {
              try {
                const you = (await listMembers(archive.id)).find((m) => m.you);
                if (!you) throw new Error('not in it');
                await removeMember(archive.id, you.userId);
                void navigate('/', { replace: true });
              } catch {
                setFailed(true);
              }
            }}
          >
            Yes, leave
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsking(false)}>
            Stay
          </button>
        </div>
      )}
      {failed && <Failed>Could not leave just now. Try again in a moment.</Failed>}
    </section>
  );
}

function DeleteProject() {
  const archive = useArchive();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const matches = typed.trim() === archive.subjectName;

  return (
    <section className="card stack settings-card settings-danger">
      <div className="stack settings-what">
        <span className="row-title">Delete this project</span>
        <span className="small muted">
          Every interview, story, person and place in it is erased, for everyone in it. This can’t
          be undone.
        </span>
      </div>
      <form
        className="stack"
        style={{ gap: 8 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!matches) return;
          setBusy(true);
          setFailed(null);
          try {
            await deleteProject(archive.id, typed.trim());
            // everything of it is erased, the unfinished interview in this browser too
            writeDraft(archive.id, null);
            void navigate('/', { replace: true });
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
        <label className="field" htmlFor="delete-confirm">
          <span className="small">
            Type <strong>{archive.subjectName}</strong> to confirm
          </span>
          <input
            id="delete-confirm"
            className="input"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            type="submit"
            className="btn btn-danger-solid"
            disabled={!matches || busy}
            data-testid="delete-project"
          >
            {busy ? 'Deleting…' : `Delete ${archive.subjectName}`}
          </button>
        </div>
        {failed && <Failed>{failed}</Failed>}
      </form>
    </section>
  );
}
