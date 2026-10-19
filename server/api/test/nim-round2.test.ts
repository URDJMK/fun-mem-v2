import { afterEach, describe, expect, it } from 'vitest';
import { Semaphore, createNimChat, readHedgeMs } from '../src/nim';

/** Round-2 regressions for the model client (review gate-conflicts-client, low-severity items). */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('N-7a: a steady stream of judge calls cannot hold an ordinary call back for ever', () => {
  it('an ordinary call that has waited its turn takes the next free slot, the kept one included', async () => {
    const sem = new Semaphore(2, { ageMs: 100 });
    let stop = false;
    // three callers that ask at 'high' again the moment they are done
    const high = async () => {
      while (!stop) {
        const release = await sem.acquire(undefined, 'high');
        await sleep(20);
        release();
      }
    };
    const loops = [high(), high(), high()];
    await sleep(10);
    const t0 = Date.now();
    const release = await Promise.race([
      sem.acquire(undefined, 'normal'),
      sleep(1500).then(() => null),
    ]);
    const waited = Date.now() - t0;
    stop = true;
    await Promise.all(loops);
    expect(release).not.toBeNull(); // strict priority: it never got one
    expect(waited).toBeLessThan(500);
    release!();
  });

  it('a newcomer does not take the slot an aged ordinary call is owed', async () => {
    const sem = new Semaphore(2, { ageMs: 50 });
    const a = await sem.acquire(undefined, 'high');
    const b = await sem.acquire(undefined, 'high');
    const order: string[] = [];
    const normal = sem.acquire(undefined, 'normal').then((r) => (order.push('normal'), r));
    await sleep(80); // now aged
    const late = sem.acquire(undefined, 'high').then((r) => (order.push('high'), r));
    a();
    await sleep(5);
    expect(order).toEqual(['normal']);
    (await normal)();
    b();
    (await late)();
  });
});

describe('N-7b: NIM_HEDGE_MS can turn duplicates off', () => {
  const saved = process.env.NIM_HEDGE_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.NIM_HEDGE_MS;
    else process.env.NIM_HEDGE_MS = saved;
  });

  it('0, a negative number and "off" mean off; garbage keeps the default', () => {
    for (const off of ['0', '-1', '-40000', 'off', 'OFF', ' false ', 'no', 'none', 'disabled'])
      expect(readHedgeMs(off)).toBe(0);
    expect(readHedgeMs('25000')).toBe(25_000);
    expect(readHedgeMs(undefined)).toBe(40_000);
    expect(readHedgeMs('')).toBe(40_000);
    expect(readHedgeMs('soon')).toBe(40_000);
  });

  it('a client made with NIM_HEDGE_MS=-1 sends no duplicate of a slow call', async () => {
    process.env.NIM_HEDGE_MS = '-1';
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      await sleep(60);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl, limiter: new Semaphore(4) })!;
    expect(await chat.complete('s', 'u')).toBe('x');
    expect(requests).toBe(1);
  });
});
