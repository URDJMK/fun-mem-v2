import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ModelError, Semaphore, createNimChat, readEnvNumber } from '../src/nim';

/**
 * Regressions from the review of the model client (review-ai findings 7-11). Each of these
 * failed against the client as it was: a cancel that waited out a 20 s Retry-After, a
 * listener left on the job's signal per retry, a typo in NIM_CONCURRENCY that hung every
 * call, duplicates sent for every slow call, and a judge stuck behind a whole interview.
 */

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), {
    status: 200,
  });
const status = (s: number, headers: Record<string, string> = {}) =>
  new Response('echoed family testimony', { status: s, headers });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'none';
  } catch (e) {
    return (e as ModelError).kind;
  }
};
/** a request that only ends when it is aborted */
const hang = (init: RequestInit) =>
  new Promise<Response>((_r, reject) =>
    init.signal!.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      { once: true },
    ),
  );

describe('cancelling is immediate (finding 9)', () => {
  it("a cancel while the duplicate runs does not first sleep out the original's Retry-After", async () => {
    let n = 0;
    const fetchImpl = ((_u: string, init: RequestInit) =>
      n++ === 0
        ? new Promise((r) => setTimeout(() => r(status(503, { 'retry-after': '20' })), 60))
        : hang(init)) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 20, limiter: new Semaphore(4) })!;
    const ac = new AbortController();
    const p = chat.complete('s', 'u', { signal: ac.signal });
    await sleep(100); // the original has failed (retryable, "wait 20 s"); the duplicate is still running
    const t0 = Date.now();
    ac.abort();
    expect(await kindOf(p)).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('a cancel while the answer is still arriving is a cancel, not a retryable outage', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"'));
          init.signal!.addEventListener('abort', () =>
            ctl.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 0, limiter: new Semaphore(4) })!;
    const ac = new AbortController();
    const p = chat.complete('s', 'u', { signal: ac.signal });
    await sleep(30);
    const t0 = Date.now();
    ac.abort();
    expect(await kindOf(p)).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('a deadline the caller passes as a timeout signal ends as `timeout`, a cancel as `cancelled`', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) => hang(init)) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 0, limiter: new Semaphore(4) })!;
    const job = new AbortController();
    // what an import passes: its own cancel, and the time it has left
    const deadline = AbortSignal.any([job.signal, AbortSignal.timeout(40)]);
    expect(await kindOf(chat.complete('s', 'u', { signal: deadline }))).toBe('timeout');
    const job2 = new AbortController();
    const p = chat.complete('s', 'u', {
      signal: AbortSignal.any([job2.signal, AbortSignal.timeout(5_000)]),
    });
    setTimeout(() => job2.abort(), 20);
    expect(await kindOf(p)).toBe('cancelled');
  });

  it('a slot is not queued for by a caller who has already cancelled', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const gone = new AbortController();
    gone.abort();
    const t0 = Date.now();
    await expect(sem.acquire(gone.signal)).rejects.toBeInstanceOf(ModelError);
    expect(Date.now() - t0).toBeLessThan(50);
    hold();
  });
});

describe('a long-lived signal collects no listeners (finding 11)', () => {
  it('100 calls that each retry once leave nothing on the shared signal', async () => {
    const job = new AbortController();
    const seen = new Map<string, number>();
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const id = JSON.parse(String(init.body)).messages[1].content as string;
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      return n === 0 ? status(503, { 'retry-after': '0' }) : ok('fine');
    }) as unknown as typeof fetch;
    const chat = createNimChat({
      apiKey: 'k',
      fetchImpl,
      hedgeMs: 0,
      limiter: new Semaphore(200),
      random: () => 0,
    })!;
    // side by side, so the real backoff sleeps overlap: one retry each, through the real sleep
    const out = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        chat.complete('s', `call ${i}`, { signal: job.signal }),
      ),
    );
    expect(out.every((t) => t === 'fine')).toBe(true);
    expect([...seen.values()].every((n) => n === 2)).toBe(true);
    expect(getEventListeners(job.signal, 'abort')).toHaveLength(0);
  });
});

describe('numbers from the environment (finding 10)', () => {
  it('a missing, non-numeric or too-small value falls back to the default', () => {
    expect(readEnvNumber(undefined, 4, 1)).toBe(4);
    expect(readEnvNumber('', 4, 1)).toBe(4);
    expect(readEnvNumber('four', 4, 1)).toBe(4);
    expect(readEnvNumber('0', 4, 1)).toBe(4);
    expect(readEnvNumber('-2', 4, 1)).toBe(4);
    expect(readEnvNumber('6', 4, 1)).toBe(6);
    expect(readEnvNumber('0', 40_000, 0)).toBe(0); // hedging off is a valid choice
    expect(readEnvNumber('soon', 40_000, 0)).toBe(40_000);
  });

  it('a limiter built from garbage still hands out a slot', async () => {
    const sem = new Semaphore(Number('four'));
    const got = await Promise.race([
      sem.acquire().then(() => 'acquired'),
      sleep(200).then(() => 'hung'),
    ]);
    expect(got).toBe('acquired');
    expect(new Semaphore(0).size).toBe(1);
  });
});

describe('priority: the judge never waits behind a whole interview (finding 7)', () => {
  it('keeps one slot for high calls, and serves waiting high calls first', async () => {
    const sem = new Semaphore(3);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(sem.tryAcquire('normal')).toBeNull(); // the third slot is not for ordinary calls
    const order: string[] = [];
    const n1 = sem.acquire(undefined, 'normal').then((r) => (order.push('normal'), r));
    const h = await sem.acquire(undefined, 'high'); // at once, in the kept slot
    order.push('high-now');
    const h2 = sem.acquire(undefined, 'high').then((r) => (order.push('high-queued'), r));
    a(); // one slot frees: the queued HIGH call gets it, though the normal one waited longer
    await sleep(5);
    expect(order).toEqual(['high-now', 'high-queued']);
    (await h2)();
    h();
    await sleep(5);
    expect(order).toEqual(['high-now', 'high-queued', 'normal']);
    (await n1)();
    b();
  });

  it('a single slot is shared: nothing is kept back when there is only one', async () => {
    const sem = new Semaphore(1);
    const r = sem.tryAcquire('normal');
    expect(r).not.toBeNull();
    r!();
  });

  it("a call's own time limit starts when its request is sent, not while it waits for a slot", async () => {
    const limiter = new Semaphore(1);
    const busy = await limiter.acquire();
    let started = 0;
    const fetchImpl = (async () => {
      await sleep(20);
      return ok('answer');
    }) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 0, limiter })!;
    const p = chat.complete('s', 'u', { timeoutMs: 60, onStart: () => started++ });
    await sleep(150); // more than the limit, spent waiting
    expect(started).toBe(0);
    busy();
    expect(await p).toBe('answer');
    expect(started).toBe(1);
    expect(chat.queued).toBe(true);
  });

  it('and when it is spent, the call ends as a timeout, without further attempts', async () => {
    let calls = 0;
    const fetchImpl = ((_u: string, init: RequestInit) => {
      calls++;
      return hang(init);
    }) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 0, limiter: new Semaphore(4) })!;
    const t0 = Date.now();
    expect(await kindOf(chat.complete('s', 'u', { timeoutMs: 50 }))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(400);
    expect(calls).toBe(1);
  });
});

describe('duplicates are rationed (finding 8)', () => {
  /** every request takes `ms`; counts requests and duplicates sent */
  const slow = (ms: number) => {
    const log = { requests: 0 };
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        log.requests++;
        let answered = false;
        const t = setTimeout(() => {
          answered = true;
          resolve(ok('x'));
        }, ms);
        init.signal?.addEventListener('abort', () => {
          if (answered) return;
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    return { fetchImpl, log };
  };

  it('a duplicate only goes into a slot that is free: it never queues and never takes the kept slot', async () => {
    const { fetchImpl, log } = slow(120);
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 20, limiter: new Semaphore(3) })!;
    // two slow calls fill both ordinary slots; their duplicates find no free one
    await Promise.all([chat.complete('s', 'a'), chat.complete('s', 'b')]);
    expect(log.requests).toBe(2);
  });

  it("at most a quarter of a client's recent calls are duplicated", async () => {
    const { fetchImpl, log } = slow(60);
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 10, limiter: new Semaphore(8) })!;
    for (let i = 0; i < 8; i++) await chat.complete('s', `call ${i}`);
    const duplicates = log.requests - 8;
    expect(duplicates).toBeGreaterThanOrEqual(1); // a lone slow call is still helped
    expect(duplicates).toBeLessThanOrEqual(2);
  });

  it('a Retry-After of 0 does not remove the backoff', async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () =>
      n++ === 0 ? status(429, { 'retry-after': '0' }) : ok('x')) as unknown as typeof fetch;
    const chat = createNimChat({
      apiKey: 'k',
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
      limiter: new Semaphore(4),
    })!;
    expect(await chat.complete('s', 'u')).toBe('x');
    expect(waits).toEqual([500]); // half the 1 s backoff, not 0
  });
});
