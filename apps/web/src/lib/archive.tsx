import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { listArchives, type ArchiveSummary, type ProjectKind } from './api';
import { storeArchiveId } from './supabase';
import { canWrite } from './words';
import { Failed, TopBar } from '../components/ui';

export interface Archive {
  id: string;
  /** the person (personal) or the family's name (family) */
  subjectName: string;
  kind: ProjectKind;
  /** ISO country code whose privacy law the project follows */
  jurisdiction: string;
  role: string;
  /** may this person add and change memories here (the server checks again) */
  writer: boolean;
  /** ask the server again, after the project itself changed (renamed, grown into a family) */
  reload: () => Promise<void>;
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
  const { archives, reload } = useArchives();

  if (archives === null) return null;
  if (archives === 'failed') {
    return (
      <>
        <TopBar />
        <main className="page">
          <Failed>Could not load this project. Reload the page.</Failed>
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
          <Failed>This project could not be found, or you are not a member of it.</Failed>
          <p>
            <Link to="/">Back to your projects</Link>
          </p>
        </main>
      </>
    );
  }
  storeArchiveId(found.id);
  return (
    <ArchiveContext.Provider
      key={found.id}
      value={{ ...found, writer: canWrite(found.role), reload }}
    >
      {children}
    </ArchiveContext.Provider>
  );
}

/** owners and stewards look after who is in the project */
export const canManage = (role: string) => role === 'owner' || role === 'steward';

/** The address of a page inside an archive. */
export const inArchive = (archiveId: string, path = '') => `/a/${archiveId}${path}`;

/** People and places live on the People & places page; every other note is a story. */
export const isEntity = (type: string) => type === 'person' || type === 'place';

export const noteHref = (archiveId: string, note: { id: string; type: string }) =>
  inArchive(archiveId, `${isEntity(note.type) ? '/people' : '/stories'}/${note.id}`);
