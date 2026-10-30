import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import type { Flip } from 'gsap/Flip';
import { inArchive } from '../lib/archive';
import type { Draft, Mode, StartFailure } from '../lib/interview';
import type { LiveStatus } from '../lib/live';
import { Studio } from './Studio';
import { Clock } from './Transcript';

/** an interview going on: whose, with whom, and how it began */
export interface Session {
  archiveId: string;
  /** the person being interviewed */
  narrator: string;
  /** a family project's name, when the person is one of its family */
  project: string | null;
  interviewer: string;
  mode: Mode;
  startedAt: string;
  flip: Flip.FlipState | null;
}

/** an interview that has ended, waiting for its project's Home to take it to the read-over */
export interface Ended {
  archiveId: string;
  narrator: string;
  draft: Draft;
  failed: StartFailure | null;
  audio: Blob[];
}

interface Live {
  session: Session | null;
  /** how the recording is doing, for the signs of it elsewhere in the app */
  status: LiveStatus | null;
  ended: Ended | null;
  start: (s: Session) => void;
  /** Home has taken the ended interview to its read-over */
  takeEnded: () => void;
  /** where the interview is drawn while its Home is showing (see StudioSlot) */
  host: HTMLDivElement;
  park: () => void;
}

const LiveContext = createContext<Live | null>(null);

export function useLiveInterview(): Live | null {
  return useContext(LiveContext);
}

/**
 * The interview, kept going across the app (DESIGN.md: an interview goes on while you look at
 * other pages). It lives here, above every signed-in page, rather than in Home: Home shows it in
 * its page (StudioSlot), and when you go elsewhere it carries on unseen, with the microphone and
 * the live transcription untouched, and a small floating sign says it is still recording.
 *
 * The interview is drawn into one element of its own (`host`), which is moved into Home's page
 * while Home is showing and back to a hidden holder here when it is not, so React never unmounts
 * it in between.
 */
export function LiveInterviewProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const elapsed = useRef<() => number>(() => 0);
  const holder = useRef<HTMLDivElement>(null);
  const host = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'studio-host';
    return el;
  }, []);

  const park = useCallback(() => {
    holder.current?.appendChild(host);
  }, [host]);
  useLayoutEffect(() => {
    if (!host.parentElement) park();
  }, [host, park]);

  const start = useCallback((s: Session) => {
    setEnded(null);
    setStatus('connecting');
    setSession(s);
  }, []);
  const takeEnded = useCallback(() => setEnded(null), []);

  const value = useMemo<Live>(
    () => ({ session, status, ended, start, takeEnded, host, park }),
    [session, status, ended, start, takeEnded, host, park],
  );

  return (
    <LiveContext.Provider value={value}>
      {children}
      {/* the interview's place while its Home is not showing: there, but not drawn */}
      <div ref={holder} hidden />
      {session &&
        createPortal(
          <Studio
            key={session.startedAt}
            archiveId={session.archiveId}
            name={session.narrator}
            project={session.project}
            interviewer={session.interviewer}
            mode={session.mode}
            startedAt={session.startedAt}
            flipFrom={session.flip}
            onLive={(s, time) => {
              setStatus(s);
              elapsed.current = time;
            }}
            onEnd={(draft, failed, audio) => {
              setEnded({
                archiveId: session.archiveId,
                narrator: session.narrator,
                draft,
                failed,
                audio,
              });
              setSession(null);
              setStatus(null);
            }}
          />,
          host,
        )}
      <StillRecording session={session} status={status} ended={ended} elapsed={elapsed} />
    </LiveContext.Provider>
  );
}

/**
 * Where Home shows the interview: the interview's own element is moved in here while this is on
 * the page, and handed back to be kept, unseen, when it leaves.
 */
export function StudioSlot() {
  const live = useLiveInterview();
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!live || !slot.current) return;
    slot.current.appendChild(live.host);
    return () => live.park();
    // the host and its holder are made once, for the life of the app
  }, []);
  return <div ref={slot} className="studio-slot" />;
}

const SAYS: Partial<Record<LiveStatus, string>> = {
  connecting: 'Starting the interview',
  live: 'Recording',
  paused: 'Interview paused',
  reconnecting: 'Reconnecting…',
  stopping: 'Finishing the last words…',
};

/**
 * The sign, on every page but the interview's own, that it is still going: what it is doing, how
 * long it has run, and the way back to it. After it has ended, until its Home takes it, the same
 * place says so and offers the read-over.
 */
function StillRecording({
  session,
  status,
  ended,
  elapsed,
}: {
  session: Session | null;
  status: LiveStatus | null;
  ended: Ended | null;
  elapsed: { current: () => number };
}) {
  const { pathname } = useLocation();
  const archiveId = session?.archiveId ?? ended?.archiveId;
  if (!archiveId) return null;
  const home = inArchive(archiveId);
  if (pathname === home || pathname === `${home}/`) return null;

  return (
    <div className="still-recording" role="status" data-testid="still-recording">
      {session ? (
        <>
          <span className={`live-dot live-dot-${status ?? 'connecting'}`} aria-hidden="true" />
          <span>{SAYS[status ?? 'connecting'] ?? 'Recording'}</span>
          <Clock elapsed={() => elapsed.current()} />
          <Link to={home} className="still-recording-back">
            Back to the interview
          </Link>
        </>
      ) : (
        <>
          <span>The interview with {ended!.narrator} has ended.</span>
          <Link to={home} className="still-recording-back">
            Read it over
          </Link>
        </>
      )}
    </div>
  );
}
