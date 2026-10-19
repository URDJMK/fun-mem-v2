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
import { supabase } from './lib/supabase';
import { ArchiveGate } from './lib/archive';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Welcome } from './pages/Welcome';
import { NoteList } from './pages/NoteList';
import { NewNote } from './pages/NewNote';
import { NotePage } from './pages/NotePage';

function useSignedIn(): { loading: boolean; signedIn: boolean } {
  const [state, setState] = useState({ loading: true, signedIn: false });
  useEffect(() => {
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
 * Every page goes through here. `/` is the front door: the welcome page for someone who is not
 * signed in, their memories for someone who is. Any other page needs a session; without one
 * it sends the person to the front door, and if the session ENDED on that page (a sign-in that
 * could not be renewed, one revoked elsewhere) it says so and brings them back afterwards.
 *
 * `loading` renders nothing: the session is read from the browser in a frame or two, and
 * flashing the welcome page at someone who is signed in is worse than a beat of nothing.
 */
function Shell() {
  const { loading, signedIn } = useSignedIn();
  const where = useLocation();
  const had = useRef(false);
  if (signedIn) had.current = true;
  if (loading) return null;
  if (!signedIn) {
    if (where.pathname === '/') return <Welcome />;
    return (
      <Navigate
        to={`/?next=${encodeURIComponent(where.pathname + where.search)}`}
        replace
        state={had.current ? { ended: true } : undefined}
      />
    );
  }
  return (
    <ArchiveGate>
      <Outlet />
    </ArchiveGate>
  );
}

/**
 * Keyed on the note id, so moving from one note to another starts the page afresh: nothing
 * one note's page holds (an open edit, a delete in progress) can reach the next.
 */
function NoteRoute() {
  const { id } = useParams<{ id: string }>();
  return <NotePage key={id} noteId={id ?? ''} />;
}

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<NoteList />} />
            <Route path="new" element={<NewNote />} />
            <Route path="note/:id" element={<NoteRoute />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
