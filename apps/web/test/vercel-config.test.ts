import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vercel serves the built app and forwards /v1 to the API Worker, the way the Vite dev server
 * proxies it locally: same origin, so the Authorization header never needs a CORS preflight.
 */
interface Rewrite {
  source: string;
  destination: string;
}
const configPath = join(__dirname, '..', 'vercel.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as { rewrites: Rewrite[] };
const guard = join(__dirname, '..', 'scripts', 'check-api-rewrite.mjs');

const API = 'https://funmem-api.example.workers.dev/v1/:path*';
/** what a Vercel build has in its environment, once the project's variables are set */
const ON_VERCEL = {
  VERCEL: '1',
  VITE_SUPABASE_URL: 'https://example-ref.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'a-public-key',
};

/**
 * run the build guard on a vercel.json whose /v1 rewrite points at `destination`, with
 * `env` as the build's environment (by default, a local build: not on Vercel)
 */
function check(
  destination: string,
  env: Record<string, string> = {},
): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-config-'));
  const file = join(dir, 'vercel.json');
  writeFileSync(
    file,
    JSON.stringify({ ...config, rewrites: [{ source: '/v1/:path*', destination }] }),
  );
  try {
    // the guard reads these on Vercel only: none of this machine's own reach it
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_') && k !== 'VERCEL'),
    );
    return {
      ok: true,
      out: execFileSync('node', [guard, file], { encoding: 'utf8', env: { ...base, ...env } }),
    };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('vercel.json', () => {
  it('forwards /v1 before anything else, and gives every other path the app', () => {
    const v1 = config.rewrites.findIndex((r) => r.source === '/v1/:path*');
    expect(v1).toBe(0);
    expect(config.rewrites[v1]!.destination).toMatch(/^https:\/\/[^/]+\/v1\/:path\*$/);
    expect(config.rewrites.at(-1)).toEqual({ source: '/(.*)', destination: '/index.html' });
  });
});

describe('the build guard', () => {
  it('refuses a build whose /v1 rewrite still points at the placeholder', () => {
    const r = check('https://funmem-api-origin-not-set.invalid/v1/:path*');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('/v1');
  });

  it('refuses a destination that is not https', () => {
    expect(check('http://funmem-api.example.workers.dev/v1/:path*').ok).toBe(false);
  });

  it('lets a build through once /v1 points at a real https origin', () => {
    expect(check(API).ok).toBe(true);
    expect(check(API, ON_VERCEL).ok).toBe(true);
  });

  it('on Vercel, refuses a build without the Supabase project it signs in with', () => {
    // without them the app would sign in against the local stack (lib/supabase.ts): every
    // sign-in would fail on the deployed site
    const noUrl = { ...ON_VERCEL, VITE_SUPABASE_URL: '' };
    const noKey = { ...ON_VERCEL, VITE_SUPABASE_ANON_KEY: '' };
    expect(check(API, noUrl)).toMatchObject({ ok: false });
    expect(check(API, noUrl).out).toContain('VITE_SUPABASE_URL');
    expect(check(API, noKey).out).toContain('VITE_SUPABASE_ANON_KEY');
    expect(check(API, { ...ON_VERCEL, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' }).ok).toBe(
      false,
    );
  });
});
