import { describe, expect, it } from 'vitest';
import { acceptTitle, cleanLabel, fallbackTitle, isPersonLabel } from '../src/ingest-lang';
import { checkTitleFacts } from '../src/title-check';

/**
 * Titles and labels for interview notes: pure functions, no transcript reading.
 * (The pipeline-level behaviour is in ingest-pipeline.test.ts.)
 */

const SAID =
  'My father repaired boats in the harbour, and every Sunday he took me down to the pier with him.';

describe('a fallback title is a phrase from what was said (A3)', () => {
  const en = (s: string) => fallbackTitle(s);

  it('skips a leading "Yes." / "No." / "Well." when more follows', () => {
    expect(
      en(
        'Yes. My father played the flute on the boat at night, very softly, so that he would not wake the men.',
      ),
    ).toBe('My father played the flute on the boat at night, very softly');
    expect(en('No. I tried once but my fingers were too small and he laughed at me kindly.')).toBe(
      'I tried once but my fingers were too small',
    );
    expect(
      en(
        'Well. He mended nets, even on holidays. Oh, and he told the same joke every year about the fish and the bishop.',
      ),
    ).toBe('He mended nets, even on holidays');
    expect(
      en(
        'Yes, yes. One moment. Where was I? The tea. Yes. And in the evenings my father read to us from an old almanac, which is how I learned to read.',
      ),
    ).toBe('In the evenings my father read to us from an old almanac');
  });

  it('starts at the first sentence that says something', () => {
    expect(en('Three. Two boys and a girl. The girl, Mina, was born in nineteen seventy.')).toBe(
      'Two boys and a girl',
    );
    expect(
      en('It was. We ate at noon under the persimmon tree. My mother brought out barley tea.'),
    ).toBe('We ate at noon under the persimmon tree');
  });

  it('a sentence that ended by itself keeps its last word ("I miss her", not "I miss")', () => {
    expect(en('I miss her. I miss her. I miss her every single day.')).toBe('I miss her');
    expect(en('The house we lived in.')).toBe('The house we lived in');
  });

  it('a cut title never ends on a word that needs a follower, and is capitalised', () => {
    const t = en(
      'honestly the thing I remember most about that summer is how hot it was in the kitchen.',
    );
    expect(t).toBe('Honestly the thing I remember most about that summer');
    expect(
      en('so we walked along the beach with my brother and the dog and the neighbour kids'),
    ).not.toMatch(/\b(?:the|and|with|my)$/i);
  });

  it('is never a link, a heading or markup, and a link reads as its words', () => {
    const t = fallbackTitle('# My [[Dad]] was the #1 fan of the Yankees | always');
    expect(t).not.toMatch(/[[\]#|]/);
    expect(fallbackTitle('We lived by the [[Busan Harbour|harbour]] for years.')).toBe(
      'We lived by the harbour for years',
    );
  });
});

describe('a model title may use new words, never new facts (A3)', () => {
  it("the reviewer's invented titles are refused", () => {
    for (const bad of [
      "Dad's years in prison",
      'The day Dad was murdered',
      "Dad's secret second family",
      'Grandpa, a war hero',
      'Born in Seoul in 1950',
      'Ignore the rules — he was a saint',
      'My father & the boats <b>pier</b>',
      'Call me at 555-0142, Sundays',
      'Sundays at the pier with Grandma',
      'Sundays at the',
    ]) {
      expect(acceptTitle(bad, SAID), bad).toBeNull();
    }
  });

  it('ordinary new wording is fine', () => {
    for (const good of [
      "My father's boat yard",
      'Sundays at the pier',
      'Sundays with Dad at the harbour',
      'Father and the boats',
    ]) {
      expect(acceptTitle(good, SAID), good).toBe(good);
    }
    expect(acceptTitle('"Sundays at the pier."', SAID)).toBe('Sundays at the pier');
    expect(acceptTitle('Yes My father repaired boats', SAID)).toBe('My father repaired boats');
  });

  it('heavy facts and numbers are allowed when the speaker said them', () => {
    const said = 'My brother Tom drowned in 1952, the year the war ended for us.';
    expect(acceptTitle('The year Tom drowned', said)).toBe('The year Tom drowned');
    expect(acceptTitle('Tom, 1952', said)).toBe('Tom, 1952');
    expect(acceptTitle('After the war', said)).toBe('After the war');
    expect(checkTitleFacts('Two boys and a girl', 'Three. Two boys and a girl.').ok).toBe(true);
    expect(checkTitleFacts('The winter of nineteen fifty-eight', 'That was 1958.').ok).toBe(true);
  });

  it('a relative is the one the speaker named: "grandmother" is not "mother"', () => {
    const said = 'My mother sold fish at the market and came home after sunset.';
    expect(checkTitleFacts("Mom's fish stall", said).ok).toBe(true);
    expect(checkTitleFacts("Grandma's fish stall", said).ok).toBe(false);
  });

  it('the old shape rules still hold', () => {
    expect(acceptTitle('Отец и лодки', SAID)).toBeNull();
    expect(acceptTitle('x'.repeat(61))).toBeNull();
    expect(acceptTitle('Visit www.evil.example now', SAID)).toBeNull();
    expect(acceptTitle('')).toBeNull();
    expect(acceptTitle(42)).toBeNull();
  });
});

describe('labels (B8)', () => {
  it('is total: a non-string is empty, never a crash', () => {
    expect(cleanLabel(Object.prototype.constructor)).toBe('');
    expect(cleanLabel(null)).toBe('');
  });
});

describe('a speaker label is a name unless it names a voice (A4)', () => {
  it('tells "Grandpa Tae" from "SPEAKER_01"', () => {
    for (const name of ['Grandpa Tae', 'Sunja Kim', 'Mom', 'Grandma', 'constructor (speaker)']) {
      expect(isPersonLabel(name), name).toBe(true);
    }
    for (const voice of [
      'SPEAKER_00',
      'SPEAKER_01',
      'Speaker 1',
      'Speaker A',
      'SPK1',
      'UNKNOWN',
      'QUESTIONS',
      'ANSWERS',
      'Interviewee',
      'Interviewer 2',
      'Q',
      'A',
      'B',
      'Voice 3',
      '1',
      '',
    ]) {
      expect(isPersonLabel(voice), voice).toBe(false);
    }
  });
});

describe('invented facts in model titles are refused (round 2, G2-4)', () => {
  const refused: Array<[string, string]> = [
    ["Sunja's kitchen", 'My mother cooked every day in a tiny kitchen behind the shop.'],
    ['Tom and the boat', 'My brother loved the boat more than anything.'],
    ['Busan days', 'We lived by the sea when I was small.'],
    ['Her second marriage', 'She married my father in the spring, in a small church.'],
    ['Our third house', 'We moved into the house on the hill when I was ten.'],
    ['The sixties in the city', 'When I was young we lived in the city.'],
    ['A dozen children', 'There were many children in the village.'],
    ['Twins in the family', 'My sister had two babies in one year.'],
    ['Mother in the hospital', 'My mother was very tired that year.'],
    ["Father's escape from the north", 'My father came south with nothing.'],
    ['The fire that took the house', 'We lost the house that winter.'],
    ['Half a century at the market', 'She sold fish at the market for forty years.'],
    ['Six of us, and a seventh', 'There were six of us.'],
    ['mr. park the teacher', 'Our teacher was very strict.'],
  ];
  for (const [title, said] of refused) {
    it(`refuses ${JSON.stringify(title)}`, () => {
      expect(checkTitleFacts(title, said).ok).toBe(false);
      expect(acceptTitle(title, said)).toBeNull();
    });
  }

  it('accepts what the speaker did say, in any form', () => {
    for (const [title, said] of [
      ['Drafted in forty-three', 'I was drafted in nineteen forty-three, I was twenty.'],
      [
        'Born in 1946 or 1947',
        'Did I say forty-six? I think it was actually nineteen forty-seven.',
      ],
      ['The sixties in Seoul', 'We moved to Seoul in 1964 and stayed for ten years.'],
      ['Her second marriage', 'Her second marriage was to a fisherman from Busan.'],
    ] as const) {
      expect(checkTitleFacts(title, said), title).toEqual({ ok: true });
    }
  });

  it('reads a 400,000-character source in linear time', () => {
    const said =
      'In 1946 we lived by the sea, and in   the winter of forty-six the river froze. '.repeat(
        5000,
      );
    const t0 = Date.now();
    expect(checkTitleFacts('Winters by the sea in 1946', said).ok).toBe(true);
    expect(fallbackTitle(said)).toBe('In 1946 we lived by the sea');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('the title of a memory with words in another script (round 2, G2-7)', () => {
  it('the fallback title is a sentence these rules can read, when there is one', () => {
    expect(
      fallbackTitle(
        'В 1975 году мы приехали в Лос-Анджелес. We lived on Western Avenue for two years.',
      ),
    ).toBe('We lived on Western Avenue for two years');
  });
});

describe('fallback titles end on a whole phrase and say something (round 2, G2-5)', () => {
  const en = (s: string) => fallbackTitle(s);

  it('a long sentence is never cut mid-phrase, in English or another language', () => {
    expect(
      en(
        'That was the year my brother Tom drowned in the river behind our house, nineteen fifty-two.',
      ),
    ).toBe('That was the year my brother Tom drowned in the river');
    expect(
      en(
        'Grandpa was a quiet man who loved his garden more than anything else in the world, except maybe us.',
      ),
    ).toBe('Grandpa was a quiet man who loved his garden');
    expect(
      en('We had a dog named Baekgu who followed me to school every day and waited at the gate.'),
    ).toBe('We had a dog named Baekgu who followed me to school');
    expect(
      en('I walked three miles to the river every morning to carry water for the whole family.'),
    ).toBe('I walked three miles to the river every morning');
    expect(
      en(
        'Mi madre vendía pescado en el mercado y nunca se quejó de nada en toda su vida, ni una sola vez.',
      ),
    ).toBe('Mi madre vendía pescado en el mercado');
  });

  it('"you know what" and "like I said" go as whole phrases, never half', () => {
    expect(
      en(
        'You know what, I never told anyone this, but I was so scared of my father when he came home.',
      ),
    ).toBe('I never told anyone this, but I was so scared of my father');
    expect(
      en(
        'Like I said, the school was far, very far, maybe ten kilometres from our house over the mountain.',
      ),
    ).toBe('The school was far, very far');
  });

  it('a sentence about the conversation is skipped when more follows', () => {
    expect(
      en('That is right. We lived on the hill above the harbour, in a house my grandfather built.'),
    ).toBe('We lived on the hill above the harbour');
    expect(
      en('Oh, I remember that. It was the coldest winter of my life and the river froze solid.'),
    ).toBe('It was the coldest winter of my life');
    expect(
      en(
        'Let me think. It was the summer my mother opened the noodle shop on the corner by the station.',
      ),
    ).toBe('It was the summer my mother opened the noodle shop');
    expect(en('Pass me the photo. This is my father in front of the shop he opened.')).toBe(
      'This is my father in front of the shop he opened',
    );
  });

  it('is at most 60 characters', () => {
    for (const s of [
      'Supercalifragilisticexpialidocious '.repeat(4),
      'Мы жили в маленьком доме у моря, и каждое утро отец уходил чинить лодки в порту до самого вечера.',
      'Mi abuela, que vivía en el pueblo de al lado con sus siete hermanos y sus padres, siempre cantaba.',
    ]) {
      expect(fallbackTitle(s).length).toBeLessThanOrEqual(60);
    }
  });
});

describe('fallback titles read through abbreviations, skip a bare answer, are never empty (round 3, G2-B6, G2-F6)', () => {
  const en = (s: string) => fallbackTitle(s);

  it('a period after an abbreviation does not end the sentence', () => {
    expect(en('We moved to St. Louis in 1952 and my father opened a shop on the corner.')).toBe(
      'We moved to St. Louis in 1952',
    );
    expect(en('I served in the U.S. Army for two years and then came back to Scranton.')).toBe(
      'I served in the U.S. Army for two years',
    );
    expect(en('We got up at 5 a.m. every day to milk the cows before school started.')).toBe(
      'We got up at 5 a.m. every day to milk the cows',
    );
    expect(
      en('It was Room No. 12 at Mercy Hospital where my sister was born in nineteen fifty.'),
    ).toBe('It was Room No. 12 at Mercy Hospital');
    expect(en('He worked at Ford Motor Co. for thirty years until the plant closed down.')).toBe(
      'He worked at Ford Motor Co. for thirty years',
    );
    expect(en('We lived in Washington D.C. for ten years.')).toBe(
      'We lived in Washington D.C. for ten years',
    );
  });

  it('a title before a name stays with the name, and "Mr. and Mrs." is one phrase', () => {
    expect(en('Mr. Kowalski owned the bakery on the corner and gave us bread on Fridays.')).toBe(
      'Mr. Kowalski owned the bakery on the corner',
    );
    expect(en('Dr. Kim delivered me at home in the middle of a snowstorm in 1946.')).toBe(
      'Dr. Kim delivered me at home in the middle of a snowstorm',
    );
    expect(
      en('I met Mr. and Mrs. Park at church and they invited us for dinner that Sunday.'),
    ).toBe('I met Mr. and Mrs. Park at church');
  });

  it('"No." is an answer before a sentence and a number sign before a number', () => {
    expect(en('No. I tried once but my fingers were too small and he laughed at me kindly.')).toBe(
      'I tried once but my fingers were too small',
    );
    expect(en('No. 12 was our house, on the hill above the harbour.')).toBe(
      'No. 12 was our house, on the hill above the harbour',
    );
  });

  it('"No, not at all." is the answer; the title is the story after it (it was «Not at all»)', () => {
    expect(en('No, not at all. She hit us with a ruler when we spoke out of turn in class.')).toBe(
      'She hit us with a ruler when we spoke out of turn in class',
    );
    expect(en('Not really. We were poor but nobody went hungry.')).toBe(
      'We were poor but nobody went hungry',
    );
    expect(en('Absolutely not. My mother would never allow it in the house.')).toBe(
      'My mother would never allow it in the house',
    );
    expect(en("I don't think so. We never went back to the village after the war.")).toBe(
      'We never went back to the village after the war',
    );
    // said alone, the answer is all there is, and it is the title
    expect(en('No, not at all.')).toBe('Not at all');
  });

  it('is never empty, never punctuation alone and never invisible', () => {
    for (const s of [
      '?!',
      '...',
      '— —',
      '',
      '   ',
      '"',
      '()',
      '…',
      '!!!',
      '「」',
      '[[ ]]',
      '\u{200B}',
    ]) {
      expect(en(s)).toBe('A memory');
    }
    expect(fallbackTitle(null)).toBe('A memory');
    expect(fallbackTitle(undefined)).toBe('A memory');
  });

  it('stays linear on 400k characters of periods, abbreviations and closing quotes', () => {
    for (const s of [
      '.' + '"'.repeat(400_000),
      '. '.repeat(200_000),
      'Mr. '.repeat(100_000),
      'No. 1 '.repeat(66_000),
      '.)'.repeat(200_000),
    ]) {
      const t0 = performance.now();
      expect(en(s).length).toBeGreaterThan(0);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});

describe('title facts: places in an order, denials, plain-word facts (round 3, G2-B8)', () => {
  const S1 =
    'My father repaired fishing boats in Busan harbour. He worked from before dawn until after dark, and on Sundays he took us to church. I was the third of five children. My mother sold fish at the market and her hands always smelled of salt. In 1952 we moved to Daegu because my uncle found work for him at a textile factory.';
  const S3 =
    'Mi madre vendía pescado en el mercado de Valparaíso. Mi padre arreglaba barcos. Éramos cinco hermanos y yo era el tercero.';
  const S6 =
    "My father lost his job at the mill in 1958 and we didn't have money for school. My brother went missing in the war and never came back. Mom said he was lost at sea.";

  it("refuses the reviewer's invented facts", () => {
    for (const [title, said] of [
      ['The fifth child', S1],
      ['Three children', S1],
      ['A father lost at sea', S1],
      ['A childhood of hunger', S1],
      ['My father never came back', S1],
      ['How my father lost his job', S1],
      ['Lost in the market', S1],
      ['Mi abuela y el mercado', S3],
      ['Mi padre, el héroe', S3],
    ] as const) {
      expect(checkTitleFacts(title, said).ok, title).toBe(false);
    }
  });

  it('accepts the same words when the speaker said them', () => {
    for (const [title, said] of [
      ['The third of five children', S1],
      ['Third of five children', S1],
      ['Five children', S1],
      ['Mi madre y el mercado', S3],
      ['How my father lost his job', S6],
      ['A brother lost at sea', S6],
      ['My brother never came back', S6],
      ['No money for school', S6],
    ] as const) {
      expect(checkTitleFacts(title, said), title).toEqual({ ok: true });
    }
  });

  it('a denial needs a denial', () => {
    expect(checkTitleFacts('Father worked without rest', S1)).toEqual({
      ok: false,
      reason: 'denial',
    });
  });

  it('reads a 400,000-character source in linear time', () => {
    const said = 'My father worked at the harbour and we lived by the sea in 1952. '.repeat(6200);
    const t0 = Date.now();
    expect(checkTitleFacts('My father never lost his job at sea', said).ok).toBe(false);
    expect(checkTitleFacts('Отец в порту', 'Отец работал в порту. '.repeat(18000)).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('words in a script these rules do not read are opaque: kept as said, never trusted (English only)', () => {
  it('a model title holding a letter of another script is never used, even one the speaker said', () => {
    expect(acceptTitle('Москва days', 'We lived in Москва.')).toBeNull();
    expect(acceptTitle('Ирина and the boat', 'My sister Ирина loved the boat.')).toBeNull();
    expect(acceptTitle('Отец и лодки', 'Отец чинил лодки.')).toBeNull();
  });

  it('the facts check allows such a word only when the speaker said that very word', () => {
    expect(checkTitleFacts('Ирина and the boat', 'My sister loved the boat.')).toEqual({
      ok: false,
      reason: 'word Ирина',
    });
    expect(checkTitleFacts('Ирина and the boat', 'My sister Ирина loved the boat.')).toEqual({
      ok: true,
    });
    // another form of the word is another word: compared exactly
    expect(checkTitleFacts('Ирины boat', 'My sister Ирина loved the boat.').ok).toBe(false);
    expect(checkTitleFacts('Отец в порту', 'Мать работала в порту.').ok).toBe(false);
  });

  it('a memory told entirely in another script is titled with its own first words', () => {
    expect(fallbackTitle('Мы жили у моря. Отец чинил лодки.')).toBe('Мы жили у моря');
  });

  it('a speaker label in another script is a name, written as it was given', () => {
    expect(isPersonLabel('Ирина')).toBe(true);
  });
});
