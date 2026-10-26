// Run before every Vercel build (vercel.json's buildCommand). The /v1 rewrite is what makes the
// app's same-origin API calls reach the Worker; while it still points at the placeholder, a
// deployment would load and then fail every call, so the build stops here instead.
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

const p = problem();
if (p) {
  console.error(`check-api-rewrite: ${p}`);
  process.exit(1);
}
console.log(`check-api-rewrite: /v1 goes to ${rewrite.destination}`);
