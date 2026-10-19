import { describe, expect, it } from 'vitest';
import { KoreanGroundingGate } from '../src/drafts-gate';
import { checkGrounding, type ViolationKind } from '../src/grounding-ko';

/**
 * Round 2 of the grounding check: meaning changes a reviewer found it still accepting, and
 * faithful tidy-ups it still refused. Every `refused` case below was ACCEPTED at a9cc143.
 */

const gate = new KoreanGroundingGate();
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

describe('Korean: a word is the same word only with the same stem', () => {
  it.each([
    ['형이 군대에서 돌아왔다.', '형이 군대에서 돌아갔다.', 'came back -> went back'],
    ['형이 군대에서 돌아왔다.', '형이 군대에서 돌아가셨다.', 'came back -> died'],
    ['할아버지가 일본에서 돌아오셨다.', '할아버지가 일본에서 돌아가셨다.', '돌아오셨 -> 돌아가셨'],
    [
      '오빠가 미국에 갔다가 돌아왔어요.',
      '오빠가 미국에 갔다가 돌아가셨어요.',
      '돌아와 -> 돌아가셨',
    ],
    [
      '아버지가 집에 돌아와서 주무셨다.',
      '아버지가 집에 돌아가서 주무셨다.',
      '돌아와서 -> 돌아가서',
    ],
    ['아버지가 동생을 데려왔다.', '아버지가 동생을 데려갔다.', 'brought -> took away'],
    ['할머니가 방에서 나왔다.', '할머니가 방에서 나갔다.', 'came out -> went out'],
    ['아버지는 죽도록 일하셨다.', '아버지는 일하다 죽었다.', 'worked to death -> died'],
    ['어머니가 사과를 주셨다.', '어머니가 사서 주셨다.', '사과 (apple) is not 사 (buy)'],
    [
      '어머니는 시장에서 장사를 하셨다.',
      '어머니는 시장에서 거지처럼 장사를 하셨다.',
      '거지 (beggar) is not free',
    ],
    ['동생이 학교에서 돌아왔다.', '동생이 학교에서 맞고 돌아왔다.', '맞고 (beaten) added'],
  ])('%s -> %s (%s) is refused', (src, body) => refused(src, body));

  it('numbers said in words are numbers: 일 년 is not 이 년, 삼 원 is not 삼만 원', () => {
    refused('어머니는 일 년 동안 아프셨다.', '어머니는 이 년 동안 아프셨다.', 'number');
    refused('빚이 삼 원이었다.', '빚이 삼만 원이었다.', 'number');
    refused('아버지는 삼 년 동안 군대에 계셨다.', '아버지는 삼십 년 동안 군대에 계셨다.');
    refused('어머니는 오 년 동안 아프셨다.', '어머니는 오십 년 동안 아프셨다.');
    refused('아버지가 돌아가신 지 십 년이 됐어요.', '아버지가 돌아가신 지 이십 년이 됐어요.');
    refused('어머니가 열여섯 살에 시집오셨다.', '어머니가 열 살에 시집오셨다.');
    refused('동생이 셋 있었어요.', '동생이 넷 있었어요.');
  });

  it('...and the same number in digits is the same: 열두 살 = 12살, 스무 살 = 20살, 다섯 식구 = 5식구, 육이오 = 6·25', () => {
    accepted('그 때 저는 열두 살이었어요.', '그때 저는 12살이었습니다.');
    accepted('저는 스무 살에 결혼했어요.', '저는 20살에 결혼했습니다.');
    accepted('우리 가족은 다섯 식구였어요.', '우리 가족은 5식구였다.');
    accepted('저는 육이오 때 피난을 갔어요.', '저는 6·25 때 피난을 갔어요.');
    accepted('빚이 삼만 원이었어요.', '빚이 30000원이었어요.');
    accepted('아버지는 천구백오십년에 돌아가셨다.', '아버지는 1950년에 돌아가셨다.');
  });

  it('a changed number is caught beside any counter, with a word before it: 삼 is not 사, 열 is not 열한', () => {
    refused('우리는 삼 남매였어요.', '우리는 사 남매였어요.', 'number');
    refused('우리는 삼남매였어요.', '우리는 사남매였어요.');
    refused('그때는 삼 형제였어요.', '그때는 사 형제였어요.');
    refused('그 집에서 삼 대가 같이 살았어요.', '그 집에서 사 대가 같이 살았어요.');
    refused('그때 삼 일 동안 앓았어요.', '그때 사 일 동안 앓았어요.');
    refused('그때 열 곳을 다녔어요.', '그때 열한 곳을 다녔어요.');
    refused('그때 열한 곳을 다녔어요.', '그때 열 곳을 다녔어요.');
    refused('그때 십 곳을 다녔어요.', '그때 십이 곳을 다녔어요.');
    refused('그때 오 분 걸렸어요.', '그때 십 분 걸렸어요.');
  });

  it('...and the same number said another way, or with other spacing, still passes', () => {
    accepted('우리는 삼 남매였어요.', '우리는 세 남매였어요.');
    accepted('우리는 삼 남매였어요.', '우리는 3 남매였어요.');
    accepted('우리는 삼 남매였어요.', '우리는 삼남매였어요.');
    accepted('우리는 삼남매였어요.', '우리는 삼 남매였어요.');
    accepted('삼십 대에 결혼했어요.', '삼십대에 결혼했어요.');
    accepted('삼십대에 결혼했어요.', '삼십 대에 결혼했어요.');
    accepted('그때 오 분 걸렸어요.', '그때 오분 걸렸어요.');
    accepted('그 일은 안 했어요.', '그 일은 안했어요.');
    accepted('그때 밥상 차려주심', '그때 밥상을 차려 주셨다.');
  });

  it('words that only look like numbers stay words: 만세, 세대, 이번, 이분, 하나님, 열 (fever), 백 (a surname)', () => {
    for (const [said, numeric] of [
      ['만세를 불렀어요.', '10000세를 불렀어요.'],
      ['세대가 달라요.', '3대가 달라요.'],
      ['이번에 갔어요.', '2번에 갔어요.'],
      ['이분이 우리 할머니예요.', '2분이 우리 할머니예요.'],
      ['하나님께 기도했어요.', '1님께 기도했어요.'],
      ['열이 났어요.', '10이 났어요.'],
      ['백 사장님이 잘해 주셨어요.', '100 사장님이 잘해 주셨어요.'],
    ] as const) {
      expect(checkGrounding(said, numeric).violations.length, numeric).toBeGreaterThan(0);
      accepted(said, said);
    }
  });

  it('a tidy rewrite still passes: endings, honorifics, particles, spacing, 거든요, 대요, 이세요, dialect', () => {
    accepted('그때 우리가 대구로 이사를 갔거든요.', '그때 우리는 대구로 이사를 갔다.');
    accepted('어머니가 저를 업고 산을 넘으셨대요.', '어머니가 저를 업고 산을 넘으셨다고 해요.');
    accepted('아버지는 1925년생이세요.', '아버지는 1925년생이십니다.');
    accepted('아부지가 장에 가셨어예.', '아버지가 장에 가셨어요.');
    accepted('할매가 밥을 해 주셨데이.', '할머니가 밥을 해 주셨다.');
    accepted('아마 1960년쯤이었을 거예요.', '아마 1960년쯤이었을 겁니다.');
    accepted('그때가 1960년쯤이었을 거예요.', '그때가 1960년쯤이었을 것입니다.');
    accepted('아버지가 왔어요.', '아버지께서 오셨습니다.');
    accepted('어머니는 시장에서 생선을 팔았어요.', '어머니는 시장에서 생선을 파셨다.');
    accepted(
      '1997년 겨울에 회사 그만두고 집에 갔는데 어머니가 아무것도 안 물어보고 밥상 차려주심',
      '1997년 겨울, 회사를 그만두고 집에 간 날이었다. 어머니는 아무것도 묻지 않으셨다. 밥상을 차려 주셨다.',
    );
  });
});

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

describe('Korean links end where the word ends', () => {
  it('the aunt is not linked inside 이모부 (her husband), nor a son inside 아들딸', async () => {
    const { linkKnownTitles } = await import('../src/drafts');
    expect(linkKnownTitles('이모부가 오셨다.', ['이모']).body).toBe('이모부가 오셨다.');
    expect(linkKnownTitles('고모부가 돈을 빌려 주셨다.', ['고모']).linked).toEqual([]);
    expect(linkKnownTitles('손자며느리가 왔다.', ['손자']).linked).toEqual([]);
    expect(linkKnownTitles('아들딸 모두 왔다.', ['아들']).linked).toEqual([]);
    expect(linkKnownTitles('삼촌댁이 오셨다.', ['삼촌']).linked).toEqual([]);
    // a particle, 씨, 네 or the copula after the title is still the same person
    expect(linkKnownTitles('아버지가 오셨다.', ['아버지']).body).toBe('[[아버지]]가 오셨다.');
    expect(linkKnownTitles('김순자씨가 왔다.', ['김순자']).body).toBe('[[김순자]]씨가 왔다.');
    expect(linkKnownTitles('김순자네 집에 갔다.', ['김순자']).body).toBe('[[김순자]]네 집에 갔다.');
    expect(linkKnownTitles('어머니께서는 오셨다.', ['어머니']).body).toBe(
      '[[어머니]]께서는 오셨다.',
    );
    expect(linkKnownTitles('그분이 우리 아버지였다.', ['아버지']).body).toBe(
      '그분이 우리 [[아버지]]였다.',
    );
  });

  it('...and the whole gate does not write [[이모]]부 or say it linked', () => {
    const r = gate.check(
      {
        title: '이모부',
        type: 'event',
        occurred: null,
        body: '이모부가 돈을 빌려 주셨다.',
        notes: [],
      },
      { text: '이모부가 돈을 빌려 주셨다.', media: null, titles: ['이모'] },
    );
    expect(r.accepted?.body).toBe('이모부가 돈을 빌려 주셨다.');
    expect(r.accepted?.notes.some((n) => n.includes('연결'))).toBe(false);
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
    ['만약 비가 오면 집에 있었어요.', '비가 와서 집에 있었어요.', 'hedge'],
    ['아들만 셋이었어요.', '아들이 셋이었어요.', 'hedge'],
    ['1950년 이전에 서울로 왔어요.', '1950년에 서울로 왔어요.', 'hedge'],
    ['전남편이 집을 팔았어요.', '남편이 집을 팔았어요.', 'person'],
  ] as const)('%s', (src, body, kind) => refused(src, body, kind));

  it('the same words kept, or written another way, still pass', () => {
    accepted(
      '어머니는 몸이 약하셨는데 일을 많이 하셨어요.',
      '어머니는 몸이 약하셨지만 일을 많이 하셨어요.',
    );
    accepted('어 그게 뭐냐면 아버지가 광부였어요.', '아버지가 광부였어요.');
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
  it('20,000 negations, and 20,000 mismatched Korean ones, each under 1 s', () => {
    const nots = Array.from(
      { length: 20000 },
      (_, i) => `I did not go ${i % 3 ? 'there' : 'home'}.`,
    ).join(' ');
    const notsDiff = Array.from(
      { length: 20000 },
      (_, i) => `I did not go ${i % 3 ? 'home' : 'there'}.`,
    ).join(' ');
    const ko = Array.from(
      { length: 20000 },
      (_, i) => `안 ${['갔다', '먹었다', '했다'][i % 3]}.`,
    ).join(' ');
    const ko2 = Array.from(
      { length: 20000 },
      (_, i) => `안 ${['먹었다', '했다', '갔다'][i % 3]}.`,
    ).join(' ');
    expect(ms(() => checkGrounding(nots, nots))).toBeLessThan(1000);
    expect(ms(() => checkGrounding(nots, notsDiff))).toBeLessThan(1000);
    let r: ReturnType<typeof checkGrounding> | null = null;
    expect(ms(() => (r = checkGrounding(ko, ko2)))).toBeLessThan(1000);
    // and a hostile text gets a few violations, never one per sentence
    expect(r!.violations.length).toBeLessThan(20);
  });
  it('400,000 characters of Korean numerals and counters stay linear', () => {
    const t = Array.from({ length: 80000 }, (_, i) => (i % 2 ? '삼십 년' : '열두 살')).join(' ');
    expect(t.length).toBeGreaterThan(390_000);
    expect(ms(() => checkGrounding(t, t))).toBeLessThan(3000);
  });
});

/**
 * Round 3: Korean tense and mood. Round 2 matched words by stem, so 갈 거예요 and 갔어요
 * became one word: every swap below was ACCEPTED at e94173c.
 */
describe('Korean tense, future, guesses, hearsay, commands and obligation are kept', () => {
  type V = Record<
    | 'past'
    | 'pres'
    | 'fut'
    | 'conj'
    | 'hear'
    | 'quote'
    | 'prog'
    | 'must'
    | 'wish'
    | 'tryTo'
    | 'can'
    | 'neg',
    string
  >;
  const verb = (
    past: string,
    pres: string,
    fut: string,
    stem: string,
    must: string,
    tryTo: string,
  ): V => ({
    past,
    pres,
    fut: `${fut} 거예요`,
    conj: `${past.slice(0, -2)}을 거예요`,
    hear: `${past.slice(0, -2)}대요`,
    quote: `${stem}라고 했어요`,
    prog: `${stem}고 있었어요`,
    must: `${must} 했어요`,
    wish: `${stem}고 싶었어요`,
    tryTo: `${tryTo}려고 했어요`,
    can: `${fut} 수 있었어요`,
    neg: `${stem}지 않았어요`,
  });
  const verbs: V[] = [
    verb('갔어요', '가요', '갈', '가', '가야', '가'),
    verb('왔어요', '와요', '올', '오', '와야', '오'),
    verb('일했어요', '일해요', '일할', '일하', '일해야', '일하'),
    { ...verb('먹었어요', '먹어요', '먹을', '먹', '먹어야', '먹으'), quote: '먹으라고 했어요' },
    verb('팔았어요', '팔아요', '팔', '팔', '팔아야', '팔'),
    verb('결혼했어요', '결혼해요', '결혼할', '결혼하', '결혼해야', '결혼하'),
    verb('이사했어요', '이사해요', '이사할', '이사하', '이사해야', '이사하'),
    verb('살았어요', '살아요', '살', '살', '살아야', '살'),
    verb('만났어요', '만나요', '만날', '만나', '만나야', '만나'),
    verb('떠났어요', '떠나요', '떠날', '떠나', '떠나야', '떠나'),
  ];
  const subjects = ['아버지가', '그때 어머니가', '큰형이'];
  const flips: Array<[string, keyof V, keyof V]> = [
    ['past -> present', 'past', 'pres'],
    ['present -> past', 'pres', 'past'],
    ['future -> past (갈 거예요 -> 갔어요)', 'fut', 'past'],
    ['past -> future', 'past', 'fut'],
    ['a guess made a fact (갔을 거예요 -> 갔어요)', 'conj', 'past'],
    ['hearsay made a fact (갔대요 -> 갔어요)', 'hear', 'past'],
    ['a command made an act (가라고 했어요 -> 갔어요)', 'quote', 'past'],
    ['progressive -> past', 'prog', 'past'],
    ['an obligation dropped (가야 했어요 -> 갔어요)', 'must', 'past'],
    ['a wish dropped', 'wish', 'past'],
    ['an attempt dropped', 'tryTo', 'past'],
    ['an ability dropped', 'can', 'past'],
    ['a negation dropped', 'neg', 'past'],
    ['a negation added', 'past', 'neg'],
  ];
  it.each(flips)('%s is refused for 10 verbs x 3 subjects', (_name, from, to) => {
    const leaks: string[] = [];
    for (const v of verbs)
      for (const s of subjects)
        if (checkGrounding(`${s} ${v[from]}.`, `${s} ${v[to]}.`).violations.length === 0)
          leaks.push(`${s} ${v[from]} -> ${v[to]}`);
    expect(leaks).toEqual([]);
  });

  it('...and the same tense and mood in another register passes, both ways', () => {
    const groups = [
      ['갔어요', '갔다', '갔습니다', '갔어'],
      ['가요', '간다', '갑니다'],
      ['갈 거예요', '갈 것이다', '갈 겁니다', '갈 거야'],
      ['갔을 거예요', '갔을 것이다', '갔을 겁니다'],
      ['갔대요', '갔다고 해요', '갔다고 합니다', '갔대', '갔다고 하더라고요', '갔다고 했어요'],
      ['간대요', '간다고 해요'],
      ['가라고 했어요', '가라고 했다', '가라고 하셨어요', '가래요', '가라고 해요'],
      ['가고 있었어요', '가고 있었다'],
      ['가야 했어요', '가야 했다', '가야 했습니다'],
      ['가지 않았어요', '가지 않았다'],
      ['먹었어요', '먹었다', '먹었습니다'],
      ['먹어요', '먹는다', '먹습니다'],
      ['먹을 거예요', '먹을 것이다', '먹을 겁니다'],
      ['먹으라고 했어요', '먹으라고 했다'],
      ['팔아요', '판다', '팝니다'],
      ['살아요', '산다', '삽니다'],
      ['일해요', '일한다', '일합니다'],
      ['떠날 거예요', '떠날 것이다', '떠날 겁니다'],
    ];
    const refusedOnes: string[] = [];
    for (const g of groups)
      for (const a of g)
        for (const b of g)
          for (const s of subjects)
            if (a !== b && checkGrounding(`${s} ${a}.`, `${s} ${b}.`).violations.length > 0)
              refusedOnes.push(`${s} ${a} -> ${b}`);
    expect(refusedOnes).toEqual([]);
    for (const [said, tidy] of [
      ['제 고향은 부산이에요.', '제 고향은 부산입니다.'],
      ['아버지가 광부였거든요.', '아버지가 광부였어요.'],
      ['그게 내 고향이거든요.', '그게 내 고향이야.'],
      ['아버지가 광부였어예.', '아버지가 광부였어요.'],
      ['그때 참 추웠데이.', '그때 참 추웠다.'],
      ['"밥 먹어라" 하셨어요.', '"밥 먹어라"라고 하셨어요.'],
      ['그분이 의사래요.', '그분이 의사라고 해요.'],
      ['어머니는 아직 살아 계세요.', '어머니는 아직 살아 계십니다.'],
      ['친구가 돈을 빌려 주셨어요.', '친구가 돈을 빌려주셨다.'],
      ['아버지가 집에 와서 주무셨어요.', '아버지께서 집에 오셔서 주무셨다.'],
      ['서울에 살게 됐어요.', '서울에서 살게 됐습니다.'],
    ] as const) {
      accepted(said, tidy);
      accepted(tidy, said);
    }
  });

  it.each([
    ['어머니는 아직 살아 계세요.', '어머니는 아직 살아 계셨어요.'],
    ['아버지가 갔대요.', '아버지가 갔어요.'],
    ['아버지가 가라고 하셨어요.', '아버지가 가셨어요.'],
    ['내일 갈 거예요.', '내일 갔어요.'],
    ['친구가 돈을 빌려 주셨어요.', '친구가 돈을 빌리셨어요.'],
    ['친구가 돈을 빌렸어요.', '친구가 돈을 빌려줬어요.'],
    ['밥을 해 주셨어요.', '밥을 하셨어요.'],
    ['그분이 의사래요.', '그분이 의사예요.'],
    ['아버지가 가래요.', '아버지가 가요.'],
    ['아버지가 가래요.', '아버지가 갔다고 해요.'],
    ['아버지가 가라고 했어요.', '아버지가 갔다고 했어요.'],
    ['제가 갈게요.', '제가 갔어요.'],
    ['돌아가셨다고 하더라고요.', '돌아가셨어요.'],
  ])('%s -> %s is refused', (src, body) => refused(src, body, 'hedge'));

  // a "tidy" model that unifies the endings the way models do (b-gate-pipeline/e2e-ko-flip)
  const flipsE2e: Array<[RegExp, string]> = [
    [/가셨대요/g, '가셨어요'],
    [/돌아가셨다고 하더라고요/g, '돌아가셨어요'],
    [/가라고 하셨어요/g, '가셨어요'],
    [/갈 거예요/g, '갔어요'],
    [/살아 계세요/g, '살아 계셨어요'],
    [/가야 했어요/g, '갔어요'],
  ];
  const turns = [
    '큰아버지는 1950년에 서울로 가셨대요. 그 뒤로 소식이 없었는데 나중에 돌아가셨다고 하더라고요. 그때 나는 열 살이었어요.',
    '작은아버지는 부산에서 장사를 하셨는데 내년에 우리 집에 오실 거예요. 어머니는 아직 살아 계세요. 저는 거기 가야 했어요.',
    '큰어머니가 저더러 서울로 가라고 하셨어요. 내일 우리가 갈 거예요.',
  ];
  it.each(turns)('the gate refuses the unified endings of: %s', (turn) => {
    let body = turn;
    for (const [re, to] of flipsE2e) body = body.replace(re, to);
    expect(body).not.toBe(turn);
    expect(verdict(turn, body)).toBe(false);
    expect(verdict(turn, turn)).toBe(true);
  });
  it('...and end to end the import saves those turns word for word, never as ai-grounded', async () => {
    const { ingestTranscript } = await import('../src/ingest-pipeline');
    const chat = {
      id: 'tidy',
      complete: async (_s: string, u: string) =>
        JSON.stringify({
          memories: u.split('\n').flatMap((l) => {
            const m = /^\[(\d+)(?:\|[^\]]*)?\] ([\s\S]*)$/.exec(l);
            if (!m) return [];
            let b = m[2]!;
            for (const [re, to] of flipsE2e) b = b.replace(re, to);
            return [{ turns: [Number(m[1])], title: '', body: b }];
          }),
        }),
    };
    const text = [
      '질문자: 큰아버지는요?',
      `할머니: ${turns[0]}`,
      '질문자: 작은아버지는요?',
      `할머니: ${turns[1]}`,
      '질문자: 큰어머니는요?',
      `할머니: ${turns[2]}`,
    ].join('\n');
    const out = await ingestTranscript(
      text,
      { interviewees: ['할머니'] },
      {
        chat: chat as never,
        titles: [],
      },
    );
    expect(out.memories.map((m) => m.method)).toEqual(['verbatim', 'verbatim', 'verbatim']);
    expect(out.memories.map((m) => m.body.split('\n')[0])).toEqual(turns);
  });

  it('400,000 characters of Korean endings, and one 400,000-character word, stay linear', () => {
    const ms = (f: () => void): number => {
      const t0 = performance.now();
      f();
      return performance.now() - t0;
    };
    const parts = [
      '아버지가 가라고 하셨대요.',
      '내일 갈 거예요.',
      '갔을 것 같아요.',
      '"밥 먹어라" 하셨어요.',
      '돈을 빌려 주셨더라고요.',
      '가야 했어요.',
      '가도 돼요.',
      '의사래요.',
      '갈게요.',
    ];
    const t = Array.from({ length: 40000 }, (_, i) => parts[i % parts.length]).join(' ');
    expect(t.length).toBeGreaterThan(390_000);
    expect(ms(() => checkGrounding(t, t))).toBeLessThan(3000);
    const word = '가라'.repeat(100_000) + '고 했어요.';
    expect(ms(() => checkGrounding(word, word))).toBeLessThan(1000);
    const rae = `${'래'.repeat(200_000)} ${'빌려주'.repeat(70_000)}`;
    expect(ms(() => checkGrounding(rae, rae))).toBeLessThan(1000);
  });

  it('...and 400,000 characters of frames, frequencies, asides and one-word sentences too', () => {
    const parts = [
      '꿈에서 가끔 아직 들은 소문에 혹시 오빠가 왔어요.',
      'You know, I heard that he sometimes still came too.',
      'Like I said, first of all, I mean, he died.',
      'He died.',
      '무서웠어요.',
    ];
    const t = Array.from({ length: 14000 }, (_, i) => parts[i % parts.length]).join(' ');
    expect(t.length).toBeGreaterThan(390_000);
    const dropped = t.replaceAll(' He died.', '');
    const t0 = performance.now();
    checkGrounding(t, t);
    const r = checkGrounding(t, dropped);
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(r.violations.map((v) => v.kind)).toContain('dropped');
  });
});

/**
 * Round 3, B2: a long turn could lose 10% of its words, and the words that went were the ones
 * that say who it came from, how often and how far ("I heard that", "sometimes", 꿈에서).
 * Every `refused` case below was ACCEPTED at e94173c.
 */
describe('a long turn keeps who said it, how often, how far, and every short sentence', () => {
  const lead = (x: string) =>
    `${x} my uncle died in Ohio in 1947, and the whole family took the train from Scranton to the funeral, which was held in the church by the river.`;
  const adv = (x: string) =>
    `When the war started in 1943, my father, who had worked at the mill in town for many years, ${x} brought home bread and sugar for the whole family every Friday after work.`;
  const leadKo = (x: string) =>
    `${x} 삼촌이 1947년에 오하이오에서 돌아가셔서 온 가족이 스크랜턴에서 기차를 타고 강가에 있는 교회에서 열린 장례식에 갔어요.`;
  const advKo = (x: string) =>
    `전쟁이 시작된 1943년 겨울에 우리 아버지는 읍내 방앗간에서 오랫동안 일하셨는데, 금요일마다 퇴근길에 ${x} 빵과 설탕을 사 오셔서 온 식구가 나눠 먹었어요.`;
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

  it.each(['소문에', '꿈에서', '듣기로는', '제가 알기로는', '제 생각에는'])(
    '"%s ..." is not the fact itself',
    (frame) => refused(leadKo(frame), without(leadKo), 'hedge'),
  );
  it.each([
    '혹시',
    '가끔',
    '항상',
    '늘',
    '언제나',
    '자주',
    '아직',
    '이미',
    '벌써',
    '겨우',
    '간신히',
    '전혀',
    '절대',
    '처음',
    '나중에',
    '계속',
  ])('"%s" is kept in a long turn', (w) => refused(advKo(w), without(advKo)));

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
  it.each(['그는 죽었어요.', '무서웠어요.', '우리는 가난했어요.'])(
    'the one-word sentence "%s" is not dropped from a long turn',
    (d) => {
      const head =
        '아버지는 일주일에 엿새를 허드슨 석탄 회사 광산에서 일하셨고 어머니는 집 뒤에서 닭을 키우셨어요.';
      const tail =
        '겨울에는 오빠가 철도 마당에서 수레로 날라 온 석탄을 때고 일요일에는 강가에 있는 교회까지 걸어갔어요.';
      refused(`${head} ${d} ${tail}`, `${head} ${tail}`, 'dropped');
    },
  );

  it('...but "you know", "I mean", "like I said", "first of all" and 참 may go, and too is also', () => {
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
    accepted(
      '그때 아버지는 참 열심히 탄광에서 일하셨고 어머니는 시장에서 생선을 팔아서 우리 다섯 식구를 먹여 살리셨어요.',
      '그때 아버지는 열심히 탄광에서 일하셨고 어머니는 시장에서 생선을 팔아서 우리 다섯 식구를 먹여 살리셨어요.',
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
      [/꿈에서 /g, ''],
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
      '꿈에서 오빠가 1943년에 전쟁에서 돌아왔는데 다음 날 아침에 어머니가 오빠 밥상을 차려 놓고 우리는 하루 종일 창가에서 기다렸어요.',
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
    ['아버지는 광부였어요. 우리는 가난했어요.', '아버지는 광부였어요. 그래서 우리는 가난했어요.'],
    ['아버지는 광부였어요. 우리는 가난했어요.', '아버지는 광부였지만 우리는 가난했어요.'],
    ['아버지가 돌아가셨어요. 우리는 이사했어요.', '아버지가 돌아가셔서 우리는 이사했어요.'],
    ['아버지가 돌아가셨어요. 우리는 이사했어요.', '아버지가 돌아가시자 우리는 이사했어요.'],
    ['아버지가 돌아가시고 학교를 그만뒀어요.', '아버지가 돌아가셔서 학교를 그만뒀어요.'],
    ['가난해서 학교를 못 갔어요.', '가난했지만 학교를 못 갔어요.'],
    ['가난했지만 학교에 갔어요.', '가난해서 학교에 갔어요.'],
    ['비가 왔는데 갔어요.', '비가 와서 갔어요.'],
    ['아버지가 술을 드셨어요. 어머니가 떠나셨어요.', '아버지가 술을 드셔서 어머니가 떠나셨어요.'],
  ])('a link the speaker did not make: %s -> %s', unsupported);

  it('...but "and", a comma, a full stop, and the links they did make, still pass', () => {
    accepted('He drank. She left.', 'He drank and she left.');
    accepted('He drank. She left.', 'He drank, and she left.');
    accepted('아버지는 광부였어요. 우리는 가난했어요.', '아버지는 광부였고 우리는 가난했어요.');
    accepted('학교에 갔어요. 공부를 했어요.', '학교에 가서 공부를 했어요.');
    accepted(
      '어머니가 시장에 가셨어요. 생선을 파셨어요.',
      '어머니가 시장에 가셔서 생선을 파셨어요.',
    );
    accepted(
      '어머니는 몸이 약하셨는데 일을 많이 하셨어요.',
      '어머니는 몸이 약하셨지만 일을 많이 하셨어요.',
    );
    accepted('아버지가 돌아가셨어요. 그래서 이사했어요.', '아버지가 돌아가셔서 이사했어요.');
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
    [
      '아버지가 돌아가셨어요. 우리는 이사를 갔어요.',
      '우리는 이사를 갔어요. 아버지가 돌아가셨어요.',
    ],
    ['전쟁이 났어요. 아버지가 돌아가셨어요.', '아버지가 돌아가셨어요. 전쟁이 났어요.'],
  ])('not in the order it was said: %s -> %s', unsupported);

  const S =
    'I was born in Busan. We lived near the harbour. My father repaired boats and my mother sold fish.';
  const SK =
    '저는 부산에서 태어났어요. 우리는 항구 근처에 살았어요. 아버지는 배를 고치셨고 어머니는 생선을 파셨어요.';
  it.each([
    [S, `${S} We lived near the harbour.`],
    [S, `We lived near the harbour. ${S}`],
    [S, `${S} ${S}`],
    [
      S,
      'I was born in Busan. We lived near the harbour. We lived near the harbour. My father repaired boats and my mother sold fish.',
    ],
    [SK, `${SK} 우리는 항구 근처에 살았어요.`],
    [SK, `${SK} ${SK}`],
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
    accepted('아버지는 광부셨는데 일찍 돌아가셨어요.', '아버지는 광부셨다. 일찍 돌아가셨다.');
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
    ['집에 갔어요.', '집에서 갔어요.'],
    ['부산에서 왔어요.', '부산으로 왔어요.'],
    ['학교에서 돌아왔어요.', '학교로 돌아왔어요.'],
    ['서울에서 태어났어요.', '서울로 태어났어요.'],
  ])('where to and where from: %s -> %s', unsupported);

  it('...but in and at, 에 and 에서 where nothing moves, and 에 and 로 where it does, are one', () => {
    accepted('I worked in the mill.', 'I worked at the mill.');
    accepted('She came to America from Korea.', 'She came from Korea to America.');
    accepted('서울에 살았어요.', '서울에서 살았어요.');
    accepted('서울에 갔어요.', '서울로 갔어요.');
    accepted('그때는 학교에 안 갔어요.', '그때는 학교에 가지 않았어요.');
    accepted(
      '우리는 부산에서 살았어요. 그리고 대구로 이사했어요.',
      '우리는 부산에서 살다가 대구로 이사했어요.',
    );
  });

  it('400,000 characters of joined, reordered and repeated sentences stay linear', () => {
    const parts = [
      'My father died in the war.',
      'We moved to Ohio with my mother.',
      'He drank, so she left.',
      '아버지가 돌아가셔서 우리는 서울로 이사했어요.',
      '학교에 가서 공부를 했어요.',
    ];
    const t = Array.from({ length: 16000 }, (_, i) => parts[i % parts.length]).join(' ');
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
 * born in Busan and his father was a miner") or addresses it to someone ("당신은") is not the
 * speaker's. Every `refused` case below was ACCEPTED at e94173c.
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
    [
      '저는 1946년에 부산에서 태어났어요. 아버지는 광부셨어요.',
      '그는 1946년에 부산에서 태어났어요. 아버지는 광부셨어요.',
    ],
    [
      '나는 1946년에 부산에서 태어났어요. 우리 아버지는 광부셨어요.',
      '그는 1946년에 부산에서 태어났어요. 그의 아버지는 광부셨어요.',
    ],
    ['제 어머니는 시장에서 일하셨어요.', '그의 어머니는 시장에서 일하셨어요.'],
    ['제 어머니는 시장에서 일하셨어요.', '그녀의 어머니는 시장에서 일하셨어요.'],
    ['저는 어머니를 도왔어요.', '당신은 어머니를 도왔어요.'],
    ['저는 어머니를 도왔어요.', '너는 어머니를 도왔어요.'],
    ['저는 갔어요.', '그는 갔어요.'],
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
    accepted('저는 1946년에 부산에서 태어났어요.', '저는 1946년에 부산에서 태어났습니다.');
    accepted('우리 아버지는 광부셨어요.', '우리 아버지는 광부였다.');
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
    const { eojeols, shownText } = await import('../src/grounding-ko');
    const { linkKnownTitles } = await import('../src/drafts');
    const ms = (f: () => void): number => {
      const t0 = performance.now();
      f();
      return performance.now() - t0;
    };
    const runs = '[['.repeat(200_000);
    const half = Array.from({ length: 50_000 }, (_, i) => (i % 2 ? '[[아버지' : '[[')).join('');
    expect(runs.length).toBe(400_000);
    for (const t of [runs, half]) {
      expect(ms(() => checkGrounding(t, t))).toBeLessThan(2000);
      expect(ms(() => checkGrounding('아버지가 오셨다.', t))).toBeLessThan(2000);
      expect(ms(() => eojeols(t))).toBeLessThan(500);
      expect(ms(() => shownText(t))).toBeLessThan(500);
      expect(ms(() => linkKnownTitles(t, ['아버지']))).toBeLessThan(2000);
      expect(ms(() => verdict(t, t))).toBeLessThan(3000);
    }
    // and a link is still a link
    expect(shownText('[[아버지]]가 오셨다')).toBe('아버지가 오셨다');
    expect(eojeols('[[아버지]] 오셨다')).toEqual(['오셨다']);
  });
});
