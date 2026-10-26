import { describe, expect, it } from 'vitest';
import { RequestPools } from '../src/request-pool';
import { DB_URL } from './helpers';

/**
 * A Worker may not carry a connection from one request into another, so it cannot hold one
 * pg.Pool for its life the way the Node server does. RequestPools stands in for that pool in
 * AppDeps: every query goes to a pool of the CURRENT request's own, closed once it is done.
 */
const pools = new RequestPools({ connectionString: DB_URL, max: 2 });

const backendPid = async (): Promise<number> =>
  ((await pools.pool.query('select pg_backend_pid() as pid')).rows[0] as { pid: number }).pid;

describe('RequestPools', () => {
  it('answers queries and transactions through the stand-in pool, inside a request', async () => {
    const out = await pools.run(async () => {
      const one = (await pools.pool.query('select 1 + 1 as n')).rows[0] as { n: number };
      const client = await pools.pool.connect();
      try {
        await client.query('begin');
        const inTx = (await client.query('select txid_current_if_assigned() is null as fresh'))
          .rows[0] as { fresh: boolean };
        await client.query('commit');
        return { n: one.n, fresh: inTx.fresh };
      } finally {
        client.release();
      }
    });
    expect(out).toEqual({ n: 2, fresh: true });
  });

  it('gives two requests at once a pool each', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = pools.run(async () => {
      const pid = await backendPid();
      await hold;
      return { pid, again: await backendPid() };
    });
    const second = pools.run(async () => {
      const pid = await backendPid();
      release();
      return pid;
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.pid).toBe(a.again); // still its own pool after the other request ran
    expect(b).not.toBe(a.pid);
  });

  it("closes the request's pool when the request is done", async () => {
    // work the request started, still going after it: it has the request's pool, now closed
    let late!: Promise<unknown>;
    await pools.run(async () => {
      await pools.pool.query('select 1');
      late = new Promise((r) => setTimeout(r, 50)).then(() => pools.pool.query('select 1'));
    });
    await expect(late).rejects.toThrow(/after calling end/);
  });

  it('hands the closing to waitUntil, so the response need not wait for it', async () => {
    const handed: Promise<unknown>[] = [];
    await pools.run(async () => pools.pool.query('select 1'), {
      waitUntil: (p) => void handed.push(p),
    });
    expect(handed).toHaveLength(1);
    await handed[0];
  });

  it('refuses a query made outside any request, saying so', async () => {
    await expect(pools.pool.query('select 1')).rejects.toThrow(/outside a request/);
  });
});
