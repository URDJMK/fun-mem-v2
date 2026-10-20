import { describe, expect, it } from 'vitest';
import { cleanSpeech, readEnglishDate, spokenYearsToDigits } from '../src/speech';
import { applyRoles, parseTranscript, stripSoundNotes } from '../src/transcript';

/**
 * Round 2: cleaning must never change what a sentence MEANS (parser #8, pipeline #12), a sound
 * note is removed but a name in brackets is not (parser #9), and a comma ends a number's phrase
 * for the date readers (P2-10).
 */

describe('cleanSpeech keeps names, corrections and clauses', () => {
  it.each([
    // Um, Uh, Uhm are also surnames
    ['His name was Um Jae-sun.', 'His name was Um Jae-sun.'],
    ['We met Mr. Um at church.', 'We met Mr. Um at church.'],
    ['Um Jae-sun was my uncle.', 'Um Jae-sun was my uncle.'],
    ['I said to Uh, my friend, come here.', 'I said to Uh, my friend, come here.'],
    ['My teacher was Uhm Jung-ja.', 'My teacher was Uhm Jung-ja.'],
    // a correction stays: "I mean" is meaning there
    ['In 1950, I mean, 1951.', 'In 1950, I mean, 1951.'],
    [
      'My mother, I mean, my stepmother, raised me.',
      'My mother, I mean, my stepmother, raised me.',
    ],
    ['It was in March, I mean, in May of 1951.', 'It was in March, I mean, in May of 1951.'],
    // a repeated word across a comma that starts the next clause is not a stammer
    ['I told you, you have to eat first.', 'I told you, you have to eat first.'],
    ['She hit it, it broke.', 'She hit it, it broke.'],
    ['If you were there then, then you know.', 'If you were there then, then you know.'],
  ])('%s', (said, kept) => expect(cleanSpeech(said)).toBe(kept));

  it('a removed filler takes its own full stop with it', () => {
    expect(cleanSpeech('Um. I think it was cold.')).toBe('I think it was cold.');
    expect(cleanSpeech('Uh. No.')).toBe('No.');
    expect(cleanSpeech('Mm-hm. That is right. We left in May.')).toBe(
      'That is right. We left in May.',
    );
    expect(cleanSpeech('We went home. Um. Then it rained.')).toBe('We went home. Then it rained.');
    // what the speaker's own text starts with stays
    expect(cleanSpeech('...and that is how we ended up in Daegu.')).toBe(
      '...and that is how we ended up in Daegu.',
    );
  });

  it("round 1's cleaning still works", () => {
    expect(cleanSpeech('Um, so I grew up on a farm.')).toBe('So I grew up on a farm.');
    expect(cleanSpeech('It was a really, really bad one.')).toBe(
      'It was a really, really bad one.',
    );
    expect(cleanSpeech('No, no, no, it was not him.')).toBe('No, no, no, it was not him.');
    expect(cleanSpeech('I mean it.')).toBe('I mean it.');
    expect(cleanSpeech('He had a, a cow.')).toBe('He had a cow.');
    expect(cleanSpeech('and, and, and then we left')).toBe('And then we left');
    expect(cleanSpeech('He was, I mean, a really kind man.')).toBe('He was a really kind man.');
    expect(cleanSpeech('um, my mother, uh, was a nurse')).toBe('My mother was a nurse');
  });

  it('is linear on the new shapes', () => {
    for (const text of [
      'Um. '.repeat(100_000),
      'Mr. Um '.repeat(57_000),
      'In 1950, I mean, 1951, '.repeat(17_000),
      'it, it, '.repeat(50_000),
      'Uh Kim '.repeat(57_000),
    ]) {
      const t0 = performance.now();
      cleanSpeech(text);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});

describe('the date helpers: a comma ends the number, buying is not paying', () => {
  it('"nineteen fifty, four years later" is a year, so both years of the sentence are read', () => {
    expect(
      spokenYearsToDigits(
        'I was born in nineteen forty-six and my brother was born in nineteen fifty, four years later.',
      ),
    ).toBe('I was born in 1946 and my brother was born in 1950, four years later.');
    expect(readEnglishDate('In 1950, two years after the war started, we fled.')).toBe('1950');
    expect(readEnglishDate('We married in 1965, five years later we had a son.')).toBe('1965');
  });

  it('"around 1970" is a year unless the sentence speaks of money outright', () => {
    expect(readEnglishDate('Sometime around 1970 we bought the shop.')).toBe('~1970');
    expect(readEnglishDate('We bought the shop around 1970.')).toBe('~1970');
    expect(readEnglishDate('He paid around 1950 for the cow.')).toBeNull();
    expect(readEnglishDate('We sold it for 1950.')).toBeNull();
    expect(spokenYearsToDigits('We sold the boat for nineteen fifty.')).toBe(
      'We sold the boat for nineteen fifty.',
    );
  });
});

describe('sound notes go, names in brackets stay', () => {
  it('a single all-capitals word in brackets is a name, not a sound', () => {
    const t = parseTranscript({
      segments: [
        {
          start: 0,
          end: 9,
          speaker: 'A',
          text: 'He worked for the [UN] in Geneva, and later for [KBS] in Seoul. [MUSIC] Then the [YMCA].',
        },
      ],
    });
    expect(t.turns[0]!.text).toBe(
      'He worked for the [UN] in Geneva, and later for [KBS] in Seoul. Then the [YMCA].',
    );
    expect(t.warnings).toContainEqual({ code: 'annotations_removed', count: 1 });
  });

  it('machine and transcriber tags still go', () => {
    const { text, removed } = stripSoundNotes(
      'a [BLANK_AUDIO] b [PHONE RINGS] c [CROSSTALK 00:02:11] d [INAUDIBLE] e [GROANS] f (whispering) g',
    );
    expect(text.replace(/\s+/g, ' ')).toBe('a b c d e f g');
    expect(removed).toBe(6);
  });
});

describe('full-width punctuation stays as she wrote it (round 3)', () => {
  it('？ ！ ， ； are kept in her words, in text and in JSON, and the person is asked who tells', () => {
    const t = parseTranscript({
      segments: [
        { start: 0, end: 2, speaker: 'SPEAKER_01', text: '你在哪里出生？' },
        { start: 2, end: 9, speaker: 'SPEAKER_00', text: '我出生在釜山． 海边的小房子！' },
      ],
    });
    expect(t.turns.map((x) => x.text)).toEqual(['你在哪里出生？', '我出生在釜山． 海边的小房子！']);
    const lines = [
      '提问者：你在哪里出生？',
      '奶奶：我1946年出生在釜山，我父亲是修船的，他的手很大！真的；很大。',
      '提问者：你母亲呢？',
      '奶奶：她在市场上卖鱼，从来没有抱怨过。',
    ];
    const zh = parseTranscript(lines.join('\n'));
    // every line is kept word for word; only English rules read it, so nothing is guessed from it
    expect(zh.turns.map((x) => x.text)).toEqual(lines);
    expect(applyRoles(zh).roles.needsConfirmation).toBe(true);
  });
});

describe('round 3: rare alterations by cleanSpeech and capitalisation', () => {
  it.each([
    [
      'My father only ever said hmm when I asked him anything.',
      'My father only ever said hmm when I asked him anything.',
    ],
    [
      'She would just say mm-hm and keep on sewing.',
      'She would just say mm-hm and keep on sewing.',
    ],
    ['Sixty, um, sixty-one maybe.', 'Sixty, sixty-one maybe.'],
    ['So, so.', 'So, so.'],
    ['It was so, so cold.', 'It was so cold.'],
    ['I was, hmm, thinking about it.', 'I was thinking about it.'],
    [
      'we lived on Elm St. and Fifth Ave. near the river',
      'We lived on Elm St. and Fifth Ave. near the river',
    ],
    ['he worked at the Co. for thirty years', 'He worked at the Co. for thirty years'],
    ['we left at 9 a.m. and walked', 'We left at 9 a.m. and walked'],
    ['it was over. then we left.', 'It was over. Then we left.'],
  ])('%s', (said, kept) => expect(cleanSpeech(said)).toBe(kept));
});
