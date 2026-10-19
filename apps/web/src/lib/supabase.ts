import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'http://127.0.0.1:54321';
// the local stack's public anon key (the same for every `supabase start`); a hosted project sets its own
const anonKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// The browser uses Supabase for signing in and nothing else: every read and write goes
// through the API (/v1), which checks membership, roles and private notes.
// A fixed storageKey: the browser tests seed a real session under it.
export const supabase = createClient(url, anonKey, {
  auth: { storageKey: 'funmem-auth', persistSession: true, detectSessionInUrl: true },
});

const ARCHIVE_KEY = 'funmem-archive';

/** The archive this browser last opened: only a tiebreaker among the ones the server lists. */
export function storedArchiveId(): string | null {
  try {
    return window.localStorage.getItem(ARCHIVE_KEY);
  } catch {
    return null;
  }
}

export function storeArchiveId(id: string): void {
  try {
    window.localStorage.setItem(ARCHIVE_KEY, id);
  } catch {
    /* storage refused: the server's list still decides */
  }
}

/**
 * Where to come back to after signing in: `?next=/note/…` from a page whose session ended.
 * Only a path on this site (one leading slash), never another origin.
 */
export function returnPath(search: string = window.location.search): string {
  const next = new URLSearchParams(search).get('next') ?? '';
  return /^\/(?![/\\])[^\s]*$/.test(next) ? next : '';
}
