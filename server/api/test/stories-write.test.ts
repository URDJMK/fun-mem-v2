import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../src/nim';
import { linesOf } from '../src/stories/lines';
import { parseDraft, showDraft, writeStory } from '../src/stories/write';

/** The write step: one story, in the third person, every sentence citing its lines. */
const say = (speaker: string, text: string) => ({
  index: 0,
  speaker,
  start: null,
  end: null,
  text,
});
const lines = linesOf(
  [
    say('Q', 'Where were you born?'),
    say('S', 'Um, I was born in Busan, near the harbour, I think it was nineteen forty-six.'),
    say('Q', 'And your father?'),
    say('S', 'My father repaired boats.'),
  ],
  ['S'],
  [['S', 'Sunja']],
);

describe('parseDraft', () => {
  it('reads a story: title, date, and sentences with their lines', () => {
    expect(
      parseDraft({
        title: 'The harbour where she was born',
        occurred: '~1946',
        until: null,
        sentences: [
          { text: 'Sunja was born in Busan, probably in 1946.', cites: ['L2'], paragraph: true },
          { text: 'Her father repaired boats.', cites: ['L3-L4'] },
        ],
      }),
    ).toEqual({
      title: 'The harbour where she was born',
      occurred: '~1946',
      until: null,
      sentences: [
        {
          text: 'Sunja was born in Busan, probably in 1946.',
          cites: [{ from: 2, to: 2 }],
          paragraph: true,
        },
        { text: 'Her father repaired boats.', cites: [{ from: 3, to: 4 }], paragraph: false },
      ],
    });
  });

  it('keeps a sentence whose citations cannot be read (the checker reports it)', () => {
    const d = parseDraft({
      title: 'T',
      sentences: [{ text: 'Sunja was born in Busan.', cites: ['somewhere'] }],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(d.sentences[0]!.cites).toEqual([]);
    expect(d.sentences[0]!.paragraph).toBe(true);
  });

  it('takes only a real fuzzy date', () => {
    const d = parseDraft({
      title: 'T',
      occurred: 'spring 1946',
      until: '1958',
      sentences: [{ text: 'A.', cites: ['L2'] }],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(d.occurred).toBeNull();
    expect(d.until).toBe('1958');
  });

  it('drops empty sentences, and sends back a story with none', () => {
    const d = parseDraft({
      title: 'T',
      sentences: [
        { text: '  ', cites: ['L2'] },
        { text: 'B.', cites: ['L4'] },
      ],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(d.sentences).toHaveLength(1);
    expect(parseDraft({ title: 'T', sentences: [] })).toMatch(/sentences/);
    expect(parseDraft(null)).toMatch(/sentences/);
  });
});

describe('parseDraft names', () => {
  it('reads the names each sentence marks', () => {
    const d = parseDraft({
      title: 'Seaweed soup',
      occurred: null,
      until: null,
      sentences: [
        {
          text: 'His mother made seaweed soup.',
          cites: ['L4'],
          names: [{ e: 'e4', words: 'His mother' }, { e: 'e5', words: '' }, 'x'],
        },
      ],
    });
    expect(typeof d === 'string' ? d : d.sentences[0]!.names).toEqual([
      { e: 'e4', words: 'His mother' },
    ]);
  });

  it('drops names with no entity, keeps at most twelve, and leaves a sentence without them alone', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ e: `e${i}`, words: `w${i}` }));
    const d = parseDraft({
      title: 'T',
      sentences: [
        { text: 'A.', cites: ['L2'], names: [{ words: 'her' }, { e: '', words: 'her' }, ...many] },
        { text: 'B.', cites: ['L4'], names: 'e4' },
        { text: 'C.', cites: ['L4'] },
      ],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(d.sentences[0]!.names).toEqual(many.slice(0, 12));
    expect(d.sentences[1]).not.toHaveProperty('names');
    expect(d.sentences[2]).not.toHaveProperty('names');
  });

  it('leaves out the key when no mark is usable', () => {
    const d = parseDraft({
      title: 'T',
      sentences: [{ text: 'A.', cites: ['L2'], names: [{ e: 'e4', words: '   ' }, 7, null] }],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(d.sentences[0]).not.toHaveProperty('names');
  });

  it('trims the id and the words, drops words that are only whitespace, and joins inner whitespace', () => {
    const d = parseDraft({
      title: 'T',
      sentences: [
        {
          text: 'His mother made soup.',
          cites: ['L4'],
          names: [
            { e: ' e4 ', words: ' His mother ' },
            { e: 'e5', words: ' \n\t ' },
            { e: 'e6', words: 'His   old\n mother' },
          ],
        },
      ],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(d.sentences[0]!.names).toEqual([
      { e: 'e4', words: 'His mother' },
      { e: 'e6', words: 'His old mother' },
    ]);
  });
});

describe('showDraft', () => {
  it('shows the sentences without the names they mark (the writer gives them again)', () => {
    const d = parseDraft({
      title: 'Seaweed soup',
      occurred: null,
      until: null,
      sentences: [
        { text: 'His mother made soup.', cites: ['L4'], names: [{ e: 'e4', words: 'His mother' }] },
      ],
    });
    if (typeof d === 'string') throw new Error(d);
    expect(showDraft(d)).toBe('Title: Seaweed soup\nOccurred: none\n0. His mother made soup. [L4]');
  });
});

describe('writeStory', () => {
  it('shows the story’s lines, and on a second try the problems found', async () => {
    const users: string[] = [];
    const chat: ChatModel = {
      id: 'scripted',
      complete: async (_s, user) => {
        users.push(user);
        return JSON.stringify({
          result: {
            title: 'The harbour where she was born',
            occurred: '~1946',
            sentences: [{ text: 'Sunja was born in Busan, probably in 1946.', cites: ['L2'] }],
          },
        });
      },
    };
    const story = {
      title: 'Born by the harbour',
      ranges: [{ from: 1, to: 2 }],
      tellers: ['Sunja'],
      continues: null,
    };
    const lookup = { search: async () => [], read: async () => null };
    const first = await writeStory(chat, {
      story,
      lines,
      subject: 'Sunja',
      feedback: null,
      lookup,
      maxToolCalls: 2,
    });
    expect(first.draft.title).toBe('The harbour where she was born');
    expect(users[0]).toContain('Working title: Born by the harbour');
    expect(users[0]).toContain('L2 Sunja: Um, I was born in Busan');
    expect(users[0]).not.toContain('Problems found');

    await writeStory(chat, {
      story,
      lines,
      subject: 'Sunja',
      feedback: {
        draft: first.draft,
        problems: [{ sentence: 0, kind: 'made_up', detail: 'the lines do not say spring' }],
      },
      lookup,
      maxToolCalls: 2,
    });
    expect(users[1]).toContain('Your previous draft');
    expect(users[1]).toContain('0. Sunja was born in Busan, probably in 1946. [L2]');
    expect(users[1]).toContain('sentence 0 (made_up): the lines do not say spring');
  });

  it('keeps the planned title when the model gives none', async () => {
    const chat: ChatModel = {
      id: 'scripted',
      complete: async () =>
        '{"result": {"title": "", "sentences": [{"text": "A.", "cites": ["L2"]}]}}',
    };
    const out = await writeStory(chat, {
      story: {
        title: 'Born by the harbour',
        ranges: [{ from: 2, to: 2 }],
        tellers: ['Sunja'],
        continues: null,
      },
      lines,
      subject: 'Sunja',
      feedback: null,
      lookup: { search: async () => [], read: async () => null },
      maxToolCalls: 0,
    });
    expect(out.draft.title).toBe('Born by the harbour');
  });

  it('shows the writer the list of people, places and things', async () => {
    const seen: string[] = [];
    const chat: ChatModel = {
      id: 'scripted',
      complete: async (_s, user) => {
        seen.push(user);
        return JSON.stringify({
          result: {
            title: 'T',
            occurred: null,
            until: null,
            sentences: [{ text: 'A.', cites: ['L2'] }],
          },
        });
      },
    };
    const base = {
      story: {
        title: 'Born by the harbour',
        ranges: [{ from: 2, to: 2 }],
        tellers: ['Sunja'],
        continues: null,
      },
      lines,
      subject: 'Sunja',
      feedback: null,
      lookup: { search: async () => [], read: async () => null },
      maxToolCalls: 0,
    };
    await writeStory(chat, { ...base, cast: "e4  Noah Kim's mother (person): his mother" });
    expect(seen[0]).toContain(
      "People, places and things in this interview:\ne4  Noah Kim's mother (person): his mother",
    );
    expect(seen[0]!.indexOf('The narrator: Sunja.')).toBeLessThan(
      seen[0]!.indexOf('People, places and things'),
    );

    await writeStory(chat, base);
    await writeStory(chat, { ...base, cast: '' });
    expect(seen[1]).not.toContain('People, places and things');
    expect(seen[2]).not.toContain('People, places and things');
  });

  it('keeps the names a sentence marks', async () => {
    const chat: ChatModel = {
      id: 'scripted',
      complete: async () =>
        JSON.stringify({
          result: {
            title: 'T',
            sentences: [
              {
                text: 'Her father repaired boats.',
                cites: ['L4'],
                names: [{ e: 'e1', words: 'Her father' }],
              },
            ],
          },
        }),
    };
    const out = await writeStory(chat, {
      story: {
        title: 'Boats',
        ranges: [{ from: 3, to: 4 }],
        tellers: ['Sunja'],
        continues: null,
      },
      lines,
      subject: 'Sunja',
      feedback: null,
      lookup: { search: async () => [], read: async () => null },
      maxToolCalls: 0,
    });
    expect(out.draft.sentences[0]!.names).toEqual([{ e: 'e1', words: 'Her father' }]);
  });
});
