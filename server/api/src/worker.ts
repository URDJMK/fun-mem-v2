/**
 * The API as a Cloudflare Worker (wrangler.toml). The same app as the Node server (main.ts,
 * which `just api` still runs): `createApp` holds every route, and only what the platform
 * makes different is here.
 *
 * - The database: a pool per request (request-pool.ts), over Supabase's transaction pooler; a
 *   Worker may not reuse one request's connection in another.
 * - Embeddings: Workers AI's bge-m3, since the local model does not fit in a Worker.
 * - What the Node server does on timers (the embedding drain, letting go of expired import jobs)
 *   a Cron Trigger does here, through the /internal routes; an import nobody waits on goes to
 *   a Queue, whose consumer runs it (up to 15 minutes, the import's own hard limit).
 * - There is no graceful shutdown to do: a Worker serves requests, it does not stop.
 */
import { DeterministicEmbeddingProvider, type EmbeddingProvider } from '@funmem/core';
import type { ExecutionContext } from 'hono';
import { createNimAgentModel } from './agent';
import { createApp, type App } from './app';
import { WorkersAiEmbeddingProvider, type AiBinding } from './embeddings-workers-ai';
import { createNimChat } from './ingest';
import { RequestPools } from './request-pool';

interface IngestMessage {
  jobId: string;
}

/** The Worker's bindings: secrets and vars (strings), the queue and Workers AI. */
export interface Env {
  /** Supabase's transaction pooler (port 6543) */
  FUNMEM_DB_URL?: string;
  FUNMEM_SUPABASE_URL?: string;
  /** absent: imports keep the speaker's own words, the assistant answers 503 */
  NVIDIA_API_KEY?: string;
  /** `workers-ai` (default) or `deterministic` (keyword search only; tests) */
  FUNMEM_EMBEDDING_PROVIDER?: string;
  INGEST_QUEUE?: { send(body: IngestMessage): Promise<unknown> };
  AI?: AiBinding;
  [name: string]: unknown;
}

interface Batch {
  messages: ReadonlyArray<{ body: IngestMessage; ack(): void; retry(): void }>;
}

interface Built {
  app: App;
  pools: RequestPools;
  /** made here, sent only to ourselves: the /internal routes answer nothing else */
  secret: string;
}

/** One app per isolate (its routes, its JWKS cache, its job store); the database is per request. */
let built: Built | null = null;

function build(env: Env): Built {
  if (built) return built;
  // The code reads its settings from process.env (nim.ts, ingest-jobs.ts), as on Node; a
  // Worker's vars and secrets arrive in `env`.
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && process.env[name] === undefined) process.env[name] = value;
  }
  const need = (name: 'FUNMEM_DB_URL' | 'FUNMEM_SUPABASE_URL'): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required: set it with \`wrangler secret put ${name}\``);
    return v;
  };
  const pools = new RequestPools({ connectionString: need('FUNMEM_DB_URL'), max: 5 });
  const supabaseUrl = need('FUNMEM_SUPABASE_URL');
  const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const embeddings = provider(env);
  const queue = env.INGEST_QUEUE;

  const app = createApp({
    pool: pools.pool,
    embeddings,
    chat: createNimChat(),
    agentModel: createNimAgentModel(),
    auth: {
      jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      issuer: `${supabaseUrl}/auth/v1`,
    },
    ingestJobs: {
      // the cron lets go of expired jobs; no timer outlives a request here
      sweepEveryMs: null,
      enqueue: async (jobId) => {
        if (!queue) throw new Error('INGEST_QUEUE is not bound: see wrangler.toml');
        await queue.send({ jobId });
      },
    },
    internalSecret: secret,
  });

  // readiness reports what is actually true, as on the Node server
  app.get('/ready', async (c) => {
    try {
      await pools.pool.query('select 1');
    } catch {
      return c.json({ ready: false, db: 'unreachable', embeddings: embeddings?.modelVersion }, 503);
    }
    return c.json({ ready: true, db: 'ok', embeddings: embeddings?.modelVersion ?? 'none' });
  });

  built = { app, pools, secret };
  return built;
}

/**
 * Workers AI's bge-m3 unless told otherwise. Without the binding there is NO provider, not a
 * stand-in: draining under another model would embed the archive at the wrong model version
 * (main.ts says why); search keeps its keyword legs.
 */
function provider(env: Env): EmbeddingProvider | null {
  const want = env.FUNMEM_EMBEDDING_PROVIDER ?? 'workers-ai';
  if (want === 'deterministic') return new DeterministicEmbeddingProvider();
  if (want === 'workers-ai' && env.AI) return new WorkersAiEmbeddingProvider(env.AI);
  console.error(
    `embedding provider '${want}' is not available (no AI binding?): keyword search only, nothing drained`,
  );
  return null;
}

/** A call to our own /internal routes, from the cron or the queue consumer. */
const internal = (b: Built, path: string): Promise<Response> =>
  Promise.resolve(
    b.app.fetch(
      new Request(`https://funmem.internal${path}`, {
        method: 'POST',
        headers: { 'x-funmem-internal': b.secret },
      }),
    ),
  );

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // only ever reached from inside (see `internal`): from outside it does not exist
    if (new URL(req.url).pathname.startsWith('/internal')) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    const b = build(env);
    return b.pools.run(() => Promise.resolve(b.app.fetch(req, env, ctx)), ctx);
  },

  /** The Cron Trigger: embed what is waiting for a vector, let go of expired import jobs. */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const b = build(env);
    await b.pools.run(async () => {
      const drained = await internal(b, '/internal/embeddings/drain');
      // 503: no provider, already said at start; 500: the route logged what failed
      if (drained.status !== 200 && drained.status !== 503 && drained.status !== 500) {
        console.error(`[cron] embedding drain answered ${drained.status}`);
      }
      const swept = await internal(b, '/internal/ingest/sweep');
      if (!swept.ok) console.error(`[cron] import sweep answered ${swept.status}`);
    }, ctx);
  },

  /** The queue consumer: run each import handed over; a failure is retried by the queue. */
  async queue(batch: Batch, env: Env, ctx: ExecutionContext): Promise<void> {
    const b = build(env);
    for (const m of batch.messages) {
      const res = await b.pools.run(
        () => internal(b, `/internal/ingest/run/${encodeURIComponent(m.body.jobId)}`),
        ctx,
      );
      if (res.ok) m.ack();
      else m.retry();
    }
  },
};
