import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { returnPath, supabase } from '../lib/supabase';
import { setDemoSignedIn, SKIP_LOGIN } from '../lib/demo';
import { Brand } from '../components/ui';

/**
 * Signing in, with Google (the only way the server accepts). After it, the person comes back
 * to the page whose session ended, when there was one (`?next=`), and to their archives
 * otherwise.
 */
export function SignIn() {
  const ended = (useLocation().state as { ended?: boolean } | null)?.ended === true;
  const [failed, setFailed] = useState(false);

  // demo mode: no sign-in to do; the app sends the person on to where they were going
  useEffect(() => {
    if (SKIP_LOGIN) setDemoSignedIn(true);
  }, []);
  if (SKIP_LOGIN) return null;

  async function signIn() {
    setFailed(false);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}${returnPath() || '/'}` },
      });
      if (error) setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="stack" style={{ minHeight: '100vh', fontSize: 15 }}>
      <title>Sign in · Firepit</title>
      <header className="public-header" style={{ width: '100%' }}>
        <Brand />
        <Link
          to="/"
          className="small"
          style={{
            color: 'var(--muted)',
            minHeight: 32,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          Back to home
        </Link>
      </header>
      <main
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '21px 10px 62px',
        }}
      >
        <div
          className="card stack"
          style={{
            width: '100%',
            maxWidth: 420,
            borderRadius: 8,
            padding: '23px 21px',
            gap: 14,
            boxShadow: 'var(--shadow)',
          }}
        >
          <div className="stack" style={{ gap: 4, textAlign: 'center' }}>
            <h1 style={{ fontSize: 22 }}>Welcome</h1>
            <p className="muted">Sign in or create an account. It only takes a moment.</p>
          </div>
          {ended && (
            <p role="status" data-testid="welcome-ended" className="notice notice-sage small">
              You have been signed out. Sign in again to come back to the page you were on.
            </p>
          )}
          <button
            type="button"
            className="btn btn-outline"
            style={{ minHeight: 32 }}
            data-testid="login-google"
            onClick={() => void signIn()}
          >
            <span
              aria-hidden="true"
              className="avatar"
              style={{
                width: 22,
                height: 22,
                background: 'var(--soft)',
                fontFamily: 'var(--sans)',
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              G
            </span>
            Continue with Google
          </button>
          {failed && (
            <p role="alert" data-testid="login-error" className="notice notice-error small">
              Could not sign in. Wait a moment and try again.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
