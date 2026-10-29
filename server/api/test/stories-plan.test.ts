import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../src/nim';
import { linesOf } from '../src/stories/lines';
import { parsePlan, planPart } from '../src/stories/plan';
import type { StoryLookup } from '../src/stories/tools';

/** The plan: which stories the interview tells, and which lines tell each one. */
const say = (speaker: string, text: string) => ({
  index: 0,
  speaker,
  start: null,
  end: null,
  text,
});
const lines = linesOf(
  [
    say('Q', 'Hello, can you hear me?'),
    say('S', 'Yes, hello dear.'),
    say('Q', 'Where were you born?'),
    say('S', 'I was born in Busan, near the harbour, in 1946.'),
    say('Q', 'And your father?'),
    say('S', 'My father repaired boats and took me to the pier on Sundays.'),
    say('Q', 'When did you meet your husband?'),
    say('S', 'I met Minho at a church supper in 1966. He spilled gravy on his shirt.'),
  ],
  ['S'],
  [['S', 'Sunja']],
);
const story = (title: string, lineRefs: string[], extra: Record<string, unknown> = {}) => ({
  title,
  lines: lineRefs,
  tellers: ['Sunja'],
  ...extra,
});

describe('parsePlan', () => {
  it('reads a plan: titles, line ranges, who tells it, and the interview’s name', () => {
    const plan = parsePlan(
      {
        interviewName: 'Sunja on Busan and Minho',
        stories: [
          story('The harbour where she was born', ['L3-L6']),
          story('Gravy at the church supper', ['L7', 'L8']),
        ],
      },
      lines,
      [],
    );
    expect(plan).toEqual({
      interviewName: 'Sunja on Busan and Minho',
      stories: [
        {
          title: 'The harbour where she was born',
          ranges: [{ from: 3, to: 6 }],
          tellers: ['Sunja'],
          continues: null,
        },
        {
          title: 'Gravy at the church supper',
          ranges: [{ from: 7, to: 8 }],
          tellers: ['Sunja'],
          continues: null,
        },
      ],
    });
  });

  it('keeps each line in one story only (the first that claims it), and drops lines that are not there', () => {
    const plan = parsePlan(
      { stories: [story('Busan', ['L3-L6']), story('Father', ['L5-L6', 'L40-L50'])] },
      lines,
      [],
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0]!.ranges).toEqual([{ from: 3, to: 6 }]);
  });

  it('drops a "story" with none of the narrator’s lines in it', () => {
    const plan = parsePlan(
      { stories: [story('Questions', ['L3']), story('Busan', ['L4'])] },
      lines,
      [],
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.stories.map((s) => s.title)).toEqual(['Busan']);
  });

  it('joins the stories of one period of the narrator’s life into one', () => {
    const plan = parsePlan(
      {
        stories: [
          story('Born by the harbour', ['L3-L4'], { period: 'Childhood in Busan' }),
          story('Sundays at the pier', ['L5-L6'], { period: 'childhood in Busan ' }),
          story('Gravy at the church supper', ['L7-L8'], { period: 'Marriage' }),
        ],
      },
      lines,
      [],
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.stories.map((s) => [s.title, s.ranges])).toEqual([
      ['Born by the harbour', [{ from: 3, to: 6 }]],
      ['Gravy at the church supper', [{ from: 7, to: 8 }]],
    ]);
  });

  it('names the tellers from the lines when the plan does not', () => {
    const plan = parsePlan({ stories: [{ title: 'Busan', lines: ['L4'] }] }, lines, []);
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.stories[0]!.tellers).toEqual(['Sunja']);
  });

  it('sends back a plan with no story when the narrator said plenty', () => {
    expect(parsePlan({ stories: [] }, lines, [])).toMatch(/no stories/i);
    expect(parsePlan('nonsense', lines, [])).toMatch(/stories/);
  });

  it('accepts no story for a conversation that holds none', () => {
    const greetings = lines.slice(0, 2);
    expect(parsePlan({ stories: [] }, greetings, [])).toEqual({ interviewName: null, stories: [] });
  });

  it('carries a story on only from one it was given', () => {
    const plan = parsePlan(
      {
        stories: [
          story('Busan', ['L4'], { continues: 'The harbour' }),
          story('Minho', ['L8'], { continues: 'Made up' }),
        ],
      },
      lines,
      ['The harbour'],
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.stories.map((s) => s.continues)).toEqual(['The harbour', null]);
  });

  it('gives a story without a usable title a plain one', () => {
    const plan = parsePlan(
      { stories: [story('', ['L4']), story('x'.repeat(200), ['L6'])] },
      lines,
      [],
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.stories.map((s) => s.title)).toEqual([
      'A story from the interview',
      'A story from the interview (2)',
    ]);
  });
});

describe('planPart', () => {
  it('may look in the project first, then plans', async () => {
    const users: string[] = [];
    const chat: ChatModel = {
      id: 'scripted',
      complete: async (_system, user) => {
        users.push(user);
        return users.length === 1
          ? '{"tool": "search_notes", "args": {"query": "Minho"}}'
          : JSON.stringify({
              result: { stories: [story('Gravy at the church supper', ['L7-L8'])] },
            });
      },
    };
    const lookup: StoryLookup = {
      search: async () => [{ id: 'n9', title: 'Minho', type: 'person', snippet: 'her husband' }],
      read: async () => null,
    };
    const { plan, calls } = await planPart(chat, {
      lines,
      subject: 'Sunja',
      carried: [],
      lookup,
      maxToolCalls: 5,
    });
    expect(calls).toBe(2);
    expect(plan.stories[0]!.title).toBe('Gravy at the church supper');
    expect(users[0]).toContain('L4 Sunja: I was born in Busan');
    expect(users[1]).toContain('Minho (person, id n9)');
  });

  it('shows the planner who is in the interview, when it is known', async () => {
    const seen: string[] = [];
    const chat: ChatModel = {
      id: 'scripted',
      complete: async (_system, user) => {
        seen.push(user);
        return JSON.stringify({ result: { stories: [story('Busan', ['L4'])] } });
      },
    };
    const base = {
      lines,
      subject: 'Sunja',
      carried: [],
      lookup: { search: async () => [], read: async () => null } as StoryLookup,
      maxToolCalls: 0,
    };
    await planPart(chat, { ...base, cast: "Noah Kim's mother (person)\nBusan (place)" });
    expect(seen[0]).toContain("Who is in it:\nNoah Kim's mother (person)\nBusan (place)");
    expect(seen[0]!.indexOf('The narrator: Sunja.')).toBeLessThan(seen[0]!.indexOf('Who is in it'));
    expect(seen[0]!.indexOf('Who is in it')).toBeLessThan(seen[0]!.indexOf('The transcript'));

    await planPart(chat, base);
    await planPart(chat, { ...base, cast: '' });
    expect(seen[1]).not.toContain('Who is in it');
    expect(seen[2]).not.toContain('Who is in it');
  });
});
