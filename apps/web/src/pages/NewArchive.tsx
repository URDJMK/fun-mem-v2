import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { provisionArchive } from '../lib/api';
import { inArchive } from '../lib/archive';
import { storeArchiveId } from '../lib/supabase';
import { Account, Failed, Icon } from '../components/ui';

/**
 * A new archive for one person. The server asks for two things, and nothing more is asked
 * here: whose memories they are, and which country's law the archive follows.
 */
export function NewArchive() {
  const navigate = useNavigate();
  const [subjectName, setSubjectName] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const { archiveId } = await provisionArchive(subjectName.trim(), jurisdiction.trim());
      storeArchiveId(archiveId);
      void navigate(inArchive(archiveId), { replace: true });
    } catch {
      setError('Could not create the archive. Try again in a moment.');
      setPending(false);
    }
  }

  const name = subjectName.trim();

  return (
    <>
      <title>Start an archive · Varve</title>
      <header className="topbar">
        <Link to="/" className="btn btn-quiet" style={{ paddingLeft: 8 }}>
          <Icon name="back" />
          Your archives
        </Link>
        <Account />
      </header>
      <main className="page page-narrow" style={{ paddingTop: 21 }}>
        <div className="stack" style={{ gap: 5 }}>
          <h1 style={{ fontSize: 24 }}>Whose stories are we keeping?</h1>
          <p className="muted" style={{ fontSize: 15 }}>
            Each person gets their own archive: their interviews, stories, people and places, all in
            one spot.
          </p>
        </div>

        <form
          data-testid="provision-form"
          className="stack"
          style={{ gap: 13 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            What do you call them?
            <input
              className="input"
              name="subjectName"
              required
              placeholder="Grandma Nell"
              value={subjectName}
              onChange={(e) => setSubjectName(e.target.value)}
            />
            <span className="hint">
              This is how their name shows up around the archive. You can change it later.
            </span>
          </label>
          <label className="field">
            Which country’s law does it follow?
            <input
              className="input"
              name="jurisdiction"
              required
              placeholder="US"
              style={{ maxWidth: 200 }}
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            />
            <span className="hint">A country code, like US or GB: usually where they live.</span>
          </label>

          {error && <Failed>{error}</Failed>}

          <div className="spread" style={{ paddingTop: 3 }}>
            <span className="small muted">Private to you and the people who belong to it.</span>
            <button type="submit" className="btn btn-primary btn-lg" disabled={pending}>
              {pending ? 'Creating…' : name ? `Create ${name}’s archive` : 'Create the archive'}
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
