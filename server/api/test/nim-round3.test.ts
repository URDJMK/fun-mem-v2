import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/nim';

/** Round-3 regressions for the model client (review round3/reports/C-conflicts.md F7). */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('N-F7: a judge call never waits while a slot is free', () => {
  it('ordinary calls at their full share, one more queued and old: the judge still gets the kept slot at once', async () => {
    const sem = new Semaphore(4, { ageMs: 50 });
    const running = [
      await sem.acquire(undefined, 'normal'),
      await sem.acquire(undefined, 'normal'),
      await sem.acquire(undefined, 'normal'),
    ];
    let fourth = false;
    const queued = sem.acquire(undefined, 'normal').then((r) => ((fourth = true), r));
    await sleep(120); // older than ageMs: round 2 then refused the free slot to 'high'
    expect(fourth).toBe(false); // waiting behind other ordinary calls is not starving
    expect(sem.free).toBe(1);
    const t0 = Date.now();
    const judge = await Promise.race([sem.acquire(undefined, 'high'), sleep(500).then(() => null)]);
    expect(judge).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);
    judge!();
    // and the duplicate a slow judge call sends (tryAcquire) is not refused a free slot either
    const hedge = sem.tryAcquire('high');
    expect(hedge).not.toBeNull();
    hedge!();
    running[0]!();
    (await queued)();
    running.slice(1).forEach((r) => r());
  });

  it('a starved ordinary call (held back by judge calls) takes a slot that is free, without waiting for a release', async () => {
    const sem = new Semaphore(2, { ageMs: 50 });
    const a = await sem.acquire(undefined, 'high'); // the only ordinary-usable slot is busy with a judge
    let got = false;
    const normal = sem.acquire(undefined, 'normal').then((r) => ((got = true), r));
    await sleep(120);
    // nothing was released, but it has starved: it is handed the free (kept) slot
    expect(got).toBe(true);
    (await normal)();
    a();
  });
});
