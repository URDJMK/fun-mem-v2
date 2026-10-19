import { describe, expect, it } from 'vitest';
import { findConflicts, type ConflictReport } from '../src/conflicts';
import type { ChatModel } from '../src/nim';

/**
 * The centrepiece of the demo is one judge call: "I was born in Busan, I think it was 1946" against the note
 * "Sunja was born in Daegu in 1952". Ten identical real calls at once: eight answered in 1.5-9 s, two hung
 * until the 25 s limit and the disagreement went unmarked (round-2 live check). A duplicate sent when the
 * first call fails or stays silent rescues what waiting cannot; a healthy call is never doubled.
 */
const seed = {
  id: 'seed-1',
  title: 'Sunja Kim',
  text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
  teller: null,
  voice: 'author:someone',
};
const retrieve = Object.assign(async () => [seed], { voice: 'author:someone' });
const claim =
  'I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.';
const ANSWER = JSON.stringify({
  conflicts: [{ note: 'Sunja Kim', about: 'place and year of birth', existing: seed.text }],
});

/** a model whose n-th call is scripted: 'hang' (until aborted), 'fail', or the reply itself */
function scripted(plan: string[]) {
  const seen = { calls: 0, aborted: [] as boolean[] };
  const model: ChatModel = {
    id: 'scripted',
    complete: (_system, _user, o) => {
      const step = plan[Math.min(seen.calls, plan.length - 1)]!;
      const mine = seen.calls++;
      seen.aborted[mine] = false;
      return new Promise<string>((resolve, reject) => {
        if (step === 'fail') return reject(new Error('503'));
        if (step === 'hang') {
          o?.signal?.addEventListener('abort', () => {
            seen.aborted[mine] = true;
            reject(new Error('aborted'));
          });
          return;
        }
        resolve(step);
      });
    },
  };
  return { model, seen };
}

const ask = async (model: ChatModel, hedgeMs: number, signal?: AbortSignal) => {
  const report: ConflictReport = { incomplete: false };
  const t0 = Date.now();
  const found = await findConflicts(
    {
      retrieve: retrieve as never,
      judge: model,
      subject: 'Grandma Sunja',
      report,
      signal,
      budget: { left: 3, hedgeMs, timeoutMs: 5_000 },
    },
    [claim],
  );
  return { found, report, ms: Date.now() - t0 };
};

describe('a slow or failing judge call is rescued by one duplicate', () => {
  it('a call that hangs: the duplicate answers, the hung call is cancelled', async () => {
    const { model, seen } = scripted(['hang', ANSWER]);
    const r = await ask(model, 60);
    expect(r.found).toHaveLength(1);
    expect(r.found[0]!.source?.title).toBe('Sunja Kim');
    expect(seen.calls).toBe(2);
    expect(seen.aborted[0]).toBe(true);
    expect(r.ms).toBeLessThan(2_000);
    expect(r.report.judgeFailed).toBeUndefined();
  });

  it('a call that fails at once: the second goes at once, not after the wait', async () => {
    const { model, seen } = scripted(['fail', ANSWER]);
    const r = await ask(model, 4_000);
    expect(r.found).toHaveLength(1);
    expect(seen.calls).toBe(2);
    expect(r.ms).toBeLessThan(1_500);
  });

  it('both calls failing is one failed judge, counted, and nothing is marked', async () => {
    const { model, seen } = scripted(['fail', 'fail']);
    const r = await ask(model, 30);
    expect(r.found).toHaveLength(0);
    expect(seen.calls).toBe(2);
    expect(r.report.judgeFailed).toBe(1);
  });

  it('a healthy call is never doubled', async () => {
    const { model, seen } = scripted([ANSWER]);
    const r = await ask(model, 300);
    expect(r.found).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 450));
    expect(seen.calls).toBe(1);
  });

  it('a cancel stops the duplicate from being sent', async () => {
    const { model, seen } = scripted(['hang', ANSWER]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);
    const r = await ask(model, 120, stop.signal);
    await new Promise((res) => setTimeout(res, 300));
    expect(r.found).toHaveLength(0);
    expect(seen.calls).toBe(1);
    expect(r.report.incomplete).toBe(true);
  });
});
