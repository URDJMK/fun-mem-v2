import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../src/nim';
import { linesOf } from '../src/stories/lines';
import { parseDraft, writeStory } from '../src/stories/write';

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
});
