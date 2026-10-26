import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { DeterministicEmbeddingProvider, type EmbeddingProvider } from '@funmem/core';
import { createApp, type App, type AppDeps } from '../src/app';

/**
 * Shared integration-test fixtures (FM-016+). Same conventions as
 * auth.test.ts/notes.test.ts: local stack, env-overridable constants, real
 * GoTrue sessions via the magic-link token flow — never mocked auth; the
 * service key is a fixture mechanism only and never appears in an
 * access-control assertion.
 */
/**
 * Local Supabase sits behind Docker Desktop's port proxy, which drops roughly one
 * new connection in a hundred and then stalls ~8s before ETIMEDOUT (measured:
 * 2 of 150 sequential requests). A short per-attempt timeout plus a retry turns a
 * flaky environment into a non-event, without hiding real failures: an HTTP error
 * status is returned as-is, and only connection-level errors are retried.
 */
export const retryFetch: typeof fetch = async (input, init) => {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(3000 * (attempt + 1)),
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      const timedOut =
        (e as { name?: string }).name === 'TimeoutError' ||
        (e as { name?: string }).name === 'AbortError';
      if (!timedOut && code !== 'ETIMEDOUT' && code !== 'ECONNRESET' && code !== 'ECONNREFUSED')
        throw e;
      last = e;
    }
  }
  throw last;
};

export const SUPABASE_URL = process.env.FUNMEM_SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const DB_URL =
  process.env.FUNMEM_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const ANON_KEY =
  process.env.FUNMEM_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SERVICE_KEY =
  process.env.FUNMEM_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export interface RealSession {
  token: string;
  userId: string;
}

export interface TestContext {
  /** the deps the app was built with: a test may set `deps.chat` to script the AI model */
  deps: AppDeps;
  pool: Pool;
  admin: SupabaseClient;
  app: App;
  embeddings: EmbeddingProvider;
  realSession: (email: string) => Promise<RealSession>;
  api: (token: string, method: string, path: string, body?: unknown) => Promise<Response>;
  provisionArchive: (s: RealSession, name: string) => Promise<string>;
  /** Call from afterAll. */
  close: () => Promise<void>;
}

export function testContext(overrides?: { embeddings?: TestContext['embeddings'] }): TestContext {
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const embeddings = overrides?.embeddings ?? new DeterministicEmbeddingProvider();
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: retryFetch },
  });
  const deps: AppDeps = {
    pool,
    // the deterministic provider is the suite-wide default: the real ONNX
    // model must never load in the default test tier (env-gated smoke only)
    embeddings,
    auth: {
      jwksUrl: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
      issuer: `${SUPABASE_URL}/auth/v1`,
    },
    // import jobs live in the database: each test file's app gets jobs (and limits) of its own,
    // as each in-memory store used to be, rather than sharing them with every file running
    // (and no sweep timer, which would outlive the pool a file closes)
    ingestJobs: { scope: randomUUID(), sweepEveryMs: null },
  };
  const app = createApp(deps);

  async function realSession(email: string): Promise<RealSession> {
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error && !/already/i.test(created.error.message)) throw created.error;
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error) throw link.error;
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: retryFetch },
    });
    let verified = await anon.auth.verifyOtp({
      type: 'email',
      token_hash: link.data.properties.hashed_token,
    });
    if (verified.error) {
      verified = await anon.auth.verifyOtp({
        type: 'magiclink',
        token_hash: link.data.properties.hashed_token,
      });
    }
    if (verified.error) throw verified.error;
    const session = verified.data.session;
    const user = verified.data.user;
    if (!session || !user) throw new Error('verifyOtp returned no session');
    return { token: session.access_token, userId: user.id };
  }

  async function api(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function provisionArchive(s: RealSession, name: string): Promise<string> {
    const res = await api(s.token, 'POST', '/v1/provision', {
      subjectName: name,
      jurisdiction: 'US',
    });
    if (res.status !== 201) throw new Error(`provision failed: ${res.status}`);
    const { archiveId } = (await res.json()) as { archiveId: string };
    return archiveId;
  }

  return {
    deps,
    pool,
    admin,
    app,
    embeddings,
    realSession,
    api,
    provisionArchive,
    close: () => pool.end(),
  };
}
