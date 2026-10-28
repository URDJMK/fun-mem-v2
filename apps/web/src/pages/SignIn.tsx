import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { returnPath, supabase } from '../lib/supabase';
import { setDemoSignedIn, SKIP_LOGIN } from '../lib/demo';
import { Brand } from '../components/ui';

type Mode = 'signin' | 'signup' | 'forgot';

/** A Supabase auth error, in words a person can act on; code is only set on newer SDK errors. */
function authFailure(error: { code?: string; message: string }): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'Wrong email or password.';
    case 'user_already_exists':
    case 'email_exists':
      return 'An account with that email already exists. Sign in instead.';
    case 'weak_password':
      return 'That password is too weak. Use at least 6 characters.';
    case 'over_email_send_rate_limit':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'email_not_confirmed':
      return 'Confirm your email first — check your inbox for the link.';
    default:
      return error.message || 'Something went wrong. Try again in a moment.';
  }
}

/**
 * Signing in: with Google, or with an email and a password. After it, the person comes back
 * to the page whose session ended, when there was one (`?next=`), and to their archives
 * otherwise.
 */
export function SignIn() {
  const ended = (useLocation().state as { ended?: boolean } | null)?.ended === true;
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (SKIP_LOGIN) setDemoSignedIn(true);
  }, []);
  if (SKIP_LOGIN) return null;

  async function signInGoogle() {
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

  function switchTo(m: Mode) {
    setMode(m);
    setError(null);
    setSent(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setError(authFailure(error));
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${returnPath() || '/'}` },
        });
        if (error) setError(authFailure(error));
        // a project that requires confirming email returns no session yet
        else if (!data.session) setSent('Check your email for a link to confirm your account.');
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) setError(authFailure(error));
        else setSent('Check your email for a link to reset your password.');
      }
    } finally {
      setBusy(false);
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
            <p className="muted">
              {mode === 'signup'
                ? 'Create an account. It only takes a moment.'
                : mode === 'forgot'
                  ? 'We’ll email you a link to reset it.'
                  : 'Sign in or create an account. It only takes a moment.'}
            </p>
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
            onClick={() => void signInGoogle()}
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

          <div className="row" style={{ alignItems: 'center', gap: 10 }} aria-hidden="true">
            <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            <span className="small muted">or</span>
            <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>

          <form className="stack" style={{ gap: 10 }} onSubmit={(e) => void submit(e)}>
            <label className="field">
              Email
              <input
                type="email"
                className="input"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {mode !== 'forgot' && (
              <label className="field">
                Password
                <input
                  type="password"
                  className="input"
                  required
                  minLength={6}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            {mode === 'signin' && (
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                style={{
                  alignSelf: 'flex-end',
                  padding: 0,
                  minHeight: 0,
                  textDecoration: 'underline',
                }}
                onClick={() => switchTo('forgot')}
              >
                Forgot password?
              </button>
            )}
            {error && (
              <p role="alert" className="notice notice-error small">
                {error}
              </p>
            )}
            {sent && (
              <p role="status" className="notice notice-sage small">
                {sent}
              </p>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy
                ? 'Just a moment…'
                : mode === 'signup'
                  ? 'Create account'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : 'Sign in'}
            </button>
          </form>

          <p className="small muted" style={{ textAlign: 'center' }}>
            {mode === 'signup' ? (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  style={{ padding: 0, minHeight: 0, textDecoration: 'underline' }}
                  onClick={() => switchTo('signin')}
                >
                  Sign in
                </button>
              </>
            ) : mode === 'forgot' ? (
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                style={{ padding: 0, minHeight: 0, textDecoration: 'underline' }}
                onClick={() => switchTo('signin')}
              >
                Back to sign in
              </button>
            ) : (
              <>
                New here?{' '}
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  style={{ padding: 0, minHeight: 0, textDecoration: 'underline' }}
                  onClick={() => switchTo('signup')}
                >
                  Create an account
                </button>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
