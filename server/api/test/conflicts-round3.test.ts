import { describe, expect, it } from 'vitest';
import {
  claimUnits,
  compareClaims,
  contentWords,
  displayText,
  factWords,
  norm,
  overlap,
  planEdit,
  plainText,
  quotedIn,
  restates,
} from '../src/claims';
import {
  findConflicts,
  findConflictsInGroups,
  makeRetriever,
  markersFor,
  retrievalQuery,
  tellerVoice,
  type Passage,
} from '../src/conflicts';
import { createNimChat, Semaphore } from '../src/nim';

/**
 * Round-3 regressions for the disagreement check (review round3/reports/C-conflicts.md F1-F14).
 * Every input below is one the reviewer ran.
 */

describe('N-F5: no text can freeze the server (F5: a run of unclosed "[[" took cubic time)', () => {
  // a 4,000-character run of "[[" took 10.6 s in displayText, and 6,000 characters 70 s in
  // compareClaims, with the whole server's event loop blocked
  const SHAPES = [
    '[[',
    '[',
    '![',
    '![[',
    '[[a|',
    '[[a#',
    '[[a^',
    '<a ',
    '“',
    '“a',
    '[a](',
    '_',
    'a_',
    ']]',
  ];
  const READERS: Array<[string, (s: string) => unknown]> = [
    ['displayText', displayText],
    ['plainText', plainText],
    ['norm', norm],
    ['contentWords', contentWords],
    ['quotedIn', quotedIn],
    ['claimUnits', claimUnits],
    ['factWords', factWords],
    ['retrievalQuery', retrievalQuery],
    ['overlap', (s) => overlap(s, 'We sold the farm in 1982.')],
    ['compareClaims', (s) => compareClaims(s, 'We sold the farm in 1982.')],
    ['restates', (s) => restates('We sold the farm in 1982.', s)],
    ['planEdit', (s) => planEdit(s, `${s} A new sentence.`)],
    [
      'markersFor',
      (s) =>
        markersFor(
          { when: '2026-10-19', who: null, channel: 'interview' },
          [],
          [{ claim: s, existing: s, source: { id: 'n', title: 'T' }, by: 'numbers' }],
        ),
    ],
  ];

  it.each(SHAPES)('400,000 characters of %j through every reader', (unit) => {
    const s = unit.repeat(Math.ceil(400_000 / unit.length)).slice(0, 400_000);
    const t0 = Date.now();
    for (const [, read] of READERS) read(s);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a planted note and a claim full of "[[" are checked in milliseconds, end to end', async () => {
    const planted: Passage = {
      id: 'n',
      title: 'Planted',
      text: `${'[['.repeat(200_000)} We sold the farm in 1982.`,
      voice: 'author:me',
    };
    const claim = `My father repaired boats and he said ${'[['.repeat(1000)} and then he sold the farm in nineteen eighty-four.`;
    const t0 = Date.now();
    await findConflictsInGroups({ judge: null, budget: { left: 0 } }, [
      {
        retrieve: async () => [planted],
        claims: [claim, 'We sold the farm in 1984.'],
        voice: 'author:me',
      },
    ]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('well-formed links still read as their words', () => {
    expect(displayText('and [[My Aunt Mae|Aunt Mae]] baked ![[abc123]] it')).toBe(
      'and Aunt Mae baked  it',
    );
    expect(displayText('[[Title#Heading]] and [[Title^block|that]] here')).toBe(
      'Title and that here',
    );
    expect(displayText('an unclosed [[ stays as typed')).toBe('an unclosed [[ stays as typed');
    expect(quotedIn('> ⚠ x: “one” — “two”')).toEqual(['one', 'two']);
  });
});

describe('N-F12: the assistant can record a year correction for any verb (F12: lived/moved/went were refused)', () => {
  it.each([
    ['We lived in Scranton in 1950 and loved it.', 'We lived in Scranton in 1951 and loved it.'],
    ['We moved to Ohio in 1952.', 'We moved to Ohio in 1953.'],
    ['We went to Busan in 1970.', 'We went to Busan in 1971.'],
    ['The church burned down in 1955.', 'The church burned down in 1957.'],
    ['Dad worked at the mill from 1950.', 'Dad worked at the mill from 1952.'],
    ['We had 12 cows.', 'We had 20 cows.'],
    ['My mother was born in 1925.', 'My mother was born in 1926.'],
    ['We sold the farm in nineteen eighty-four.', 'We sold the farm in 1982.'],
  ])('%s -> a correction, the original kept', (old, neu) => {
    const body = `${old}\n\n> From the interview transcript`;
    const p = planEdit(body, `${neu}\n\n> From the interview transcript`);
    expect(p).toMatchObject({ ok: true, corrections: [{ neu, old }] });
    if (p.ok) expect(p.body).toBe(body);
  });

  it('only the format of a number changed: not a correction (no false "disagreement"), and still refused', () => {
    expect(planEdit('We paid 1,500 dollars for it.', 'We paid 1500 dollars for it.')).toMatchObject(
      { ok: false, kind: 'reworded' },
    );
  });

  it('a rewording is still refused, not taken for a correction', () => {
    expect(planEdit('We lived in Scranton in 1950.', 'We stayed in Scranton in 1951.').ok).toBe(
      false,
    );
  });
});

describe('N-F1: what is said of NOW is not compared across two tellings (F1: an age is the first thing an elder says)', () => {
  it.each([
    ['I am 82 years old.', 'I am 85 years old.'],
    ['Grandma is 82 years old.', 'Grandma is 85 years old.'],
    ['Sunja is eighty-two.', 'Sunja is eighty-five.'],
    ['My mother is 90.', 'My mother is 92.'],
    ['I have three grandchildren.', 'I have five grandchildren.'],
    ['I have 4 great-grandchildren now.', 'I have 6 great-grandchildren now.'],
    ['We have 20 cows now.', 'We have 25 cows now.'],
    ['Sunja has two sons and a daughter.', 'Sunja has three sons and a daughter.'],
    ['Mom lives in Ohio with her three cats.', 'Mom lives in Ohio with her two cats.'],
    ["I've got three children.", "I've got four children."],
    ['Dad will be 90 next year.', 'Dad will be 91 next year.'],
    ['She turned 80 last spring.', 'She turned 81 last spring.'],
    ['I will be 83 in March.', 'I will be 86 in March.'],
    [
      'I am 81 years old and I live with my daughter.',
      'I am 82 years old and I live with my daughter.',
    ],
  ])('%s / %s', (a, b) => {
    expect(compareClaims(a, b).relation).not.toBe('conflict');
    expect(compareClaims(b, a).relation).not.toBe('conflict');
  });

  it('...while the same facts told of the PAST still disagree', () => {
    for (const [a, b] of [
      ['Mom had four children.', 'Mom had five children.'],
      ['I was 20 when I married.', 'I was 22 when I married.'],
      ['Now, in 1950 we sold the farm.', 'We sold the farm in 1952.'],
    ])
      expect(compareClaims(a!, b!).relation).toBe('conflict');
  });

  it('end to end: a note "Sunja is 81 years old." and her own "I am 82 years old." a year later', async () => {
    const note: Passage = {
      id: 'n',
      title: 'Sunja Kim',
      text: 'Sunja is 81 years old.',
      voice: 'author:noah',
    };
    const earlier: Passage = {
      id: 'm',
      title: 'At home',
      text: 'I am 81 years old and I live with my daughter.\n\n> From “2025” · told by Grandma Sunja',
      teller: 'Grandma Sunja',
    };
    const [list] = await findConflictsInGroups({ judge: null, budget: { left: 0 } }, [
      {
        retrieve: async () => [note, earlier],
        claims: ['I am 82 years old.', 'I am 82 years old and I live with my daughter.'],
        subject: 'Grandma Sunja',
      },
    ]);
    expect(list).toEqual([]);
  });
});

const innocent = (a: string, b: string) => {
  expect(compareClaims(a, b).relation).not.toBe('conflict');
  expect(compareClaims(b, a).relation).not.toBe('conflict');
};

describe('N-F3: a wish, a plan, hearsay or a condition is not a fact (F3)', () => {
  it.each([
    [
      'Minho wanted to retire in nineteen eighty, but the company asked him to stay.',
      'Minho retired in nineteen eighty-five.',
    ],
    ['My mother wanted six children, but she had four.', 'My mother had four children.'],
    ['Minho hoped to retire in 1980.', 'Minho retired in 1985.'],
    ['Minho planned to retire in 1980.', 'Minho retired in 1985.'],
    ['Minho was going to retire in 1980.', 'Minho retired in 1985.'],
    ['Minho was supposed to retire in 1980.', 'Minho retired in 1985.'],
    ['Minho tried to retire in 1980.', 'Minho retired in 1985.'],
    ['Minho was said to have retired in 1980.', 'Minho retired in 1985.'],
    ['Dad could have died in 1950.', 'Dad died in 1990.'],
    ['Had he lived, Dad would have retired in 1990.', 'Dad retired in 1985.'],
    ['Mom was due to be born in 1930.', 'Mom was born in 1931.'],
    ['Minho meant to retire in 1980.', 'Minho retired in 1985.'],
    ['Minho almost retired in 1980.', 'Minho retired in 1985.'],
    ['Minho wished he had retired in 1980.', 'Minho retired in 1985.'],
    ['I heard that Minho retired in 1980.', 'Minho retired in 1985.'],
    ['Minho was told to retire in 1980.', 'Minho retired in 1985.'],
    ['If Minho had retired early it would have been 1980.', 'Minho retired in 1985.'],
  ])('%s', innocent);

  it('a hedge on one\'s own memory is still a statement ("I think")', () => {
    expect(
      compareClaims('We sold the farm in 1982, I think.', 'We sold the farm in 1984.').relation,
    ).toBe('conflict');
  });
});

describe('N-F2: an approximate number or a bound is not a point (F2)', () => {
  it.each([
    ['Minho worked at the mill for about 30 years.', 'Minho worked at the mill for 32 years.'],
    ['Minho worked at the mill for over 30 years.', 'Minho worked at the mill for 32 years.'],
    ['Minho worked at the mill for around 30 years.', 'Minho worked at the mill for 29 years.'],
    ['My mother was born maybe 1931.', 'My mother was born in 1932.'],
    ['My mother was born in 1931 or so.', 'My mother was born in 1932.'],
    [
      'Minho worked at the mill for more than thirty years.',
      'Minho worked at the mill for 32 years.',
    ],
    ['Minho worked at the mill for at least 30 years.', 'Minho worked at the mill for 32 years.'],
    ['Minho worked at the mill for 30 or so years.', 'Minho worked at the mill for 32 years.'],
    ['Minho worked at the mill for 30 years or so.', 'Minho worked at the mill for 32 years.'],
    ['We had between 4 and 6 children at the table.', 'We had 5 children at the table.'],
    ['We had something like six cows.', 'We had seven cows.'],
    [
      'Minho worked at the mill for 30 years, give or take.',
      'Minho worked at the mill for 32 years.',
    ],
    [
      'Minho worked at the mill for 30 years, more or less.',
      'Minho worked at the mill for 32 years.',
    ],
    [
      'Minho worked at the mill for 30 years or thereabouts.',
      'Minho worked at the mill for 32 years.',
    ],
  ])('%s', innocent);
});

describe('N-F10: a four-digit amount is not a year (F10)', () => {
  it.each([
    ['Minho sold the cow for 2000 won.', 'Minho sold the cow in nineteen fifty.'],
    ['Minho sold the cow for 2000 dollars.', 'Minho sold the cow in 1950.'],
    ['Minho sold the cow for $1900.', 'Minho sold the cow in 1950.'],
    ['We kept 2000 chickens on the farm.', 'We kept chickens on the farm in 1950.'],
    ['They were married for 1950 days.', 'They married in 1960.'],
  ])('%s', innocent);

  it('...while "in 1950" is still a year', () => {
    expect(
      compareClaims('Minho sold the cow in 1950.', 'Minho sold the cow in 1952.').relation,
    ).toBe('conflict');
    // ("that cow": one thing; a bare "sold a cow" may be any cow, review round 3 F9)
    expect(
      compareClaims('Minho sold that cow in 1950.', 'Minho sold that cow in 1952.').relation,
    ).toBe('conflict');
  });
});

describe('labels (F2/F9 neighbours)', () => {
  it.each([
    ['I was in Company 12.', 'I was in Company 14.'],
    ['Grade 5 was hard.', 'Grade 6 was hard.'],
    ['We lived at 25 Main Street.', 'We lived at 52 Main Street.'],
  ])('%s', innocent);
});

describe('N-F13c / N-F14a: only a usable answer wins the judge race, and no reply can crash the check', () => {
  const SUNJA: Passage = {
    id: 'n-sunja',
    title: 'Sunja Kim',
    text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
    voice: 'author:noah',
  };
  const claims = [
    'I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.',
  ];
  const ANSWER = JSON.stringify({
    conflicts: [{ note: 'Sunja Kim', about: 'where she was born', existing: SUNJA.text }],
  });
  const scripted = (replies: Array<() => unknown>) => {
    let n = 0;
    return {
      calls: () => n,
      judge: {
        id: 'j',
        complete: (() => {
          const r = replies[Math.min(n++, replies.length - 1)]!;
          return r();
        }) as never,
      },
    };
  };

  it('a first reply that is empty does not end the race: the duplicate answers and the claim is marked', async () => {
    const s = scripted([() => Promise.resolve(''), () => Promise.resolve(ANSWER)]);
    const [list] = await findConflictsInGroups({ judge: s.judge, budget: { left: 3 } }, [
      { retrieve: async () => [SUNJA], claims, subject: 'Grandma Sunja' },
    ]);
    expect(s.calls()).toBe(2);
    expect(list).toHaveLength(1);
  });

  it('replies that are not text, or a model that throws, are failed calls, never a crash', async () => {
    for (const bad of [
      () => Promise.resolve(undefined),
      () => Promise.resolve(null),
      () => Promise.resolve(42),
      () => {
        throw new Error('sync');
      },
    ]) {
      const s = scripted([bad]);
      const report = { incomplete: false } as import('../src/conflicts').ConflictReport;
      const [list] = await findConflictsInGroups({ judge: s.judge, budget: { left: 3 }, report }, [
        { retrieve: async () => [SUNJA], claims, subject: 'Grandma Sunja' },
      ]);
      expect(list).toEqual([]);
      expect(report).toMatchObject({ incomplete: false, judgeFailed: 1 });
    }
  });
});

describe('N-F4: the judge reads what is about the claim, and the report says why a check fell short (F4)', () => {
  type Judge = import('../src/nim').ChatModel;
  type Report = import('../src/conflicts').ConflictReport;
  const SEED: Passage = {
    id: 'n-sunja',
    title: 'Sunja Kim',
    text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
    voice: 'author:noah',
  };
  const DEMO =
    'I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.';
  const shownIn = (user: string) =>
    [...user.matchAll(/<<<EXISTING \[(.*?)\][^\n]*\n([\s\S]*?)\n<<<END>>>/g)].map((m) => ({
      title: m[1]!,
      first: m[2]!.split(/(?<=[.!?])\s+/)[0]!,
      text: m[2]!,
    }));
  const newIn = (user: string) => /<<<NEW[^\n]*\n([\s\S]*?)\n<<<END>>>/.exec(user)?.[1] ?? '';
  /** answers like a judge would on the demo: Busan against a passage that has her born in Daegu */
  const birthJudge = () => {
    const asked: Array<{ claim: string; titles: string[] }> = [];
    const judge: Judge = {
      id: 'birth',
      complete: async (_s, user) => {
        const shown = shownIn(user);
        asked.push({ claim: newIn(user), titles: shown.map((p) => p.title) });
        const hit = /Busan/.test(newIn(user))
          ? shown.filter((p) => /Daegu/.test(p.text) && /born|Born/.test(p.text))
          : [];
        return JSON.stringify({
          conflicts: hit.map((p) => ({
            note: p.title,
            about: 'where she was born',
            existing: p.first,
          })),
        });
      },
    };
    return { asked, judge };
  };
  /** a judge that accuses every passage it is shown, quoting its first sentence */
  const accuser = (): Judge => ({
    id: 'accuser',
    complete: async (_s, user) =>
      JSON.stringify({
        conflicts: shownIn(user).map((p) => ({
          note: p.title,
          about: 'the same thing',
          existing: p.first,
        })),
      }),
  });

  it('her own name and "those", "there", "were" do not make a sentence about the same thing', async () => {
    // each of these was put to the judge against the seed (sharing "sunja" and "those"/"there"/"were")
    const b = birthJudge();
    const [list] = await findConflictsInGroups({ judge: b.judge, budget: { left: 12 } }, [
      {
        retrieve: async () => [SEED],
        claims: [
          'I loved those Sundays.',
          'There were six of us in two rooms.',
          'I only finished fifth grade.',
          'My father repaired boats.',
          DEMO,
        ],
        subject: 'Grandma Sunja',
      },
    ]);
    expect(b.asked.map((a) => a.claim)).toEqual([DEMO]);
    expect(list).toHaveLength(1);
  });

  it('the demo in a busy archive: the seed is shown first, unrelated sentences are not asked, and the marker is found', async () => {
    // the reviewer's W3 archive: nine short family notes beside the seed; the retriever returns all
    const family: Array<[string, string]> = [
      [
        'Minho Park',
        'Minho married Sunja in nineteen sixty-seven and worked at a printing house in Daegu.',
      ],
      ['Jaesung Kim', 'Jaesung is the brother of Sunja. He kept a bird in a box.'],
      ['Mrs. Han', 'Mrs. Han taught Sunja at school in Busan.'],
      ['Mr. Baek', 'Mr. Baek was a tailor in Daegu who taught Sunja to cut cloth.'],
      ['Busan', 'Busan is a port city. Sunja grew up near the harbour in Busan.'],
      ['Daegu', 'Daegu is a city. Sunja and Minho lived in Daegu above a tailor shop.'],
      ['Textile factory', 'Sunja started at a textile factory at eighteen.'],
      ['Pencil box', 'The pencil box with a crane on the lid belonged to Sunja.'],
      ['Church supper', 'Sunja met Minho at a church supper in Busan.'],
    ];
    const archive: Passage[] = [
      ...family.map(([title, text], i) => ({ id: `n${i}`, title, text, voice: 'author:noah' })),
      SEED,
    ];
    const b = birthJudge();
    const report: Report = { incomplete: false };
    const [list] = await findConflictsInGroups({ judge: b.judge, budget: { left: 12 }, report }, [
      {
        retrieve: async () => archive,
        claims: [
          DEMO,
          'My mother sold fish at the market.',
          'I loved those Sundays.',
          'There were six of us in two rooms.',
          'She could count money faster than anyone I ever met.',
        ],
        subject: 'Grandma Sunja',
      },
    ]);
    expect(b.asked.map((a) => a.claim)).toEqual([DEMO]);
    expect(b.asked[0]!.titles[0]).toBe('Sunja Kim'); // it was crowded out of the four shown
    expect(list!.map((c) => c.source?.title)).toEqual(['Sunja Kim']);
    expect(report).toEqual({ incomplete: false, checked: 5 });
  });

  it("a judge that accuses everything is believed only about a sentence on the claim's topic", async () => {
    const note: Passage = {
      id: 'n-sunja',
      title: 'Sunja Kim',
      text: 'Sunja loved those Sundays at the church. Sunja was born in Daegu in nineteen fifty-two.',
      voice: 'author:noah',
    };
    const [list] = await findConflictsInGroups({ judge: accuser(), budget: { left: 3 } }, [
      { retrieve: async () => [note], claims: [DEMO], subject: 'Grandma Sunja' },
    ]);
    // "Sunja loved those Sundays at the church." shares only her name and "those" with the claim
    expect(list).toEqual([]);
  });

  it('the teller typed in lower case is still the person the archive names', async () => {
    for (const [subject, seed, claim] of [
      ['grandma sunja', SEED, DEMO],
      [
        'sunja kim',
        {
          id: 'k',
          title: 'Sunja',
          text: 'Sunja was born in Daegu in nineteen fifty-two.',
          voice: 'author:noah',
        },
        'I was born in Busan, and it was nineteen forty-six.',
      ],
    ] as const) {
      const b = birthJudge();
      const [list] = await findConflictsInGroups({ judge: b.judge, budget: { left: 3 } }, [
        { retrieve: async () => [seed], claims: [claim, 'We were so happy then.'], subject },
      ]);
      expect(b.asked.map((a) => a.claim)).toEqual([claim]);
      expect(list).toHaveLength(1);
    }
  });

  it('a note that is hers by its title is read too: "Sunja Kim" with no name in the sentence, a memoir titled with her name (F11)', async () => {
    for (const seed of [
      {
        id: 't',
        title: 'Sunja Kim',
        text: 'Born in Daegu in nineteen fifty-two.',
        voice: 'author:noah',
      },
      {
        id: 'm',
        title: 'Grandma Sunja story',
        text: 'I was born in Daegu in nineteen fifty-two and grew up on a farm.',
        voice: 'author:noah',
      },
    ]) {
      const b = birthJudge();
      const [list] = await findConflictsInGroups({ judge: b.judge, budget: { left: 3 } }, [
        { retrieve: async () => [seed], claims: [DEMO], subject: 'Grandma Sunja' },
      ]);
      expect(list!.map((c) => c.source?.title)).toEqual([seed.title]);
    }
    // ...but a note about another Kim is not hers for the family name
    const b = birthJudge();
    await findConflictsInGroups({ judge: b.judge, budget: { left: 3 } }, [
      {
        retrieve: async () => [
          {
            id: 'j',
            title: 'Jaesung Kim',
            text: 'Born in Daegu in nineteen fifty.',
            voice: 'author:noah',
          },
        ],
        claims: [DEMO],
        subject: 'Sunja Kim',
      },
    ]);
    expect(b.asked).toEqual([]);
  });

  it('report.reason says why a check fell short: "ai" over "time" over "budget"', async () => {
    const groups = () => [
      { retrieve: async () => [SEED], claims: [DEMO], subject: 'Grandma Sunja' },
    ];
    const failing: Judge = {
      id: 'down',
      complete: async () => {
        throw new Error('503');
      },
    };
    const report: Report = { incomplete: false };
    await findConflictsInGroups(
      { judge: birthJudge().judge, budget: { left: 0 }, report },
      groups(),
    );
    expect(report).toEqual({ incomplete: false, checked: 1, unjudged: 1, reason: 'budget' });
    await findConflictsInGroups(
      { judge: birthJudge().judge, budget: { left: 3, until: Date.now() - 1 }, report },
      groups(),
    );
    expect(report).toMatchObject({ incomplete: true, reason: 'time' });
    await findConflictsInGroups(
      { judge: failing, budget: { left: 3, hedgeMs: 5 }, report },
      groups(),
    );
    expect(report).toMatchObject({ judgeFailed: 1, reason: 'ai' });
    await findConflictsInGroups(
      { judge: birthJudge().judge, budget: { left: 0 }, report },
      groups(),
    );
    expect(report).toEqual({
      incomplete: true,
      checked: 4,
      unjudged: 2,
      judgeFailed: 1,
      reason: 'ai',
    });
    // nothing missed: no reason at all
    const clean: Report = { incomplete: false };
    await findConflictsInGroups(
      { judge: birthJudge().judge, budget: { left: 3 }, report: clean },
      groups(),
    );
    expect(clean).toEqual({ incomplete: false, checked: 1 });
  });
});

describe('N-F6: two relatives who share a name, or a family word, are not one teller (F6)', () => {
  const told = (tellerA: string, tellerB: string, a: string, b: string) =>
    compareClaims(a, b, { sameTeller: false, sameText: false, tellerA, tellerB }).relation;

  it.each([
    ['Grandma Sunja', 'Aunt Sunja', 'I was born in 1946 in Busan.', 'I was born in 1950 in Busan.'],
    ['Grandpa Joe', 'Uncle Joe', 'My wife died in 1980.', 'My wife died in 1990.'],
    ['Grandpa Joe', 'Cousin Joe', 'My mother was born in 1925.', 'My mother was born in 1950.'],
    ['Joe Sr.', 'Joe Jr.', 'I was born in 1920.', 'I was born in 1950.'],
    ['Joe', 'Joe Jr.', 'I was born in 1920.', 'I was born in 1950.'],
  ])('%s and %s', (a, b, x, y) => {
    expect(told(a, b, x, y)).not.toBe('conflict');
    expect(told(b, a, y, x)).not.toBe('conflict');
  });

  it.each([
    ['Walt', 'Walt Kowalski', 'I was born in 1946.', 'I was born in 1950.'],
    ['walt kowalski', 'Walt Kowalski', 'I was born in 1946.', 'I was born in 1950.'],
    ['José García', 'josé garcía', 'I was born in 1946.', 'I was born in 1950.'],
    ['Grandma Sunja', 'Sunja Kim', 'I was born in 1946.', 'I was born in 1950.'],
  ])('...while %s and %s are one person, told twice', (a, b, x, y) => {
    expect(told(a, b, x, y)).toBe('conflict');
  });

  it('a name with a family word in a note is that person: "Grandma Sunja was born" is the teller Grandma Sunja, not Aunt Sunja (F11 X3/X8)', () => {
    const one = (teller: string, claim: string, note: string) =>
      compareClaims(claim, note, { sameTeller: false, sameText: false, tellerA: teller }).relation;
    const EN = 'Grandma Sunja was born in Daegu in nineteen fifty-two.';
    expect(one('Grandma Sunja', 'I was born in Daegu in nineteen forty-six.', EN)).toBe('conflict');
    expect(one('Aunt Sunja', 'I was born in Daegu in nineteen forty-six.', EN)).not.toBe(
      'conflict',
    );
    // and the teller's own grandmother is not the teller
    expect(
      one('Grandma Sunja', 'My grandmother was born in 1920.', 'Grandma Sunja was born in 1952.'),
    ).not.toBe('conflict');
  });

  it('a mention by part of her names is the teller; her family name alone is not (F11 X2/X6)', () => {
    const one = (teller: string, claim: string, note: string) =>
      compareClaims(claim, note, { sameTeller: false, sameText: false, tellerA: teller }).relation;
    expect(
      one('Sunja Kim', 'I was born in Daegu in 1946.', 'Sunja was born in Daegu in 1952.'),
    ).toBe('conflict');
    expect(
      one('Sunja Kim', 'I was born in Daegu in 1946.', 'Kim was born in Daegu in 1952.'),
    ).not.toBe('conflict');
    expect(
      one('Grandma Sunja', 'I was born in Daegu in 1946.', 'Sunja Park was born in Daegu in 1952.'),
    ).not.toBe('conflict');
  });

  it('"told by Grandma" in the archive and a new teller "Grandma" are not taken to be one person; one interview\'s "Grandma" is', async () => {
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('regexp_split_to_table'))
          return {
            rows: (params[0] as string[]).map((id) => ({
              id,
              kind: 'archive-members',
              quoted: [`> From “Winter 2025” · told by ${id === 'g1' ? 'Grandma' : 'Granny'}`],
            })),
          };
        return {
          rows: [
            {
              note_id: 'g1',
              title: 'Husband',
              content: 'My husband died in nineteen eighty.',
              created_by: 'u',
            },
            {
              note_id: 'g2',
              title: 'Wife',
              content: 'My wife died in nineteen eighty.',
              created_by: 'u',
            },
          ],
        };
      },
    };
    const r = makeRetriever({ pool } as never, 'archive', 'u');
    const got = await r('husband');
    expect(got.map((p) => p.voice)).toEqual([
      `${tellerVoice('Grandma')}#g1`,
      `${tellerVoice('Granny')}#g2`,
    ]);
    const [fromArchive, sameInterview] = await findConflictsInGroups(
      { judge: null, budget: { left: 0 } },
      [
        {
          retrieve: r,
          claims: ['My husband died in nineteen ninety.', 'My wife died in nineteen ninety.'],
          subject: 'Grandma',
        },
        {
          // the same interview's earlier memory: the same "Grandma"
          retrieve: async () => [
            {
              id: 'run:1',
              title: 'Husband',
              text: 'My husband died in nineteen eighty.',
              teller: 'Grandma',
            },
          ],
          claims: ['My husband died in nineteen ninety.'],
          subject: 'Grandma',
        },
      ],
    );
    expect(fromArchive).toEqual([]);
    expect(sameInterview).toHaveLength(1);
  });

  it('the judge is not shown a note told by another relative as hers: "Aunt Sunja" is not "Grandma Sunja"', async () => {
    let asked = 0;
    const judge = {
      id: 'j',
      complete: async () => {
        asked++;
        return '{"conflicts":[]}';
      },
    };
    await findConflictsInGroups({ judge, budget: { left: 3 } }, [
      {
        retrieve: async () => [
          {
            id: 'a',
            title: 'Aunt Sunja',
            text: 'I grew up in Busan.\n\n> From “Winter 2025” · told by Aunt Sunja',
            teller: 'Aunt Sunja',
          },
        ],
        claims: ['I grew up in Daegu on a farm.'],
        subject: 'Grandma Sunja',
      },
    ]);
    expect(asked).toBe(0);
  });
});

describe('the check costs little when there is nothing to weigh a sentence against (lead, round 3)', () => {
  it('a 50,000-character interview against an empty archive is checked in well under the 7 s it took', async () => {
    // as an import does it: each memory's sentences against the archive (empty) and the
    // interview's own earlier memories that share words with it
    const answers = [
      'I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.',
      'My father repaired boats. He had big hands, really big, and he did not talk much at all.',
      'My mother sold fish at the market. She left before dawn and came home after sunset every single day.',
      'We lived in a shack made of scrap boards, and the wind came through the walls in winter.',
      'I only finished fifth grade. My teacher, Mrs. Han, gave me a pencil box as a prize when I left.',
      'At eighteen I started at a textile factory, and I gave my whole pay to my mother.',
      'I met Minho in nineteen sixty-six, at a church supper. We married in June of nineteen sixty-seven.',
      'We moved to Daegu, because Minho had found work at a printing house there.',
    ];
    const memories: string[] = [];
    for (let size = 0, k = 0; size < 50_000;) {
      let body = '';
      while (body.length < 2000) body += `${body ? ' ' : ''}${answers[k++ % answers.length]}`;
      memories.push(body);
      size += body.length;
    }
    const groups = memories.map((m, i) => ({
      retrieve: async () =>
        memories
          .slice(Math.max(0, i - 3), i)
          .map((text, j) => ({ id: `run:${j}`, title: `M${j}`, text, teller: 'Grandma Sunja' })),
      claims: claimUnits(m).map((u) => u.text),
      subject: 'Grandma Sunja',
    }));
    const t0 = Date.now();
    await findConflictsInGroups(
      {
        judge: { id: 'quiet', complete: async () => '{"conflicts":[]}' },
        budget: { left: 12 },
        judgeable: (s) => s !== null && !s.id.startsWith('run:'),
      },
      groups,
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('N-F9: "once in a life" is what happens once, to one person or one thing (F9)', () => {
  it.each([
    ['We bought a car in 1955.', 'We bought a car in 1962.'],
    ['We bought a house in 1960.', 'We bought a house in 1975.'],
    ['We sold the cows in 1950.', 'We sold the cows in 1960.'],
    ['Dad built a barn in 1950.', 'Dad built a barn in 1962.'],
    ['I lost my job in 1980.', 'I lost my job in 1992.'],
    ['We lost a baby in 1955.', 'We lost a baby in 1962.'],
    ['We lost the crop in 1950.', 'We lost the crop in 1951.'],
    ['Our dog died in 1980.', 'Our dog died in 1992.'],
    ['The priest died in 1960.', 'The priest died in 1975.'],
    ['My teacher died in 1960.', 'My teacher died in 1970.'],
    ['We started a business in 1950.', 'We started a business in 1962.'],
    ['Grandpa opened a shop in 1930.', 'Grandpa opened a shop in 1945.'],
    ['I quit smoking in 1980.', 'I quit smoking in 1990.'],
    ['The store closed in 1980.', 'The store closed in 1990.'],
    ['She enrolled in a class in 1960.', 'She enrolled in a class in 1970.'],
    ['My uncle married in 1950.', 'My uncle married in 1965.'],
    ['My sister divorced in 1980.', 'My sister divorced in 1995.'],
    ['My cousin was born in 1950.', 'My cousin was born in 1952.'],
    ['My brother was born in nineteen fifty.', 'My brother was born in nineteen fifty-three.'],
    ['My son was born in 1960.', 'My son was born in 1963.'],
    ['The war ended in 1945.', 'The war ended in 1953.'],
    ['I was 12 when we moved.', 'I was 15 when we moved.'],
    ['I was 16 when I got a job.', 'I was 18 when I got a job.'],
    ['My mother was 20 when she had a baby.', 'My mother was 22 when she had a baby.'],
    ['Dad was 30 when he lost his job.', 'Dad was 40 when he lost his job.'],
    ['He was 12 when he left school.', 'He was 14 when he left school.'],
    ['Minho bought a car in 1960.', 'Minho bought a car in 1970.'],
    ['Minho built a house in 1950.', 'Minho built a house in 1971.'],
    ['Minho got a new job in 1960.', 'Minho got a new job in 1962.'],
    ['Minho divorced in 1970.', 'Minho divorced in 1980.'],
    ['My brother was born in 1950.', 'My brother was born in 1953.'],
  ])('%s', innocent);

  it.each([
    ['We sold the farm in 1982.', 'We sold the farm in 1984.'],
    ['The farm was sold in 1984.', 'The farm was sold in 1982.'],
    [
      'Grandfather bought the farm in 1935 for eight hundred dollars.',
      'Grandfather bought the farm in 1936.',
    ],
    ['The house on Elm Street was built in 1920.', 'The house on Elm Street was built in 1925.'],
    ['I lost my husband in 1980.', 'I lost my husband in 1985.'],
    ['My eldest son was born in 1960.', 'My eldest son was born in 1963.'],
    ['My brother Jaesung was born in 1950.', 'My brother Jaesung was born in 1953.'],
    ['Our oldest son Tom was born in 1968 in a snowstorm.', 'Our oldest son Tom was born in 1969.'],
    ['The Vietnam War ended in 1975.', 'The Vietnam War ended in 1976.'],
    ['The flood of 1972 took our barn and two of the cows.', 'The flood of 1974 took the barn.'],
    ['I started school in 1950.', 'I started school in 1951.'],
    ['I left home at 16.', 'I left home at 17.'],
    [
      'I started working at the factory when I was eighteen.',
      'I started working at the factory when I was sixteen.',
    ],
    [
      'The textile factory in Daegu closed in 1991.',
      'The textile factory in Daegu closed in 1989.',
    ],
    ['Walt joined the army in 1968.', 'Walt joined the army in 1969.'],
    ['Walt was drafted in 1968.', 'Walt was drafted in 1969.'],
    ['My uncle Joe died in 1980 of a heart attack.', 'Uncle Joe died in 1982.'],
    ['Dad retired in 1985.', 'Dad retired in 1987.'],
    ['Father sold that farm in 1984.', 'Father sold that farm in 1982.'],
    ['My eldest son was born in 1970.', 'My eldest son was born in 1971.'],
  ])('...while this is one event told twice: %s', (a, b) => {
    expect(compareClaims(a, b).relation).toBe('conflict');
    expect(compareClaims(b, a).relation).toBe('conflict');
  });
});

describe("N-F8: a sentence that holds the claim's words in other roles is no repeat, and a repeat hides only its own note (F8)", () => {
  const quietJudge = (answer: (user: string) => object) => {
    let asked = 0;
    return {
      asked: () => asked,
      judge: {
        id: 'j',
        complete: async (_s: string, user: string) => {
          asked++;
          return JSON.stringify(answer(user));
        },
      },
    };
  };
  it.each([
    ['Sunja was born in Daegu and moved to Busan when she was ten.', 'I was born in Busan.'],
    ['Dad was born in Busan and died in Daegu in 1985.', 'Dad died in Busan.'],
  ])('%s / %s: the judge is asked, and the claim is marked', async (seedText, claim) => {
    const j = quietJudge(() => ({
      conflicts: [{ note: 'Sunja Kim', about: 'the place', existing: seedText }],
    }));
    const [list] = await findConflictsInGroups({ judge: j.judge, budget: { left: 3 } }, [
      {
        retrieve: async () => [{ id: 's', title: 'Sunja Kim', text: seedText, voice: 'author:x' }],
        claims: [claim],
        subject: 'Grandma Sunja',
      },
    ]);
    expect(j.asked()).toBe(1);
    expect(list).toHaveLength(1);
    expect(restates(claim, seedText)).toBe(false);
  });

  it('the same interview imported before is no reason to keep the seed from the judge (e2e W1)', async () => {
    const claim =
      'I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.';
    const seed: Passage = {
      id: 'seed',
      title: 'Sunja Kim',
      text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
      voice: 'author:x',
    };
    const earlier: Passage = {
      id: 'old',
      title: 'Born in Busan',
      text: `${claim}\n\n> From “Spring 2026” · told by Grandma Sunja (0:03–0:24)`,
      teller: 'Grandma Sunja',
    };
    const shown: string[][] = [];
    const j = quietJudge((user) => {
      shown.push([...user.matchAll(/<<<EXISTING \[(.*?)\]/g)].map((m) => m[1]!));
      return { conflicts: [{ note: 'Sunja Kim', about: 'birth', existing: seed.text }] };
    });
    const [list] = await findConflictsInGroups({ judge: j.judge, budget: { left: 3 } }, [
      { retrieve: async () => [earlier, seed], claims: [claim], subject: 'Grandma Sunja' },
    ]);
    expect(shown).toEqual([['Sunja Kim']]); // the earlier import is not shown: it says the same
    expect(list!.map((c) => c.source?.title)).toEqual(['Sunja Kim']);
    expect(restates(claim, claim)).toBe(true);
    // ...and a repeat of the interview's own earlier memory (never shown) still asks nothing more
    const k = quietJudge(() => ({ conflicts: [] }));
    await findConflictsInGroups(
      {
        judge: k.judge,
        budget: { left: 3 },
        judgeable: (s) => s !== null && !s.id.startsWith('run:'),
      },
      [
        {
          retrieve: async () => [{ ...earlier, id: 'run:1' }, seed],
          claims: [claim],
          subject: 'Grandma Sunja',
        },
      ],
    );
    expect(k.asked()).toBe(0);
  });
});

describe('N-F11: a seed that names her otherwise than the teller label is still hers (F11, e2e part 8)', () => {
  // the judge says nothing here: only the numbers can mark
  const CLAIM = 'I was born in Daegu in nineteen forty-six.';
  it.each([
    ['X1', 'Grandma Sunja', 'Sunja was born in Daegu in nineteen fifty-two.', CLAIM],
    ['X2', 'Sunja Kim', 'Sunja was born in Daegu in nineteen fifty-two.', CLAIM],
    ['X3', 'Grandma Sunja', 'Grandma Sunja was born in Daegu in nineteen fifty-two.', CLAIM],
    ['T10', 'grandma sunja', 'Sunja was born in Daegu in nineteen fifty-two.', CLAIM],
  ])('%s: teller %s, seed %s', async (_label, subject, seed, claim) => {
    const [list] = await findConflictsInGroups(
      { judge: { id: 'silent', complete: async () => '{"conflicts":[]}' }, budget: { left: 3 } },
      [
        {
          retrieve: async () => [{ id: 's', title: 'Sunja Kim', text: seed, voice: 'author:x' }],
          claims: [claim],
          subject,
        },
      ],
    );
    expect(list!.map((c) => c.by)).toEqual(['numbers']);
  });
});

describe('N-F14: a duplicate judge call never queues behind its sibling, and clause pairs are bounded (F14b, F14c)', () => {
  const seed: Passage = {
    id: 'seed',
    title: 'Sunja Kim',
    text: 'Sunja was born in Daegu in nineteen fifty-two and grew up on a farm.',
    voice: 'author:x',
  };
  const claim =
    'I was born in Busan, in a little house near the harbour, I think it was nineteen forty-six, in the spring.';
  const ANSWER = JSON.stringify({
    conflicts: [{ note: 'Sunja Kim', about: 'place and year of birth', existing: seed.text }],
  });
  /** the first request hangs until it is cut off; any later one answers at once */
  const service = () => {
    const sent: number[] = [];
    const t0 = Date.now();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(Date.now() - t0);
      if (sent.length === 1)
        return new Promise<Response>((_res, rej) =>
          init.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        );
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: ANSWER } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  };
  const check = (limiter: Semaphore, fetchImpl: typeof fetch) => {
    const report = { incomplete: false } as import('../src/conflicts').ConflictReport;
    const judge = createNimChat({ apiKey: 'k', fetchImpl, limiter, hedgeMs: 0 })!;
    return findConflicts(
      {
        retrieve: Object.assign(async () => [seed], { voice: 'author:x' }),
        judge,
        subject: 'Grandma Sunja',
        report,
        budget: { left: 3, hedgeMs: 40, timeoutMs: 600 },
      },
      [claim],
    ).then((found) => ({ found, report }));
  };

  it('one slot: the duplicate is not sent at all (it went out at the deadline, only to be cut off), and the check says the AI failed', async () => {
    const s = service();
    const { found, report } = await check(new Semaphore(1), s.fetchImpl);
    expect(s.sent).toHaveLength(1);
    expect(found).toEqual([]);
    expect(report).toMatchObject({ judgeFailed: 1, reason: 'ai' });
  });

  it('every slot busy when it is due, one free soon after: the duplicate goes into it then, and rescues the call', async () => {
    const s = service();
    const limiter = new Semaphore(2);
    const other = await limiter.acquire(undefined, 'normal');
    setTimeout(other, 150);
    const { found } = await check(limiter, s.fetchImpl);
    expect(found).toHaveLength(1);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!).toBeGreaterThanOrEqual(140);
    expect(s.sent[1]!).toBeLessThan(500); // not at the 600 ms deadline
  });

  it('80 clauses against 800 of the same shape: bounded, not 2.6 s (F14c)', () => {
    const mk = (n: number) => `${'Tom bought 5 hens in 1950 and '.repeat(n)}done.`;
    const t0 = Date.now();
    compareClaims(mk(80), mk(800));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
