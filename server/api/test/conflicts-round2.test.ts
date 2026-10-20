import { describe, expect, it } from 'vitest';
import { compareClaims } from '../src/claims';
import {
  findConflicts,
  findConflictsInGroups,
  footerTeller,
  makeRetriever,
  markersFor,
  retrievalQuery,
  tellerVoice,
  type ConflictReport,
  type Passage,
} from '../src/conflicts';
import type { ChatModel } from '../src/nim';

/**
 * Round-2 regressions for the disagreement check (review reports gate-conflicts-client R3, R4,
 * R10, R11 and e2e-behaviour E4, E15). Every input below is one the reviewers ran.
 */

const plain =
  (...p: Passage[]) =>
  async () =>
    p;
/** what makeRetriever hands back for the person writing: their own notes in their own voice */
const own = (...p: Passage[]) =>
  Object.assign(async () => p.map((x) => ({ voice: 'author:me', ...x })), { voice: 'author:me' });
const judgeSaying = (reply: object, seen?: string[]): ChatModel => ({
  id: 'judge',
  complete: async (_s, user) => (seen?.push(user), JSON.stringify(reply)),
});
const none = { judge: null, budget: { left: 0 } };

describe('N-1: a different year is a disagreement only for what happens once (review R3)', () => {
  // round2-gate/pairs.mts: [new claim, existing sentence]. Two true sentences, never marked.
  it.each([
    ['diff person', 'My mother was born in 1925.', 'My father was born in 1926.'],
    ['state verb two years', 'We lived in Scranton in 1950.', 'We lived in Scranton in 1960.'],
    [
      'worked two years',
      'My father worked at the mill in 1950.',
      'My father worked at the mill in 1955.',
    ],
    ['repeatable trip', 'We went to Busan in 1970.', 'We went to Busan in 1975.'],
    ['visited twice', 'We visited Ireland in 1990.', 'We visited Ireland in 1995.'],
    ['two times two counts', 'In 1950 we had 12 cows.', 'In 1960 we had 20 cows.'],
    ['age by year', 'In 1960 my son was five.', 'In 1965 my son was ten.'],
    ['age by year 2', 'My son was five in 1960.', 'My son was ten in 1965.'],
    ['different place', 'We moved to Scranton in 1952.', 'We moved to Ohio in 1960.'],
    [
      'approx',
      'Dad worked at the mill for 30 years.',
      'Dad worked at the mill for about 25 years.',
    ],
    ['unit differs', 'Mom had four children.', 'Mom had five grandchildren.'],
    ['units', 'I was in the hospital for 12 hours.', 'I was in the hospital for 3 days.'],
    [
      'age vs duration',
      'My brother was 12 when he started working.',
      'My brother worked for 30 years.',
    ],
    ['age vs year', 'I left home at 16.', 'I left home in 1962.'],
    ['first/second wife', 'My first wife died in 1970.', 'My second wife died in 1990.'],
    ['husband vs his brother', 'My husband died in 1980.', "My husband's brother died in 1975."],
    ["mother's sister", 'My mother died in 1980.', "My mother's sister died in 1975."],
    ['grandpa/grandma', 'Grandpa came to America in 1910.', 'Grandma came to America in 1912.'],
    ['decade', 'Mom was born in Daegu in 1931.', 'Mom was born in Daegu in the 1930s.'],
    ['bought/sold', 'We bought the house in 1960.', 'We sold the house in 1975.'],
    ['flood vs fire', 'The flood was in 1972.', 'The fire was in 1974.'],
    ['raise twice', 'The boss gave me a raise in 1960.', 'The boss gave me a raise in 1965.'],
    [
      'habit vs one year',
      'Mom made 40 jars of kimchi every winter.',
      'Mom made 50 jars of kimchi in 1970.',
    ],
    ['different times', 'We had 3 dogs when I was little.', 'We had 2 dogs when we moved to Ohio.'],
    ['names', 'My son Jack was born in 1960.', 'My son Tom was born in 1962.'],
    ['different events', 'I was 20 when I married.', 'I was 22 when I had my first child.'],
    ['hours vs years', 'Mom worked 12 hours a day.', 'Mom worked at the factory for 30 years.'],
    ['kids vs at table', 'There were 9 of us kids.', 'There were 11 of us at the table.'],
    // no subject said: these may be two people's sentences
    ['subjectless', 'Moved to Scranton in 1950.', 'Moved to Scranton in 1952.'],
    // said of NOW, true when said (round 3, F1): a grandchild may have been born in between
    ['present count', 'I have 3 grandchildren.', 'I have 5 grandchildren.'],
    // e2e H-long-monologue: a numbered part is a label, and "It" is not a person
    [
      'part N',
      'It stayed with me for all of my life, part 7 of my story.',
      'It stayed with me for all of my life, part 1 of my story.',
    ],
    [
      'a year and a count both differ',
      'We bought the house in 1960 for $8,000.',
      'We bought the house in 1965 for $9,000.',
    ],
  ])('%s', (_label, a, b) => {
    expect(compareClaims(a, b).relation).not.toBe('conflict');
    expect(compareClaims(b, a).relation).not.toBe('conflict');
  });

  // ...and the same fact told differently stays marked (pairs.mts's true pairs that are caught)
  it.each([
    ['TP birth year', 'My mother was born in 1925.', 'My mother was born in 1926.'],
    ['TP duration', 'Dad worked at the mill for 30 years.', 'Dad worked at the mill for 25 years.'],
    ['TP count', 'Mom had four children.', 'Mom had five children.'],
    ['TP age', 'I left home at 16.', 'I left home at 17.'],
    ['TP marriage', 'My wife and I married in 1955.', 'My wife and I married in 1956.'],
    [
      'TP emigrating, with a companion',
      'Grandpa came to America in 1910.',
      'Grandpa came to America in 1912 with his brother.',
    ],
    [
      'TP price',
      'We bought the house in 1960 for $8,000.',
      'We bought the house in 1960 for $9,000.',
    ],
    ['TP same name', 'Jack was born in 1960.', 'Jack was born in 1962.'],
    ['TP age at the wedding', 'I was 20 when I married.', 'I was 22 when I married.'],
    [
      'the factory closed (e2e K14)',
      'The textile factory in Daegu closed in 1991.',
      'The textile factory in Daegu closed in 1989.',
    ],
    ['the flood', 'The flood was in 1972.', 'The flood was in 1974.'],
  ])('%s', (_label, a, b) => {
    expect(compareClaims(a, b).relation).toBe('conflict');
    expect(compareClaims(b, a).relation).toBe('conflict');
  });
  // Not caught, and accepted as misses (a miss leaves two plain sentences; nothing is wrong):
  // "We moved to Ohio in 1952 when I was 6" / "...when I was 7" (a move can repeat), "back then"
  // (which time?), "we had 12 cows" (no subject is named).
});

describe('N-2: another relative\'s "I" is not this teller\'s (review R4)', () => {
  // round2-gate/teller.mts: Eddie's new interview against his brother Walt's
  const WALT: Passage[] = [
    {
      id: 'm-walt',
      title: 'Born in Scranton',
      text: 'I was born in 1950 in Scranton, the youngest of four.\n\n> From “Walt 2026” · told by Walt Kowalski (0:03–0:20)',
      teller: 'Walt Kowalski',
    },
    {
      id: 'm-walt2',
      title: 'My mother',
      text: 'My mother was born in 1928 in Dunmore.\n\n> From “Walt 2026” · told by Walt Kowalski',
      teller: 'Walt Kowalski',
    },
  ];
  const EDDIE = ['I was born in 1946 in Scranton.', 'My mother was born in 1925 in Dunmore.'];

  it('Eddie\'s "I" and "my mother" are not Walt\'s: no marker', async () => {
    const [list] = await findConflictsInGroups(none, [
      { retrieve: plain(...WALT), claims: EDDIE, subject: 'Eddie Kowalski' },
    ]);
    expect(list).toEqual([]);
  });

  it("nor when nobody knows who told the other note (the reviewer's own footer)", async () => {
    const unknown = WALT.map((p) => ({
      ...p,
      teller: undefined,
      text: p.text.replace(/> .*$/m, '> Interview with Walt Kowalski, 2026-03-02.'),
    }));
    const [list] = await findConflictsInGroups(none, [
      { retrieve: plain(...unknown), claims: EDDIE, subject: 'Eddie Kowalski' },
    ]);
    expect(list).toEqual([]);
  });

  it('but the SAME teller contradicting himself across two interviews is marked', async () => {
    const [list] = await findConflictsInGroups(none, [
      {
        retrieve: plain(...WALT),
        claims: ['I was born in 1946 in Scranton.'],
        subject: 'Walt Kowalski',
      },
    ]);
    expect(list).toEqual([
      expect.objectContaining({
        by: 'numbers',
        source: { id: 'm-walt', title: 'Born in Scranton' },
      }),
    ]);
  });

  it('a teller\'s "I" is that teller: Grandma Sunja\'s "I was born in 1946" against a note about Sunja', async () => {
    const SUNJA: Passage = {
      id: 'n-sunja',
      title: 'Sunja Kim',
      text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
      voice: 'author:noah',
    };
    const [list] = await findConflictsInGroups(none, [
      {
        retrieve: plain(SUNJA),
        claims: ['I was born in nineteen forty-six.'],
        subject: 'Grandma Sunja',
      },
    ]);
    expect(list).toEqual([
      expect.objectContaining({ by: 'numbers', source: { id: 'n-sunja', title: 'Sunja Kim' } }),
    ]);
    // somebody else's "I" is not about Sunja
    const [other] = await findConflictsInGroups(none, [
      {
        retrieve: plain(SUNJA),
        claims: ['I was born in nineteen forty-six.'],
        subject: 'Eddie Kowalski',
      },
    ]);
    expect(other).toEqual([]);
  });

  it('"he" in one note is not "he" in another', async () => {
    const found = await findConflicts(
      {
        retrieve: own({ id: 'n1', title: 'Grandpa', text: 'He was born in 1921 in Daegu.' }),
        judge: null,
      },
      ['He was born in 1925 in Daegu.'],
    );
    expect(found).toEqual([]);
    // within the one note being added to, it is
    const same = await findConflicts(
      { retrieve: plain(), judge: null },
      ['He was born in 1925 in Daegu.'],
      {
        thisNote: { id: 'x', title: 'Grandpa', body: 'He was born in 1921 in Daegu.' },
      },
    );
    expect(same).toHaveLength(1);
  });

  it('THE DEMO: "Sunja Kim" (born in Daegu in 1952) against Grandma Sunja\'s "I think it was nineteen forty-six" is marked once, by the judge', async () => {
    // docs/ingest/demo.md step 1 and samples/grandma-sunja-en.json: the first answer, as spoken
    const SUNJA: Passage = {
      id: 'n-sunja',
      title: 'Sunja Kim',
      text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
      voice: 'author:noah',
    };
    const claims = [
      'Um, I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.',
      'My mother always said the fishing boats were coming in the morning I was born, so there was a lot of noise, you know, and the midwife could hardly hear herself think.',
    ];
    // what the real model answered in rehearsal: born elsewhere, another year
    const answer = {
      conflicts: [
        {
          note: 'Sunja Kim',
          about: 'where and when she was born',
          existing: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
        },
      ],
    };
    const seen: string[] = [];
    const report: ConflictReport = { incomplete: false };
    const [list] = await findConflictsInGroups(
      { judge: judgeSaying(answer, seen), budget: { left: 12 }, report },
      [{ retrieve: plain(SUNJA), claims, subject: 'Grandma Sunja' }],
    );
    expect(list).toHaveLength(1); // one marker, though two of her sentences led the judge to it
    expect(list![0]).toMatchObject({ by: 'judge', source: { id: 'n-sunja', title: 'Sunja Kim' } });
    const lines = markersFor(
      { when: '2026-10-19', who: 'Noah', channel: 'interview', teller: 'Grandma Sunja' },
      [],
      list!,
    ).lines;
    expect(lines).toEqual([
      '> ⚠ May disagree with [[Sunja Kim]] · 2026-10-19 · an interview with Grandma Sunja, added by Noah: that note says “Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.”',
    ]);
    expect(seen[0]).toMatch(/^<<<NEW \(told by Grandma Sunja\)>>>/);
    expect(report).toMatchObject({ incomplete: false });
  });

  it('who told a note is read from its footer', () => {
    expect(
      footerTeller(
        'Text.\n\n> Question: “Where?”\n> From “Spring 2026” · told by Grandma Sunja (0:03–0:24)',
      ),
    ).toBe('Grandma Sunja');
    expect(footerTeller('Text.\n\n> From the interview transcript · told by Walt')).toBe('Walt');
    expect(footerTeller('A note written by hand.\n\n> From the interview transcript')).toBeNull();
    expect(tellerVoice('Grandma  Sunja')).toBe(tellerVoice('grandma sunja'));
  });

  it('makeRetriever gives each note its teller (from the footer) or else its author', async () => {
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('regexp_split_to_table'))
          return {
            rows: (params[0] as string[]).map((id) => ({
              id,
              kind: 'archive-members',
              quoted: id === 'a1' ? ['> From “Walt 2026” · told by Walt Kowalski (0:03–0:20)'] : [],
            })),
          };
        return {
          rows: [
            {
              note_id: 'a1',
              title: 'Born in Scranton',
              content: 'I was born in 1950.',
              created_by: 'u-noah',
            },
            { note_id: 'a2', title: 'Mine', content: 'I was born in 1980.', created_by: 'u-noah' },
          ],
        };
      },
    };
    const r = makeRetriever({ pool } as never, 'archive', 'u-noah');
    const got = await r('born');
    expect(got.map((p) => [p.teller ?? null, p.voice])).toEqual([
      ['Walt Kowalski', tellerVoice('Walt Kowalski')],
      [null, 'author:u-noah'],
    ]);
    expect(r.voice).toBe('author:u-noah');
  });
});

describe('N-3: short claims are checked too (review R10)', () => {
  it.each([
    ['Dad died in 1985.', 'Dad died in 1980.'],
    ['Mom was born in 1931.', 'Mom was born in 1930.'],
    ['I was born in 1946.', 'I was born in 1947.'],
    ['Mom had five kids.', 'Mom had six kids.'],
    ['My dad died in 1985.', 'My dad died in 1980.'],
  ])('%s (the same person writing both)', async (claim, existing) => {
    const report: ConflictReport = { incomplete: false };
    const f = await findConflicts(
      { retrieve: own({ id: 'n1', title: 'Family', text: existing }), judge: null, report },
      [claim],
    );
    expect(f).toHaveLength(1);
    const [g] = await findConflictsInGroups({ judge: null, budget: { left: 3 } }, [
      {
        retrieve: own({ id: 'n1', title: 'Family', text: existing }),
        claims: [claim],
        voice: 'author:me',
      },
    ]);
    expect(g).toHaveLength(1);
    expect(report.incomplete).toBe(false);
  });

  it('a short claim about someone named, from anyone', async () => {
    const f = await findConflicts(
      { retrieve: plain({ id: 'n1', title: 'Tom', text: 'Tom died in 1980.' }), judge: null },
      ['Tom died in 1985.'],
    );
    expect(f).toHaveLength(1);
  });

  it('the edit path: a short sentence added to a note that says otherwise', async () => {
    const f = await findConflicts({ retrieve: plain(), judge: null }, ['Dad died in 1985.'], {
      thisNote: { id: 'x', title: 'Dad', body: 'Dad died in 1980.' },
    });
    expect(f).toHaveLength(1);
  });

  it('the search keeps the short words that say who', () => {
    expect(retrievalQuery('Mom was born in 1931.')).toBe('born OR mom');
    expect(retrievalQuery('Dad died in 1985.')).toBe('died OR dad');
    expect(retrievalQuery('Tom died in 1985.')).toBe('died OR tom');
  });
});

describe('N-4: a claim that says MORE than an archive sentence still goes to the judge (review R11)', () => {
  // round2-gate/judge3.mts
  const raw = {
    conflicts: [
      { note: 'Dad', about: 'year of death', existing: 'He died in 1980 in Bethlehem hospital.' },
    ],
  };
  it('"…until he died in Bethlehem in 1985" is not a repeat of "Dad worked at the steel mill in Bethlehem."', async () => {
    const seen: string[] = [];
    const f = await findConflicts(
      {
        retrieve: plain({
          id: 'n',
          title: 'Dad',
          text: 'Dad worked at the steel mill in Bethlehem. He died in 1980 in Bethlehem hospital.',
        }),
        judge: judgeSaying(raw, seen),
      },
      ['Dad worked at the steel mill until he died in Bethlehem in 1985.'],
    );
    expect(seen).toHaveLength(1);
    expect(f).toEqual([
      expect.objectContaining({ by: 'judge', existing: 'He died in 1980 in Bethlehem hospital.' }),
    ]);
  });

  it('a true repeat is still not sent', async () => {
    const seen: string[] = [];
    await findConflicts(
      {
        retrieve: plain({
          id: 'n',
          title: 'Dad',
          text: 'Dad worked at the steel mill in Bethlehem all his life.',
        }),
        judge: judgeSaying({ conflicts: [] }, seen),
      },
      ['Dad worked at the steel mill in Bethlehem.'],
    );
    expect(seen).toHaveLength(0);
  });
});

describe('N-5: every sentence is checked, and "incomplete" means only that time ran out (review E4)', () => {
  // e2e K14: the contradiction in the 8th sentence of one answer was never looked at
  const FACTORY: Passage = {
    id: 'n-f',
    title: 'Daegu textile factory',
    text: 'The textile factory in Daegu closed in 1989.',
  };
  const answer = [
    'My father repaired boats down at the harbour.',
    'He came home smelling of tar every evening.',
    'My mother grew cabbages behind the house.',
    'We slept in one room in winter.',
    'The teacher hit our hands with a ruler.',
    'I walked to the river for water each morning.',
    'My brother sent money from the city.',
    'The textile factory in Daegu closed in 1991.',
  ];

  it('the 8th sentence is compared, and the check is complete', async () => {
    const report: ConflictReport = { incomplete: false };
    const [list] = await findConflictsInGroups({ judge: null, budget: { left: 12 }, report }, [
      { retrieve: plain(FACTORY), claims: answer, subject: 'Grandma' },
    ]);
    expect(list!.map((c) => c.claim)).toEqual(['The textile factory in Daegu closed in 1991.']);
    expect(report).toEqual({ incomplete: false, checked: 8 });
  });

  it('memories share the time: the first sentence of every memory before the second of any', async () => {
    const order: string[] = [];
    const tracked = (name: string) => async (q: string) => (order.push(`${name}:${q}`), []);
    await findConflictsInGroups(none, [
      {
        retrieve: tracked('a'),
        claims: ['Alpha first sentence here.', 'Alpha second sentence here.'],
      },
      {
        retrieve: tracked('b'),
        claims: ['Bravo first sentence here.', 'Bravo second sentence here.'],
      },
    ]);
    expect(order.map((x) => x.split(':')[0] + (x.includes('first') ? '1' : '2'))).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
    ]);
  });

  it('a cut-short check counts what it did not reach, and says time ran out', async () => {
    const ac = new AbortController();
    let n = 0;
    const report: ConflictReport = { incomplete: false };
    const stopAfterTwo = async () => {
      if (++n === 2) ac.abort();
      return [];
    };
    await findConflictsInGroups({ judge: null, budget: { left: 0 }, signal: ac.signal, report }, [
      { retrieve: stopAfterTwo, claims: answer.slice(0, 3) },
      { retrieve: stopAfterTwo, claims: answer.slice(3, 6) },
    ]);
    expect(report).toEqual({ incomplete: true, checked: 1, skipped: 5, reason: 'time' });
  });

  it("the judge's calls go first to claims that share a number with the archive", async () => {
    const seen: string[] = [];
    const NOTE: Passage = {
      id: 'n',
      title: 'Grandma',
      text: 'Sunja grew up on a farm near Daegu and married in 1952.',
    };
    await findConflictsInGroups(
      { judge: judgeSaying({ conflicts: [] }, seen), budget: { left: 1 } },
      [
        { retrieve: plain(NOTE), claims: ['Sunja grew up on a farm near Busan with her aunt.'] },
        {
          retrieve: plain(NOTE),
          claims: ['Sunja married near Daegu in 1952, on a farm, to a teacher.'],
        },
      ],
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Sunja married near Daegu in 1952');
  });
});

describe('N-6: one marker per memory, note and sentence (review E15)', () => {
  it('two sentences of one memory that clash with the same existing sentence give one marker', async () => {
    const NOTE: Passage = {
      id: 'n1',
      title: 'Selling the farm',
      text: 'We sold the farm in 1984.',
      voice: 'speaker:A',
    };
    const [list] = await findConflictsInGroups(none, [
      {
        retrieve: plain(NOTE),
        claims: ['We sold the farm in 1982.', 'Well, we sold the farm in 1980.'],
        voice: 'speaker:A',
      },
    ]);
    expect(list).toHaveLength(1);
    const lines = markersFor(
      { when: '2026-10-19', who: null, channel: 'interview' },
      [],
      list!,
    ).lines;
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("the marker date is the UTC day unless FUNMEM_TZ names the family's zone", () => {
  it('a valid zone wins; none, or one that does not exist, gives the UTC day', async () => {
    const { today } = await import('../src/conflicts');
    const saved = process.env.FUNMEM_TZ;
    const evening = new Date('2026-10-18T16:30:00Z');
    try {
      delete process.env.FUNMEM_TZ;
      expect(today(evening)).toBe('2026-10-18');
      expect(today(new Date('2026-10-18T23:59:00Z'))).toBe('2026-10-18');
      expect(today(new Date('2026-10-19T00:00:00Z'))).toBe('2026-10-19');
      // 05:30 the next morning in Auckland; 22:00 the evening before in New York
      process.env.FUNMEM_TZ = 'Pacific/Auckland';
      expect(today(evening)).toBe('2026-10-19');
      process.env.FUNMEM_TZ = 'America/New_York';
      expect(today(new Date('2026-10-19T02:00:00Z'))).toBe('2026-10-18');
      process.env.FUNMEM_TZ = 'UTC';
      expect(today(evening)).toBe('2026-10-18');
      // a misspelt zone, or an empty one, falls back to UTC
      process.env.FUNMEM_TZ = 'Not/AZone';
      expect(today(evening)).toBe('2026-10-18');
      process.env.FUNMEM_TZ = '';
      expect(today(evening)).toBe('2026-10-18');
    } finally {
      if (saved === undefined) delete process.env.FUNMEM_TZ;
      else process.env.FUNMEM_TZ = saved;
    }
  });
});

describe('every new reader stays linear on 400,000 characters', () => {
  it('compareClaims, factWords, restates, retrievalQuery and footerTeller', async () => {
    const { factWords, restates } = await import('../src/claims');
    const words =
      'My father sold 12 cows in 1984 with his brother Tom part 7 room 12 every winter, '
        .repeat(5000)
        .slice(0, 400_000);
    const digits = '1984 '.repeat(80_000);
    const spaces = `a${' '.repeat(399_998)}b`;
    const t0 = Date.now();
    compareClaims(words, 'My father sold 10 cows in 1980.');
    compareClaims(digits, 'We sold the farm in 1982.');
    compareClaims(spaces, 'We sold the farm in 1982.');
    factWords(words);
    restates(words, 'My father sold the cows.');
    retrievalQuery(words);
    footerTeller(`> From “x” · told by ${'a'.repeat(390)}\n`.repeat(1000));
    footerTeller(`> From ${'·'.repeat(399_990)}`);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
