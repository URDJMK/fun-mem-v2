import { describe, expect, it } from 'vitest';
import {
  compareClaims,
  displayText,
  namesOf,
  norm,
  numbersOf,
  planEdit,
  plainText,
  unitsOf,
  withLines,
  withoutSentence,
} from '../src/claims';
import { spokenNumbersToDigits } from '../src/speech';

describe('spoken numbers', () => {
  it.each([
    ['forty cows', '40 cows'],
    ['forty-two', '42'],
    ['fifteen miles', '15 miles'],
    ['two hundred fifty', '250'],
    ['four layers', '4 layers'],
    ['no one came', 'no one came'],
    ['one day', 'one day'],
  ])('%s -> %s', (from, to) => expect(spokenNumbersToDigits(from)).toBe(to));

  it('numbers keep their kind: a year is not a count', () => {
    expect([...numbersOf('We sold it in nineteen eighty-four for forty dollars')].sort()).toEqual([
      'n40',
      'y1984',
    ]);
  });
});

describe('what a reader sees', () => {
  it('shows alias or title, and drops embeds', () => {
    expect(displayText('and [[My Aunt Mae|Aunt Mae]] baked ![[abc123]] it')).toBe(
      'and Aunt Mae baked  it',
    );
    expect(displayText('and [[Aunt Mae]] baked')).toBe('and Aunt Mae baked');
    expect(displayText('[[Title#Heading]] here')).toBe('Title here');
  });

  it('splits prose into sentences and keeps > lines whole', () => {
    const u = unitsOf(
      'First one. Second one!\n\n> Question: “Why?”\n> From the interview (0:05–0:40)',
    );
    expect(u.map((x) => [x.text, x.quote])).toEqual([
      ['First one.', false],
      ['Second one!', false],
      ['> Question: “Why?”', true],
      ['> From the interview (0:05–0:40)', true],
    ]);
  });
});

describe('names', () => {
  it('finds names mid-sentence and a leading name only before a verb', () => {
    expect([...namesOf('Walt was the one who put the frog there.')]).toEqual(['walt']);
    expect([...namesOf('Later we sold the farm to Eddie in Dunmore.')].sort()).toEqual([
      'dunmore',
      'eddie',
    ]);
    expect([...namesOf('Small. We had it at the Methodist church.')]).toEqual(['methodist']);
  });
});

describe('compareClaims: conflict only when it is clear', () => {
  it('flags a different year for the same event, spoken or written', () => {
    expect(
      compareClaims(
        'We sold the farm in 1982.',
        'We sold the farm in nineteen eighty-four because none of us could keep it going.',
      ).relation,
    ).toBe('conflict');
    expect(
      compareClaims('We had fifty cows and a barn.', 'We had forty cows and a barn.').relation,
    ).toBe('conflict');
  });

  it('does not flag agreement, extra detail, or unrelated sentences', () => {
    expect(
      compareClaims(
        'We sold the farm in 1984.',
        'We sold the farm in nineteen eighty-four because none of us could keep it going.',
      ).relation,
    ).not.toBe('conflict');
    expect(compareClaims('We sold the farm.', 'We sold the farm in 1984.').relation).not.toBe(
      'conflict',
    );
    expect(
      compareClaims(
        'My mother sold fish at the market.',
        'My mother sold fish at the market every morning.',
      ).relation,
    ).toBe('same');
    expect(compareClaims('Tom was born in 1973.', 'Susan was born in 1969.').relation).toBe(
      'unrelated',
    );
  });

  it('finds the disagreement in long sentences, where the rest of the sentence dilutes the overlap', () => {
    expect(
      compareClaims(
        'Well we sold the farm in nineteen eighty-two right after the funeral, I remember it well.',
        'We sold the farm in nineteen eighty-four because none of us could keep it going.',
      ).relation,
    ).toBe('conflict');
    // (one farm: "the cows" may be sold more than once, review round 3 F9)
    expect(
      compareClaims(
        'We moved to Scranton in 1958 and sold the farm in 1959.',
        'We sold the farm in 1962.',
      ).relation,
    ).toBe('conflict');
  });

  it('but not when the clauses are about different things or people', () => {
    expect(
      compareClaims(
        'Susan was born in 1969, in a snowstorm, and Ray drove us to the hospital.',
        'Tom was born in 1973 in July.',
      ).relation,
    ).not.toBe('conflict');
    expect(
      compareClaims(
        'We moved to Scranton in 1958 and my father sold the cows.',
        'My father sold the farm in 1984 and moved to town.',
      ).relation,
    ).not.toBe('conflict');
    expect(
      compareClaims(
        'He was twenty when we left, and we left in 1958 on the early train.',
        'We left in 1958 on the early train to Boston.',
      ).relation,
    ).not.toBe('conflict');
  });

  it('does not flag two different people with the same attribute', () => {
    expect(
      compareClaims('Walt was born in Dunmore in 1944.', 'Eddie was born in Dunmore in 1948.')
        .relation,
    ).not.toBe('conflict');
  });

  it('never compares an age with a year', () => {
    expect(
      compareClaims('He was twenty when we moved to Scranton.', 'We moved to Scranton in 1958.')
        .relation,
    ).not.toBe('conflict');
  });
});

describe('compareClaims: a different number is a conflict only for the SAME fact (review: false "may disagree" markers)', () => {
  // Every one of these was called a conflict, and would have put "⚠ May disagree" on a true
  // memory: different people, different events, different units (review-pipeline claims1/2,
  // review-ai 01 and 13). None may be a conflict.
  it.each([
    ['two parents', 'My mother was born in Daegu in 1905.', 'My father was born in Daegu in 1903.'],
    [
      'two parents, longer',
      'My mother was born in Daegu in 1905, the youngest of six.',
      'My father was born in Daegu in 1903, near the old market.',
    ],
    [
      'two daughters',
      'My first daughter was born in 1955.',
      'My second daughter was born in 1958.',
    ],
    ['two sons', 'My first son was born in 1948.', 'My second son was born in 1951.'],
    [
      'mother / grandmother',
      'My mother came to Seoul in 1950.',
      'My grandmother came to Seoul in 1932.',
    ],
    [
      'brother / sister',
      'My brother Walt was ten when the war started.',
      'My sister was seven when the war started.',
    ],
    ['bought / sold', 'My father bought the farm in 1934.', 'My father sold the farm in 1984.'],
    ['bought / sold (2)', 'My father bought the farm in 1950.', 'My father sold the farm in 1984.'],
    ['born / died', 'My mother was born in Daegu in 1905.', 'My mother died in Daegu in 1990.'],
    [
      'started / retired',
      'My father started at the steel mill in 1950.',
      'My father retired from the steel mill in 1985.',
    ],
    ['married / lost', 'My mother married my father in 1945.', 'My mother lost my father in 1989.'],
    [
      'moved in / out',
      'We moved into the house on Elm Street in 1952.',
      'We moved out of the house on Elm Street in 1970.',
    ],
    [
      'went / came home',
      'My father went to sea when he was 16.',
      'My father came home from sea when he was 40.',
    ],
    [
      'hours / years',
      'My father worked twelve hours a day at the mill.',
      'My father worked at the mill for thirty years.',
    ],
    ['children / grandchildren', 'We had four children.', 'We had five grandchildren.'],
    ['lost whom', 'I lost my husband in 1970.', 'I lost my son in 1975.'],
    ['married whom', 'I married Minho in 1952.', 'I married Jae in 1950.'],
    ['someone else, not "I"', 'My sister married in 1958.', 'Sunja married Minho in 1952.'],
    [
      'someone else, not "I" (2)',
      'My son moved to Seoul in 1980.',
      'Sunja moved to Seoul in 1962.',
    ],
    [
      'two events in one breath',
      'We moved to Scranton in 1958, and the drought came in 1960.',
      'We moved to Scranton in 1958, and the flood came in 1962.',
    ],
    ['around a year', 'We sold the farm around 1984.', 'We sold the farm in 1982.'],
    ['a decade', 'We sold the farm in the 1980s.', 'We sold the farm in 1982.'],
    ['after a year', 'We sold the farm after 1980.', 'We sold the farm in 1982.'],
    ['negated', 'We did not sell the farm in 1984.', 'We sold the farm in 1982.'],
    ['a question', 'Did we sell the farm in 1984?', 'We sold the farm in 1982.'],
    [
      'entered / graduated',
      'I entered school in Busan in 1955.',
      'I graduated from school in Busan in 1961.',
    ],
    // no subject said: these may be two people's sentences (Sunja's interview, and Minho's)
    ['nobody named', 'Born in 1921 in Daegu.', 'Born in 1923 in Daegu.'],
    ['nobody named (2)', 'Sold the farm in 1984.', 'Sold the farm in 1982.'],
    ['1st / 2nd son', 'My 1st son was born in 1948.', 'My 2nd son was born in 1951.'],
    [
      'brothers / brother',
      'My brothers were born in 1940 and 1942.',
      'My brother was born in 1941.',
    ],
    [
      'a move can happen twice',
      'In 1950, my mother moved to Seoul.',
      'My mother moved to Seoul in 1952.',
    ],
  ])('%s', (_label, a, b) => {
    expect(compareClaims(a, b).relation).not.toBe('conflict');
    expect(compareClaims(b, a).relation).not.toBe('conflict');
  });

  // ...and these ARE the same fact told with a different number: they stay conflicts
  it.each([
    ['a year', 'We sold the farm in 1982.', 'We sold the farm in 1984.'],
    ['a birth year', 'My father was born in 1921.', 'My father was born in 1922.'],
    ['a count of children', 'We had four children.', 'We had five children.'],
    ['a count, with more said', 'We had fifty cows and a barn.', 'We had forty cows and a barn.'],
    [
      'a year, written out',
      'I was born in 1946 in Busan.',
      'I was born in nineteen forty-seven in Busan.',
    ],
    // (a move can happen twice, a death cannot: the year is only compared for what happens once)
    ['a leading phrase', 'In 1950, my mother died in Seoul.', 'My mother died in Seoul in 1952.'],
    [
      'a hedged recollection is still a different account',
      'The long drought came and we sold the farm in 1982, I think.',
      'We sold the farm in 1984 after the long drought, and my father cried.',
    ],
    ['a thing, not a person', 'The farm was sold in 1984.', 'The farm was sold in 1982.'],
    ['a birth year, said by "I"', 'I was born in 1931.', 'I was born in 1932.'],
    [
      'a birth year, a place named',
      'My mother was born in Daegu in 1905.',
      'My mother was born in Daegu in 1907.',
    ],
  ])('%s', (_label, a, b) => {
    expect(compareClaims(a, b).relation).toBe('conflict');
    expect(compareClaims(b, a).relation).toBe('conflict');
  });
});

describe('text in a script the English rules do not cover is opaque: kept, compared as written, never a false alarm', () => {
  const RU = 'Мы продали ферму в 1984 году. Потом мы переехали в город.';
  const FOOT = '\n\n> From the interview transcript';

  it('is compared by its own letters and digits: nothing is dropped from what is compared', () => {
    expect(norm('Мы продали ферму в 1984 году!')).toBe('мы продали ферму в 1984 году');
    expect(norm('我们1984年卖了农场。')).toBe('我们1984年卖了农场');
    expect(norm('باعنا المزرعة عام 1984.')).toBe('باعنا المزرعة عام 1984');
    expect(norm(RU)).not.toBe(norm(RU.replace('1984', '1982')));
    expect(unitsOf(RU).map((u) => u.text)).toEqual([
      'Мы продали ферму в 1984 году.',
      'Потом мы переехали в город.',
    ]);
  });

  it('the number check stays quiet: with no rules for the words it cannot tell what the numbers belong to', () => {
    expect(
      compareClaims('Мы продали ферму в 1982 году.', 'Мы продали ферму в 1984 году.').relation,
    ).not.toBe('conflict');
  });

  it('an edit cannot remove or reword it, may add to it, and a changed number is recorded with the original kept', () => {
    const old = `${RU}${FOOT}`;
    expect(planEdit(old, old.replace(' Потом мы переехали в город.', ''))).toMatchObject({
      ok: false,
      kind: 'removed',
    });
    expect(planEdit(old, old.replace('переехали в город', 'уехали в деревню')).ok).toBe(false);
    expect(planEdit(old, old.replace('Потом', 'Зимой было холодно. Потом'))).toMatchObject({
      ok: true,
      corrections: [],
    });
    const p = planEdit(old, old.replace('1984', '1982'));
    expect(p).toMatchObject({
      ok: true,
      corrections: [{ neu: 'Мы продали ферму в 1982 году.', old: 'Мы продали ферму в 1984 году.' }],
    });
    if (p.ok) expect(p.body).toBe(old);
    expect(planEdit(old, RU)).toMatchObject({ ok: false, kind: 'quote-removed' });
    // a script written without spaces between sentences is one unit: never edited in place either
    const zh = '我们1984年卖了农场。后来我们搬到了城里。';
    expect(planEdit(zh, '我们1984年卖了农场。')).toMatchObject({ ok: false, kind: 'removed' });
    expect(planEdit(zh, `${zh} 冬天很冷。`)).toMatchObject({ ok: true, corrections: [] });
  });
});

describe('plain words for a marker', () => {
  it('drops markup and keeps the words a reader sees', () => {
    expect(plainText('Sunja was **born** in ~~Busan~~ <b>Daegu</b>.')).toBe(
      'Sunja was born in Busan Daegu.',
    );
    expect(plainText('[[My Aunt Mae|Aunt Mae]] baked `bread` and _pie_.')).toBe(
      'Aunt Mae baked bread and pie.',
    );
    expect(plainText('# A heading line')).toBe('A heading line');
    expect(plainText('see [the farm](https://x.example) ![](https://x.example/p.png)')).toBe(
      'see the farm',
    );
  });
});

describe('planEdit: add, never replace', () => {
  it('a sentence said twice is two sentences: dropping one copy is removing one (review-pipeline planedit1)', () => {
    const old =
      'He was a good man. He fixed boats all his life. He was a good man.\n\n> From the interview transcript';
    expect(
      planEdit(
        old,
        'He was a good man. He fixed boats all his life.\n\n> From the interview transcript',
      ),
    ).toMatchObject({ ok: false, kind: 'removed' });
    expect(
      planEdit(
        old,
        'He was a good man. He fixed boats all his life. He was a good man. He died in 1989.\n\n> From the interview transcript',
      ).ok,
    ).toBe(true);
    // and repeating a sentence once more is still only an addition
    expect(planEdit(old, old.replace('all his life.', 'all his life. He was a good man.')).ok).toBe(
      true,
    );
  });

  const OLD =
    'We sold the farm in nineteen eighty-four because none of us could keep it going. I still dream about that red barn.\n\n> Question: “When was the farm sold?”\n> From the interview transcript (4:00–4:40)';

  it('accepts an addition, wherever it is put', () => {
    const p = planEdit(OLD, OLD.replace('I still dream', 'Mom moved to town. I still dream'));
    expect(p).toMatchObject({ ok: true, corrections: [] });
  });

  it('turns an in-place correction into a restored original plus a recorded correction', () => {
    const proposed = OLD.replace('nineteen eighty-four', '1982');
    const p = planEdit(OLD, proposed);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.body).toBe(OLD);
    expect(p.corrections).toEqual([
      {
        neu: 'We sold the farm in 1982 because none of us could keep it going.',
        old: 'We sold the farm in nineteen eighty-four because none of us could keep it going.',
      },
    ]);
  });

  it('refuses to reword a sentence', () => {
    const p = planEdit(
      OLD,
      OLD.replace('I still dream about that red barn.', 'I still dream of the old red barn.'),
    );
    expect(p).toMatchObject({ ok: false, kind: 'reworded' });
  });

  it('refuses to remove a sentence, and says why', () => {
    const p = planEdit(OLD, OLD.replace(' I still dream about that red barn.', ''));
    expect(p).toMatchObject({ ok: false, kind: 'removed' });
    if (!p.ok) expect(p.refusal).toMatch(/cannot remove text/);
  });

  it('refuses to remove the source line', () => {
    const p = planEdit(OLD, OLD.split('\n\n')[0]!);
    expect(p).toMatchObject({ ok: false, kind: 'quote-removed' });
  });

  it('a link that keeps the words is fine; one that changes them is not', () => {
    const old = 'We had it at the Methodist church and Aunt Mae baked the cake. Walt gave a toast.';
    expect(planEdit(old, old.replace('Aunt Mae', '[[My Aunt Mae|Aunt Mae]]')).ok).toBe(true);
    expect(planEdit(old, old.replace('Aunt Mae', '[[Aunt Mae]]')).ok).toBe(true);
    expect(planEdit(old, old.replace('Aunt Mae', '[[My Aunt Mae]]'))).toMatchObject({
      ok: false,
      kind: 'reworded',
    });
  });
});

describe('body helpers', () => {
  it('removes a sentence and tidies, and appends > lines to an existing blockquote', () => {
    expect(withoutSentence('One. Two. Three.', 'Two.')).toBe('One. Three.');
    expect(withLines('Text.', ['> a'])).toBe('Text.\n\n> a');
    expect(withLines('Text.\n\n> src', ['> a', '> b'])).toBe('Text.\n\n> src\n> a\n> b');
  });
});
