import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolConfig } from 'pg';
import { describeError } from './ingest-jobs';

/**
 * A database pool per request, standing in for the one long-lived pg.Pool of the Node server.
 *
 * A Cloudflare Worker may not use a connection (a socket) that another request opened, so it
 * cannot keep one pool for its life. `pool` here is what AppDeps gets instead: every query and
 * every `connect()` goes to a pool of the CURRENT request's own, made by `run` and closed when
 * that request is done. The code that queries is the same code the Node server runs: it never
 * learns which kind of pool it has.
 */
export class RequestPools {
  private readonly current = new AsyncLocalStorage<Pool>();
  /** the pool to give AppDeps: every call goes to the current request's pool */
  readonly pool: Pool;

  constructor(private readonly config: PoolConfig) {
    const here = (): Pool => {
      const p = this.current.getStore();
      if (!p) throw new Error('no database outside a request: run it inside RequestPools.run');
      return p;
    };
    // a failure is a rejected promise, as pg's own are: callers catch, they do not try
    this.pool = {
      query: async (...args: Parameters<Pool['query']>) =>
        (here().query as (...a: unknown[]) => Promise<unknown>)(...args),
      connect: async () => here().connect(),
    } as unknown as Pool;
  }

  /**
   * Run `fn` (a request, a queue message, a cron run) with a pool of its own, and close that
   * pool when `fn` is done: through `waitUntil` when there is one, so a response need not wait.
   */
  async run<T>(fn: () => Promise<T>, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<T> {
    const pool = new Pool(this.config);
    // A connection that dies must cost only the requests using it (see main.ts): pg reports
    // it as an 'error' event, and with no listener that event would end the isolate. Once the
    // request is done its connections are closed on purpose, and workerd's socket reports that
    // as an error too: no loss, so nothing to say.
    let closing = false;
    pool.on('connect', (client) => {
      client.on('error', (e: unknown) => {
        if (!closing) console.error(`database connection lost: ${describeError(e)}`);
      });
    });
    pool.on('error', () => undefined);
    try {
      return await this.current.run(pool, fn);
    } finally {
      closing = true;
      const closed = pool.end().catch(() => undefined);
      if (ctx) ctx.waitUntil(closed);
      else await closed;
    }
  }
}
