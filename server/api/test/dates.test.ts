import { describe, expect, it } from 'vitest';
import { readMemoryDate } from '../src/dates';

/**
 * The date a memory is filed under. A wrong date on a family timeline is worse than none, so
 * the common answer is null. Every "null" case below is a real wrong date that two independent
 * reviewers produced from realistic speech.
 */

describe('what is NOT a date', () => {
  it('prices and quantities, spoken or in digits', () => {
    for (const t of [
      'We paid two thousand dollars for that first house.',
      'Two thousand people came to his funeral.',
      'We sold the boat for nineteen hundred dollars.',
      'We paid nineteen fifty for that cow.',
      'It cost nineteen ninety-five.',
      'It cost 1950 dollars.',
      'He kept 1946 chickens behind the barn.',
      'We lived at 1946 Main Street for many years.',
      'The house was $2000 and the land was $1950.',
      'We walked nineteen miles to school every day.',
      '그릇을 2000원에 샀다.',
    ]) {
      expect(readMemoryDate(t), t).toBeNull();
    }
  });

  it('ages, spans and years that are only in passing', () => {
    expect(readMemoryDate('I was nineteen when I left home.')).toBeNull();
    expect(readMemoryDate('He was twenty-one years old.')).toBeNull();
    expect(
      readMemoryDate('My dad had farmed since 1934. I was born in 1946. We sold it in 1984.'),
    ).toBeNull();
    expect(readMemoryDate('We lived there until nineteen seventy.')).toBeNull();
    expect(readMemoryDate('It rained between 1950 and 1953.')).toBeNull();
    expect(readMemoryDate('We had forty cows and a red barn.')).toBeNull();
    // someone else's birth year in a clause that is not what the story is about
    expect(
      readMemoryDate(
        'My grandmother, who was born in eighteen ninety-eight, made kimchi every November.',
      ),
    ).toBeNull();
    expect(readMemoryDate('Old Mr. Kang (born 1912) always sat by the door.')).toBeNull();
  });

  it('the recording itself is not a memory', () => {
    expect(
      readMemoryDate(
        'My name is Kim Min-ho. Today is the eighteenth of October, two thousand and twenty-six.',
      ),
    ).toBeNull();
    expect(readMemoryDate('This was recorded on 2026-10-18 at my kitchen table.')).toBeNull();
    // but a date in a sentence that merely begins "my name is" is the speaker's
    expect(readMemoryDate('My name is Sunja, and I was born in nineteen forty-six.')).toBe('1946');
  });

  it('several years, none led with', () => {
    expect(
      readMemoryDate('We had a drought. We sold the cows in 1959. We left in 1961.'),
    ).toBeNull();
    expect(readMemoryDate('It was 1946 or 1947, I never know which.')).toBeNull();
  });
});

describe('numbers that name a thing, and years nobody is dating a memory by', () => {
  it('phone numbers, rooms, flights, buses, jerseys, serial numbers', () => {
    for (const t of [
      'Call 555-1946 if you need her.',
      'His number was 1946-2233.',
      'My phone number was 010-1946-5523.',
      '우리 집 전화번호는 010-1946-5523이었어요.',
      '전화번호가 1946-2233이었어요.',
      'Room 1912 at the hospital was hers.',
      'She stayed in room 1912 for a week.',
      'Flight 1946 to Seoul was delayed.',
      'The bus number was 2005.',
      'She wore jersey number 1984.',
      'His prisoner number was 1944.',
      'His serial number was 1953 and he never forgot it.',
      '방 번호가 1912호였어요.',
      '1912호에 입원했어요.',
      '서울시 종로구 1946번지에 살았어요.',
      '1946번 버스를 탔어요.',
    ]) {
      expect(readMemoryDate(t), t).toBeNull();
    }
    // a thing with a number does not hide the real date that follows
    expect(readMemoryDate('Room 1912 was where she died. That was in 2001.')).toBe('2001');
    expect(readMemoryDate('I got married in 1965. Our phone number was 555-1962.')).toBe('1965');
  });

  it('spans, ranges and decades are time claims, not events', () => {
    for (const t of [
      '1950–53 were the hard years.',
      'The war was 1950-1953.',
      'Since 1975 I have lived alone.',
      '1953년 전에는 북쪽에 살았어요.',
      '1953년 이후로 혼자 살았어요.',
      '1953년까지 거기 살았어요.',
      '1953년부터 혼자 살았어요.',
      '1953년 이전에는 몰랐어요.',
      'That was in the 1960s, when I was young.',
      '1960년대에는 다들 가난했어요.',
      '1970년대 초에 서울로 왔어요.',
      '1990년대 말에 아버지가 돌아가셨어요.',
    ]) {
      expect(readMemoryDate(t), t).toBeNull();
    }
    // a span before an event year is a second year: the story has no single date
    expect(readMemoryDate('Since 1934 my dad farmed. In 1946 I was born.')).toBeNull();
    // but a decade only places a year inside it
    expect(readMemoryDate('In the 1960s, in 1965 exactly, we moved.')).toBe('1965');
    // December 1965 is a month, not the range 1965-12
    expect(readMemoryDate('We married in 1965-12.')).toBe('1965-12');
    expect(readMemoryDate('We married on 1965-06-05.')).toBe('1965-06-05');
  });

  it('a year the speaker rejects, hands to other people, or that is today or tomorrow', () => {
    expect(readMemoryDate('No, not 1950. It was 1951.')).toBe('1951');
    expect(readMemoryDate('Not in 1950. In 1951.')).toBe('1951');
    expect(readMemoryDate('It was not 1950, it was 1951.')).toBe('1951');
    expect(readMemoryDate('People think it was 1950. It was 1951, actually.')).toBe('1951');
    expect(readMemoryDate('Everyone says 1950 but it was really 1951.')).toBe('1951');
    expect(readMemoryDate('1950년이 아니고 1951년이에요.')).toBe('1951');
    expect(readMemoryDate('1950년은 아니에요. 1951년이었어요.')).toBe('1951');
    expect(readMemoryDate('We did not leave in 1950. We stayed until the end.')).toBeNull();
    expect(readMemoryDate('They say it was built in 1880.')).toBeNull();
    // "No one" is not the speaker rejecting the year
    expect(readMemoryDate('No one came to the funeral in 1950.')).toBe('1950');
    // today is not a memory
    expect(readMemoryDate('It is 2026 now. I was born in 1946.')).toBe('1946');
    expect(readMemoryDate('Now in 2026 I still remember 1950.')).toBe('1950');
    expect(readMemoryDate('It is 2026 now and I am ninety.')).toBeNull();
    expect(readMemoryDate('지금이 2026년인데 아직도 그 생각이 나요.')).toBeNull();
    // and neither is a year that has not happened
    expect(readMemoryDate('I hope to see 2049, if God lets me live that long.')).toBeNull();
  });

  it('a person described in passing never competes with the story', () => {
    expect(
      readMemoryDate('My mother, born 1920, raised us alone. In 1950 she lost the farm.'),
    ).toBe('1950');
    expect(readMemoryDate('My mother, born 1920, was the oldest.')).toBeNull();
  });

  it('a comma after the year does not turn it into a quantity', () => {
    expect(readMemoryDate('In 1950, two years after the war started, we fled.')).toBe('1950');
    expect(readMemoryDate('We married in 1965, five years later we had a son.')).toBe('1965');
    expect(readMemoryDate('It was 1946, 3 weeks before Christmas.')).toBe('1946');
    expect(
      readMemoryDate(
        'In 1950, two years after the war started, we fled. My brother was born in 1952.',
      ),
    ).toBe('1950');
    expect(
      readMemoryDate('We moved in 1950, three years after my father died in 1947.'),
    ).toBeNull();
    expect(
      readMemoryDate(
        'I was born in nineteen forty-six and my brother was born in nineteen fifty, four years later.',
      ),
    ).toBeNull();
  });
});

describe('round-3 review: prices, model years and times of day are not dates', () => {
  it('a Korean price followed by a particle or a copula does not hide the real year', () => {
    expect(readMemoryDate('그때 차비가 1950원이었는데 1960년에 올랐어요.')).toBe('1960');
    expect(readMemoryDate('연탄 한 장이 2000원이에요. 1975년에 이사했어요.')).toBe('1975');
    expect(readMemoryDate('용돈은 1990원씩 받았어요. 1998년 겨울이었어요.')).toBe('1998');
    expect(readMemoryDate('월급이 1950달러였어요. 1962년에 취직했어요.')).toBe('1962');
    expect(readMemoryDate('그 집은 1950만 원이었어요. 1970년에 샀어요.')).toBe('1970');
    expect(readMemoryDate('1950개나 있었어요. 1960년에 팔았어요.')).toBe('1960');
    expect(readMemoryDate('1950명이 모였어요. 1960년 봄이었죠.')).toBe('1960');
    for (const t of [
      '버스 요금이 1980원이었어요.',
      '월급이 1950달러였어요.',
      '그 집은 1950만원이었어요.',
    ]) {
      expect(readMemoryDate(t), t).toBeNull();
    }
  });

  it('"twenty-twenty vision", a model year before a brand, and a time of day are not years', () => {
    for (const t of [
      'My father had twenty-twenty vision until the day he died.',
      'The tractor was a nineteen fifty-two Farmall.',
      'She drove a nineteen fifty-seven Chevy for thirty years.',
      'I drove a 1957 Ford for years.',
      'The train left at 1930 sharp.',
      'The train left at nineteen thirty.',
    ]) {
      expect(readMemoryDate(t), t).toBeNull();
    }
    // a real year in the same sentence still wins
    expect(readMemoryDate('In 1962 my father bought a 1957 Chevy.')).toBe('1962');
    // "It was twenty twenty" IS a year
    expect(readMemoryDate('It was twenty twenty before I saw her again.')).toBe('2020');
  });
});

describe('what is a date', () => {
  it('a year said in words or digits', () => {
    expect(readMemoryDate('We sold the farm in nineteen eighty-four.')).toBe('1984');
    expect(readMemoryDate('I was born in Busan in 1946.')).toBe('1946');
    expect(readMemoryDate('My brother was born in nineteen oh five.')).toBe('1905');
    expect(readMemoryDate('1946년에 부산에서 태어났어요.')).toBe('1946');
  });

  it('the 2000s and "nineteen hundred and ...", which readers kept getting wrong', () => {
    expect(readMemoryDate('Father died in two thousand and twenty-one.')).toBe('2021');
    expect(readMemoryDate('We moved in two thousand and eight, in the autumn.')).toBe('2008');
    expect(readMemoryDate('She was born in nineteen hundred and twelve.')).toBe('1912');
    expect(readMemoryDate('He was born in nineteen hundred and five.')).toBe('1905');
    expect(readMemoryDate('The shop closed in twenty twenty-two.')).toBe('2022');
  });

  it('months, and days, when they are said', () => {
    expect(readMemoryDate('We married in June of nineteen sixty-seven.')).toBe('1967-06');
    expect(readMemoryDate('He passed away on March 15th, 1987.')).toBe('1987-03-15');
    expect(readMemoryDate('1989년 3월에 돌아가셨어요.')).toBe('1989-03');
    // a month and a year in DIFFERENT sentences are not one date
    expect(readMemoryDate('We married in May. 1951 was the year of the flood.')).not.toBe(
      '1951-05',
    );
  });

  it('a hedge next to the date makes it approximate; a hedge elsewhere does not', () => {
    expect(readMemoryDate('It was maybe nineteen fifty-eight.')).toBe('~1958');
    expect(readMemoryDate('I think we moved in 1960.')).toBe('~1960');
    expect(readMemoryDate('That was about nineteen sixty-two.')).toBe('~1962');
    expect(readMemoryDate('그때 1948년이었나?')).toBe('~1948');
    expect(readMemoryDate('아마 1946년쯤이었을 거예요.')).toBe('~1946');
    expect(readMemoryDate('We sold the farm in 1984 and I still dream about that barn.')).toBe(
      '1984',
    );
    // "maybe" opens the clause the date is in; "about ten" hedges an age, not the year
    expect(readMemoryDate('Maybe it was 1950, I am not sure.')).toBe('~1950');
    expect(readMemoryDate('I was about ten in 1950.')).toBe('1950');
    expect(readMemoryDate('We were maybe ten families in 1950.')).toBe('1950');
    expect(readMemoryDate('We were about to leave in 1950.')).toBe('1950');
    expect(readMemoryDate('The war was over around Christmas 1950.')).toBe('1950');
    // 한 hedges only as a word of its own, not at the start of 한국, 한번, 한복
    expect(readMemoryDate('한 1962년쯤 서울에 갔어요.')).toBe('~1962');
    expect(readMemoryDate('한국에 1975년에 왔어요.')).toBe('1975');
    expect(readMemoryDate('한번은 1962년에 서울에 갔어요.')).toBe('1962');
    expect(readMemoryDate('어머니가 한복을 입으신 1965년 설날이었어요.')).toBe('1965');
    // "1946 or 47": the speaker is not sure which
    expect(readMemoryDate('I was born in 1946 or 47, my mother never wrote it down.')).toBe(
      '~1946',
    );
  });

  it('the same year said twice is that year; the most specific reading wins', () => {
    expect(readMemoryDate('We moved in 1950. In 1950 my father died.')).toBe('1950');
    expect(readMemoryDate('It was 1967. We married in June of nineteen sixty-seven.')).toBe(
      '1967-06',
    );
  });

  it('several years: the one the speaker led with, skipping "Yes." and "Well."', () => {
    expect(readMemoryDate('In 1958 there was a drought. We sold the cows in 1959.')).toBe('1958');
    expect(
      readMemoryDate(
        'At a church supper in nineteen sixty-six he spilled gravy. We married in June of nineteen sixty-seven.',
      ),
    ).toBe('1966');
    expect(
      readMemoryDate(
        'Yes. In nineteen eighty-one I opened a little shop. By nineteen eighty-eight I had moved it.',
      ),
    ).toBe('1981');
    expect(
      readMemoryDate('Well. It was a long time ago. In 1958 and again in 1959 it rained.'),
    ).toBeNull();
  });

  it('footer lines (">") are not text', () => {
    expect(
      readMemoryDate(
        'We sold the cows.\n\n> From “tape 1960” · told by Grandma (0:12–0:40)\n> Question: “What happened in 1975?”',
      ),
    ).toBeNull();
  });
});

describe('it is fast on hostile text', () => {
  it('400,000 characters of number words, of dollars and of digits', () => {
    const shapes = [
      'nineteen '.repeat(44_000),
      'two thousand and '.repeat(24_000),
      'one hundred dollars '.repeat(20_000),
      '1946 '.repeat(80_000),
      'since '.repeat(60_000),
      '(born '.repeat(60_000),
      'who was born '.repeat(30_000),
      '1.1.'.repeat(100_000),
      '1,1,'.repeat(100_000),
      '9'.repeat(400_000),
      'not '.repeat(80_000),
      'people said '.repeat(40_000),
      'room' + ' '.repeat(400_000),
      '1946' + ' '.repeat(400_000) + '아니',
      '1950-'.repeat(60_000),
      ', born '.repeat(50_000),
      '1950년 '.repeat(60_000),
      '555-1946 '.repeat(40_000),
      'number was '.repeat(30_000),
    ];
    for (const text of shapes) {
      const t0 = performance.now();
      readMemoryDate(text);
      expect(performance.now() - t0, text.slice(0, 20)).toBeLessThan(1500);
    }
  });
});
