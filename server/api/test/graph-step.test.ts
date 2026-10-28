import { describe, expect, it } from 'vitest';
import type { EntityLookup } from '../src/graph/store';
import { graphStep, GRAPH_SYSTEM, type StoryForGraph } from '../src/graph/step';
import type { ChatModel } from '../src/nim';
import type { Line } from '../src/stories/lines';

/**
 * The Graph step (graph design 4.1, 4.2): the people, places and things a story names, and the
 * relationships it tells. A scripted model plays the AI; the checks and the judge decide what stays.
 */
const line = (
  n: number,
  speaker: string,
  text: string,
  teller = speaker !== 'Interviewer',
): Line => ({
  n,
  speaker,
  name: speaker,
  teller,
  start: null,
  end: null,
  text,
});
const LINES: Line[] = [
  line(1, 'Interviewer', 'Who did you meet at school?'),
  line(
    2,
    'Noah',
    'My friend Sarah sat next to me on the first day. She brought her brother Tom to meet me.',
  ),
  line(3, 'Interviewer', 'And your birthdays?'),
  line(4, 'Noah', 'My mother always made seaweed soup, the way they did in Korea.'),
];
const STORIES: StoryForGraph[] = [
  {
    ref: 'm1',
    title: 'The new boy at school',
    text: 'Noah met his friend Sarah on his first day. Sarah brought her brother Tom to meet him.',
    sentences: [
      { text: 'Noah met his friend Sarah on his first day.', cites: [{ from: 2, to: 2 }] },
      { text: 'Sarah brought her brother Tom to meet him.', cites: [{ from: 2, to: 2 }] },
    ],
    ranges: [{ from: 1, to: 2 }],
    tellers: ['Noah'],
  },
  {
    ref: 'm2',
    title: 'Seaweed soup on his birthday',
    text: 'Every birthday his mother made seaweed soup, the way they did in Korea.',
    sentences: [
      {
        text: 'Every birthday his mother made seaweed soup, the way they did in Korea.',
        cites: [{ from: 4, to: 4 }],
      },
    ],
    ranges: [{ from: 3, to: 4 }],
    tellers: ['Noah'],
  },
];
const NOAH = { id: 'k-noah', name: 'Noah Kim', type: 'person' as const, aliases: ['Noah'] };
const lookup = (found: Record<string, Array<{ id: string; name: string }>> = {}): EntityLookup => ({
  find: async (name) =>
    (found[name] ?? []).map((f) => ({ ...f, type: 'person' as const, aliases: [], lines: [] })),
  read: async () => null,
});

const mention = (story: string, words: string[], text: string, cites = ['L2']) => ({
  story,
  words,
  line: text,
  cites,
});
const HAPPY = {
  entities: [
    {
      ref: 'e1',
      name: 'Noah Kim',
      type: 'person',
      match: 'k-noah',
      mentions: [
        mention('S1', ['Noah'], 'Noah met Sarah on his first day at school.'),
        mention('S2', ['his mother'], 'Noah’s mother made him seaweed soup.', ['L4']),
      ],
    },
    {
      ref: 'e2',
      name: 'Sarah',
      type: 'person',
      match: 'new',
      mentions: [mention('S1', ['Sarah'], 'Sarah sat next to Noah on the first day.')],
    },
    {
      ref: 'e3',
      name: 'Tom',
      type: 'person',
      match: 'new',
      mentions: [mention('S1', ['her brother Tom'], 'Tom is Sarah’s brother.')],
    },
    {
      ref: 'e4',
      name: 'Noah Kim’s mother',
      type: 'person',
      match: 'new',
      mentions: [mention('S2', ['his mother'], 'She made seaweed soup every birthday.', ['L4'])],
    },
    {
      ref: 'e5',
      name: 'Seaweed soup',
      type: 'thing',
      match: 'new',
      mentions: [mention('S2', ['seaweed soup'], 'Made every birthday.', ['L4'])],
    },
    {
      ref: 'e6',
      name: 'Korea',
      type: 'place',
      match: 'new',
      mentions: [mention('S2', ['Korea'], 'Where the soup is made that way.', ['L4'])],
    },
  ],
  relationships: [
    {
      a: 'e2',
      b: 'e1',
      description: 'Sarah — Noah’s friend from his first day',
      story: 'S1',
      cites: ['L2'],
    },
    { a: 'e3', b: 'e2', description: 'Tom — Sarah’s brother', story: 'S1', cites: ['L2'] },
    {
      a: 'e4',
      b: 'e1',
      description: 'Noah Kim’s mother — made his birthday soup',
      story: 'S2',
      cites: ['L4'],
    },
  ],
};

/** a model answering the Graph step with `graph`, and the judge with `rulings` (all supported) */
function model(
  graph: unknown,
  judge: (user: string) => string[] = () => [],
): ChatModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'scripted-graph',
    calls,
    complete: async (system, user) => {
      calls.push(system.startsWith(GRAPH_SYSTEM) ? 'graph' : 'judge');
      if (system.startsWith(GRAPH_SYSTEM)) return JSON.stringify({ result: graph });
      const n = (user.match(/^\d+\. /gm) ?? []).length;
      const bad = judge(user);
      return JSON.stringify({
        result: {
          rulings: Array.from({ length: n }, (_, i) => {
            const text = new RegExp(`^${i}\\. (.*)$`, 'm').exec(user)?.[1] ?? '';
            return bad.some((b) => text.includes(b))
              ? { sentence: i, verdict: 'made_up', reason: 'not told' }
              : { sentence: i, verdict: 'supported' };
          }),
        },
      });
    },
  };
}

const run = (chat: ChatModel, over: Partial<Parameters<typeof graphStep>[0]> = {}) =>
  graphStep({
    chat,
    judge: chat,
    stories: STORIES,
    lines: LINES,
    profile: '',
    known: [NOAH],
    names: ['Noah', 'Noah Kim'],
    lookup: lookup(),
    ...over,
  });

const relOf = (p: Awaited<ReturnType<typeof run>>, a: string, b: string) => {
  const ref = (name: string) => p.entities.find((e) => e.name === name)?.ref;
  return p.relationships.find((r) => [r.a, r.b].sort().join() === [ref(a), ref(b)].sort().join());
};

describe('graphStep', () => {
  it('names the people, places and things, and the relationships told', async () => {
    const p = await run(model(HAPPY));
    expect(p.entities.map((e) => [e.name, e.type])).toEqual([
      ['Noah Kim', 'person'],
      ['Sarah', 'person'],
      ['Tom', 'person'],
      ['Noah Kim’s mother', 'person'],
      ['Seaweed soup', 'thing'],
      ['Korea', 'place'],
    ]);
    expect(p.entities[0]!.match).toEqual({
      kind: 'existing',
      entityId: 'k-noah',
      name: 'Noah Kim',
    });
    expect(p.entities[1]!.match).toEqual({ kind: 'new' });
    expect(p.entities[2]!.mentions).toEqual([
      {
        story: 'm1',
        words: ['her brother Tom'],
        line: 'Tom is Sarah’s brother.',
        sources: [{ interviewId: null, from: 2, to: 2 }],
      },
    ]);
    // the bridge: Tom joins through Sarah, and nothing joins him to Noah
    expect(relOf(p, 'Sarah', 'Noah Kim')!.description).toBe(
      'Sarah — Noah’s friend from his first day',
    );
    expect(relOf(p, 'Tom', 'Sarah')!.story).toBe('m1');
    expect(relOf(p, 'Tom', 'Noah Kim')).toBeUndefined();
    expect(p.relationships).toHaveLength(3);
    expect(p.pending).toBeUndefined();
  });

  it('drops what the story does not say: unwritten words, unknown names, made-up relationships', async () => {
    const graph = structuredClone(HAPPY);
    // a story that never names him: the mention goes, and Tom with it, and his relationship
    graph.entities[2]!.mentions[0] = mention('S2', ['Tom'], 'Tom came for soup.', ['L4']);
    // a name the cited lines do not hold
    graph.entities[1]!.mentions[0]!.line = 'Sarah sat next to Noah and Jessica.';
    graph.entities[1]!.mentions.push(mention('S1', ['Sarah'], 'unused'));
    const p = await run(model(graph, () => ['made his birthday soup']));
    expect(p.entities.map((e) => e.name)).not.toContain('Tom');
    expect(relOf(p, 'Tom', 'Sarah')).toBeUndefined();
    // Sarah's only line failed: she has no supported mention left, so she goes too
    expect(p.entities.map((e) => e.name)).not.toContain('Sarah');
    // the judge ruled the mother's relationship made up
    expect(relOf(p, 'Noah Kim’s mother', 'Noah Kim')).toBeUndefined();
    expect(p.entities.map((e) => e.name)).toContain('Noah Kim’s mother');
    expect(p.stats!.dropped).toBeGreaterThan(0);
  });

  it('keeps the words short, falling back to the name, and one relationship per pair per story', async () => {
    const graph = structuredClone(HAPPY);
    // a whole phrase is not the words for someone: the name the story uses is
    graph.entities[0]!.mentions[0]!.words = ['Noah met his friend Sarah on his first day'];
    graph.relationships.push({
      a: 'e1',
      b: 'e2',
      description: 'Noah — Sarah’s friend',
      story: 'S1',
      cites: ['L2'],
    });
    // a name made from a relationship is found as the story says it, never by its first word
    graph.entities[3]!.mentions[0]!.words = ['the mother of Noah who cooked'];
    const p = await run(model(graph), {
      stories: [
        STORIES[0]!,
        {
          ...STORIES[1]!,
          text: 'Every birthday Noah’s mother made seaweed soup, the way they did in Korea.',
        },
      ],
    });
    expect(p.entities[0]!.mentions[0]!.words).toEqual(['Noah']);
    expect(p.entities.find((e) => e.name === 'Noah Kim’s mother')!.mentions[0]!.words).toEqual([
      'Noah’s mother',
    ]);
    expect(
      p.relationships.filter((r) => r.story === 'm1' && [r.a, r.b].includes('e1')),
    ).toHaveLength(1);
  });

  it('drops a line that only says one knew of another through someone', async () => {
    const graph = structuredClone(HAPPY);
    graph.relationships.push(
      {
        a: 'e1',
        b: 'e3',
        description: 'Noah — knew Tom only from Sarah’s stories',
        story: 'S1',
        cites: ['L2'],
      },
      {
        a: 'e3',
        b: 'e1',
        description: 'Tom — known to Noah through Sarah',
        story: 'S1',
        cites: ['L2'],
      },
    );
    graph.relationships[2]!.description = 'Noah Kim’s mother — Noah Kim’s mother';
    const p = await run(model(graph));
    expect(relOf(p, 'Tom', 'Noah Kim')).toBeUndefined();
    expect(p.stats!.left!.map((l) => l.why)).toContain('known only through another person');
    expect(relOf(p, 'Noah Kim’s mother', 'Noah Kim')!.description).toBe('Noah Kim’s mother');
  });

  it('keeps at most three things from a story', async () => {
    const graph = structuredClone(HAPPY);
    const things = ['the pot', 'the spoon', 'the bowl', 'the table'];
    const story2: StoryForGraph = {
      ...STORIES[1]!,
      text: `${STORIES[1]!.text} She used the pot, the spoon, the bowl and the table.`,
    };
    graph.entities.push(
      ...things.map((t, i) => ({
        ref: `t${i}`,
        name: t,
        type: 'thing',
        match: 'new',
        mentions: [mention('S2', [t], `Used for the soup in Korea.`, ['L4'])],
      })),
    );
    const p = await run(model(graph), { stories: [STORIES[0]!, story2] });
    expect(p.entities.filter((e) => e.type === 'thing')).toHaveLength(3);
  });

  it('a match the tools never offered is a new entity; one found by name is that entity', async () => {
    const graph = structuredClone(HAPPY);
    graph.entities[1]!.match = 'made-up-id';
    graph.entities[5]!.match = 'new';
    const p = await run(model(graph), {
      lookup: lookup({ Korea: [{ id: 'k-korea', name: 'Korea' }] }),
    });
    expect(p.entities.find((e) => e.name === 'Sarah')!.match).toEqual({ kind: 'new' });
    expect(p.entities.find((e) => e.name === 'Korea')!.match).toEqual({
      kind: 'existing',
      entityId: 'k-korea',
      name: 'Korea',
    });
  });

  it('asks, with the candidates it was offered', async () => {
    const graph = structuredClone(HAPPY) as typeof HAPPY & {
      entities: Array<(typeof HAPPY)['entities'][number] & { candidates?: string[] }>;
    };
    graph.entities[1]!.match = 'ask';
    graph.entities[1]!.candidates = ['k-sarah-lee', 'nobody'];
    const p = await run(model(graph), {
      lookup: lookup({ Sarah: [{ id: 'k-sarah-lee', name: 'Sarah Lee' }] }),
    });
    expect(p.entities.find((e) => e.name === 'Sarah')!.match).toEqual({
      kind: 'ask',
      candidates: [{ entityId: 'k-sarah-lee', name: 'Sarah Lee' }],
    });
  });
});
