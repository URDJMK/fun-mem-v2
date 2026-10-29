import { describe, expect, it } from 'vitest';
import { IngestCancelled } from '../src/ingest-pipeline';
import { ModelError, type ChatModel } from '../src/nim';
import { FIND_SYSTEM } from '../src/graph/find';
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
const SUNJA_PROFILE = {
  noteId: 'n1',
  name: 'Sunja Kim',
  born: '~1946',
  died: null,
  aliases: ['Grandma Sunja', 'Sunja'],
};

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

type Step = 'plan' | 'write' | 'judge' | 'find';
const stepOf = (system: string): Step =>
  system.startsWith(PLAN_SYSTEM)
    ? 'plan'
    : system.startsWith(WRITE_SYSTEM)
      ? 'write'
      : system.startsWith(FIND_SYSTEM)
        ? 'find'
        : 'judge';

/** a model answering each step by a function, after a delay (per step, if a function); it records every call */
function model(
  answer: (step: Step, user: string, n: number) => unknown,
  delay: number | ((step: Step) => number) = 0,
): ChatModel & { calls: Array<{ step: Step; user: string }> } {
  const calls: Array<{ step: Step; user: string }> = [];
  return {
    id: 'scripted',
    calls,
    complete: async (system, user, opts) => {
      const step = stepOf(system);
      calls.push({ step, user });
      const delayMs = typeof delay === 'number' ? delay : delay(step);
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

  it('the profile goes with every step, and a fact from it may be cited', async () => {
    const seen: Record<string, string[]> = { plan: [], write: [], judge: [] };
    const chat = model((step, user) => {
      seen[step]!.push(user);
      if (step === 'write' && user.includes('Working title: The harbour')) {
        return {
          ...HARBOUR,
          sentences: [...HARBOUR.sentences, sentence('Her family calls her Grandma Sunja.', ['P'])],
        };
      }
      return happy(step, user);
    });
    const out = await writeStories(parsed(), OPTS, {
      chat,
      lookup: noLookup,
      titles: [],
      profiles: [SUNJA_PROFILE],
    });
    for (const step of ['plan', 'write', 'judge']) {
      expect(seen[step]![0]).toContain(
        'Who this is about:\n- Sunja Kim (called "Grandma Sunja", "Sunja"). Born about 1946.',
      );
    }
    const harbour = out.memories.find((m) => m.title === 'The harbour where she was born')!;
    expect(harbour.body).toContain('Her family calls her Grandma Sunja.');
    expect(harbour.sources!.at(-1)).toMatchObject({ from: 0, to: 0 });
    expect(harbour.sources!.at(-1)!.text).toContain('Grandma Sunja');
    expect(out.stats.stories!.removed).toBe(0);
  });

  it('an age said in the interview becomes a year, from the profile', async () => {
    const factory = parseTranscript(
      [
        'Interviewer: What happened after you left school?',
        'Sunja: At eighteen I started at a textile factory, and I gave my whole pay to my mother.',
        'Interviewer: And after that?',
        'Sunja: She put a little aside for me in a tin, every month.',
      ].join('\n'),
    );
    const ask = (age: { years: number; cites: string[] }) =>
      model((step, user) =>
        step === 'plan'
          ? { stories: [{ title: 'The tin of savings', lines: ['L1-L4'], tellers: ['Sunja'] }] }
          : step === 'judge'
            ? allSupported(user)
            : {
                title: 'The tin of savings',
                occurred: null,
                age,
                sentences: [
                  sentence('At eighteen Sunja started work at a textile factory.', ['L2'], true),
                  sentence('Her mother put a little aside for her in a tin every month.', ['L4']),
                ],
              },
      );
    const deps = { lookup: noLookup, titles: [], profiles: [SUNJA_PROFILE] };
    const said = await writeStories(factory, OPTS, {
      ...deps,
      chat: ask({ years: 18, cites: ['L2'] }),
    });
    expect(said.memories[0]).toMatchObject({
      occurred: '~1964',
      dateBasis: 'Sunja Kim was 18; born about 1946',
    });
    // an age the cited lines do not say is not used
    const unsaid = await writeStories(factory, OPTS, {
      ...deps,
      chat: ask({ years: 30, cites: ['L4'] }),
    });
    expect(unsaid.memories[0]!.occurred).toBeNull();
    expect(unsaid.memories[0]!.dateBasis).toBeUndefined();
    // without a birth date there is no year to work out
    const noBirth = await writeStories(factory, OPTS, {
      ...deps,
      profiles: [{ ...SUNJA_PROFILE, born: null }],
      chat: ask({ years: 18, cites: ['L2'] }),
    });
    expect(noBirth.memories[0]!.occurred).toBeNull();
  });

  it('a year the writer worked out from an age said in the lines is kept, and says so', async () => {
    const factory = parseTranscript(
      [
        'Interviewer: What happened after you left school?',
        'Sunja: At eighteen I started at a textile factory, and I gave my whole pay to my mother.',
        'Interviewer: And after that?',
        'Sunja: She put a little aside for me in a tin, every month.',
      ].join('\n'),
    );
    // the model does the sum itself and gives a year, not the age
    const dated = (occurred: string) =>
      model((step, user) =>
        step === 'plan'
          ? { stories: [{ title: 'The tin of savings', lines: ['L1-L4'], tellers: ['Sunja'] }] }
          : step === 'judge'
            ? allSupported(user)
            : {
                title: 'The tin of savings',
                occurred,
                sentences: [
                  sentence('At eighteen Sunja started work at a textile factory.', ['L2'], true),
                  sentence('Her mother put a little aside for her in a tin every month.', ['L4']),
                ],
              },
      );
    const deps = { lookup: noLookup, titles: [], profiles: [SUNJA_PROFILE] };
    const worked = await writeStories(factory, OPTS, { ...deps, chat: dated('~1964') });
    expect(worked.memories[0]).toMatchObject({
      occurred: '~1964',
      dateBasis: 'Sunja Kim was 18; born about 1946',
    });
    // a year that is not born + an age said is still dropped
    const guessed = await writeStories(factory, OPTS, { ...deps, chat: dated('1970') });
    expect(guessed.memories[0]!.occurred).toBeNull();
    expect(guessed.memories[0]!.dateBasis).toBeUndefined();
  });

  it('an age found in one draft is kept when the story is written again', async () => {
    const factory = parseTranscript(
      [
        'Interviewer: What happened after you left school?',
        'Sunja: At eighteen I started at a textile factory, and I gave my whole pay to my mother.',
        'Interviewer: And after that?',
        'Sunja: She put a little aside for me in a tin, every month.',
      ].join('\n'),
    );
    const told = [
      sentence('At eighteen Sunja started work at a textile factory.', ['L2'], true),
      sentence('Her mother put a little aside for her in a tin every month.', ['L4']),
    ];
    let writes = 0;
    const chat = model((step, user) => {
      if (step === 'plan')
        return { stories: [{ title: 'The tin of savings', lines: ['L1-L4'], tellers: ['Sunja'] }] };
      if (step === 'write') {
        writes++;
        // first: a year worked out, and a sentence the judge fails; then: neither
        return writes === 1
          ? {
              title: 'The tin of savings',
              occurred: '~1964',
              sentences: [...told, sentence('She bought a radio with it.', ['L4'])],
            }
          : { title: 'The tin of savings', occurred: null, sentences: told };
      }
      return user.includes('radio')
        ? {
            rulings: [
              { sentence: 0, verdict: 'supported' },
              { sentence: 1, verdict: 'supported' },
              { sentence: 2, verdict: 'made_up', reason: 'no radio is told' },
            ],
          }
        : allSupported(user);
    });
    const out = await writeStories(factory, OPTS, {
      chat,
      lookup: noLookup,
      titles: [],
      profiles: [SUNJA_PROFILE],
    });
    expect(writes).toBe(2);
    // the writer is shown the age it is asked to keep
    expect(chat.calls.filter((c) => c.step === 'write')[1]!.user).toContain('Age: 18');
    expect(out.memories[0]).toMatchObject({
      occurred: '~1964',
      dateBasis: 'Sunja Kim was 18; born about 1946',
    });
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

describe('people, places and things, found before the stories (entity design 3)', () => {
  const SUNJA_ENTITY = {
    id: 'k-sunja',
    name: 'Sunja Kim',
    type: 'person' as const,
    aliases: ['Sunja'],
    subject: true,
    note: { noteId: 'n1', title: 'Sunja Kim' },
  };
  const graphDeps = {
    lookup: { find: async () => [], read: async () => null },
    known: [SUNJA_ENTITY],
  };
  const FOUND = {
    entities: [
      { ref: 'e1', name: 'Sunja Kim', type: 'person', match: 'k-sunja', ways: [], description: [] },
      {
        ref: 'e2',
        name: 'Minho',
        type: 'person',
        match: 'new',
        ways: ['her husband'],
        description: [{ text: 'Minho spilled gravy all over his shirt.', cites: ['L8'] }],
      },
      {
        ref: 'e3',
        name: 'Busan',
        type: 'place',
        match: 'new',
        ways: [],
        description: [{ text: 'Sunja was born in Busan.', cites: ['L4'] }],
      },
    ],
    relationships: [
      { a: 'e2', b: 'e1', description: 'Minho — met Sunja at a church supper', cites: ['L8'] },
      { a: 'e3', b: 'e1', description: 'Busan — where Sunja was born', cites: ['L4'] },
      // a line no story uses
      { a: 'e2', b: 'e3', description: 'Minho — heard Sunja in Busan', cites: ['L2'] },
    ],
  };
  const named = <T extends { sentences: Array<Record<string, unknown>> }>(
    draft: T,
    names: Array<{ e: string; words: string }>,
  ): T => ({
    ...draft,
    sentences: [{ ...draft.sentences[0]!, names }, ...draft.sentences.slice(1)],
  });
  // the writer marks Minho, and the narrator (whom it should not); and "a small house" as Busan
  const MARKED_GRAVY = named(GRAVY, [
    { e: 'e2', words: 'Minho' },
    { e: 'e1', words: 'Sunja' },
  ]);
  const MARKED_HARBOUR = named(HARBOUR, [{ e: 'e3', words: 'a small house' }]);
  const listed = (step: Step, user: string) =>
    step === 'find'
      ? FOUND
      : step === 'write'
        ? user.includes('Working title: Gravy')
          ? MARKED_GRAVY
          : MARKED_HARBOUR
        : happy(step, user);
  const run = (chat: ChatModel, more: Partial<Parameters<typeof writeStories>[2]> = {}) =>
    writeStories(parsed(), OPTS, {
      chat,
      lookup: noLookup,
      titles: [],
      graph: graphDeps,
      ...more,
    });

  it('finds them before any story is planned, once per part', async () => {
    const one = model(listed);
    await run(one);
    expect(one.calls[0]!.step).toBe('find');
    expect(one.calls.filter((c) => c.step === 'find')).toHaveLength(1);

    const long = model(listed);
    await writeStories(parse6(), OPTS, {
      chat: long,
      lookup: noLookup,
      titles: [],
      graph: graphDeps,
      contextTokens: 40,
    });
    const steps = long.calls.map((c) => c.step);
    const plans = steps.filter((s) => s === 'plan').length;
    expect(plans).toBeGreaterThanOrEqual(2);
    expect(steps.filter((s) => s === 'find')).toHaveLength(plans);
    expect(steps.lastIndexOf('find')).toBeLessThan(steps.indexOf('plan'));
  });

  it('the planner and the writer are given the list, without the person it is about', async () => {
    const chat = model(listed);
    await run(chat);
    const plan = chat.calls.find((c) => c.step === 'plan')!.user;
    expect(plan).toContain('Who is in it:\nMinho (person)\nBusan (place)');
    const write = chat.calls.find((c) => c.step === 'write')!.user;
    expect(write).toContain(
      'People, places and things in this interview:\ne2  Minho (person): her husband\ne3  Busan (place)',
    );
    for (const user of [plan, write]) expect(user).not.toContain('Sunja Kim (person)');
  });

  it('a story links the first time it names each one, never the person it is about', async () => {
    const out = await run(model(listed));
    const [harbour, gravy] = out.memories;
    expect(gravy!.body.match(/\[\[Minho\]\]/g)).toHaveLength(1);
    expect(gravy!.body).not.toContain('[[Sunja');
    // the writer did not mark Busan: its name is found in the sentence
    expect(harbour!.body).toContain('Sunja was born in [[Busan]], in a small house');
    expect(harbour!.body).not.toContain('small house]]');
    expect(out.stats.stories!.problems!.mark).toBe(1);
    // the checks and the judge read the sentences without links, and the sources keep them so
    expect(harbour!.sources![0]!.sentence).not.toContain('[[');
  });

  it('each name is a mention of its story, and a relationship belongs to the story telling it', async () => {
    const out = await run(model(listed));
    expect(out.memories.map((m) => m.id)).toEqual(['m1', 'm2']);
    const g = out.graph!;
    expect(g.pending).toBeUndefined();
    const of = (name: string) => g.entities.find((e) => e.name === name)!;
    expect(of('Minho').mentions).toEqual([
      {
        story: 'm2',
        words: ['Minho'],
        line: 'Sunja met Minho at a church supper in 1966.',
        sources: [{ interviewId: null, from: 8, to: 8 }],
      },
    ]);
    expect(of('Busan').mentions).toEqual([
      {
        story: 'm1',
        words: ['Busan'],
        line: HARBOUR.sentences[0]!.text,
        sources: [{ interviewId: null, from: 4, to: 4 }],
      },
    ]);
    // the person it is about is never linked, but the stories naming them are still counted
    expect(of('Sunja Kim').mentions.map((m) => [m.story, m.words])).toEqual([
      ['m1', ['Sunja']],
      ['m2', ['Sunja']],
    ]);
    const story = (d: string) => g.relationships.find((r) => r.description.startsWith(d))!.story;
    expect(story('Minho — met')).toBe('m2');
    expect(story('Busan')).toBe('m1');
    expect(story('Minho — heard')).toBeNull();
    expect(g.stats!.calls).toBeGreaterThan(0);
  });

  it('when the find fails, the stories are written as before, without links, and the list waits', async () => {
    const chat = model((step, user) =>
      step === 'find' ? new ModelError('bad', 'bad_output', false) : listed(step, user),
    );
    const out = await run(chat);
    expect(out.pending).toBeUndefined();
    expect(out.memories).toHaveLength(2);
    for (const m of out.memories) expect(m.body).not.toContain('[[');
    expect(chat.calls.find((c) => c.step === 'plan')!.user).not.toContain('Who is in it:');
    expect(out.graph).toEqual({
      entities: [],
      relationships: [],
      pending: { reason: 'bad_plan' },
    });
  });

  it('a rejected key while finding them ends the import', async () => {
    const chat = model((step, user) =>
      step === 'find'
        ? new ModelError('the AI service answered HTTP 403', 'auth', false, 403)
        : listed(step, user),
    );
    const out = await run(chat);
    expect(out.pending).toEqual({ reason: 'auth' });
    expect(out.memories).toEqual([]);
    expect(chat.calls).toHaveLength(1);
  });

  it('a find slower than its own share of the time leaves the stories their time, without links', async () => {
    const chat = model(listed, (step) => (step === 'find' ? 300 : 0));
    const out = await run(chat, { findDeadlineMs: 20 });
    expect(out.pending).toBeUndefined();
    expect(out.memories).toHaveLength(2);
    for (const m of out.memories) expect(m.body).not.toContain('[[');
    expect(out.graph!.pending).toEqual({ reason: 'deadline' });
  });

  it('a find that spends its own calls leaves the stories theirs, without links', async () => {
    const chat = model(listed);
    const out = await run(chat, { findCallCap: 1 });
    expect(out.pending).toBeUndefined();
    expect(out.memories).toHaveLength(2);
    for (const m of out.memories) expect(m.body).not.toContain('[[');
    expect(out.graph!.pending).toEqual({ reason: 'budget' });
    // the one call it made counts in the import's too
    expect(chat.calls.filter((c) => c.step === 'find')).toHaveLength(1);
    expect(out.stats.stories!.calls).toBe(chat.calls.length);
  });

  it('a cancel while finding them stops the import as cancelled', async () => {
    const ac = new AbortController();
    const chat = model(listed, (step) => (step === 'find' ? 300 : 0));
    setTimeout(() => ac.abort(), 20);
    await expect(run(chat, { signal: ac.signal })).rejects.toBeInstanceOf(IngestCancelled);
    expect(chat.calls.map((c) => c.step)).toEqual(['find']);
  });

  it('does not look without the project’s graph', async () => {
    const chat = model(listed);
    const out = await writeStories(parsed(), OPTS, { chat, lookup: noLookup, titles: [] });
    expect(out.graph).toBeUndefined();
    expect(chat.calls.some((c) => c.step === 'find')).toBe(false);
    expect(chat.calls.find((c) => c.step === 'plan')!.user).not.toContain('Who is in it:');
  });
});
