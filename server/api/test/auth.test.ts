import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { provisionSignup } from '../src/provision';

// Local Supabase stack (must be running — these tests FAIL when it is down; loop rule 1).
// All values are the CLI's static local-demo defaults, env-overridable for CI/hosted.
const SUPABASE_URL = process.env.FUNMEM_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const DB_URL =
  process.env.FUNMEM_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const JWT_SECRET =
  process.env.FUNMEM_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
const ANON_KEY =
  process.env.FUNMEM_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
// service key is a TEST FIXTURE ONLY: it mints real GoTrue sessions via the admin API.
// It never touches the app under test and never appears in an RLS assertion.
const SERVICE_KEY =
  process.env.FUNMEM_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const pool = new Pool({ connectionString: DB_URL, max: 4 });
const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let app: App;
// Captured, not thrown: a thrown beforeAll marks tests SKIPPED (numFailedTests=0) and the
// red would read as green. requireSetup() re-throws per test — same discipline as rls.test.ts.
let setupError: unknown = null;

interface RealSession {
  token: string;
  userId: string;
  email: string;
}

/**
 * The REAL magic-link flow against local GoTrue, minus the email hop:
 * admin.generateLink({type:'magiclink'}) issues the same hashed OTP token the captured
 * email would carry; verifyOtp consumes it and GoTrue mints a genuine session JWT.
 * No mocked auth anywhere — the token the app verifies was signed by GoTrue itself.
 */
async function realSession(email: string): Promise<RealSession> {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error) throw link.error;
  const tokenHash = link.data.properties.hashed_token;
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // docs are ambiguous between 'email' and 'magiclink' here (supabase#41672); try both
  let verified = await anon.auth.verifyOtp({ type: 'email', token_hash: tokenHash });
  if (verified.error) {
    verified = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
  }
  if (verified.error) throw verified.error;
  const session = verified.data.session;
  const user = verified.data.user;
  if (!session || !user) throw new Error('verifyOtp returned no session');
  return { token: session.access_token, userId: user.id, email };
}

function authed(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

// unique per run so reruns never collide with leftover rows
const RUN = randomUUID().slice(0, 8);

// Local CLI now signs with ES256 and serves a JWKS (verified against the running
// stack) — so local and hosted share ONE verification mode. The HS256 branch is
// covered separately below as the legacy/self-hosted path.
let hs256App: App;

beforeAll(async () => {
  try {
    app = createApp({
      embeddings: null,
      pool,
      auth: {
        jwksUrl: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
        issuer: `${SUPABASE_URL}/auth/v1`,
      },
    });
    hs256App = createApp({
      embeddings: null,
      pool,
      auth: { hs256Secret: JWT_SECRET, issuer: `${SUPABASE_URL}/auth/v1` },
    });
  } catch (e) {
    setupError = e;
  }
});

afterAll(async () => {
  await pool.end();
});

function requireSetup(): void {
  if (setupError) throw setupError;
}

describe('FM-014 auth wiring + tenant provisioning', () => {
  it('rejects absent invalid and mis-signed tokens with 401', async () => {
    requireSetup();
    // absent
    expect((await app.request('/v1/me')).status).toBe(401);
    // malformed
    expect((await app.request('/v1/me', authed('garbage.not.a-jwt'))).status).toBe(401);
    // structurally valid JWT signed with the WRONG secret — decode-without-verify would pass this
    const misSigned = await new SignJWT({
      role: 'authenticated',
      aud: 'authenticated',
      sub: randomUUID(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('the-wrong-secret-padded-to-thirty-two-chars!!'));
    expect((await app.request('/v1/me', authed(misSigned))).status).toBe(401);
    // the HS256 legacy branch must ALSO reject bad signatures — a decode-without-verify
    // regression confined to that branch would otherwise pass the whole suite
    expect((await hs256App.request('/v1/me', authed(misSigned))).status).toBe(401);
    // claim checks beyond the signature, exercised on the HS256 (legacy) branch where
    // we can mint a token whose SIGNATURE is valid: anon role/aud must still be 401
    const anonToken = await new SignJWT({ role: 'anon', aud: 'anon', sub: randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await hs256App.request('/v1/me', authed(anonToken))).status).toBe(401);
    // valid signature + authenticated claims but a non-uuid sub: 401 here, never a
    // downstream pg cast error (only a legacy-mode secret holder could mint this)
    const nonUuidSub = await new SignJWT({ role: 'authenticated', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('service-x')
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await hs256App.request('/v1/me', authed(nonUuidSub))).status).toBe(401);
    // ...while the same signature with authenticated claims is accepted there
    const okToken = await new SignJWT({
      role: 'authenticated',
      aud: 'authenticated',
      sub: randomUUID(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await hs256App.request('/v1/me', authed(okToken))).status).toBe(200);
    // health stays open
    expect((await app.request('/health')).status).toBe(200);
  });

  it('signup provisions tenant archive and owner membership atomically', async () => {
    requireSetup();
    const s = await realSession(`prov-${RUN}@test.local`);
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectName: `Subject ${RUN}`, jurisdiction: 'US' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenantId: string; archiveId: string };
    const rows = await pool.query(
      `select t.kind, a.jurisdiction, m.role
         from public.tenants t
         join public.archives a on a.tenant_id = t.id
         join public.memberships m on m.archive_id = a.id
        where t.id = $1 and a.id = $2 and m.user_id = $3`,
      [body.tenantId, body.archiveId, s.userId],
    );
    expect(rows.rows).toEqual([{ kind: 'personal', jurisdiction: 'US', role: 'owner' }]);

    // jurisdiction is required (FR-128, no default) — refused before any insert
    const noJur = await app.request('/v1/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectName: 'No Jurisdiction' }),
    });
    expect(noJur.status).toBe(400);

    // atomicity: a userId absent from auth.users makes the LAST insert (membership FK)
    // fail — the earlier tenant+archive inserts must roll back, leaving no orphans.
    const marker = `orphan-${RUN}`;
    await expect(
      provisionSignup(pool, {
        userId: randomUUID(),
        subjectName: 'Orphan Probe',
        jurisdiction: 'US',
        tenantName: marker,
      }),
    ).rejects.toThrow();
    const orphans = await pool.query(`select 1 from public.tenants where name = $1`, [marker]);
    expect(orphans.rowCount).toBe(0);
  });

  it('magic link flow yields a working session against local supabase', async () => {
    requireSetup();
    const s = await realSession(`magic-${RUN}@test.local`);
    const res = await app.request('/v1/me', authed(s.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: s.userId });
  });

  it('membership gates archive access with 404 for foreigners', async () => {
    requireSetup();
    const owner = await realSession(`owner-${RUN}@test.local`);
    const stranger = await realSession(`stranger-${RUN}@test.local`);
    const prov = await app.request('/v1/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectName: `Gate ${RUN}`, jurisdiction: 'US' }),
    });
    const { archiveId } = (await prov.json()) as { archiveId: string };

    const own = await app.request(`/v1/archives/${archiveId}`, authed(owner.token));
    expect(own.status).toBe(200);
    // foreign member: 404, NOT 403 — existence must not be disclosed (FR-081)
    const foreign = await app.request(`/v1/archives/${archiveId}`, authed(stranger.token));
    expect(foreign.status).toBe(404);
    // unknown and non-uuid ids are indistinguishable from foreign ones
    const unknown = await app.request(`/v1/archives/${randomUUID()}`, authed(stranger.token));
    expect(unknown.status).toBe(404);
    const nonUuid = await app.request('/v1/archives/not-a-uuid', authed(stranger.token));
    expect(nonUuid.status).toBe(404);
  });

  // FM-032 (audit register #6): the pre-existing anon fixture sets BOTH role
  // and aud to 'anon', so either guard could be deleted with the suite green —
  // they masked each other. One fixture per claim, each differing from a known-
  // good token in exactly ONE field, so every guard is independently load-
  // bearing. iss / is_anonymous / the algorithm pin had no fixture at all.
  it('each auth claim guard rejects independently', async () => {
    const good = {
      role: 'authenticated',
      aud: 'authenticated',
      sub: randomUUID(),
      is_anonymous: false,
    };
    const sign = async (claims: Record<string, unknown>, alg = 'HS256') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg })
        .setIssuer(`${SUPABASE_URL}/auth/v1`)
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(JWT_SECRET));

    // POSITIVE CONTROL: the unmodified token is accepted. Without this, every
    // 401 below could be caused by something unrelated to the claim under test.
    expect((await hs256App.request('/v1/me', authed(await sign(good)))).status).toBe(200);

    const cases: Array<[string, Record<string, unknown>]> = [
      ['role', { ...good, role: 'anon' }],
      ['aud', { ...good, aud: 'anon' }],
      ['is_anonymous', { ...good, is_anonymous: true }],
      ['sub is not a uuid', { ...good, sub: 'not-a-uuid' }],
    ];
    for (const [claim, payload] of cases) {
      const res = await hs256App.request('/v1/me', authed(await sign(payload)));
      expect(res.status, `a token whose only defect is ${claim} must be rejected`).toBe(401);
    }

    // issuer: the one claim SignJWT sets separately
    const badIss = await new SignJWT(good)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://evil.example/auth/v1')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await hs256App.request('/v1/me', authed(badIss))).status).toBe(401);

    // ALGORITHM PIN (frozen-contract DoD 3): the HS256 config pins
    // algorithms:['HS256'], so a token signed with a different HMAC algorithm
    // must be rejected even though the secret is correct and every claim is
    // valid. Without this, deleting the pin leaves the suite green.
    const wrongAlg = await sign(good, 'HS512');
    expect(
      (await hs256App.request('/v1/me', authed(wrongAlg))).status,
      'a token signed with an unpinned algorithm must be rejected',
    ).toBe(401);

    // expiry
    const expired = await new SignJWT(good)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setExpirationTime('-1m')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await hs256App.request('/v1/me', authed(expired))).status).toBe(401);
  });
});
