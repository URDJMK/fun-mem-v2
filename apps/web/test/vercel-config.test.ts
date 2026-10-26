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

/** run the build guard on a vercel.json whose /v1 rewrite points at `destination` */
function check(destination: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-config-'));
  const file = join(dir, 'vercel.json');
  writeFileSync(
    file,
    JSON.stringify({ ...config, rewrites: [{ source: '/v1/:path*', destination }] }),
  );
  try {
    return { ok: true, out: execFileSync('node', [guard, file], { encoding: 'utf8' }) };
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
    expect(check('https://funmem-api.example.workers.dev/v1/:path*').ok).toBe(true);
  });
});
