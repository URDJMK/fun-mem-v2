import { describe, expect, it } from 'vitest';
import {
  acceptTitle,
  cleanLabel,
  detectLang,
  fallbackTitle,
  honorific,
  isPersonLabel,
  languageOf,
} from '../src/ingest-lang';
import { checkTitleFacts } from '../src/title-check';

/**
 * Titles, labels and language for interview notes: pure functions, no transcript reading.
 * (The pipeline-level behaviour is in ingest-pipeline.test.ts.)
 */

const SAID =
  'My father repaired boats in the harbour, and every Sunday he took me down to the pier with him.';

describe('a fallback title is a phrase from what was said (A3)', () => {
  const en = (s: string) => fallbackTitle(s, 'en');

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

  it('Korean: the sentence after "네.", or the last clause boundary within 28 syllables', () => {
    expect(
      fallbackTitle(
        '네. 2019년 봄에 아버지가 갑자기 쓰러지셨어요. 병원에 갔더니 폐암 말기라고 하더라고요. 의사 선생님이 석 달 정도 남았다고 했는데, 아버지는 그 말을 듣고도 아무 말씀이 없으셨어요.',
        'ko',
      ),
    ).toBe('2019년 봄에 아버지가 갑자기 쓰러지셨어요');
    const cut = fallbackTitle(
      '그 뭐냐 어머니가 시장에서 생선을 파시던 그 가게는 아직도 거기에 있는데 내가 어릴 적에는 매일 거기서 놀았어요',
      'ko',
    );
    expect(cut.replace(/\s/g, '').length).toBeLessThanOrEqual(28);
    expect(cut.startsWith('어머니가')).toBe(true);
    expect(cut).toMatch(/있는데$/);
    expect(fallbackTitle('네. 네. 그랬죠. 아버지가요, 배를 고치셨어요.', 'ko')).toBe(
      '아버지가요, 배를 고치셨어요',
    );
  });

  it('is never a link, a heading or markup, and a link reads as its words', () => {
    const t = fallbackTitle('# My [[Dad]] was the #1 fan of the Yankees | always', 'en');
    expect(t).not.toMatch(/[[\]#|]/);
    expect(fallbackTitle('We lived by the [[Busan Harbour|harbour]] for years.', 'en')).toBe(
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
      expect(acceptTitle(bad, 'en', SAID), bad).toBeNull();
    }
  });

  it('ordinary new wording is fine', () => {
    for (const good of [
      "My father's boat yard",
      'Sundays at the pier',
      'Sundays with Dad at the harbour',
      'Father and the boats',
    ]) {
      expect(acceptTitle(good, 'en', SAID), good).toBe(good);
    }
    expect(acceptTitle('"Sundays at the pier."', 'en', SAID)).toBe('Sundays at the pier');
    expect(acceptTitle('Yes My father repaired boats', 'en', SAID)).toBe(
      'My father repaired boats',
    );
  });

  it('heavy facts and numbers are allowed when the speaker said them', () => {
    const said = 'My brother Tom drowned in 1952, the year the war ended for us.';
    expect(acceptTitle('The year Tom drowned', 'en', said)).toBe('The year Tom drowned');
    expect(acceptTitle('Tom, 1952', 'en', said)).toBe('Tom, 1952');
    expect(acceptTitle('After the war', 'en', said)).toBe('After the war');
    expect(checkTitleFacts('Two boys and a girl', 'Three. Two boys and a girl.').ok).toBe(true);
    expect(checkTitleFacts('The winter of nineteen fifty-eight', 'That was 1958.').ok).toBe(true);
  });

  it('a relative is the one the speaker named: "grandmother" is not "mother"', () => {
    const said = 'My mother sold fish at the market and came home after sunset.';
    expect(checkTitleFacts("Mom's fish stall", said).ok).toBe(true);
    expect(checkTitleFacts("Grandma's fish stall", said).ok).toBe(false);
    expect(checkTitleFacts('외할머니의 생선 가게', '어머니가 시장에서 생선을 파셨어요.').ok).toBe(
      false,
    );
    expect(checkTitleFacts('엄마의 생선 가게', '어머니가 시장에서 생선을 파셨어요.').ok).toBe(true);
  });

  it('Korean: an invented name or heavy fact is refused, ordinary words are not', () => {
    const said = '나는 부산에서 태어났어요. 어릴 때 바닷가 집에서 살았어요.';
    expect(acceptTitle('부산의 바닷가 집', 'ko', said)).toBe('부산의 바닷가 집');
    expect(acceptTitle('어린 시절의 기억', 'ko', said)).toBe('어린 시절의 기억');
    expect(acceptTitle('서울에서 보낸 날들', 'ko', said)).toBeNull();
    expect(acceptTitle('철수의 바닷가', 'ko', said)).toBeNull();
    expect(acceptTitle('바닷가 집의 비밀', 'ko', said)).toBeNull();
    expect(acceptTitle('아버지의 감옥 생활', 'ko', said)).toBeNull();
  });

  it('the old shape rules still hold', () => {
    expect(acceptTitle('아버지의 배 수리', 'en', SAID)).toBeNull();
    expect(acceptTitle('My father', 'ko', SAID)).toBeNull();
    expect(acceptTitle('x'.repeat(61), 'en')).toBeNull();
    expect(acceptTitle('Visit www.evil.example now', 'en', SAID)).toBeNull();
    expect(acceptTitle('', 'en')).toBeNull();
    expect(acceptTitle(42, 'en')).toBeNull();
  });
});

describe('Korean honorifics (B8)', () => {
  it('no 님 after a word that already carries respect or cannot take it; 선생 becomes 선생님', () => {
    for (const n of [
      '언니',
      '오빠',
      '누나',
      '형',
      '큰언니',
      '큰누나',
      '이모',
      '고모',
      '삼촌',
      '할매',
      '막내 삼촌',
      '엄마',
    ]) {
      expect(honorific(n), n).toBe(n);
    }
    expect(honorific('김 선생')).toBe('김 선생님');
    expect(honorific('막내 형')).toBe('막내 형');
    expect(honorific('큰형')).toBe('큰형');
    // a given name that ends like a kinship word is a name
    expect(honorific('박준형')).toBe('박준형님');
    expect(honorific('김순자 할머니')).toBe('김순자 할머니');
    expect(honorific('김순자')).toBe('김순자님');
    expect(honorific('김순자 (할머니)')).toBe('김순자 (할머니)');
  });

  it('is total: a non-string is empty, never a crash', () => {
    expect(honorific(undefined)).toBe('');
    expect(honorific(Object.prototype.toString)).toBe('');
    expect(cleanLabel(Object.prototype.constructor)).toBe('');
    expect(cleanLabel(null)).toBe('');
  });
});

describe('language detection weighs a Hangul syllable as the letters it is worth (B1)', () => {
  it('decides by what dominates, with a fallback for digits alone', () => {
    expect(detectLang('나는 LA에서 오래 살았어요')).toBe('ko');
    expect(detectLang('We came to Los Angeles in 1975, 부산에서')).toBe('en');
    // 5 syllables are worth 12.5 letters, more than the 8 of "Kim Sunja"
    expect(detectLang('우리 어머니 Kim Sunja')).toBe('ko');
    // 8 syllables against the 10 letters of "Los Angeles": counted one for one, this was "English"
    expect(detectLang('Los Angeles에서 오래 살았어요')).toBe('ko');
    expect(detectLang('Los Angeles에서 오래')).toBe('en');
    expect(detectLang('1946.', 'ko')).toBe('ko');
    expect(detectLang('I was born in 부산')).toBe('en');
  });
});

describe('a speaker label is a name unless it names a voice (A4)', () => {
  it('tells "Grandpa Tae" from "SPEAKER_01"', () => {
    for (const name of ['Grandpa Tae', '김순자', 'Mom', 'Grandma', 'constructor (speaker)']) {
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
      '화자 1',
      '화자1',
      '참석자 2',
      'Voice 3',
      '1',
      '',
    ]) {
      expect(isPersonLabel(voice), voice).toBe(false);
    }
  });
});

describe('invented facts in model titles are refused (round 2, G2-4)', () => {
  const refused: Array<[string, 'en' | 'ko', string]> = [
    ["Sunja's kitchen", 'en', 'My mother cooked every day in a tiny kitchen behind the shop.'],
    ['Tom and the boat', 'en', 'My brother loved the boat more than anything.'],
    ['Busan days', 'en', 'We lived by the sea when I was small.'],
    ['Her second marriage', 'en', 'She married my father in the spring, in a small church.'],
    ['Our third house', 'en', 'We moved into the house on the hill when I was ten.'],
    ['The sixties in the city', 'en', 'When I was young we lived in the city.'],
    ['A dozen children', 'en', 'There were many children in the village.'],
    ['Twins in the family', 'en', 'My sister had two babies in one year.'],
    ['Mother in the hospital', 'en', 'My mother was very tired that year.'],
    ["Father's escape from the north", 'en', 'My father came south with nothing.'],
    ['The fire that took the house', 'en', 'We lost the house that winter.'],
    ['Half a century at the market', 'en', 'She sold fish at the market for forty years.'],
    ['Six of us, and a seventh', 'en', 'There were six of us.'],
    ['mr. park the teacher', 'en', 'Our teacher was very strict.'],
    ['순자 이모의 집', 'ko', '이모가 저를 키워 주셨어요.'],
    ['철수 삼촌과의 여름', 'ko', '삼촌이랑 바닷가에서 여름을 보냈어요.'],
    ['영수와 바다', 'ko', '동생이랑 바다에 갔어요.'],
    ['서울로 간 날', 'ko', '우리는 큰 도시로 이사를 갔어요.'],
    ['부산 피난 시절', 'ko', '전쟁 때 남쪽으로 피난을 갔어요.'],
    ['열 남매 중 셋째', 'ko', '형제가 여섯이었어요. 제가 둘째였어요.'],
    ['두 번째 결혼', 'ko', '어머니는 아버지와 결혼하셨어요.'],
    ['육십년대의 시장', 'ko', '젊을 때 시장에서 일했어요.'],
    ['아버지의 병', 'ko', '아버지가 많이 피곤해 하셨어요.'],
    ['박 선생님', 'ko', '선생님이 엄하셨어요.'],
  ];
  for (const [title, lang, said] of refused) {
    it(`refuses ${JSON.stringify(title)}`, () => {
      expect(checkTitleFacts(title, said).ok).toBe(false);
      expect(acceptTitle(title, lang, said)).toBeNull();
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
      ['자녀 아들 둘 딸 하나', '아들 둘에 딸 하나예요.'],
      ['세 자녀 모두 대학 보낸 자랑', '세 아이가 다 대학에 간 거요. 아이들은 꼭 보내고 싶었어요.'],
      ['남편 1999년 겨울 별세', '남편이 1999년 겨울에 돌아가셨을 때예요.'],
      ['손주들에게 당부', '밥 잘 챙겨 먹고, 엄마 아빠한테 전화 자주 해라.'],
      [
        '아버지의 배 수리 일과 일요일 부두 구경',
        '아버지는 배를 고치셨어요. 일요일마다 부두에 데리고 가서 배 구경을 시켜 주셨어요.',
      ],
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
    expect(fallbackTitle(said, 'en')).toBe('In 1946 we lived by the sea');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('Korean footers and the language of each memory (round 2, G2-7)', () => {
  it('no 님 after a name written in Latin letters, or after a dialect or household word', () => {
    for (const n of [
      'Grandma',
      'Mom',
      'Aunt Mae',
      'Sunja Kim',
      'Halmoni',
      'Grace',
      '어무이',
      '엄니',
      '아부지',
      '아줌마',
      '막내',
      '둘째',
    ]) {
      expect(honorific(n), n).toBe(n);
    }
    expect(honorific('김순자')).toBe('김순자님');
    expect(honorific('박준형')).toBe('박준형님');
    expect(honorific('김 선생')).toBe('김 선생님');
  });

  it('a code-switching memory is Korean when Hangul carries two fifths of it; an English one with a Korean word stays English', () => {
    expect(
      languageOf(
        '1975년에 LA로 갔어요. 우리 큰딸 Jenny가 그때 세 살이었어요. We lived on Western Avenue for two years, and then we moved.',
      ),
    ).toBe('ko');
    expect(
      languageOf('We ate 김치 and 떡국 every New Year at my grandmother’s house in Busan.'),
    ).toBe('en');
    expect(languageOf('1946.', 'ko')).toBe('ko');
  });

  it('the fallback title is a sentence in the memory’s own language', () => {
    expect(
      fallbackTitle('1975년에 LA로 갔어요. We lived on Western Avenue for two years.', 'en'),
    ).toBe('We lived on Western Avenue for two years');
  });
});

describe('fallback titles end on a whole phrase and say something (round 2, G2-5)', () => {
  const en = (s: string) => fallbackTitle(s, 'en');

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
    expect(fallbackTitle('저기 그 사진 좀 줘 봐. 이게 우리 아버지야.', 'ko')).toBe(
      '이게 우리 아버지야',
    );
  });

  it('Latin letters in a Korean sentence are not counted as syllables', () => {
    expect(fallbackTitle('아버지는 LA downtown에서 grocery store를 하셨어요.', 'ko')).toBe(
      '아버지는 LA downtown에서 grocery store를 하셨어요',
    );
  });

  it('is at most 60 characters', () => {
    for (const s of [
      'Supercalifragilisticexpialidocious '.repeat(4),
      '아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주 일이었어요.',
      'Mi abuela, que vivía en el pueblo de al lado con sus siete hermanos y sus padres, siempre cantaba.',
    ]) {
      expect(fallbackTitle(s, /[가-힣]/.test(s) ? 'ko' : 'en').length).toBeLessThanOrEqual(60);
    }
  });
});

describe('fallback titles read through abbreviations, skip a bare answer, are never empty (round 3, G2-B6, G2-F6)', () => {
  const en = (s: string) => fallbackTitle(s, 'en');
  const ko = (s: string) => fallbackTitle(s, 'ko');

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
    expect(ko('아니요, 전혀요. 선생님이 자로 때리셨어요.')).toBe('선생님이 자로 때리셨어요');
    expect(ko('절대 아니에요. 아버지는 한 번도 손을 안 대셨어요.')).toBe(
      '아버지는 한 번도 손을 안 대셨어요',
    );
    // said alone, the answer is all there is, and it is the title
    expect(en('No, not at all.')).toBe('Not at all');
    expect(ko('아니요, 전혀요.')).toBe('아니요, 전혀요');
  });

  it('is never empty, never punctuation alone and never invisible', () => {
    for (const s of ['?!', '...', '— —', '', '   ', '"', '()', '…', '!!!', '「」', '[[ ]]', '​']) {
      expect(en(s)).toBe('A memory');
      expect(ko(s)).toBe('기억');
    }
    expect(fallbackTitle(null, 'en')).toBe('A memory');
    expect(fallbackTitle(undefined, 'ko')).toBe('기억');
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
      expect(ko(s).length).toBeGreaterThan(0);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});

describe('title facts: places in an order, one-syllable Korean words, denials, plain-word facts (round 3, G2-B8)', () => {
  const S1 =
    'My father repaired fishing boats in Busan harbour. He worked from before dawn until after dark, and on Sundays he took us to church. I was the third of five children. My mother sold fish at the market and her hands always smelled of salt. In 1952 we moved to Daegu because my uncle found work for him at a textile factory.';
  const S2 =
    '우리 아버지는 부산 부두에서 배를 고치셨어요. 새벽부터 밤까지 일하셨고 일요일에는 우리를 교회에 데리고 가셨어요. 저는 오 남매 중에 셋째였어요. 어머니는 시장에서 생선을 파셨는데 손에서 늘 소금 냄새가 났어요. 1952년에 삼촌이 대구 방직공장에 일자리를 구해 주셔서 이사를 갔어요.';
  const S3 =
    'Mi madre vendía pescado en el mercado de Valparaíso. Mi padre arreglaba barcos. Éramos cinco hermanos y yo era el tercero.';
  const S5 =
    '저는 학교에 못 갔어요. 집에 돈이 없었거든요. 아버지는 술을 좋아하셨는데 쉰 살에 끊으셨어요.';
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
      ['아버지가 술을 끊은 날', S2],
      ['아버지의 술', S2],
      ['어머니의 빚', S2],
      ['우리 집 개', S2],
      ['두번째 결혼', S2],
    ] as const) {
      expect(checkTitleFacts(title, said).ok, title).toBe(false);
    }
  });

  it('accepts the same words when the speaker said them', () => {
    for (const [title, said] of [
      ['The third of five children', S1],
      ['Third of five children', S1],
      ['Five children', S1],
      ['오 남매 중 셋째', S2],
      ['세 번째 아이', S2],
      ['고향의 봄', S2],
      ['집 안 풍경', S2],
      ['대구로 간 해', S2],
      ['Mi madre y el mercado', S3],
      ['아버지가 술을 끊은 날', S5],
      ['학교에 못 간 이야기', S5],
      ['돈이 없던 시절', S5],
      ['How my father lost his job', S6],
      ['A brother lost at sea', S6],
      ['My brother never came back', S6],
      ['No money for school', S6],
    ] as const) {
      expect(checkTitleFacts(title, said), title).toEqual({ ok: true });
    }
  });

  it('a denial needs a denial: "집 안" is inside, "안 간" is not going', () => {
    for (const title of ['교회에 안 간 일요일', '교회에 못 간 일요일', '교회에 가지 않은 일요일']) {
      expect(checkTitleFacts(title, S2), title).toEqual({ ok: false, reason: 'denial' });
    }
    expect(checkTitleFacts('교회에 간 일요일', S2).ok).toBe(true);
    expect(checkTitleFacts('Father worked without rest', S1)).toEqual({
      ok: false,
      reason: 'denial',
    });
    expect(checkTitleFacts('배 안에서', S2).ok).toBe(true);
    expect(checkTitleFacts('학교에 가지 않은 날', S5).ok).toBe(true);
  });

  it('reads a 400,000-character source in linear time', () => {
    const said = 'My father worked at the harbour and we lived by the sea in 1952. '.repeat(6200);
    const t0 = Date.now();
    expect(checkTitleFacts('My father never lost his job at sea', said).ok).toBe(false);
    expect(
      checkTitleFacts('우리 집 안 풍경', `${'아버지는 부두에서 일하셨어요. '.repeat(25000)}`).ok,
    ).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
