import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { listArchives, type ArchiveSummary } from './api';
import { storeArchiveId } from './supabase';
import { canWrite } from './words';
import { Failed, TopBar } from '../components/ui';

export interface Archive {
  id: string;
  subjectName: string;
  role: string;
  /** may this person add and change memories here (the server checks again) */
  writer: boolean;
}

const ArchiveContext = createContext<Archive | null>(null);

/** The archive the signed-in person is looking at. Only used under `ArchiveRoute`. */
export function useArchive(): Archive {
  const archive = useContext(ArchiveContext);
  if (!archive) throw new Error('useArchive outside ArchiveRoute');
  return archive;
}

/** The archives this person belongs to, as the server lists them. */
export function useArchives(): {
  archives: ArchiveSummary[] | null | 'failed';
  reload: () => Promise<void>;
} {
  // null: still asking
  const [archives, setArchives] = useState<ArchiveSummary[] | null | 'failed'>(null);
  const reload = useCallback(async () => {
    try {
      setArchives(await listArchives());
    } catch {
      setArchives('failed');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { archives, reload };
}

/**
 * Every page inside one archive goes through here. The archive is named in the address, and
 * the server is asked whether this person belongs to it: with Google sign-in two people can
 * share one browser, and an address left behind by the first is nothing to the second.
 */
export function ArchiveRoute({ children }: { children: ReactNode }) {
  const { archiveId = '' } = useParams<{ archiveId: string }>();
  const { archives } = useArchives();

  if (archives === null) return null;
  if (archives === 'failed') {
    return (
      <>
        <TopBar />
        <main className="page">
          <Failed>Could not load this archive. Reload the page.</Failed>
        </main>
      </>
    );
  }
  const found = archives.find((a) => a.id.toLowerCase() === archiveId.toLowerCase());
  if (!found) {
    return (
      <>
        <TopBar />
        <main className="page">
          <Failed>This archive could not be found, or you are not a member of it.</Failed>
          <p>
            <Link to="/">Back to your archives</Link>
          </p>
        </main>
      </>
    );
  }
  storeArchiveId(found.id);
  return (
    <ArchiveContext.Provider key={found.id} value={{ ...found, writer: canWrite(found.role) }}>
      {children}
    </ArchiveContext.Provider>
  );
}

/** The address of a page inside an archive. */
export const inArchive = (archiveId: string, path = '') => `/a/${archiveId}${path}`;

/** People and places live on the People & places page; every other note is a story. */
export const isEntity = (type: string) => type === 'person' || type === 'place';

export const noteHref = (archiveId: string, note: { id: string; type: string }) =>
  inArchive(archiveId, `${isEntity(note.type) ? '/people' : '/stories'}/${note.id}`);
