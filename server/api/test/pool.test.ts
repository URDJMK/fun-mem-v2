import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/pool';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapPool', () => {
  it('keeps the order of the items, whatever order they finish in', async () => {
    const out = await mapPool([30, 5, 20, 1, 10], 3, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10']);
  });

  it('never runs more than the limit at once, and starts the next the moment one is free', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const t0 = Date.now();
    // one slow item (120 ms) and five quick ones (20 ms): batch-by-batch would take ~240 ms
    await mapPool([120, 20, 20, 20, 20, 20], 2, async (ms, i) => {
      started.push(Date.now() - t0);
      running++;
      peak = Math.max(peak, running);
      await sleep(ms);
      running--;
      return i;
    });
    expect(peak).toBe(2);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(started).toHaveLength(6);
  });

  it('handles nothing, one item, and a silly limit', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    expect(await mapPool([7], 0, async (x) => x * 2)).toEqual([14]);
    expect(await mapPool([1, 2, 3], -5, async (x) => x)).toEqual([1, 2, 3]);
  });

  it('a limit that is not a number still runs every item (it returned holes, running nothing)', async () => {
    const ran: number[] = [];
    expect(await mapPool([1, 2, 3], Number.NaN, async (x) => (ran.push(x), x * 10))).toEqual([
      10, 20, 30,
    ]);
    expect(ran).toEqual([1, 2, 3]);
    expect(await mapPool([1, 2], 2.7, async (x) => x)).toEqual([1, 2]);
  });

  it('a failure is thrown, no new item is started after it, and the running ones are waited for', async () => {
    const started: number[] = [];
    let finished = 0;
    await expect(
      mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
        started.push(x);
        if (x === 2) throw new Error('boom');
        await sleep(30);
        finished++;
        return x;
      }),
    ).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6);
    expect(finished).toBe(started.filter((x) => x !== 2).length); // nothing left running behind it
  });

  it('`before` can refuse to start more work', async () => {
    let n = 0;
    await expect(
      mapPool(
        [1, 2, 3, 4],
        1,
        async (x) => x,
        () => {
          if (++n > 2) throw new Error('out of time');
        },
      ),
    ).rejects.toThrow('out of time');
  });
});
