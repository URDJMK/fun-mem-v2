import { describe, expect, it } from 'vitest';
import { GroundingGate } from '../src/drafts-gate';
import { checkGrounding, type ViolationKind } from '../src/grounding-check';

/**
 * Round 2 of the grounding check: meaning changes a reviewer found it still accepting, and
 * faithful tidy-ups it still refused. Every `refused` case below was ACCEPTED at a9cc143.
 */

const gate = new GroundingGate();
const verdict = (src: string, body: string) =>
  gate.check(
    { title: '', type: 'event', occurred: null, body, notes: [] },
    { text: src, media: null, titles: [] },
  ).accepted !== null;
const refused = (src: string, body: string, kind?: ViolationKind) => {
  const r = checkGrounding(src, body);
  expect(r.violations.length, `should be refused: ${body}`).toBeGreaterThan(0);
  if (kind) expect(r.violations.map((v) => v.kind)).toContain(kind);
  expect(verdict(src, body)).toBe(false);
};
const accepted = (src: string, body: string) => {
  expect(checkGrounding(src, body).violations, `should be accepted: ${body}`).toEqual([]);
};

describe('English: what might have been is not what was, and now is not then', () => {
  it.each([
    ['He could have died in that mine.', 'He died in that mine.'],
    ['They would have shot him if he had run.', 'They shot him if he had run.'],
    ['My father would have been a doctor.', 'My father was a doctor.'],
    ['He may have been forty.', 'He was forty.'],
    ['She must have been sixty when she remarried.', 'She was sixty when she remarried.'],
    ['We will move to Ohio.', 'We moved to Ohio.'],
    ['I should have married him.', 'I married him.'],
    ['I can swim.', 'I swim.'],
    ['My brother would have turned a hundred this year.', 'My brother turned a hundred this year.'],
    ['My mother is still alive.', 'My mother was still alive.'],
    ['She is my wife.', 'She was my wife.'],
    ['He works at the mill.', 'He worked at the mill.'],
  ])('%s -> %s is refused', (src, body) => refused(src, body, 'hedge'));

  it('the same modal or tense written another way still passes', () => {
    accepted("He's the one who built the barn.", 'He is the one who built the barn.');
    accepted("I'd go to the market every day.", 'I would go to the market every day.');
    accepted("I'll never forget it.", 'I will never forget it.');
    accepted('There was five of us kids.', 'There were five of us kids.');
    accepted('We moved to Scranton. That was in 1952.', 'We moved to Scranton in 1952.');
    accepted(
      "My father's name was Walter but everybody called him Walt.",
      'My father was named Walter, but everybody called him Walt.',
    );
    accepted(
      'He would come home late. He would sit by the door.',
      'He would come home late and sit by the door.',
    );
    accepted("We couldn't afford it.", 'We could not afford it.');
  });
});

describe('conditions, restrictions and former spouses are kept, even in a long turn', () => {
  it.each([
    [
      'If my father had come home that night, we would have stayed in Scranton with my grandmother and never moved out to Ohio with the Kowalski family.',
      'My father had come home that night, we would have stayed in Scranton with my grandmother and never moved out to Ohio with the Kowalski family.',
      'hedge',
    ],
    [
      'Unless the mine was closed, my father worked every single day of the week, from early morning until late at night, for the Hudson Coal Company.',
      'The mine was closed, my father worked every single day of the week, from early morning until late at night, for the Hudson Coal Company.',
      'hedge',
    ],
    [
      'My ex-husband Frank worked at the steel mill in Bethlehem for twenty years and then he moved to Florida with his second wife.',
      'My husband Frank worked at the steel mill in Bethlehem for twenty years and then he moved to Florida with his second wife.',
      'person',
    ],
    ['My first wife died in 1970.', 'My wife died in 1970.', 'person'],
    ['My late husband loved to fish.', 'My husband loved to fish.', 'person'],
    ['We only had one cow.', 'We had one cow.', 'hedge'],
  ] as const)('%s', (src, body, kind) => refused(src, body, kind));

  it('the same words kept, or written another way, still pass', () => {
    accepted('My ex-husband drank a lot.', 'My former husband drank a lot.');
    accepted('If it rained we stayed home.', 'If it rained, we stayed home.');
  });
});

describe('an unchanged copy always passes', () => {
  it.each([
    'He fought in World War Two.',
    'My father was wounded in World War One, in France.',
    'We drove out on Route Sixty-Six.',
    'We lived at Number Ten Downing Lane.',
    'My son Jack was born in Room Twelve of Mercy Hospital.',
    'He worked for Ford Motor Company for Thirty Years, as he liked to say.',
  ])('%s', (text) => accepted(text, text));
});

describe('time grows with the text, not with its square', () => {
  const ms = (f: () => void): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  it('20,000 negations, and 20,000 mismatched ones in English and in another script, each under 1 s', () => {
    const nots = Array.from(
      { length: 20000 },
      (_, i) => `I did not go ${i % 3 ? 'there' : 'home'}.`,
    ).join(' ');
    const notsDiff = Array.from(
      { length: 20000 },
      (_, i) => `I did not go ${i % 3 ? 'home' : 'there'}.`,
    ).join(' ');
    const other = Array.from(
      { length: 20000 },
      (_, i) => `Я не ${['пошёл', 'ел', 'спал'][i % 3]}.`,
    ).join(' ');
    const other2 = Array.from(
      { length: 20000 },
      (_, i) => `Я не ${['ел', 'спал', 'пошёл'][i % 3]}.`,
    ).join(' ');
    expect(ms(() => checkGrounding(nots, nots))).toBeLessThan(1000);
    let en: ReturnType<typeof checkGrounding> | null = null;
    expect(ms(() => (en = checkGrounding(nots, notsDiff)))).toBeLessThan(1000);
    let r: ReturnType<typeof checkGrounding> | null = null;
    expect(ms(() => (r = checkGrounding(other, other2)))).toBeLessThan(1000);
    // and a hostile text gets a few violations, never one per sentence
    expect(en!.violations.length).toBeLessThan(20);
    expect(r!.violations.length).toBeGreaterThan(0);
    expect(r!.violations.length).toBeLessThan(20);
  });
  it('400,000 characters of spoken numbers stay linear', () => {
    const t = Array.from({ length: 32000 }, (_, i) =>
      i % 2 ? 'thirty years' : 'twelve years old',
    ).join(' ');
    expect(t.length).toBeGreaterThan(390_000);
    expect(ms(() => checkGrounding(t, t))).toBeLessThan(3000);
  });
});

/**
 * Round 3, B2: a long turn could lose 10% of its words, and the words that went were the ones
 * that say who it came from, how often and how far ("I heard that", "sometimes", "in my
 * dream"). Every `refused` case below was ACCEPTED at e94173c.
 */
describe('a long turn keeps who said it, how often, how far, and every short sentence', () => {
  const lead = (x: string) =>
    `${x} my uncle died in Ohio in 1947, and the whole family took the train from Scranton to the funeral, which was held in the church by the river.`;
  const adv = (x: string) =>
    `When the war started in 1943, my father, who had worked at the mill in town for many years, ${x} brought home bread and sugar for the whole family every Friday after work.`;
  const without = (f: (x: string) => string) =>
    f('')
      .replace(/\s{2,}/g, ' ')
      .replace(/^\s+/, '')
      .replace(/^my/, 'My');

  it.each([
    'I heard that',
    'They say that',
    'I was told that',
    'I dreamed that',
    'I imagined that',
    'I thought that',
    'In my dream,',
    'It is said that',
    'Rumor has it that',
    'I read that',
    'To my knowledge,',
  ])('"%s ..." is not the fact itself', (frame) => refused(lead(frame), without(lead), 'hedge'));

  it.each([
    'sometimes',
    'usually',
    'often',
    'always',
    'rarely',
    'seldom',
    'occasionally',
    'frequently',
    'still',
    'already',
    'also',
    'first',
    'later',
    'barely',
    'merely',
    'partly',
    'reportedly',
    'allegedly',
    'evidently',
    'seemingly',
    'secretly',
    'instead',
    'suddenly',
  ])('"%s" is kept in a long turn', (w) => refused(adv(w), without(adv)));

  it.each([
    'He died.',
    'She cried.',
    'I was scared.',
    'We were poor.',
    'He hit us.',
    'He was arrested.',
    'It was a lie.',
    'I hated him.',
  ])('the one-word sentence "%s" is not dropped from a long turn', (d) => {
    const head =
      'My father worked in the mine six days a week for the Hudson Coal Company and my mother raised chickens behind the house.';
    const tail =
      'In the winter we burned coal that my brother carried home from the railroad yard in a wheelbarrow, and on Sundays we walked to the church by the river.';
    refused(`${head} ${d} ${tail}`, `${head} ${tail}`, 'dropped');
  });

  it('...but "you know", "I mean", "like I said" and "first of all" may go, and too is also', () => {
    accepted('You know, we lived on a farm.', 'We lived on a farm.');
    accepted(
      'We lived on a farm, you know, and it was hard work, you know.',
      'We lived on a farm, and it was hard work.',
    );
    accepted('I was sick, I mean really sick, for a year.', 'I was sick, really sick, for a year.');
    accepted(
      'Like I said, my father worked in the mine for the Hudson Coal Company for thirty years.',
      'My father worked in the mine for the Hudson Coal Company for thirty years.',
    );
    accepted(
      'First of all, my father worked in the mine for the Hudson Coal Company for thirty years.',
      'My father worked in the mine for the Hudson Coal Company for thirty years.',
    );
    accepted('My brother came to the funeral too.', 'My brother also came to the funeral.');
    accepted(
      'I heard that my uncle died in Ohio in 1947.',
      'I heard my uncle died in Ohio in 1947.',
    );
    // an intensifier is still one in ten: "I just got married" is not "I got married"
    refused('I just got married.', 'I got married.', 'dropped');
    refused('I even sold my ring.', 'I sold my ring.', 'dropped');
  });

  it('end to end, a model that drops the frame gets the turn saved word for word', async () => {
    const { ingestTranscript } = await import('../src/ingest-pipeline');
    const strip: Array<[RegExp, string]> = [
      [/\bI heard that /g, ''],
      [/\bI dreamed that /g, ''],
      [/\bsometimes /g, ''],
      [/\bbarely /g, ''],
    ];
    const chat = {
      id: 'tidy',
      complete: async (_s: string, u: string) =>
        JSON.stringify({
          memories: u.split('\n').flatMap((l) => {
            const m = /^\[(\d+)(?:\|[^\]]*)?\] ([\s\S]*)$/.exec(l);
            if (!m) return [];
            let b = m[2]!;
            for (const [re, to] of strip) b = b.replace(re, to);
            return [{ turns: [Number(m[1])], title: '', body: b }];
          }),
        }),
    };
    const said = [
      'I heard that my uncle died in Ohio in 1947, and the whole family took the train from Scranton to the funeral, which was held in the church by the river.',
      'I dreamed that my brother Tom came home from the war in 1943, and the next morning my mother set the table for him and we waited all day by the window.',
      'My father barely survived the mine collapse in 1938, and he sometimes drank until dawn while my mother raised chickens behind the house.',
    ];
    const text = said.flatMap((t, i) => [`Noah: Question ${i + 1}?`, `Grandma: ${t}`]).join('\n');
    const out = await ingestTranscript(
      text,
      { interviewees: ['Grandma'] },
      {
        chat: chat as never,
        titles: [],
      },
    );
    expect(out.memories.map((m) => m.method)).toEqual(said.map(() => 'verbatim'));
  });

  it('400,000 characters of frames, frequencies, asides and one-word sentences stay linear, and a dropped one is caught', () => {
    const parts = [
      'In my dream I sometimes still heard a rumor that maybe my brother came.',
      'You know, I heard that he sometimes still came too.',
      'Like I said, first of all, I mean, it was over.',
      'He died.',
      'We were scared.',
    ];
    const t = Array.from({ length: 10_000 }, (_, i) => parts[i % parts.length]).join(' ');
    expect(t.length).toBeGreaterThan(390_000);
    const dropped = t.replaceAll(' He died.', '');
    const t0 = performance.now();
    const copy = checkGrounding(t, t);
    const r = checkGrounding(t, dropped);
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(copy.violations).toEqual([]);
    expect(r.violations.map((v) => v.kind)).toContain('dropped');
  });
});

/**
 * Round 3, B4: joining sentences may add "and", never a cause, a contrast or an order; the
 * sentences stay in the order they were said, each said once; "to" stays "to". Every
 * `refused` case below was ACCEPTED at e94173c.
 */
describe('no cause, contrast, order or direction the speaker did not say', () => {
  const unsupported = (src: string, body: string) => refused(src, body, 'unsupported_sentence');

  it.each([
    ['He drank. She left.', 'He drank, so she left.'],
    ['My father lost his job. We moved to Ohio.', 'My father lost his job, but we moved to Ohio.'],
    ['My father lost his job. We moved to Ohio.', 'My father lost his job, so we moved to Ohio.'],
    ['I got sick. I missed school.', 'I got sick, so I missed school.'],
    ['I quit school. I got married.', 'I quit school and then I got married.'],
    ['We were poor. We were happy.', 'We were poor, but we were happy.'],
    ['I walked to school.', 'So I walked to school.'],
    ['I walked to school.', 'Then I walked to school.'],
    ['We were so poor. We had nothing.', 'We were so poor, so we had nothing.'],
  ])('a link the speaker did not make: %s -> %s', unsupported);

  it('...but "and", a comma, a full stop, and the links they did make, still pass', () => {
    accepted('He drank. She left.', 'He drank and she left.');
    accepted('He drank. She left.', 'He drank, and she left.');
    accepted('So, yeah, we left.', 'So we left.');
    accepted(
      'We got married in 1960. Then we moved to Ohio.',
      'We got married in 1960, and then we moved to Ohio.',
    );
    accepted('We moved because the mine closed.', 'Because the mine closed, we moved.');
    accepted('After the war ended, we moved to Ohio.', 'We moved to Ohio after the war ended.');
    accepted('We moved to Ohio when I was ten.', 'When I was ten, we moved to Ohio.');
    accepted('We were poor back then.', 'We were poor back then.');
  });

  it.each([
    ['My father died. We moved to Ohio.', 'We moved to Ohio. My father died.'],
    [
      'I was born in Busan. My family moved to Seoul.',
      'My family moved to Seoul. I was born in Busan.',
    ],
    ['He drank. She left.', 'She left. He drank.'],
    ['The mine closed. My father lost his job.', 'My father lost his job. The mine closed.'],
    ['We moved because the mine closed.', 'The mine closed because we moved.'],
    ['She left because he drank.', 'He drank because she left.'],
    ['I was scared, so I ran.', 'I ran, so I was scared.'],
    ['I got a letter and then I left.', 'I left and then I got a letter.'],
    [
      'First I worked in the fields, then I went to school.',
      'First I went to school, then I worked in the fields.',
    ],
  ])('not in the order it was said: %s -> %s', unsupported);

  const S =
    'I was born in Busan. We lived near the harbour. My father repaired boats and my mother sold fish.';
  it.each([
    [S, `${S} We lived near the harbour.`],
    [S, `We lived near the harbour. ${S}`],
    [S, `${S} ${S}`],
    [
      S,
      'I was born in Busan. We lived near the harbour. We lived near the harbour. My father repaired boats and my mother sold fish.',
    ],
    [
      'We moved to Ohio. My father found work.',
      'We moved to Ohio. We moved to Ohio. My father found work.',
    ],
    ['He drank. She left.', 'He drank. She left. He drank.'],
    ['My father hit me.', 'My father hit me. My father hit me.'],
  ])('said once, written twice: %s -> %s', unsupported);

  it('...but what was said twice may be written twice, and a moved phrase is no new order', () => {
    const twice = 'My father was a miner. My mother sold fish. My father was a miner, too.';
    accepted(twice, twice);
    accepted('In 1950, we moved to Ohio.', 'We moved to Ohio in 1950.');
    accepted(
      'My father, who worked in the mine, died young.',
      'My father worked in the mine. He died young.',
    );
    accepted(
      'I married Tom in 1960 and we had three kids.',
      'In 1960 I married Tom, and we had three kids.',
    );
    accepted(
      'We lived in a small house. My father built it himself.',
      'We lived in a small house that my father built himself.',
    );
  });

  it.each([
    ['He moved to Boston.', 'He moved from Boston.'],
    ['We went to Ohio.', 'We went from Ohio.'],
    ['She came from Seoul.', 'She came to Seoul.'],
    ['I went with my mother.', 'I went to my mother.'],
    ['We walked to the river.', 'We walked from the river.'],
    ['I worked for the Smiths.', 'I worked with the Smiths.'],
    ['I worked at the mill.', 'I worked for the mill.'],
    ['My father was hit by a car.', 'My father was hit with a car.'],
    ['I stayed with my aunt.', 'I stayed at my aunt.'],
    ['The letter was from my father.', 'The letter was to my father.'],
    ['The money was for my mother.', 'The money was from my mother.'],
    ['She gave the ring to me.', 'She gave the ring from me.'],
  ])('where to and where from: %s -> %s', unsupported);

  it('...but in and at are one, and "to" and "from" may trade places in the sentence', () => {
    accepted('I worked in the mill.', 'I worked at the mill.');
    accepted('She came to America from Korea.', 'She came from Korea to America.');
  });

  it('400,000 characters of joined, reordered and repeated sentences stay linear', () => {
    const parts = [
      'My father died in the war.',
      'We moved to Ohio with my mother.',
      'He drank, so she left.',
      'My father died, so we moved to Boston.',
      'I went to school and studied hard.',
    ];
    const t = Array.from({ length: 12_500 }, (_, i) => parts[i % parts.length]).join(' ');
    expect(t.length).toBeGreaterThan(390_000);
    const reversed = t
      .split(/(?<=[.!?])\s+/)
      .reverse()
      .join(' ');
    const t0 = performance.now();
    expect(checkGrounding(t, t).violations).toEqual([]);
    const r = checkGrounding(t, reversed);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.violations.map((v) => v.kind)).toContain('unsupported_sentence');
    expect(r.violations.length).toBeLessThan(20);
  });
});

/**
 * Round 3, B3: the speaker is "I". A rewrite that tells the memory as a biography ("He was
 * born in Busan and his father was a miner") or addresses it to someone ("You went") is not
 * the speaker's. Every `refused` case below was ACCEPTED at e94173c.
 */
describe('the speaker stays "I", and nobody becomes "he" or "you" by a guess', () => {
  const said = [
    'I was born in Busan and my father was a miner.',
    'My mother sold fish at the market and I helped her every morning.',
    'I grew up with my brother and my two sisters in a small house by the harbour.',
    'My grandmother raised me after my father died in the mine, and I never forgot her kindness.',
    'I married my husband in 1968, and we moved to Ohio where my uncle found him a job.',
    'When I was ten my mother took me to the city and I saw the sea for the first time.',
    'We lived with my aunt until I finished school, and then I went to work in the factory.',
    'My son was born in 1972 and my daughter two years later, and I stayed home to raise them.',
  ];
  const as = (who: 'he' | 'she') => (x: string) =>
    x
      .replace(/\bI was\b/g, `${who === 'he' ? 'He' : 'She'} was`)
      .replace(/\bI\b/g, who)
      .replace(/\bmy\b/gi, (m) =>
        m[0] === 'M' ? (who === 'he' ? 'His' : 'Her') : who === 'he' ? 'his' : 'her',
      )
      .replace(/\bme\b/g, who === 'he' ? 'him' : 'her')
      .replace(/\bwe\b/gi, (m) => (m[0] === 'W' ? 'They' : 'they'));
  it.each(said)('"%s" told as "he" or as "she" is refused', (x) => {
    refused(x, as('he')(x), 'person');
    refused(x, as('she')(x), 'person');
  });

  it.each([
    ['My mother sold fish.', 'Her mother sold fish.'],
    ['My mother sold fish.', 'His mother sold fish.'],
    ['My mother sold fish and I helped her.', 'Her mother sold fish and she helped her.'],
    ['I went to Busan.', 'You went to Busan.'],
  ])('%s -> %s is refused', (src, body) => refused(src, body, 'person'));

  it('...but a pronoun for a person the speaker named, where the name was, still passes', () => {
    accepted(
      'My mother sold fish. My mother left before dawn.',
      'My mother sold fish. She left before dawn.',
    );
    accepted(
      'My father repaired boats and had big hands.',
      'My father repaired boats. He had big hands.',
    );
    accepted(
      'My first husband died. My first husband was kind.',
      'My first husband died. He was kind.',
    );
    accepted(
      'My mother ran the store. She kept the books.',
      'My mother ran the store and kept the books.',
    );
    accepted('You know, we lived on a farm.', 'We lived on a farm.');
  });
});

/** Round 3, B10: "have done" and "was doing" are kept like a tense (accepted at e94173c). */
describe('the perfect and the progressive are kept', () => {
  it.each([
    ['I have lived here for fifty years.', 'I lived here for fifty years.'],
    ["I've lived here since 1960.", 'I lived here since 1960.'],
    ['She has worked there for years.', 'She worked there for years.'],
    ['He was working there.', 'He worked there.'],
    ["He'd been drinking.", 'He was drinking.'],
    ['We had moved to Ohio by then.', 'We moved to Ohio by then.'],
  ])('%s -> %s is refused', (src, body) => refused(src, body, 'hedge'));

  it('...and written the same way, or merged, they still pass', () => {
    accepted("I've lived here since 1960.", 'I have lived here since 1960.');
    accepted(
      'We were living in Ohio when the war started.',
      'We were living in Ohio when the war started.',
    );
    accepted(
      'My father was a miner. He was working in the mine when it collapsed.',
      'My father was a miner, and he was working in the mine when it collapsed.',
    );
    accepted(
      'He could have died. He could have been killed.',
      'He could have died or been killed.',
    );
    accepted('It was boring.', 'It was boring.');
    accepted('I had a cow.', 'I had a cow.');
  });
});

describe('a run of "[[" is read once, not once per bracket', () => {
  it('400,000 characters of "[[" (and of half-made links) stay linear in every reader', async () => {
    const { textWords, shownText } = await import('../src/grounding-check');
    const { linkKnownTitles } = await import('../src/drafts');
    const ms = (f: () => void): number => {
      const t0 = performance.now();
      f();
      return performance.now() - t0;
    };
    const runs = '[['.repeat(200_000);
    const half = Array.from({ length: 50_000 }, (_, i) => (i % 2 ? '[[father' : '[[')).join('');
    expect(runs.length).toBe(400_000);
    for (const t of [runs, half]) {
      expect(ms(() => checkGrounding(t, t))).toBeLessThan(2000);
      expect(ms(() => checkGrounding('My father came home.', t))).toBeLessThan(2000);
      expect(ms(() => textWords(t))).toBeLessThan(500);
      expect(ms(() => shownText(t))).toBeLessThan(500);
      expect(ms(() => linkKnownTitles(t, ['Father']))).toBeLessThan(2000);
      expect(ms(() => verdict(t, t))).toBeLessThan(3000);
    }
    // and a link is still a link
    expect(shownText('[[Father]] came home')).toBe('Father came home');
    expect(textWords('[[Father]] came home')).toEqual(['came', 'home']);
  });
});
