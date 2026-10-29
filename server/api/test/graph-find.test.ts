import { describe, expect, it } from 'vitest';
import {
  findEntities,
  FIND_SYSTEM,
  mergeFound,
  parseFound,
  type FindResult,
} from '../src/graph/find';
import { nameHeld, uncovered, wordsOf } from '../src/graph/shared';
import type { EntityLookup } from '../src/graph/store';
import type { NoteRef, ProposedEntity } from '../src/graph/types';
import { ModelError, type ChatModel } from '../src/nim';
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
/** every entity and relationship proposed is kept or counted as left out */
const balanced = (r: Found) =>
  expect(r.stats.proposed - r.stats.dropped).toBe(r.entities.length + r.relationships.length);

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
    // the judge is told whom a sentence is about; the sentence is kept as written
    expect(chat.judged[0]).toContain(
      '. About Sarah: Sarah sat next to Noah on his first day at school.',
    );
    expect(r.stats.proposed).toBe(8);
    balanced(r);
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
    // what is asked once more, after the task
    expect(chat.finds[1]!.slice(chat.finds[0]!.length)).toContain('Korea');
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
    expect(r.stats.left).toEqual([
      { what: 'Noah Kim — knew Tom only through Sarah', why: 'known only through another person' },
      { what: 'Noah Kim — Sarah’s friend', why: 'a second relationship for the pair' },
    ]);
    balanced(r);
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
    // another entity's name, which its own lines do not hold
    found.entities[4]!.description.push({ text: 'It was what Sarah loved.', cites: ['L4'] });
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
    const judge = 'the judge: made_up (not told)';
    expect(r.stats.left).toEqual([
      { what: 'Noah Kim — knew Tom only through Sarah', why: 'known only through another person' },
      {
        what: 'Sarah sat next to Jessica.',
        why: 'not_in_source: the cited lines do not name Jessica',
      },
      { what: 'Tom was tall.', why: 'no_citation: say which lines this comes from' },
      { what: 'Tom came to every birthday.', why: 'bad_citation: the transcript ends at L4' },
      { what: 'It was what Sarah loved.', why: 'not_in_source: the cited lines do not name Sarah' },
      { what: 'Noah’s mother made it in the Korean way.', why: judge },
      { what: 'Sarah — Noah’s friend from school', why: judge },
    ]);
    // the sentences are listed, and only the two relationships counted
    expect(r.stats.dropped).toBe(2);
    balanced(r);
  });

  it('keeps for a pair the first relationship that holds', async () => {
    const found = structuredClone(FOUND);
    found.relationships[0]!.cites = ['L9'];
    found.relationships.push({
      a: 'e1',
      b: 'e2',
      description: 'Noah Kim — Sarah’s friend from the first day',
      cites: ['L2'],
    });
    const r = await run(model(found));
    expect(relOf(r, 'Sarah', 'Noah Kim')!.description).toBe(
      'Noah Kim — Sarah’s friend from the first day',
    );
    expect(r.stats.left).toContainEqual({
      what: 'Sarah — Noah’s friend from school',
      why: 'bad_citation: the transcript ends at L4',
    });
  });

  it('drops a sentence citing a line before the part', async () => {
    const mother = structuredClone(FOUND.entities[3]!);
    mother.description.push({ text: 'She met Sarah on the first day.', cites: ['L2'] });
    const r = await run(model({ entities: [FOUND.entities[0], mother], relationships: [] }), {
      lines: LINES.slice(2),
    });
    expect(byName(r, 'Noah Kim’s mother')!.description!.map((s) => s.text)).toEqual([
      'She always made seaweed soup.',
    ]);
    expect(r.stats.left).toContainEqual({
      what: 'She met Sarah on the first day.',
      why: expect.stringMatching(/^outside_story: L2 /),
    });
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
    expect(r.stats.left).toEqual([
      { what: 'Noah Kim — knew Tom only through Sarah', why: 'known only through another person' },
      { what: 'Sarah Lee', why: 'a word of the name is not in the lines' },
      { what: 'Sarah — Noah’s friend from school', why: 'an entity it joins was left out' },
      { what: 'Tom — Sarah’s brother', why: 'an entity it joins was left out' },
    ]);
    balanced(r);
  });

  it('keeps a place the lines name only as its people or language', async () => {
    const r = await run(
      model({
        entities: [
          { ref: 'e1', name: 'Noah Kim', type: 'person', match: 'k-noah' },
          { ref: 'e2', name: 'Korea', type: 'place', match: 'new' },
        ],
        relationships: [],
      }),
      { lines: [line(1, 'Noah', 'My mother always made Korean food.')] },
    );
    expect(r.entities.map((e) => e.name)).toEqual(['Noah Kim', 'Korea']);
  });

  it('leaves out a person whose name is only the start of a word said', async () => {
    const r = await run(
      model({
        entities: [
          { ref: 'e1', name: 'Noah Kim', type: 'person', match: 'k-noah' },
          { ref: 'e2', name: 'Jae Cho', type: 'person', match: 'new' },
        ],
        relationships: [],
      }),
      { lines: [line(1, 'Noah', 'Jae came with Mrs. Choi.')] },
    );
    expect(r.entities.map((e) => e.name)).toEqual(['Noah Kim']);
    expect(r.stats.left).toContainEqual({
      what: 'Jae Cho',
      why: 'a word of the name is not in the lines',
    });
  });

  it('holds a name to whole words: "sleep" does not give "Lee"', async () => {
    const found = structuredClone(FOUND);
    found.entities[1]!.name = 'Sarah Lee';
    const r = await run(model(found), {
      lines: [...LINES, line(5, 'Noah', 'Sarah could not sleep that night.')],
    });
    expect(r.entities.map((e) => e.name)).not.toContain('Sarah Lee');
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

  it('makes one entity of two that are the same existing one', async () => {
    const found = structuredClone(FOUND);
    found.entities[3]!.match = 'k-mina';
    found.entities.push(
      {
        ref: 'e6',
        name: 'Mina',
        type: 'person',
        match: 'k-mina',
        ways: ['Mom'],
        description: [{ text: 'Mina came from Korea.', cites: ['L4'] }],
      },
      { ref: 'e7', name: 'Noah', type: 'person', match: 'k-noah', ways: [], description: [] },
    );
    found.relationships.push(
      { a: 'e6', b: 'e5', description: 'Mina — made the soup', cites: ['L4'] },
      { a: 'e6', b: 'e4', description: 'Mina — Noah Kim’s mother', cites: ['L4'] },
      { a: 'e7', b: 'e2', description: 'Noah — sat next to Sarah', cites: ['L2'] },
    );
    const mina = {
      id: 'k-mina',
      name: 'Mina Kim',
      type: 'person' as const,
      aliases: ['Mina'],
      note: { noteId: 'n-mina', title: 'Mina Kim' },
    };
    const r = await run(model(found), { known: [NOAH, mina] });
    expect(r.entities.map((e) => e.name)).toEqual([
      'Noah Kim',
      'Sarah',
      'Tom',
      'Noah Kim’s mother',
      'Seaweed soup',
    ]);
    expect(byName(r, 'Noah Kim’s mother')).toMatchObject({
      match: { kind: 'existing', entityId: 'k-mina', name: 'Mina Kim' },
      note: { kind: 'existing', noteId: 'n-mina', title: 'Mina Kim' },
      aliases: ['Mina'],
      ways: ['his mother', 'Mina', 'Mom'],
      description: [
        { text: 'She always made seaweed soup.', sources: L(4) },
        { text: 'Mina came from Korea.', sources: L(4) },
      ],
    });
    expect(byName(r, 'Noah Kim')!.ways).toEqual(['Noah']);
    expect(relOf(r, 'Noah Kim’s mother', 'Seaweed soup')!.description).toBe('Mina — made the soup');
    expect(relOf(r, 'Sarah', 'Noah Kim')!.description).toBe('Sarah — Noah’s friend from school');
    expect(r.relationships).toHaveLength(3);
    expect(r.stats.left).toEqual(
      expect.arrayContaining([
        { what: 'Mina', why: 'the same entity as Noah Kim’s mother' },
        { what: 'Noah', why: 'the same entity as Noah Kim' },
        { what: 'Mina — Noah Kim’s mother', why: 'it joins an entity to itself' },
        { what: 'Noah — sat next to Sarah', why: 'a second relationship for the pair' },
      ]),
    );
    balanced(r);
  });

  it('marks the person the archive is about when found by name, though the AI said "new"', async () => {
    const found = structuredClone(FOUND);
    found.entities[0]!.match = 'new';
    found.entities[0]!.description = [{ text: 'Noah met his friend Sarah.', cites: ['L2'] }];
    const r = await run(model(found), {
      known: [{ ...NOAH, subject: true, note: { noteId: 'n-noah', title: 'Noah Kim' } }],
    });
    expect(byName(r, 'Noah Kim')).toMatchObject({
      match: { kind: 'existing', entityId: 'k-noah', name: 'Noah Kim' },
      subject: true,
      description: [],
    });
  });

  it('keeps at most 60 entities', async () => {
    const names = Array.from(
      { length: 65 },
      (_, i) =>
        `Ka${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`,
    );
    const found = structuredClone(FOUND) as { entities: unknown[]; relationships: unknown[] };
    found.entities.push(...names.map((n, i) => ({ ref: `k${i}`, name: n, type: 'person' })));
    const r = await run(model(found), {
      lines: [...LINES, line(5, 'Noah', `At the fair were ${names.join(', ')}.`)],
    });
    expect(r.entities).toHaveLength(60);
    expect(r.entities.at(-1)!.name).toBe(names[54]);
    expect(r.stats.left).toContainEqual({ what: names[55], why: 'over 60 entities' });
    balanced(r);
  });

  it('keeps at most 20 things, counting those the recall pass adds', async () => {
    const objects =
      'box bell book bowl brush clock coat comb cup desk doll drum fan flag hat jar kite lamp mat mug'.split(
        ' ',
      );
    const found = structuredClone(FOUND) as { entities: unknown[]; relationships: unknown[] };
    found.entities.push(
      ...objects.slice(0, 19).map((t, i) => ({ ref: `t${i}`, name: `the ${t}`, type: 'thing' })),
    );
    const more = {
      entities: [KOREA, { ref: 'e2', name: 'the mug', type: 'thing', match: 'new' }],
      relationships: [],
    };
    const r = await run(model(found, undefined, more), {
      lines: [...LINES, line(5, 'Noah', `We kept a ${objects.join(', a ')}.`)],
    });
    expect(r.entities.filter((e) => e.type === 'thing')).toHaveLength(20);
    expect(byName(r, 'Korea')).toBeDefined();
    expect(r.stats.left).toContainEqual({ what: 'the mug', why: 'over 20 things' });
  });

  it('keeps at most 100 relationships', async () => {
    const guests = 'Ann Ben Cal Dan Eve Fay Gus Hal Ivy Jan Kit Lou Max Ned Oz'.split(' ');
    const found = {
      entities: guests.map((g, i) => ({ ref: `g${i}`, name: g, type: 'person' })),
      relationships: guests.flatMap((g, i) =>
        guests.slice(i + 1).map((h, j) => ({
          a: `g${i}`,
          b: `g${i + j + 1}`,
          description: `${g} — at the party with ${h}`,
          cites: ['L5'],
        })),
      ),
    };
    expect(found.relationships).toHaveLength(105);
    const r = await run(model(found), {
      lines: [...LINES, line(5, 'Noah', `At the party were ${guests.join(', ')}.`)],
    });
    expect(r.relationships).toHaveLength(100);
    expect(r.stats.left!.filter((l) => l.why === 'over 100 relationships')).toHaveLength(5);
    balanced(r);
  });

  it('asks nothing more about a part where nobody tells', async () => {
    const chat = model({
      entities: [{ ref: 'e1', name: 'Noah Kim', type: 'person', match: 'k-noah' }],
      relationships: [],
    });
    await run(chat, { lines: [line(1, 'Interviewer', 'Did you ever go to Korea?')] });
    expect(chat.finds).toHaveLength(1);
  });

  it('passes on a cancel during the recall pass', async () => {
    const base = model(FOUND);
    const stop = new AbortController();
    let finds = 0;
    const chat: ChatModel = {
      id: 'scripted-cancel',
      complete: async (system, user, opts) => {
        if (system.startsWith(FIND_SYSTEM) && ++finds === 2) {
          stop.abort();
          throw new Error('cancelled');
        }
        return base.complete(system, user, opts);
      },
    };
    await expect(run(chat, { signal: stop.signal })).rejects.toThrow('cancelled');
  });

  it('keeps the first answer when the recall pass fails', async () => {
    const base = model(FOUND);
    let finds = 0;
    const chat: ChatModel = {
      id: 'scripted-recall-down',
      complete: async (system, user, opts) => {
        if (system.startsWith(FIND_SYSTEM) && ++finds === 2) {
          throw new ModelError('down', 'unavailable', true);
        }
        return base.complete(system, user, opts);
      },
    };
    const r = await run(chat);
    expect(finds).toBe(2);
    expect(r.entities.map((e) => e.name)).toEqual([
      'Noah Kim',
      'Sarah',
      'Tom',
      'Noah Kim’s mother',
      'Seaweed soup',
    ]);
  });

  it('throws when the judge does', async () => {
    const judge: ChatModel = {
      id: 'scripted-judge-down',
      complete: async () => {
        throw new ModelError('down', 'unavailable', true);
      },
    };
    await expect(run(model(FOUND), { judge })).rejects.toMatchObject({ kind: 'unavailable' });
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

describe('the name rule', () => {
  it('reads whole words, without a "\'s"', () => {
    expect(wordsOf('Sarah’s brother could not sleep.')).toEqual(
      new Set(['sarah', 'brother', 'could', 'not', 'sleep']),
    );
    const said = wordsOf('Sarah could not sleep.');
    expect(nameHeld('Sarah Lee', said, new Set())).toBe(false);
    expect(nameHeld('Sarah Lee', said, new Set(['lee']))).toBe(true);
    expect(nameHeld('Sarah of the Hills', wordsOf('Sarah lived in the hills.'), new Set())).toBe(
      true,
    );
  });
});

describe('the name rule for places named as their people or language', () => {
  const held = (name: string, text: string, asPeople = true) =>
    nameHeld(name, wordsOf(text), new Set(), { asPeople });
  it('finds a place in the word for its people or language', () => {
    expect(held('Korea', 'My mother made Korean food.')).toBe(true);
    expect(held('Japan', 'I went to the Japanese school.')).toBe(true);
    expect(held('Israel', 'He married an Israeli girl.')).toBe(true);
    expect(held('Italy', 'We ate at an Italian place.')).toBe(true);
    expect(held('Brazil', 'Her cousin was Brazilian.')).toBe(true);
  });
  it('knows the words that are not the place with an ending', () => {
    expect(held('China', 'We bought Chinese tea.')).toBe(true);
    expect(held('the Netherlands', 'Her husband was Dutch.')).toBe(true);
    expect(held('Ireland', 'Her grandmother was Irish.')).toBe(true);
  });
  it('finds nothing in a word that only starts the same', () => {
    expect(held('Kim', 'We ate kimchi every day.')).toBe(false);
    expect(held('Korea', 'We had a cup of tea.')).toBe(false);
  });
  it('never reads a person or a thing that way', () => {
    expect(held('Cho', 'Mrs. Choi taught me.', false)).toBe(false);
    expect(held('Al', 'Alan came too.', false)).toBe(false);
    expect(held('Dan', 'She was Danish.', false)).toBe(false);
    expect(held('Korea', 'My mother made Korean food.', false)).toBe(false);
  });
});

describe('uncovered', () => {
  it('gives at most 10 names, or as many as asked', () => {
    const names = Array.from(
      { length: 40 },
      (_, i) => `Ka${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`,
    );
    const text = `We met ${names.join(' and ')}.`;
    expect(uncovered([text], [])).toHaveLength(10);
    expect(uncovered([text], [], 30)).toHaveLength(30);
  });
});

describe('mergeFound', () => {
  const entity = (
    ref: string,
    name: string,
    more: Partial<ProposedEntity> = {},
  ): ProposedEntity => ({
    ref,
    name,
    type: 'person',
    match: { kind: 'new' },
    mentions: [],
    ways: [],
    description: [],
    note: { kind: 'new' },
    ...more,
  });
  const said = (text: string, from: number) => ({
    text,
    sources: [{ interviewId: null, from, to: from }],
  });
  const part = (
    entities: ProposedEntity[],
    relationships: Array<[string, string, string]> = [],
    stats: Partial<FindResult['stats']> = {},
  ): FindResult => ({
    entities,
    relationships: relationships.map(([a, b, description], i) => ({
      ref: `r${i + 1}`,
      a,
      b,
      description,
      story: null,
      sources: [],
    })),
    stats: {
      calls: 1,
      proposed: entities.length + relationships.length,
      dropped: 0,
      left: [],
      ...stats,
    },
  });
  const NOAH_ENTITY = entity('e1', 'Noah Kim', {
    match: { kind: 'existing', entityId: 'k-noah', name: 'Noah Kim' },
    note: { kind: 'existing', noteId: 'n-noah', title: 'Noah Kim' },
    aliases: ['Noah'],
    subject: true,
  });

  it("numbers the parts' entities and relationships as one list", () => {
    const out = mergeFound([
      part([NOAH_ENTITY, entity('e2', 'Sarah')], [['e2', 'e1', 'Sarah — Noah’s friend']]),
      part(
        [entity('e1', 'Busan', { type: 'place' }), entity('e2', 'Tom')],
        [['e2', 'e1', 'Tom — lived in Busan']],
      ),
    ]);
    expect(out.entities.map((e) => [e.ref, e.name])).toEqual([
      ['e1', 'Noah Kim'],
      ['e2', 'Sarah'],
      ['e3', 'Busan'],
      ['e4', 'Tom'],
    ]);
    expect(out.relationships.map((r) => [r.ref, r.a, r.b])).toEqual([
      ['r1', 'e2', 'e1'],
      ['r2', 'e4', 'e3'],
    ]);
    expect(out.stats).toEqual({ calls: 2, proposed: 6, dropped: 0, left: [] });
  });

  it('makes one entity of the same name and type, or of the same existing one, found in two parts', () => {
    const out = mergeFound([
      part([
        NOAH_ENTITY,
        entity('e2', 'Sarah', {
          ways: ['his friend Sarah'],
          description: [said('Sarah sat next to Noah.', 2)],
        }),
      ]),
      part(
        [
          entity('e1', 'Noah', {
            match: { kind: 'existing', entityId: 'k-noah', name: 'Noah Kim' },
            note: { kind: 'existing', noteId: 'n-noah', title: 'Noah Kim' },
            subject: true,
          }),
          entity('e2', 'sarah', {
            ways: ['Sally'],
            description: [said('Sarah moved away.', 9), said('Sarah wrote letters.', 10)],
          }),
          // the same name, but a place: another entity
          entity('e3', 'Sarah', { type: 'place' }),
        ],
        [['e2', 'e1', 'Sarah — Noah’s friend']],
      ),
    ]);
    expect(out.entities.map((e) => [e.ref, e.name, e.type])).toEqual([
      ['e1', 'Noah Kim', 'person'],
      ['e2', 'Sarah', 'person'],
      ['e3', 'Sarah', 'place'],
    ]);
    const sarah = out.entities[1]!;
    expect(sarah.ways).toEqual(['his friend Sarah', 'Sally']);
    expect(sarah.description!.map((d) => d.text)).toEqual([
      'Sarah sat next to Noah.',
      'Sarah moved away.',
      'Sarah wrote letters.',
    ]);
    // the second part's "Noah" is a way to call him
    expect(out.entities[0]!.ways).toEqual(['Noah']);
    expect(out.relationships.map((r) => [r.a, r.b])).toEqual([['e2', 'e1']]);
    // what was joined is counted as left out of the count, so proposed - dropped are kept
    expect(out.stats.proposed - out.stats.dropped).toBe(
      out.entities.length + out.relationships.length,
    );
  });

  it('a later part may say an entity is one the project has', () => {
    const out = mergeFound([
      part([entity('e1', 'Busan', { type: 'place' })]),
      part([
        entity('e1', 'Busan', {
          type: 'place',
          match: { kind: 'existing', entityId: 'k-busan', name: 'Busan' },
          note: { kind: 'existing', noteId: 'n-busan', title: 'Busan' },
          aliases: ['Pusan'],
        }),
      ]),
    ]);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]).toMatchObject({
      match: { kind: 'existing', entityId: 'k-busan' },
      note: { kind: 'existing', noteId: 'n-busan' },
      aliases: ['Pusan'],
    });
  });

  it('keeps one relationship for a pair, across parts', () => {
    const out = mergeFound([
      part([entity('e1', 'Sarah'), entity('e2', 'Tom')], [['e2', 'e1', 'Tom — Sarah’s brother']]),
      part([entity('e1', 'Tom'), entity('e2', 'Sarah')], [['e2', 'e1', 'Sarah — Tom’s sister']]),
    ]);
    expect(out.relationships.map((r) => r.description)).toEqual(['Tom — Sarah’s brother']);
    expect(out.stats.left).toContainEqual({
      what: 'Sarah — Tom’s sister',
      why: 'a second relationship for the pair',
    });
  });

  it('keeps the limits for the whole interview: 60 entities, 20 things, 100 relationships', () => {
    const people = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => entity(`e${i + 1}`, `Person ${from + i}`));
    const things = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) =>
        entity(`e${i + 1}`, `Thing ${from + i}`, { type: 'thing' }),
      );
    const many = mergeFound([part(people(0, 40)), part(people(40, 40))]);
    expect(many.entities).toHaveLength(60);
    expect(many.stats.left).toContainEqual({ what: 'Person 60', why: 'over 60 entities' });
    const stuff = mergeFound([part(things(0, 15)), part(things(15, 15))]);
    expect(stuff.entities).toHaveLength(20);
    // 70 pairs among a part's 30 people, in each of two parts
    const pairs = (n: number): Array<[string, string, string]> =>
      Array.from({ length: 30 }, (_, i) => i)
        .flatMap((i) => Array.from({ length: 30 - i - 1 }, (_, k) => [i, i + k + 1] as const))
        .slice(0, 70)
        .map(([a, b]) => [`e${a + 1}`, `e${b + 1}`, `told ${n}:${a}-${b}`]);
    const told = mergeFound([part(people(0, 30), pairs(1)), part(people(30, 30), pairs(2))]);
    expect(told.entities).toHaveLength(60);
    expect(told.relationships).toHaveLength(100);
    expect(told.relationships.at(-1)!.ref).toBe('r100');
  });
});
