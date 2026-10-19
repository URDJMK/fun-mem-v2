import { describe, expect, it } from 'vitest';
import { ModelError, Semaphore, createNimChat } from '../src/nim';

const ok = (content: string, finish = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), {
    status: 200,
  });
const status = (s: number, headers: Record<string, string> = {}) =>
  new Response('echoed family testimony', { status: s, headers });

/** A scripted fetch: each call returns/throws the next item; records how many calls were made. */
function scripted(items: Array<Response | Error>) {
  const calls: { n: number; bodies: string[] } = { n: 0, bodies: [] };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.bodies.push(String(init.body));
    const item = items[Math.min(calls.n++, items.length - 1)]!;
    if (item instanceof Error) throw item;
    return item.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const client = (items: Array<Response | Error>, extra: object = {}) => {
  const waits: number[] = [];
  const s = scripted(items);
  const chat = createNimChat({
    apiKey: 'k',
    fetchImpl: s.fetchImpl,
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5,
    ...extra,
  })!;
  return { chat, waits, calls: s.calls };
};
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'none';
  } catch (e) {
    return (e as ModelError).kind;
  }
};

describe('the NIM client', () => {
  it('is absent without a key', () => {
    expect(createNimChat({ apiKey: '' })).toBeNull();
  });

  it('asks at 0.2 unless told otherwise, and at 0 for a judgement that should be repeatable', async () => {
    const { chat, calls } = client([ok('a'), ok('b')]);
    await chat.complete('s', 'u');
    await chat.complete('s', 'u', { temperature: 0 });
    expect(JSON.parse(calls.bodies[0]!).temperature).toBe(0.2);
    expect(JSON.parse(calls.bodies[1]!).temperature).toBe(0);
  });

  it('sends thinking OFF, strips reasoning, and returns the text', async () => {
    const { chat, calls } = client([ok('<think>hmm</think>{"memories":[]}')]);
    expect(await chat.complete('s', 'u')).toBe('{"memories":[]}');
    expect(JSON.parse(calls.bodies[0]!)).toMatchObject({
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('retries a rate limit and a server error with growing backoff, then succeeds', async () => {
    const { chat, waits, calls } = client([status(429), status(503), ok('fine')]);
    expect(await chat.complete('s', 'u')).toBe('fine');
    expect(calls.n).toBe(3);
    expect(waits).toEqual([1000, 3000]); // 1s then 3s (jitter is neutral at 0.5)
  });

  it('honours Retry-After, capped', async () => {
    const { chat, waits } = client([
      status(429, { 'retry-after': '2' }),
      status(429, { 'retry-after': '9999' }),
      ok('x'),
    ]);
    await chat.complete('s', 'u');
    expect(waits).toEqual([2000, 20000]);
  });

  it('gives up after the attempts and says WHY, never echoing the body', async () => {
    const { chat, calls } = client([status(500)]);
    let err: ModelError | null = null;
    try {
      await chat.complete('s', 'u');
    } catch (e) {
      err = e as ModelError;
    }
    expect(err).toMatchObject({ kind: 'unavailable', retryable: true, status: 500 });
    expect(err!.message).not.toContain('testimony');
    expect(calls.n).toBe(3);
  });

  it('does not retry a rejected key, and reports it as such', async () => {
    const { chat, calls } = client([status(401)]);
    expect(await kindOf(chat.complete('s', 'u'))).toBe('auth');
    expect(calls.n).toBe(1);
  });

  it('does not retry a request the service refuses', async () => {
    const { chat, calls } = client([status(400)]);
    expect(await kindOf(chat.complete('s', 'u'))).toBe('bad_request');
    expect(calls.n).toBe(1);
  });

  it('retries a dropped connection and a timeout', async () => {
    const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const slow = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { chat, calls } = client([dropped, slow, ok('back')]);
    expect(await chat.complete('s', 'u')).toBe('back');
    expect(calls.n).toBe(3);
    expect(await kindOf(client([slow], { attempts: 1 }).chat.complete('s', 'u'))).toBe('timeout');
  });

  it('detects output cut off by the token limit, and does not retry it', async () => {
    const { chat, calls } = client([ok('{"memories":[{"turns":[1', 'length')]);
    expect(await kindOf(chat.complete('s', 'u'))).toBe('truncated');
    expect(calls.n).toBe(1);
  });

  it('an answer with no content is retried, then reported', async () => {
    const empty = new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });
    const { chat, calls } = client([empty]);
    expect(await kindOf(chat.complete('s', 'u'))).toBe('bad_output');
    expect(calls.n).toBe(3);
  });

  it('cancellation stops everything, before and during a call', async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(await kindOf(client([ok('x')]).chat.complete('s', 'u', { signal: ctl.signal }))).toBe(
      'cancelled',
    );

    const during = new AbortController();
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        ),
      )) as unknown as typeof fetch;
    const chat = createNimChat({ apiKey: 'k', fetchImpl: hang, sleep: async () => undefined })!;
    const p = chat.complete('s', 'u', { signal: during.signal });
    setTimeout(() => during.abort(), 10);
    expect(await kindOf(p)).toBe('cancelled');
  });

  it('never has more requests in flight than the limit, and queues the rest in order', async () => {
    let inFlight = 0,
      peak = 0;
    const order: number[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const n = JSON.parse(String(init.body)).messages[1].content as number;
      inFlight++;
      peak = Math.max(peak, inFlight);
      order.push(n);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return ok('done');
    }) as unknown as typeof fetch;
    // three slots: ordinary calls may use two; the third is kept for a 'high' call (the judge)
    const chat = createNimChat({ apiKey: 'k', fetchImpl, limiter: new Semaphore(3) })!;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => chat.complete('s', i as unknown as string)),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a request cancelled while waiting for a slot does not leak the slot', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ctl = new AbortController();
    const waiting = sem.acquire(ctl.signal);
    ctl.abort();
    await expect(waiting).rejects.toBeInstanceOf(ModelError);
    release();
    const again = await sem.acquire(); // would hang if the slot had leaked
    again();
  });
});

describe('a slow call is hedged with one duplicate', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** a fetch whose Nth call takes `delays[N]` ms (or never answers when null), and notes which were cancelled */
  function timed(delays: Array<number | null>, text = 'ok') {
    const log = { calls: 0, aborted: [] as number[] };
    const fetchImpl = ((_url: string, init: RequestInit) => {
      const n = log.calls++;
      const delay = delays[Math.min(n, delays.length - 1)];
      return new Promise<Response>((resolve, reject) => {
        let answered = false;
        const t =
          delay === null
            ? undefined
            : setTimeout(() => {
                answered = true;
                resolve(ok(`${text}${n}`));
              }, delay);
        init.signal?.addEventListener('abort', () => {
          if (answered) return; // aborting a finished request does nothing, as with a real fetch
          clearTimeout(t);
          log.aborted.push(n);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, log };
  }

  it('a call that never answers is answered by the duplicate, and the first is cancelled', async () => {
    const { fetchImpl, log } = timed([null, 10]);
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 40, limiter: new Semaphore(4) })!;
    const t0 = Date.now();
    expect(await chat.complete('s', 'u')).toBe('ok1');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(log.calls).toBe(2);
    expect(log.aborted).toEqual([0]);
  });

  it('a call that answers in time is never duplicated', async () => {
    const { fetchImpl, log } = timed([10]);
    const chat = createNimChat({
      apiKey: 'k',
      fetchImpl,
      hedgeMs: 200,
      limiter: new Semaphore(4),
    })!;
    expect(await chat.complete('s', 'u')).toBe('ok0');
    await sleep(260); // past the hedge time: no timer is left behind to send one
    expect(log.calls).toBe(1);
  });

  it('whichever answers first wins, even when it is the original', async () => {
    const { fetchImpl, log } = timed([120, 400]);
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 30, limiter: new Semaphore(4) })!;
    expect(await chat.complete('s', 'u')).toBe('ok0');
    expect(log.calls).toBe(2);
    expect(log.aborted).toEqual([1]);
  });

  it('the clock starts when the request starts, not while it waits for a free slot', async () => {
    const limiter = new Semaphore(1);
    const busy = await limiter.acquire(); // the only slot is taken
    const { fetchImpl, log } = timed([10]);
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 30, limiter })!;
    const p = chat.complete('s', 'u');
    await sleep(120); // longer than the hedge time, spent waiting
    busy();
    expect(await p).toBe('ok0');
    expect(log.calls).toBe(1);
  });

  it('is off at 0, and a failing call is retried as before, not hedged', async () => {
    const off = timed([60]);
    const a = createNimChat({
      apiKey: 'k',
      fetchImpl: off.fetchImpl,
      hedgeMs: 0,
      limiter: new Semaphore(4),
    })!;
    await a.complete('s', 'u');
    expect(off.log.calls).toBe(1);

    const { chat, calls } = client([status(503), ok('fine')], { hedgeMs: 5_000 });
    expect(await chat.complete('s', 'u')).toBe('fine');
    expect(calls.n).toBe(2);
  });

  it('the caller cancelling cancels both', async () => {
    const { fetchImpl, log } = timed([null, null]);
    const chat = createNimChat({ apiKey: 'k', fetchImpl, hedgeMs: 20, limiter: new Semaphore(4) })!;
    const ac = new AbortController();
    const p = chat.complete('s', 'u', { signal: ac.signal });
    await sleep(60);
    ac.abort();
    expect(await kindOf(p)).toBe('cancelled');
    expect(log.aborted.sort()).toEqual([0, 1]);
  });
});
