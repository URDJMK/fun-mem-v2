import { describe, expect, it } from 'vitest';
import { readFuzzyDate } from '../src/drafts';
import { cleanSpeech, readEnglishDate, spokenYearsToDigits } from '../src/speech';

describe('spoken years', () => {
  it.each([
    ['nineteen sixty-six', '1966'],
    ['in nineteen fifty-eight there was a drought', 'in 1958 there was a drought'],
    ['nineteen eighty', '1980'],
    ['nineteen oh five', '1905'],
    ['nineteen ten', '1910'],
    ['nineteen seventeen', '1917'],
    // a round "nineteen hundred" / "two thousand" is a year only where a year is expected:
    // "two thousand" alone is as likely "two thousand people"
    ['in nineteen hundred', 'in 1900'],
    ['twenty twenty-one', '2021'],
    ['twenty fifteen', '2015'],
    ['two thousand five', '2005'],
    ['two thousand and nine', '2009'],
    ['in two thousand', 'in 2000'],
  ])('%s -> %s', (from, to) => expect(spokenYearsToDigits(from)).toBe(to));

  it('does not turn ordinary numbers into years', () => {
    expect(spokenYearsToDigits('I was twenty five')).toBe('I was twenty five');
    expect(spokenYearsToDigits('we had forty cows')).toBe('we had forty cows');
    expect(spokenYearsToDigits('twenty thirty cows')).toBe('twenty thirty cows');
    expect(spokenYearsToDigits('I was nineteen. Thirty years later')).toBe(
      'I was nineteen. Thirty years later',
    );
  });
});

describe('English dates', () => {
  it.each([
    ['We got married in June of nineteen sixty-seven.', '1967-06'],
    ['It was March 15th, 1987.', '1987-03-15'],
    ['on the 3rd of April 1954', '1954-04-03'],
    ['In nineteen fifty-eight there was a drought.', '1958'],
    ['He died in nineteen eighty-one, in March, of a heart attack.', '1981'],
    ['since, I think, nineteen thirty-four', '~1934'],
    [
      'At a church supper in nineteen sixty-six. We got married in June of nineteen sixty-seven.',
      '1966',
    ],
  ])('%s -> %s', (text, want) => expect(readEnglishDate(text)).toBe(want));

  it('marks a date approximate only when the hedge is next to it', () => {
    expect(
      readEnglishDate(
        'Susan was born in nineteen sixty-nine, in a snowstorm, and we drove at maybe fifteen miles an hour with the hazards on.',
      ),
    ).toBe('1969');
    expect(
      readEnglishDate(
        'He died in nineteen eighty-one, of a heart attack. I still dream about that red barn.',
      ),
    ).toBe('1981');
    expect(readEnglishDate('It was maybe nineteen fifty-eight.')).toBe('~1958');
    expect(readEnglishDate('It was in nineteen fifty-eight, I think.')).toBe('~1958');
  });

  it('answers null rather than guessing', () => {
    expect(readEnglishDate('We had forty cows and a big red barn.')).toBeNull();
    expect(readEnglishDate('It cost 2000 dollars and weighed 1500 pounds.')).toBeNull();
    expect(readEnglishDate('I may go in March')).toBeNull();
  });

  it('is what readFuzzyDate falls back to, and Korean still wins when present', () => {
    expect(readFuzzyDate('We married in June of nineteen sixty-seven.')).toBe('1967-06');
    expect(readFuzzyDate('1987년 3월에 결혼했다')).toBe('1987-03');
  });
});

describe('cleanSpeech', () => {
  it('removes fillers, set-off tags and stammers, and nothing else', () => {
    expect(cleanSpeech('Um, so I grew up on a farm.')).toBe('So I grew up on a farm.');
    expect(cleanSpeech('We had forty cows and, you know, a big red barn.')).toBe(
      'We had forty cows and a big red barn.',
    );
    expect(cleanSpeech('My brothers, they did the milking and I, I fed the chickens.')).toBe(
      'My brothers, they did the milking and I fed the chickens.',
    );
    expect(cleanSpeech('The corn just, just dried up standing.')).toBe(
      'The corn just dried up standing.',
    );
    expect(cleanSpeech('he was so embarrassed he, uh, offered to pay')).toBe(
      'He was so embarrassed he offered to pay',
    );
    expect(cleanSpeech('and, and, and then we left')).toBe('And then we left');
  });

  it('a set-off "you know" keeps the comma a sentence needs, and loses both where it does not', () => {
    expect(cleanSpeech('That is how we got through, you know, people just quietly helped.')).toBe(
      'That is how we got through, people just quietly helped.',
    );
    expect(cleanSpeech('It was cold, you know, really cold.')).toBe('It was cold, really cold.');
    expect(cleanSpeech('He went to, you know, the market.')).toBe('He went to the market.');
    expect(cleanSpeech('We had forty cows and, I mean, a big red barn.')).toBe(
      'We had forty cows and a big red barn.',
    );
  });

  it('leaves meaningful repeats and words alone', () => {
    expect(cleanSpeech('It was a really, really bad one.')).toBe(
      'It was a really, really bad one.',
    );
    expect(cleanSpeech('She said that that was fine.')).toBe('She said that that was fine.');
    expect(cleanSpeech('I felt like a stranger, well, sort of.')).toBe(
      'I felt like a stranger, well, sort of.',
    );
    expect(cleanSpeech('Four-thirty! My dad had a umbrella.')).toBe(
      'Four-thirty! My dad had a umbrella.',
    );
  });

  it('removes standalone Korean fillers only', () => {
    expect(cleanSpeech('어 음 나는 부산에서 태어났어요.')).toBe('나는 부산에서 태어났어요.');
    expect(cleanSpeech('어머니는 음식을 잘 하셨어요.')).toBe('어머니는 음식을 잘 하셨어요.');
  });
});

describe('spoken years: the forms people say, and never a price or a quantity', () => {
  it.each([
    ['He died in two thousand and twenty-one.', 'He died in 2021.'],
    ['He died in two thousand twenty-two.', 'He died in 2022.'],
    ['He retired in twenty twenty-six.', 'He retired in 2026.'],
    ['We moved in two thousand and eight.', 'We moved in 2008.'],
    ['She was born in nineteen hundred and twelve.', 'She was born in 1912.'],
    [
      'I was born in nineteen hundred and forty-six, in the old house.',
      'I was born in 1946, in the old house.',
    ],
    ['She was born in nineteen oh five.', 'She was born in 1905.'],
    ['In the winter of nineteen fifty-eight it froze.', 'In the winter of 1958 it froze.'],
    ['It was around nineteen seventy.', 'It was around 1970.'],
  ])('%s', (from, to) => expect(spokenYearsToDigits(from)).toBe(to));

  it.each([
    'It cost nineteen ninety-five at Sears.',
    'We paid nineteen fifty for that cow.',
    'We paid two thousand dollars for that first house.',
    'There must have been two thousand people at his funeral.',
    'He sold the boat for nineteen hundred dollars.',
    'We bought eighteen hundred acres up north.',
    'two thousand five hundred people',
    'We had twenty twenty-dollar bills',
  ])('%s stays as it was said', (s) => expect(spokenYearsToDigits(s)).toBe(s));

  it('"and" is only eaten when a number follows it', () => {
    expect(spokenYearsToDigits('in two thousand and then we moved')).toBe(
      'in 2000 and then we moved',
    );
  });
});

describe('English dates: more forms, fewer guesses', () => {
  it.each([
    ['We married on the fifteenth of June, nineteen sixty-seven.', '1967-06-15'],
    ['He died on the 4th of July, 1976.', '1976-07-04'],
    ['June the twenty-first, 1950, was the day.', '1950-06-21'],
    // a month never reaches across a full stop
    ['We married in May. 1951 was the year my father died.', '1951'],
    ['It was 1946 or 47 when we moved.', '~1946'],
    ['It was 1946 or so.', '~1946'],
    ['Perhaps 1946.', '~1946'],
    ['I believe it was 1946.', '~1946'],
    ['I think it was in 1946 that Dad got the boat.', '~1946'],
    ['I had 1200 sheep by 1960.', '1960'],
  ])('%s -> %s', (text, want) => expect(readEnglishDate(text)).toBe(want));

  it.each([
    'The house cost 1950 dollars back then.',
    'Our address was 1946 Main Street.',
    'We had 1946 chickens.',
    'She turned 1946 days old.',
    'We paid two thousand dollars for that first house.',
  ])('%s -> null', (text) => expect(readEnglishDate(text)).toBeNull());
});

describe('cleanSpeech never changes what a word means', () => {
  it('a stammer is the same word in the same case; "so so" without a comma is a word', () => {
    expect(cleanSpeech('It was so so, the food.')).toBe('It was so so, the food.');
    expect(cleanSpeech('It was so, so cold.')).toBe('It was so cold.');
    expect(cleanSpeech('He got a Grade A, a good one.')).toBe('He got a Grade A, a good one.');
    expect(cleanSpeech('My, my, how you have grown.')).toBe('My, my, how you have grown.');
  });

  it('what is only a filler stays as it was said, unless the caller asks for nothing back', () => {
    expect(cleanSpeech('Mm-hm.')).toBe('Mm-hm.');
    expect(cleanSpeech('음.')).toBe('음.');
    expect(cleanSpeech('Mm-hm.', { keepFillerOnly: false })).toBe('');
    expect(cleanSpeech(' and then we went', { capitalize: false })).toBe('and then we went');
  });
});

describe('cleanSpeech is linear: no long run of anything makes it slow', () => {
  // a pasted transcript can hold a 100,000-space run, a recogniser stuck on "um um um ...", or a
  // 400,000-character word; none may take more than a moment. (Each of these once took seconds
  // to minutes: a pattern starting with `\s*` rescans a long run from every position.)
  const N = 400_000;
  const cases: Record<string, string> = {
    spaces: `a${' '.repeat(N)}b`,
    newlines: `a${'\n'.repeat(N)}b`,
    'alternating whitespace': `a${' \n'.repeat(N / 2)}b`,
    'one long word': 'a'.repeat(N),
    'one long Korean word': '가'.repeat(N),
    'um um um': 'um '.repeat(N / 3),
    'um, um, um,': 'um, '.repeat(N / 4),
    'you know,': ', you know, '.repeat(N / 12),
    'I, I, I,': 'I, '.repeat(N / 3),
    commas: ','.repeat(N),
    'korean fillers': '음 '.repeat(N / 3),
    sentences: 'a. '.repeat(N / 3),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`${name}`, () => {
      const t0 = performance.now();
      cleanSpeech(text);
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  }
});
