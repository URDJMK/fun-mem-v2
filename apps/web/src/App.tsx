import { useEffect, useRef, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router';
import { returnPath, supabase } from './lib/supabase';
import { demoSignedIn, onDemoSession, SKIP_LOGIN } from './lib/demo';
import { ArchiveRoute } from './lib/archive';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Landing } from './pages/Landing';
import { SignIn } from './pages/SignIn';
import { Archives } from './pages/Archives';
import { NewArchive } from './pages/NewArchive';
import { Home } from './pages/Home';
import { Interviews } from './pages/Interviews';
import { ImportInterview } from './pages/ImportInterview';
import { Stories } from './pages/Stories';
import { NewNote } from './pages/NewNote';
import { NotePage } from './pages/NotePage';
import { People } from './pages/People';
import { Timeline } from './pages/Timeline';
import { Ask } from './pages/Ask';
import { Members } from './pages/Members';
import { ProjectSettings } from './pages/ProjectSettings';

function useSignedIn(): { loading: boolean; signedIn: boolean } {
  const [state, setState] = useState({ loading: true, signedIn: false });
  useEffect(() => {
    if (SKIP_LOGIN) {
      const read = () => setState({ loading: false, signedIn: demoSignedIn() });
      read();
      return onDemoSession(read);
    }
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) setState({ loading: false, signedIn: data.session !== null });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ loading: false, signedIn: session !== null });
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);
  return state;
}

/**
 * Every page goes through here. `/` is the front door: the landing page for someone who is not
 * signed in, their archives for someone who is. Any other page needs a session; without one
 * it sends the person to sign in, and if the session ENDED on that page (a sign-in that could
 * not be renewed, one revoked elsewhere) it says so and brings them back afterwards.
 *
 * `loading` renders nothing: the session is read from the browser in a frame or two, and
 * flashing the landing page at someone who is signed in is worse than a beat of nothing.
 */
function Shell() {
  const { loading, signedIn } = useSignedIn();
  const where = useLocation();
  const had = useRef(false);
  if (signedIn) had.current = true;
  if (loading) return null;
  if (!signedIn) {
    if (where.pathname === '/') return <Landing />;
    if (where.pathname === '/sign-in') return <SignIn />;
    return (
      <Navigate
        to={`/sign-in?next=${encodeURIComponent(where.pathname + where.search)}`}
        replace
        state={had.current ? { ended: true } : undefined}
      />
    );
  }
  if (where.pathname === '/sign-in')
    return <Navigate to={returnPath(where.search) || '/'} replace />;
  return <Outlet />;
}

/**
 * Keyed on the note id, so moving from one note to another starts the page afresh: nothing
 * one note's page holds (an open edit, a delete in progress) can reach the next.
 */
function StoryRoute() {
  const { noteId } = useParams<{ noteId: string }>();
  return <NotePage key={noteId} noteId={noteId ?? ''} />;
}

function PeopleRoute() {
  const { noteId } = useParams<{ noteId: string }>();
  return <People noteId={noteId} />;
}

function InArchive() {
  return (
    <ArchiveRoute>
      <Outlet />
    </ArchiveRoute>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Archives />} />
            <Route path="sign-in" element={null} />
            <Route path="new-archive" element={<NewArchive />} />
            <Route path="a/:archiveId" element={<InArchive />}>
              <Route index element={<Home />} />
              <Route path="interviews" element={<Interviews />} />
              <Route path="interviews/new" element={<ImportInterview />} />
              <Route
                path="interviews/live"
                element={<Navigate to=".." relative="path" replace />}
              />
              <Route path="stories" element={<Stories />} />
              <Route path="stories/new" element={<NewNote />} />
              <Route path="stories/:noteId" element={<StoryRoute />} />
              <Route path="people" element={<PeopleRoute />} />
              <Route path="people/:noteId" element={<PeopleRoute />} />
              <Route path="timeline" element={<Timeline />} />
              <Route path="ask" element={<Ask />} />
              <Route path="members" element={<Members />} />
              <Route path="settings" element={<ProjectSettings />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
