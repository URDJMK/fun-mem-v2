/**
 * FM-036 composition root — the process that actually runs.
 *
 * Config is fail-closed: every value that has no safe default throws at boot
 * rather than starting a server that half-works. Provider selection lives HERE
 * and nowhere else — `createApp` stays DI-only (app.ts:20).
 */
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import type { EmbeddingProvider } from '@funmem/core';
import { DeterministicEmbeddingProvider } from '@funmem/core';
import { createApp } from './app';
import { createNimAgentModel } from './agent';
import { createNimChat } from './ingest';
import { INTERVIEW_MODEL_DEFAULT } from './interview-coach';
import { describeError } from './ingest-jobs';
import { startEmbeddingLoop } from './embeddings';
import { createBgeM3Provider, type RealProvider } from './embeddings-real';

// Local secrets (NVIDIA_API_KEY) live in a git-ignored .env at the repo
// root. Real environment variables win; a missing file is normal (CI, hosted).
for (const path of ['.env', '../../.env']) {
  try {
    process.loadEnvFile(path);
    break;
  } catch {
    /* no file here */
  }
}

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (fail-closed config: refusing to start half-wired)`);
  return v;
};

// 127.0.0.1:8788 is the hardcoded target of apps/web's Vite proxy
// (apps/web/vite.config.ts) — changing this default silently breaks the browser app.
const PORT = Number(process.env.FUNMEM_PORT ?? 8788);
const HOST = process.env.FUNMEM_HOST ?? '127.0.0.1';

/**
 * D-30: bge-m3 is the DEFAULT runtime provider; the deterministic provider is
 * the test/CI default and the HF-unreachable fallback.
 *
 * The second return value is load-bearing. `drainOnce`'s pending join is
 * model_version-scoped, so draining under a FALLBACK provider would read every
 * chunk embedded by the real model as pending and re-embed the whole corpus at
 * the wrong model_version — an HF outage would permanently degrade the archive.
 * So: the loop runs only when the provider in hand is the one that was asked for.
 */
async function selectProvider(): Promise<{
  provider: EmbeddingProvider;
  mayDrain: boolean;
  disposable: RealProvider | null;
  state: 'requested' | 'degraded';
}> {
  const want = process.env.FUNMEM_EMBEDDING_PROVIDER ?? 'bge-m3';
  if (want === 'deterministic') {
    return {
      provider: new DeterministicEmbeddingProvider(),
      mayDrain: true,
      disposable: null,
      state: 'requested',
    };
  }
  try {
    // The provider's own READY_TIMEOUT_MS is 5 minutes, to allow a genuine
    // first-run 568MB download. But main() awaits this before serving HTTP, so
    // an unreachable hub would leave the server dead-but-starting for that long.
    // Bound it here: the operator raises it for a cold first run.
    const budget = Number(process.env.FUNMEM_PROVIDER_LOAD_TIMEOUT_MS ?? 300_000);
    const real = await Promise.race([
      createBgeM3Provider(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`provider load exceeded ${budget}ms`)), budget).unref?.(),
      ),
    ]);
    return { provider: real, mayDrain: true, disposable: real, state: 'requested' };
  } catch (e) {
    console.error(
      `embedding provider '${want}' failed to load; serving keyword search only and NOT draining ` +
        `(draining under a fallback would re-embed the corpus at the wrong model_version): ${String(e)}`,
    );
    return {
      provider: new DeterministicEmbeddingProvider(),
      mayDrain: false,
      disposable: null,
      state: 'degraded',
    };
  }
}

/**
 * Wait for any connection still in use to be released before the pool is closed.
 *
 * The embedding loop's stop function now waits for its own pass (a pass computes vectors with
 * no connection checked out, so this check alone could not see it); this covers the rest, such
 * as a request that was mid-query when the server stopped accepting.
 */
async function settleInFlight(pool: Pool, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (pool.totalCount > pool.idleCount && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * How long a shutdown waits for the embedding batch in hand and for requests in flight, and
 * the point past which it stops waiting at all. A shutdown that waited for everything took
 * 26 s to minutes (the whole embedding backlog, a long import request; round-3 review D3).
 * Leaving early loses nothing: a transaction cut off by the exit is rolled back whole.
 */
const STOP_WAIT_MS = 5_000;
const HARD_STOP_MS = 15_000;

/** `p`, or nothing once `ms` have passed */
const within = (p: Promise<unknown>, ms: number): Promise<unknown> =>
  Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: need('FUNMEM_DB_URL') });
  // A connection that dies (a database restart, a failover, a network blip) must cost only the
  // requests that were using it, never the process. pg reports it as an 'error' EVENT, and with
  // no listener that event was uncaught and the server exited (round-3 review D5). Every client
  // the pool opens gets a listener for its whole life, idle or checked out; a dead client is
  // dropped by the pool when it is released. The pool's own 'error' (an idle client dying) is
  // the same event seen a second time: the client's listener has already said it.
  pool.on('connect', (client) => {
    client.on('error', (e: unknown) => {
      console.error(`database connection lost: ${describeError(e)}`);
    });
  });
  pool.on('error', () => undefined);
  const supabaseUrl = need('FUNMEM_SUPABASE_URL');

  const { provider, mayDrain, disposable, state } = await selectProvider();

  const app = createApp({
    pool,
    embeddings: provider,
    chat: createNimChat(),
    agentModel: createNimAgentModel(),
    transcriptionKey: process.env.DEEPGRAM_API_KEY || null,
    // the interview coach answers within a pause: a fast model, one attempt, a short deadline
    interviewChat: createNimChat({
      model: process.env.INTERVIEW_MODEL || INTERVIEW_MODEL_DEFAULT,
      timeoutMs: 9000,
      attempts: 1,
      hedgeMs: 0,
    }),
    auth: {
      jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      issuer: `${supabaseUrl}/auth/v1`,
    },
  });

  // readiness reports what is actually true, so a proxy can tell "up" from "usable"
  app.get('/ready', async (c) => {
    try {
      await pool.query('select 1');
    } catch {
      return c.json({ ready: false, db: 'unreachable', embeddings: state }, 503);
    }
    return c.json({ ready: true, db: 'ok', embeddings: state, draining: mayDrain });
  });

  const stopLoop = mayDrain ? startEmbeddingLoop(pool, provider) : null;
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`funmem api listening on http://${HOST}:${PORT} (embeddings: ${state})`);

  let closingSince = 0;
  const shutdown = (signal: string) => {
    // A second signal means "now" (Ctrl+C twice, a supervisor that has waited long enough); it
    // used to be ignored, so nothing could cut a stuck shutdown short. But a signal sent to the
    // process group ALSO arrives forwarded by pnpm and vite-node, a few milliseconds later: that
    // copy is the same request, not a second one.
    if (closingSince > 0) {
      if (Date.now() - closingSince < 1_000) return;
      console.log(`${signal} received again, exiting now`);
      process.exit(1);
    }
    closingSince = Date.now();
    console.log(`${signal} received, shutting down`);
    setTimeout(() => {
      console.error('shutdown is taking too long, exiting');
      process.exit(1);
    }, HARD_STOP_MS).unref();
    // Order matters, and the prototype proved it on its first real SIGTERM:
    // closing the pool while a drain pass is mid-query throws "Cannot use a pool
    // after calling end". So: stop scheduling, stop accepting, let the batch in hand
    // and the requests in flight settle (for a few seconds at most), and only then
    // release the pool.
    const loopStopped = stopLoop?.() ?? Promise.resolve();
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    void (async () => {
      await within(Promise.all([loopStopped, serverClosed]), STOP_WAIT_MS);
      await settleInFlight(pool, 2_000);
      await disposable?.dispose();
      await pool.end();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  console.error('boot failed:', e);
  process.exit(1);
});
