import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '../lib/supabase';
import { Brand, Failed } from '../components/ui';

/**
 * Where the email from "Forgot password?" (pages/SignIn.tsx) sends someone. The link itself
 * carries a one-time token that the Supabase client turns into a session before this ever
 * renders (`detectSessionInUrl` in lib/supabase.ts), so by the time the page is ready, either
 * there is a session to set a new password with, or the link was bad or had expired.
 */
export function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (live) setReady(data.session !== null);
    });
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) setError(error.message || 'Could not set the new password. Try again.');
      else setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ minHeight: '100vh', fontSize: 15 }}>
      <title>Reset password · Firepit</title>
      <header className="public-header" style={{ width: '100%' }}>
        <Brand />
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
          {ready === null ? (
            <p className="muted" role="status">
              Checking your link…
            </p>
          ) : !ready ? (
            <div className="stack" style={{ gap: 10 }}>
              <h1 style={{ fontSize: 22 }}>This link didn’t work</h1>
              <p className="muted">It may have expired. Ask for a new one from the sign-in page.</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void navigate('/sign-in')}
              >
                Back to sign in
              </button>
            </div>
          ) : done ? (
            <div className="stack" style={{ gap: 10 }}>
              <h1 style={{ fontSize: 22 }}>Password changed</h1>
              <p className="muted">You’re signed in with your new password.</p>
              <button type="button" className="btn btn-primary" onClick={() => void navigate('/')}>
                Continue
              </button>
            </div>
          ) : (
            <>
              <div className="stack" style={{ gap: 4, textAlign: 'center' }}>
                <h1 style={{ fontSize: 22 }}>Choose a new password</h1>
              </div>
              <form className="stack" style={{ gap: 10 }} onSubmit={(e) => void submit(e)}>
                <label className="field">
                  New password
                  <input
                    type="password"
                    className="input"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                {error && <Failed>{error}</Failed>}
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Set new password'}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
