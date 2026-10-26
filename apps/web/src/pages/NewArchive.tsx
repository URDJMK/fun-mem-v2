import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { provisionArchive, type ProjectKind } from '../lib/api';
import { inArchive } from '../lib/archive';
import { storeArchiveId } from '../lib/supabase';
import { Account, Failed, Icon } from '../components/ui';
import { browserCountry, CountryPicker, countryName } from '../components/CountryPicker';

const KINDS: Array<{ kind: ProjectKind; title: string; text: string }> = [
  {
    kind: 'personal',
    title: 'Personal',
    text: 'One person’s life: a grandparent, a parent, an old friend, or you.',
  },
  {
    kind: 'family',
    title: 'Family',
    text: 'Everyone in a family. Each person is added the first time you interview them.',
  },
];

/**
 * A new project. Three things are asked, and nothing more: what kind it is (one person, or a
 * family), its name, and which country's law it follows. The country is guessed from the
 * browser and shown for the person to confirm or change; it can only be one of the listed
 * countries (the server refuses anything else).
 */
export function NewArchive() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<ProjectKind>('personal');
  const [subjectName, setSubjectName] = useState('');
  const [jurisdiction, setJurisdiction] = useState<string | null>(browserCountry);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!jurisdiction) return setPicking(true);
    setPending(true);
    setError(null);
    try {
      const { archiveId } = await provisionArchive(subjectName.trim(), jurisdiction, kind);
      storeArchiveId(archiveId);
      void navigate(inArchive(archiveId), { replace: true });
    } catch {
      setError('Could not create the project. Try again in a moment.');
      setPending(false);
    }
  }

  const name = subjectName.trim();
  const family = kind === 'family';

  return (
    <>
      <title>Start a project · Firepit</title>
      <header className="topbar">
        <Link to="/" className="btn btn-quiet" style={{ paddingLeft: 8 }}>
          <Icon name="back" />
          Your projects
        </Link>
        <Account />
      </header>
      <main className="page page-narrow" style={{ paddingTop: 21 }}>
        <div className="stack" style={{ gap: 5 }}>
          <h1 style={{ fontSize: 24 }}>Whose stories are we keeping?</h1>
          <p className="muted" style={{ fontSize: 15 }}>
            A project holds the interviews, stories, people and places, all in one spot. You can
            invite family to help once it’s made.
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
          <div className="field" role="radiogroup" aria-label="Kind of project">
            <span>Kind of project</span>
            <div className="kind-cards">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.kind}
                  className="live-mode"
                  data-testid={`kind-${k.kind}`}
                  onClick={() => setKind(k.kind)}
                >
                  <span className="stack" style={{ gap: 2 }}>
                    <span className="row-title">{k.title}</span>
                    <span className="small muted">{k.text}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            {family ? 'What is the family called?' : 'What do you call them?'}
            <input
              className="input"
              name="subjectName"
              required
              placeholder={family ? 'The Marsh family' : 'Grandma Nell'}
              value={subjectName}
              onChange={(e) => setSubjectName(e.target.value)}
            />
            <span className="hint">
              {family
                ? 'The name of the project. The people in it are added as you interview them.'
                : 'This is how their name shows up around the project. You can change it later.'}
            </span>
          </label>

          <div className="field" role="group" aria-labelledby="country-label">
            <span id="country-label">Country</span>
            {jurisdiction && !picking ? (
              <div className="country-chosen">
                <span>{countryName(jurisdiction)}</span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => setPicking(true)}
                >
                  Change
                </button>
              </div>
            ) : (
              <CountryPicker
                value={jurisdiction}
                onChange={setJurisdiction}
                onDone={() => setPicking(false)}
              />
            )}
            <span className="hint">
              {family
                ? 'Usually where the family lives.'
                : `Usually where ${name || 'they'} ${name ? 'lives' : 'live'}.`}{' '}
              Privacy laws differ by country, so Firepit keeps the project to the right ones.
            </span>
          </div>

          {error && <Failed>{error}</Failed>}

          <div className="spread" style={{ paddingTop: 3 }}>
            <span className="small muted">Private to you and the people you invite.</span>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={pending || !jurisdiction}
            >
              {pending
                ? 'Creating…'
                : name
                  ? family
                    ? `Create ${name}`
                    : `Create ${name}’s project`
                  : 'Create the project'}
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
