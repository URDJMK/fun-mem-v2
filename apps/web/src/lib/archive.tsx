import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { listArchives, provisionArchive } from './api';
import { storedArchiveId, storeArchiveId } from './supabase';
import { canWrite } from './words';

export interface Archive {
  id: string;
  subjectName: string;
  role: string;
  /** may this person add and change memories here (the server checks again) */
  writer: boolean;
}

const ArchiveContext = createContext<Archive | null>(null);

/** The archive the signed-in person is looking at. Only used under `ArchiveGate`. */
export function useArchive(): Archive {
  const archive = useContext(ArchiveContext);
  if (!archive) throw new Error('useArchive outside ArchiveGate');
  return archive;
}

/**
 * Which archive is this person looking at? The server is asked, not the browser: with Google
 * sign-in two people can share one browser, and an archive id left behind by the first is
 * nothing to the second. The stored id only breaks a tie among archives the person belongs
 * to. Someone who belongs to none yet is asked whose memories to gather.
 */
export function ArchiveGate({ children }: { children: ReactNode }) {
  // undefined: still asking; null: none yet; 'failed': the server could not be asked
  const [archive, setArchive] = useState<Archive | null | undefined | 'failed'>(undefined);

  const load = useCallback(async () => {
    try {
      const mine = await listArchives();
      const stored = storedArchiveId();
      const pick = mine.find((a) => a.id === stored) ?? mine[0];
      if (!pick) return setArchive(null);
      storeArchiveId(pick.id);
      setArchive({ ...pick, writer: canWrite(pick.role) });
    } catch {
      setArchive('failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (archive === undefined) return null;
  if (archive === 'failed') {
    return <p role="alert">Could not load your archive. Reload the page.</p>;
  }
  if (archive === null) return <Provision onDone={load} />;
  return <ArchiveContext.Provider value={archive}>{children}</ArchiveContext.Provider>;
}

function Provision({ onDone }: { onDone: () => Promise<void> }) {
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
      await onDone();
    } catch {
      setError('Could not create the archive.');
      setPending(false);
    }
  }

  return (
    <main>
      <title>Create an archive · fun-mem</title>
      <p>A place to keep them</p>
      <h1>Whose memories will you gather?</h1>
      <p>Write a name, and the memories gather around that person. You can change it later.</p>
      <form
        data-testid="provision-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p>
          <label>
            Whose memories
            <br />
            <input
              name="subjectName"
              required
              placeholder="Their name"
              value={subjectName}
              onChange={(e) => setSubjectName(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Jurisdiction
            <br />
            <input
              name="jurisdiction"
              required
              placeholder="A country code, e.g. US"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            />
          </label>
        </p>
        <p>
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Start'}
          </button>
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
