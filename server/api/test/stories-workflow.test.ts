import { describe, expect, it } from 'vitest';
import { IngestCancelled } from '../src/ingest-pipeline';
import { ModelError, type ChatModel } from '../src/nim';
import { PLAN_SYSTEM } from '../src/stories/plan';
import { writeStories } from '../src/stories/workflow';
import { WRITE_SYSTEM } from '../src/stories/write';
import { parseTranscript } from '../src/transcript';

/**
 * The whole story workflow with a scripted model: plan, write, check, judge, fix, assemble.
 * The model is routed by which step's instructions it was given.
 */
const TRANSCRIPT = [
  'Interviewer: Hello, can you hear me all right?',
  'Sunja: Yes, I can hear you.',
  'Interviewer: Where were you born?',
  'Sunja: I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six.',
  'Interviewer: Tell me about your father.',
  'Sunja: My father repaired boats. On Sundays he took me to the pier and we watched the ships.',
  'Interviewer: When did you meet your husband?',
  'Sunja: I met Minho in nineteen sixty-six, at a church supper. He spilled gravy all over his shirt, and I laughed.',
].join('\n');
const parsed = () => parseTranscript(TRANSCRIPT);
const OPTS = { interviewees: ['Sunja'] };
const noLookup = { search: async () => [], read: async () => null };

const PLAN = {
  interviewName: 'Sunja on Busan and Minho',
  stories: [
    { title: 'The harbour where she was born', lines: ['L3-L6'], tellers: ['Sunja'] },
    { title: 'Gravy at the church supper', lines: ['L7-L8'], tellers: ['Sunja'] },
  ],
};
const sentence = (text: string, cites: string[], paragraph = false) => ({ text, cites, paragraph });
const HARBOUR = {
  title: 'The harbour where she was born',
  occurred: '~1946',
  sentences: [
    sentence(
      'Sunja was born in Busan, in a small house by the harbour, probably in 1946.',
      ['L4'],
      true,
    ),
    sentence('Her father repaired boats.', ['L6'], true),
    sentence('On Sundays he took her to the pier to watch the ships.', ['L6']),
  ],
};
const GRAVY = {
  title: 'Gravy at the church supper',
  occurred: '1966',
  sentences: [
    sentence('Sunja met Minho at a church supper in 1966.', ['L8'], true),
    sentence('He spilled gravy all over his shirt, and she laughed.', ['L8']),
  ],
};
const allSupported = (user: string) => {
  const n = (user.match(/^\d+\. /gm) ?? []).length;
  return { rulings: Array.from({ length: n }, (_, i) => ({ sentence: i, verdict: 'supported' })) };
};

type Step = 'plan' | 'write' | 'judge';
const stepOf = (system: string): Step =>
  system.startsWith(PLAN_SYSTEM) ? 'plan' : system.startsWith(WRITE_SYSTEM) ? 'write' : 'judge';

/** a model answering each step by a function; it records every call */
function model(
  answer: (step: Step, user: string, n: number) => unknown,
  delayMs = 0,
): ChatModel & { calls: Array<{ step: Step; user: string }> } {
  const calls: Array<{ step: Step; user: string }> = [];
  return {
    id: 'scripted',
    calls,
    complete: async (system, user, opts) => {
      const step = stepOf(system);
      calls.push({ step, user });
      if (delayMs) {
        await new Promise((r, reject) => {
          const t = setTimeout(r, delayMs);
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new ModelError('cancelled', 'cancelled', false));
          });
        });
      }
      const out = answer(step, user, calls.filter((c) => c.step === step).length);
      if (out instanceof Error) throw out;
      return JSON.stringify({ result: out });
    },
  };
}
const happy = (step: Step, user: string) =>
  step === 'plan'
    ? PLAN
    : step === 'judge'
      ? allSupported(user)
      : user.includes('Working title: Gravy')
        ? GRAVY
        : HARBOUR;

describe('writeStories', () => {
  it('turns an interview into whole stories, each sentence cited, with its metadata', async () => {
    const chat = model(happy);
    const out = await writeStories(parsed(), OPTS, { chat, lookup: noLookup, titles: [] });
    expect(out.pending).toBeUndefined();
    expect(out.interviewName).toBe('Sunja on Busan and Minho');
    expect(out.memories.map((m) => [m.title, m.method, m.type, m.occurred])).toEqual([
      ['The harbour where she was born', 'story', 'event', '~1946'],
      ['Gravy at the church supper', 'story', 'event', '1966'],
    ]);
    const [harbour] = out.memories;
    expect(harbour!.body).toBe(
      'Sunja was born in Busan, in a small house by the harbour, probably in 1946.\n\n' +
        'Her father repaired boats. On Sundays he took her to the pier to watch the ships.\n\n' +
        '> Told by Sunja, “Sunja on Busan and Minho”',
    );
    expect(harbour!.tellers).toEqual(['Sunja']);
    expect(harbour!.sources![0]).toMatchObject({
      sentence: 'Sunja was born in Busan, in a small house by the harbour, probably in 1946.',
      from: 4,
      to: 4,
    });
    expect(harbour!.sources![0]!.text).toContain('Busan');
    expect(harbour!.writtenBy).toEqual({
      workflow: 'stories-1',
      writer: 'scripted',
      judge: 'scripted',
    });
    expect(harbour!.speakerName).toBe('Sunja');
    // greetings are in no story
    expect(out.memories.some((m) => /hear you/.test(m.body))).toBe(false);
    expect(out.stats.stories).toMatchObject({
      planned: 2,
      written: 2,
      dropped: 0,
      firstPass: 2,
      removed: 0,
    });
    expect(chat.calls.map((c) => c.step)).toEqual(['plan', 'write', 'write', 'judge', 'judge']);
  });

  it('a made-up place is sent back with the reason, and the story is fixed', async () => {
    const chat = model((step, user) => {
      if (
        step === 'write' &&
        user.includes('Working title: The harbour') &&
        !user.includes('Problems found')
      ) {
        return {
          ...HARBOUR,
          sentences: [
            sentence('Sunja was born in Seoul.', ['L4'], true),
            ...HARBOUR.sentences.slice(1),
          ],
        };
      }
      return happy(step, user);
    });
    const out = await writeStories(parsed(), OPTS, { chat, lookup: noLookup, titles: [] });
    expect(out.memories[0]!.body).toContain('born in Busan');
    const retry = chat.calls.find((c) => c.step === 'write' && c.user.includes('Problems found'));
    expect(retry!.user).toContain('the cited lines do not name Seoul');
    expect(out.stats.stories).toMatchObject({ written: 2, firstPass: 1 });
  });

  it('a sentence the judge keeps failing is left out, and the reviewer is told', async () => {
    const withWedding = {
      ...GRAVY,
      sentences: [...GRAVY.sentences, sentence('They married the next spring.', ['L8'])],
    };
    const chat = model((step, user) => {
      if (step === 'write') return user.includes('Working title: Gravy') ? withWedding : HARBOUR;
      if (step === 'judge' && user.includes('married')) {
        return {
          rulings: [
            { sentence: 0, verdict: 'supported' },
            { sentence: 1, verdict: 'supported' },
            { sentence: 2, verdict: 'made_up', reason: 'no wedding is told' },
          ],
        };
      }
      return happy(step, user);
    });
    const out = await writeStories(parsed(), OPTS, { chat, lookup: noLookup, titles: [] });
    const gravy = out.memories.find((m) => m.title === 'Gravy at the church supper')!;
    expect(gravy.body).not.toContain('married');
    expect(gravy.notes.join(' ')).toContain('They married the next spring.');
    expect(out.stats.stories).toMatchObject({ written: 2, removed: 1 });
  });

  it('a story left with a single sentence is not kept', async () => {
    const chat = model((step, user) => {
      if (step === 'judge' && user.includes('He spilled gravy')) {
        return {
          rulings: [
            { sentence: 0, verdict: 'supported' },
            { sentence: 1, verdict: 'made_up', reason: 'x' },
          ],
        };
      }
      return happy(step, user);
    });
    const out = await writeStories(parsed(), OPTS, { chat, lookup: noLookup, titles: [] });
    expect(out.memories.map((m) => m.title)).toEqual(['The harbour where she was born']);
    expect(out.stats.stories).toMatchObject({ planned: 2, written: 1, dropped: 1 });
  });

  it('gives the time in the recording, once when a story is a single moment', async () => {
    const timed = parseTranscript(
      [
        '[00:03] Interviewer: Where were you born?',
        '[00:05] Sunja: I was born in Busan, in a little house near the harbour. My father repaired boats.',
      ].join('\n'),
    );
    const chat = model((step, user) =>
      step === 'plan'
        ? { stories: [{ title: 'The harbour', lines: ['L1-L2'], tellers: ['Sunja'] }] }
        : step === 'judge'
          ? allSupported(user)
          : {
              title: 'The harbour',
              sentences: [
                sentence('Sunja was born in Busan, near the harbour.', ['L2'], true),
                sentence('Her father repaired boats.', ['L2']),
              ],
            },
    );
    const out = await writeStories(timed, OPTS, {
      chat,
      lookup: noLookup,
      titles: [],
      interviewName: 'Talk',
    });
    expect(out.memories[0]!.body).toMatch(
      /> Told by Sunja, “Talk”, 0:03–0:05$|> Told by Sunja, “Talk”, 0:05$/,
    );
    expect(out.memories[0]!.body).not.toMatch(/(\d:\d\d)–\1$/);
  });

  it('with no AI, the stories wait, and nothing is chopped into fragments', async () => {
    const out = await writeStories(parsed(), OPTS, { chat: null, lookup: noLookup, titles: [] });
    expect(out.pending).toEqual({ reason: 'no_model' });
    expect(out.memories).toEqual([]);
    expect(out.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a rejected key stops everything at once', async () => {
    const chat = model(
      () => new ModelError('the AI service answered HTTP 403', 'auth', false, 403),
    );
    const out = await writeStories(parsed(), OPTS, { chat, lookup: noLookup, titles: [] });
    expect(out.pending).toEqual({ reason: 'auth' });
    expect(chat.calls).toHaveLength(1);
  });

  it('runs out of time without throwing', async () => {
    const chat = model(happy, 50);
    const out = await writeStories(parsed(), OPTS, {
      chat,
      lookup: noLookup,
      titles: [],
      deadlineMs: 5,
    });
    expect(out.pending).toEqual({ reason: 'deadline' });
    expect(out.memories).toEqual([]);
  });

  it('a cancelled import stops as cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      writeStories(parsed(), OPTS, {
        chat: model(happy),
        lookup: noLookup,
        titles: [],
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(IngestCancelled);
  });

  it('reads a long interview in parts, and a story may carry on across them', async () => {
    const chat = model((step, user, n) => {
      if (step === 'plan') {
        return n === 1
          ? {
              stories: [
                { title: 'The harbour where she was born', lines: ['L3-L4'], tellers: ['Sunja'] },
              ],
            }
          : {
              stories: [
                {
                  title: 'More of the harbour',
                  lines: ['L5-L6'],
                  tellers: ['Sunja'],
                  continues: 'The harbour where she was born',
                },
              ],
            };
      }
      return happy(step, user);
    });
    const out = await writeStories(parse6(), OPTS, {
      chat,
      lookup: noLookup,
      titles: [],
      contextTokens: 40,
    });
    expect(chat.calls.filter((c) => c.step === 'plan').length).toBeGreaterThanOrEqual(2);
    expect(out.memories).toHaveLength(1);
    const write = chat.calls.find((c) => c.step === 'write')!;
    expect(write.user).toContain('L4 Sunja');
    expect(write.user).toContain('L6 Sunja');
  });
});

/** the first six lines only: two parts at a 40-token budget */
const parse6 = () => parseTranscript(TRANSCRIPT.split('\n').slice(0, 6).join('\n'));
