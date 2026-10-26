// Run before every Vercel build (vercel.json's buildCommand). The /v1 rewrite is what makes the
// app's same-origin API calls reach the Worker; while it still points at the placeholder, a
// deployment would load and then fail every call, so the build stops here instead. On Vercel it
// also needs the Supabase project to sign in with: without it the app would sign in against the
// local stack (src/lib/supabase.ts), and every sign-in on the deployed site would fail.
//
//   node scripts/check-api-rewrite.mjs [path/to/vercel.json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] ?? fileURLToPath(new URL('../vercel.json', import.meta.url));
const config = JSON.parse(readFileSync(file, 'utf8'));
const rewrite = (config.rewrites ?? []).find((r) => r.source === '/v1/:path*');

function problem() {
  if (!rewrite) return 'vercel.json has no rewrite for /v1/:path*';
  let url;
  try {
    url = new URL(rewrite.destination.replace(':path*', 'x'));
  } catch {
    return `the /v1 rewrite's destination is not a URL: ${rewrite.destination}`;
  }
  if (url.protocol !== 'https:') return 'the /v1 rewrite must point at an https origin';
  if (url.hostname.endsWith('.invalid')) {
    return (
      'the /v1 rewrite still points at the placeholder: set its destination to the deployed ' +
      "API Worker's origin (see docs/deploy.md)"
    );
  }
  return null;
}

/** on Vercel (which sets VERCEL=1 in the build), the build-time variables the app needs */
function missingSupabase() {
  if (!process.env.VERCEL) return null;
  const url = process.env.VITE_SUPABASE_URL ?? '';
  if (!url) return 'VITE_SUPABASE_URL is not set in the Vercel project (see docs/deploy.md)';
  if (!url.startsWith('https://')) return 'VITE_SUPABASE_URL must be the https Project URL';
  if (!process.env.VITE_SUPABASE_ANON_KEY)
    return 'VITE_SUPABASE_ANON_KEY is not set in the Vercel project (see docs/deploy.md)';
  return null;
}

const p = problem() ?? missingSupabase();
if (p) {
  console.error(`check-api-rewrite: ${p}`);
  process.exit(1);
}
console.log(`check-api-rewrite: /v1 goes to ${rewrite.destination}`);
