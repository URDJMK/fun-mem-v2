import { describe, expect, it } from 'vitest';
import { findEntities, FIND_SYSTEM, parseFound } from '../src/graph/find';
import type { EntityLookup } from '../src/graph/store';
import type { NoteRef } from '../src/graph/types';
import type { ChatModel } from '../src/nim';
import type { Line } from '../src/stories/lines';

/**
 * The Entity step (entity design 4): every person, place and thing in an interview's lines, found
 * before its stories are written, with a checked description and the relationships told. A
 * scripted model plays the AI; the checks and the judge decide what stays.
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
const NOAH = { id: 'k-noah', name: 'Noah Kim', type: 'person' as const, aliases: ['Noah'] };
const lookup = (
  found: Record<
    string,
    Array<{ id: string; name: string; aliases?: string[]; close?: boolean; note?: NoteRef }>
  > = {},
): EntityLookup => ({
  find: async (name) =>
    (found[name] ?? []).map((f) => ({
      type: 'person' as const,
      aliases: [],
      lines: [],
      note: null,
      ...f,
    })),
  read: async () => null,
});

const FOUND = {
  entities: [
    { ref: 'e1', name: 'Noah Kim', type: 'person', match: 'k-noah', ways: [], description: [] },
    {
      ref: 'e2',
      name: 'Sarah',
      type: 'person',
      match: 'new',
      ways: ['his friend Sarah'],
      description: [{ text: 'Sarah sat next to Noah on his first day at school.', cites: ['L2'] }],
    },
    {
      ref: 'e3',
      name: 'Tom',
      type: 'person',
      match: 'new',
      ways: [],
      description: [{ text: 'Tom is Sarah’s brother.', cites: ['L2'] }],
    },
    {
      ref: 'e4',
      name: 'Noah Kim’s mother',
      type: 'person',
      match: 'new',
      ways: ['his mother', 'he'],
      description: [{ text: 'She always made seaweed soup.', cites: ['L4'] }],
    },
    {
      ref: 'e5',
      name: 'Seaweed soup',
      type: 'thing',
      match: 'new',
      ways: ['seaweed soup'],
      description: [{ text: 'Noah’s mother made it in the Korean way.', cites: ['L4'] }],
    },
  ],
  relationships: [
    { a: 'e2', b: 'e1', description: 'Sarah — Noah’s friend from school', cites: ['L2'] },
    { a: 'e3', b: 'e2', description: 'Tom — Sarah’s brother', cites: ['L2'] },
    { a: 'e3', b: 'e1', description: 'Noah Kim — knew Tom only through Sarah', cites: ['L2'] },
  ],
};
const KOREA = {
  ref: 'e1',
  name: 'Korea',
  type: 'place',
  match: 'new',
  ways: [],
  description: [{ text: 'Noah’s mother made soup the way they did in Korea.', cites: ['L4'] }],
};
const NOTHING = { entities: [], relationships: [] };

/**
 * A model answering the Entity step with `found`, then the recall pass with `more`, and the judge
 * with every sentence supported but those holding a phrase `judge` gives. It keeps what it was
 * asked: `finds` and `judged` are the prompts of each.
 */
function model(
  found: unknown,
  judge: (user: string) => string[] = () => [],
  more: unknown = NOTHING,
): ChatModel & { finds: string[]; judged: string[] } {
  const finds: string[] = [];
  const judged: string[] = [];
  return {
    id: 'scripted-find',
    finds,
    judged,
    complete: async (system, user) => {
      if (system.startsWith(FIND_SYSTEM)) {
        finds.push(user);
        return JSON.stringify({ result: finds.length === 1 ? found : more });
      }
      judged.push(user);
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

const run = (chat: ChatModel, over: Partial<Parameters<typeof findEntities>[0]> = {}) =>
  findEntities({
    chat,
    judge: chat,
    lines: LINES,
    profile: '',
    known: [NOAH],
    names: ['Noah', 'Noah Kim'],
    lookup: lookup(),
    ...over,
  });

type Found = Awaited<ReturnType<typeof run>>;
const byName = (r: Found, name: string) => r.entities.find((e) => e.name === name);
const relOf = (r: Found, a: string, b: string) => {
  const ref = (name: string) => byName(r, name)?.ref;
  return r.relationships.find((x) => [x.a, x.b].sort().join() === [ref(a), ref(b)].sort().join());
};
const L = (n: number) => [{ interviewId: null, from: n, to: n }];

describe('findEntities', () => {
  it('finds every person, place and thing, with the ways to call it and a checked description', async () => {
    const chat = model(FOUND);
    const r = await run(chat);
    expect(r.entities.map((e) => [e.ref, e.name, e.type])).toEqual([
      ['e1', 'Noah Kim', 'person'],
      ['e2', 'Sarah', 'person'],
      ['e3', 'Tom', 'person'],
      ['e4', 'Noah Kim’s mother', 'person'],
      ['e5', 'Seaweed soup', 'thing'],
    ]);
    expect(byName(r, 'Sarah')).toEqual({
      ref: 'e2',
      name: 'Sarah',
      type: 'person',
      match: { kind: 'new' },
      mentions: [],
      ways: ['his friend Sarah'],
      description: [{ text: 'Sarah sat next to Noah on his first day at school.', sources: L(2) }],
      note: { kind: 'new' },
    });
    // never a pronoun
    expect(byName(r, 'Noah Kim’s mother')!.ways).toEqual(['his mother']);
    expect(byName(r, 'Seaweed soup')!.description).toEqual([
      { text: 'Noah’s mother made it in the Korean way.', sources: L(4) },
    ]);
    expect(r.entities[0]!.match).toEqual({
      kind: 'existing',
      entityId: 'k-noah',
      name: 'Noah Kim',
    });
    // the stories fill the mentions later; nobody has a note yet
    for (const e of r.entities) {
      expect(e.mentions).toEqual([]);
      expect(e.note).toEqual({ kind: 'new' });
      expect(e.subject).toBeUndefined();
    }
    // the AI read the interview's lines and who is already known
    expect(chat.finds[0]).toContain('L2 Noah: My friend Sarah sat next to me');
    expect(chat.finds[0]).toContain('L1 Interviewer (asking): Who did you meet at school?');
    expect(chat.finds[0]).toContain('- Noah Kim (person, id k-noah), also called Noah');
    expect(r.stats.proposed).toBe(8);
  });

  it('marks the person the archive is about, with the note they have and no description', async () => {
    const found = structuredClone(FOUND);
    found.entities[0]!.description = [{ text: 'Noah met his friend Sarah.', cites: ['L2'] }];
    const chat = model(found);
    const r = await run(chat, {
      known: [{ ...NOAH, subject: true, note: { noteId: 'n-noah', title: 'Noah Kim' } }],
    });
    const noah = byName(r, 'Noah Kim')!;
    expect(noah.subject).toBe(true);
    expect(noah.description).toEqual([]);
    expect(noah.note).toEqual({ kind: 'existing', noteId: 'n-noah', title: 'Noah Kim' });
    expect(noah.aliases).toEqual(['Noah']);
    expect(r.entities.filter((e) => e.subject)).toHaveLength(1);
    expect(chat.finds[0]).toContain(
      '- Noah Kim (person, id k-noah), also called Noah — the person the archive is about',
    );
    // their sentence is not judged: it is not kept
    expect(chat.judged.join('\n')).not.toContain('Noah met his friend Sarah.');
  });

  it('asks once more about a capitalized name in the lines its answer left out', async () => {
    const chat = model(FOUND, undefined, { entities: [KOREA], relationships: [] });
    const r = await run(chat);
    expect(chat.finds).toHaveLength(2);
    expect(chat.finds[1]).toMatch(/not in your answer: Korea\./);
    expect(byName(r, 'Korea')).toMatchObject({
      ref: 'e6',
      type: 'place',
      match: { kind: 'new' },
      description: [{ text: 'Noah’s mother made soup the way they did in Korea.', sources: L(4) }],
    });
    // nothing left out: no second question
    const all = structuredClone(FOUND);
    all.entities.push({ ...structuredClone(KOREA), ref: 'e6' });
    const again = model(all);
    await run(again);
    expect(again.finds).toHaveLength(1);
  });

  it('takes the recall answer’s relationships to the first answer’s entities, and no one twice', async () => {
    const more = {
      entities: [
        { ...KOREA, ref: 'e2' },
        // already in the first answer
        { ref: 'e3', name: 'Sarah', type: 'person', match: 'new', ways: [], description: [] },
      ],
      relationships: [
        {
          a: 'e4',
          b: 'e2',
          description: 'Noah Kim’s mother — cooked the way of Korea',
          cites: ['L4'],
        },
        { a: 'e3', b: 'e1', description: 'Sarah — sat next to Noah', cites: ['L2'] },
      ],
    };
    const r = await run(model(FOUND, undefined, more));
    expect(r.entities.filter((e) => e.name === 'Sarah')).toHaveLength(1);
    expect(relOf(r, 'Noah Kim’s mother', 'Korea')!.description).toBe(
      'Noah Kim’s mother — cooked the way of Korea',
    );
    // "e3" in the recall answer is its own Sarah, not the first answer's Tom
    expect(relOf(r, 'Tom', 'Noah Kim')).toBeUndefined();
  });

  it('keeps the relationships the lines tell, and none known only through another person', async () => {
    const found = structuredClone(FOUND);
    found.relationships.push(
      // a pair has one relationship: the first given
      { a: 'e1', b: 'e2', description: 'Noah Kim — Sarah’s friend', cites: ['L2'] },
      { a: 'e4', b: 'e5', description: 'Noah Kim’s mother — Noah Kim’s mother', cites: ['L4'] },
    );
    const r = await run(model(found));
    expect(relOf(r, 'Sarah', 'Noah Kim')).toEqual({
      ref: 'r1',
      a: 'e2',
      b: 'e1',
      description: 'Sarah — Noah’s friend from school',
      story: null,
      sources: L(2),
    });
    expect(relOf(r, 'Tom', 'Sarah')).toMatchObject({
      description: 'Tom — Sarah’s brother',
      story: null,
    });
    // Tom joins Noah through Sarah
    expect(relOf(r, 'Tom', 'Noah Kim')).toBeUndefined();
    // the part after the dash never says the name again
    expect(relOf(r, 'Noah Kim’s mother', 'Seaweed soup')!.description).toBe('Noah Kim’s mother');
    expect(r.relationships).toHaveLength(3);
    expect(r.stats.left!.map((l) => l.why)).toContain('known only through another person');
  });

  it('drops a sentence the checks or the judge fail; the entity stays with the rest', async () => {
    const found = structuredClone(FOUND);
    found.entities[1]!.description.push(
      // a name the cited lines do not hold
      { text: 'Sarah sat next to Jessica.', cites: ['L2'] },
    );
    found.entities[2]!.description.push(
      { text: 'Tom was tall.', cites: [] },
      { text: 'Tom came to every birthday.', cites: ['L9'] },
    );
    const r = await run(model(found, () => ['Korean way', 'friend from school']));
    // the soup's only sentence was ruled made up: it stays, with no description
    expect(byName(r, 'Seaweed soup')!.description).toEqual([]);
    expect(byName(r, 'Sarah')!.description!.map((s) => s.text)).toEqual([
      'Sarah sat next to Noah on his first day at school.',
    ]);
    expect(byName(r, 'Tom')!.description!.map((s) => s.text)).toEqual(['Tom is Sarah’s brother.']);
    // a relationship the judge rules made up goes
    expect(relOf(r, 'Sarah', 'Noah Kim')).toBeUndefined();
    expect(relOf(r, 'Tom', 'Sarah')).toBeDefined();
    expect(r.entities).toHaveLength(5);
    expect(r.stats.dropped).toBeGreaterThanOrEqual(5);
  });

  it('judges ten entities at a time', async () => {
    const guests = 'Ann Ben Cal Dan Eve Fay Gus Hal Ivy Jan Kit Lou'.split(' ');
    const found = structuredClone(FOUND) as { entities: unknown[]; relationships: unknown[] };
    found.entities.push(
      ...guests.map((g, i) => ({
        ref: `g${i}`,
        name: g,
        type: 'person',
        match: 'new',
        ways: [],
        description: [{ text: `${g} came to the party.`, cites: ['L5'] }],
      })),
    );
    const chat = model(found);
    const r = await run(chat, {
      lines: [...LINES, line(5, 'Noah', `At the party were ${guests.join(', ')}.`)],
    });
    expect(r.entities).toHaveLength(17);
    expect(chat.judged).toHaveLength(2);
    expect(chat.judged[1]).toContain('Lou came to the party.');
    expect(chat.judged[1]).not.toContain('Ann came to the party.');
  });

  it('leaves out a name with a word the lines do not give, and its relationships', async () => {
    const found = structuredClone(FOUND);
    found.entities[1]!.name = 'Sarah Lee';
    const r = await run(model(found));
    expect(r.entities.map((e) => e.name)).toEqual([
      'Noah Kim',
      'Tom',
      'Noah Kim’s mother',
      'Seaweed soup',
    ]);
    expect(r.relationships).toEqual([]);
    expect(r.stats.left).toContainEqual({
      what: 'Sarah Lee',
      why: 'a word of the name is not in the lines',
    });
  });

  it('gives an entity that matches one with a note that note', async () => {
    const r = await run(model(FOUND), {
      lookup: lookup({
        Sarah: [{ id: 'k-sarah', name: 'Sarah', note: { noteId: 'n-sarah', title: 'Sarah' } }],
        // only a similar spelling: never its match, nor its note
        Tom: [
          { id: 'k-tomas', name: 'Tomas', close: true, note: { noteId: 'n-t', title: 'Tomas' } },
        ],
      }),
    });
    expect(byName(r, 'Sarah')).toMatchObject({
      match: { kind: 'existing', entityId: 'k-sarah', name: 'Sarah' },
      note: { kind: 'existing', noteId: 'n-sarah', title: 'Sarah' },
      aliases: [],
    });
    expect(byName(r, 'Tom')).toMatchObject({ match: { kind: 'new' }, note: { kind: 'new' } });
  });

  it('gives an entity the AI matched by the tools the note it has', async () => {
    let finds = 0;
    const chat: ChatModel = {
      id: 'scripted-tools',
      complete: async (system, user) => {
        if (!system.startsWith(FIND_SYSTEM)) {
          const n = (user.match(/^\d+\. /gm) ?? []).length;
          return JSON.stringify({
            result: {
              rulings: Array.from({ length: n }, (_, i) => ({ sentence: i, verdict: 'supported' })),
            },
          });
        }
        finds++;
        if (finds === 1)
          return JSON.stringify({ tool: 'find_entity', args: { name: 'Sarah Lee' } });
        const found = structuredClone(FOUND);
        found.entities[1]!.match = 'k-sarah-lee';
        return JSON.stringify({ result: finds === 2 ? found : NOTHING });
      },
    };
    const r = await run(chat, {
      lookup: lookup({
        'Sarah Lee': [
          {
            id: 'k-sarah-lee',
            name: 'Sarah Lee',
            aliases: ['Sarah'],
            note: { noteId: 'n-sarah-lee', title: 'Sarah Lee' },
          },
        ],
      }),
    });
    expect(byName(r, 'Sarah')).toMatchObject({
      match: { kind: 'existing', entityId: 'k-sarah-lee', name: 'Sarah Lee' },
      note: { kind: 'existing', noteId: 'n-sarah-lee', title: 'Sarah Lee' },
      aliases: ['Sarah'],
    });
  });

  it('gives the profile, and a sentence citing it keeps no interview source', async () => {
    const found = structuredClone(FOUND);
    found.entities[3]!.description.push({ text: 'She lived in Seoul.', cites: ['P'] });
    const chat = model(found);
    const r = await run(chat, {
      lines: [line(0, 'Profile', 'Noah Kim was born in Seoul.', false), ...LINES],
      profile: 'Who this is about: Noah Kim, born in Seoul.',
    });
    expect(chat.finds[0]!.startsWith('Who this is about: Noah Kim, born in Seoul.')).toBe(true);
    expect(chat.finds[0]).not.toContain('L0');
    expect(byName(r, 'Noah Kim’s mother')!.description).toEqual([
      { text: 'She always made seaweed soup.', sources: L(4) },
      { text: 'She lived in Seoul.', sources: [] },
    ]);
  });

  it('throws when the answer cannot be read, so the import can say it is pending', async () => {
    const chat: ChatModel = { id: 'scripted-garbled', complete: async () => 'Nobody, I think.' };
    await expect(run(chat)).rejects.toMatchObject({ kind: 'bad_output' });
  });
});

describe('parseFound', () => {
  it('keeps at most twenty things, and everyone else', () => {
    const things = Array.from({ length: 25 }, (_, i) => ({
      ref: `t${i}`,
      name: `Box ${i}`,
      type: 'thing',
      match: 'new',
    }));
    const p = parseFound({
      entities: [...things, { ref: 'p1', name: 'Sarah', type: 'person', match: 'new' }],
      relationships: [],
    });
    if (typeof p === 'string') throw new Error(p);
    expect(p.entities.filter((e) => e.type === 'thing')).toHaveLength(20);
    expect(p.entities.at(-2)!.ref).toBe('t19');
    expect(p.entities.at(-1)!.name).toBe('Sarah');
  });

  it('reads leniently: an item that is not right is left out', () => {
    expect(parseFound({ people: [] })).toMatch(/give \{"entities"/);
    const p = parseFound({
      entities: [
        {
          ref: 'e1',
          name: '[[Sarah]] #1',
          type: 'person',
          ways: ['she', 'his friend Sarah', 'the girl who sat next to him', 1, 'his friend Sarah'],
          description: [
            { text: 'One.', cites: ['L1'] },
            { text: 'Two.', cites: ['L2-L3'] },
            { text: 'Three.', cites: 'L3' },
            { text: '' },
            { text: 'Four.' },
            { text: 'Five.' },
          ],
        },
        { ref: 'e1', name: 'Tom', type: 'person' },
        { ref: 'e2', name: 'Busan', type: 'city' },
        { ref: 'e3', name: '  ', type: 'place' },
        'Tom',
        { ref: 'e4', name: 'Tom', type: 'person', match: 'ask', candidates: ['k-tom', 7] },
      ],
      relationships: [
        { a: 'e4', b: 'e1', description: 'Tom — Sarah’s brother', cites: ['L2'] },
        { a: 'e4', b: 'e9', description: 'Tom — someone', cites: ['L2'] },
        { a: 'e4', b: 'e4', description: 'Tom — himself', cites: ['L2'] },
        { a: 'e1', b: 'e4', description: '', cites: ['L2'] },
      ],
    });
    if (typeof p === 'string') throw new Error(p);
    expect(p.entities).toEqual([
      {
        ref: 'e1',
        name: 'Sarah 1',
        type: 'person',
        match: 'new',
        candidates: [],
        ways: ['his friend Sarah'],
        description: [
          { text: 'One.', cites: [{ from: 1, to: 1 }] },
          { text: 'Two.', cites: [{ from: 2, to: 3 }] },
          { text: 'Three.', cites: [] },
          { text: 'Four.', cites: [] },
        ],
      },
      {
        ref: 'e4',
        name: 'Tom',
        type: 'person',
        match: 'ask',
        candidates: ['k-tom'],
        ways: [],
        description: [],
      },
    ]);
    expect(p.relationships).toEqual([
      { a: 'e4', b: 'e1', description: 'Tom — Sarah’s brother', cites: [{ from: 2, to: 2 }] },
    ]);
  });

  it('lets a relationship name an entity of an earlier answer', () => {
    const p = parseFound(
      {
        entities: [{ ref: 'e1', name: 'Korea', type: 'place' }],
        relationships: [{ a: 'e4', b: 'e1', description: 'Noah Kim’s mother — from Korea' }],
      },
      new Set(['e4']),
    );
    if (typeof p === 'string') throw new Error(p);
    expect(p.relationships).toHaveLength(1);
  });
});
