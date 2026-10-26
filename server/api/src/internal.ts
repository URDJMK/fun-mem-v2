import { createHash, timingSafeEqual } from 'node:crypto';
import type { App, AppDeps } from './app';
import { drainOnce } from './embeddings';
import { describeError, type IngestJobs } from './ingest-jobs';
import { UUID_RE } from './membership';

/**
 * Work the Node server does on timers and in the background, as routes for a Worker's cron and
 * queue handlers to call (worker.ts): the embedding drain, letting go of expired import jobs,
 * and running an import that was handed to the queue.
 *
 * They exist only when the app is given `internalSecret`, and answer only a request carrying
 * it in `x-funmem-internal`; anything else is a 404, as for a route that is not there. The
 * Worker makes the secret per isolate and never sends it anywhere but to itself.
 */

/** How long one drain may run: a cron comes every minute, and a batch in hand is finished. */
const DRAIN_BUDGET_MS = 25_000;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function registerInternalRoutes(app: App, deps: AppDeps, jobs: IngestJobs): void {
  const secret = deps.internalSecret;
  if (!secret) return;
  const expected = digest(secret);

  app.use('/internal/*', async (c, next) => {
    const given = c.req.header('x-funmem-internal');
    if (!given || !timingSafeEqual(digest(given), expected)) {
      return c.json({ error: 'not found' }, 404);
    }
    await next();
  });

  /**
   * Embed what is waiting for a vector, for at most DRAIN_BUDGET_MS: in every archive (the
   * cron), or in the one `?archive=` names (a test, an operator catching one archive up).
   */
  app.post('/internal/embeddings/drain', async (c) => {
    const archive = c.req.query('archive')?.toLowerCase();
    if (archive !== undefined && !UUID_RE.test(archive)) {
      return c.json({ error: 'archive must be an id', code: 'bad_request' }, 400);
    }
    if (!deps.embeddings)
      return c.json({ error: 'no embedding provider', code: 'no_provider' }, 503);
    try {
      const written = await drainOnce(
        deps.pool,
        deps.embeddings,
        archive,
        AbortSignal.timeout(DRAIN_BUDGET_MS),
      );
      return c.json({ written });
    } catch (e) {
      // a failed pass is retried by the next cron; the log line names the kind, never the text
      console.error(`embedding drain failed: ${describeError(e)}`);
      return c.json({ error: 'the drain failed', code: 'internal' }, 500);
    }
  });

  /** Let go of import jobs past their time, and report the ones whose runner died. */
  app.post('/internal/ingest/sweep', async (c) => {
    await jobs.sweep();
    return c.json({ swept: true });
  });

  /** Run an import handed to the queue; one already picked up (a redelivery) does nothing. */
  app.post('/internal/ingest/run/:jobId', async (c) => {
    const id = (c.req.param('jobId') ?? '').toLowerCase();
    if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
    await jobs.runQueued(id);
    return c.json({ ran: id });
  });
}
