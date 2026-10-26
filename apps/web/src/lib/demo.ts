/**
 * Demo mode: sign-in skipped, and every /v1 call answered in the browser from a sample archive
 * (lib/demo-api.ts), so the app can be clicked through with no Supabase stack and no API.
 *
 * Only ever on under `vite dev`: a production build always signs in with Google and talks to
 * the real API. `VITE_SKIP_LOGIN=false` turns it off in dev too.
 */
export const SKIP_LOGIN =
  import.meta.env.DEV && (import.meta.env.VITE_SKIP_LOGIN as string | undefined) !== 'false';

const KEY = 'firepit-demo-signed-in';
const EVENT = 'firepit-demo-session';

export const DEMO_NAME = 'Theo Marsh';

export function demoSignedIn(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoSignedIn(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage refused: the session lasts as long as the page */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onDemoSession(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
