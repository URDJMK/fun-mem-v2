import { describe, expect, it } from 'vitest';
import { looksLikeAsking } from '../src/question-cues';

/**
 * Korean speech-to-text rarely writes "?", so a Korean question must be recognised by its words.
 * Before round 2, almost every Korean interview transcribed without "?" read as two people
 * telling and had to be confirmed by the family (79-100 % of normal interviews).
 */

describe('Korean questions without a question mark', () => {
  it.each([
    '어디서 태어나셨어요',
    '아버지는 어떤 분이셨어요',
    '어머니는요',
    '그때 집은 어땠어요',
    '그 겨울 이야기를 들려주세요',
    '그다음에는 어떻게 되었어요',
    '제일 친한 친구는 누구였어요',
    '고향 마을은 어떤 곳이었나요',
    '학교는 다니셨나요',
    '그때 몇 살이셨어요',
    '할머니 고향은 어디세요',
    '어렸을 때 꿈이 뭐였어요',
    '그 집에서 몇 년이나 사셨어요',
    '그때가 몇 년도였어요',
    '거기서 얼마나 사셨어요',
    '그래서요',
    '그 다음엔요',
    '질문 하나 해도 될까요',
    '그건 무엇인가요',
    '어떻게 만나셨습니까',
    '그 얘기 좀 더 들려주실래요',
  ])('%s', (q) => expect(looksLikeAsking(q)).toBe(true));
});

describe('Korean statements that only look like questions stay statements', () => {
  it.each([
    '기억나요',
    '그때 생각이 나요',
    '몇 년 동안 살았어요',
    '어디 갔다 왔어요',
    '왜 그랬는지 지금도 모르겠어요',
    '어떻게든 살았어요',
    '어떻게 살았나 싶어요',
    '언제나 웃으셨어요',
    '누구나 그랬어요',
    '얼마나 힘들었는지 몰라요',
    '얼마 안 돼서 전쟁이 났어요',
    '학교에 가요',
    '돈이 없으니까 못 갔지',
    '가니까요',
    '왜냐하면 돈이 없었으니까요',
    '그럼요',
    '부산에서요',
    '아버지는 배를 고치셨어요',
    '무슨 말을 해도 아버지는 안 들으셨어요',
    '어디서 왔는지 기억이 안 나요',
    '우리 할머니',
    '언니',
  ])('%s', (s) => expect(looksLikeAsking(s)).toBe(false));
});

describe('the other cues are as before', () => {
  it('a question mark, also the full-width one, and English prompts', () => {
    expect(looksLikeAsking('어디서 태어나셨어요？')).toBe(true);
    expect(looksLikeAsking('Where were you born?')).toBe(true);
    expect(looksLikeAsking('Tell me about your father.')).toBe(true);
    expect(looksLikeAsking('That is lovely. Tell me more about him.')).toBe(true);
    expect(looksLikeAsking('He repaired boats.')).toBe(false);
  });

  it('only the end of a long turn decides: the question is its last clause', () => {
    expect(
      looksLikeAsking(
        '제가 어렸을 때 할머니 댁에 자주 갔었는데 그때 생각이 많이 나요 어머니는 어떤 분이셨어요',
      ),
    ).toBe(true);
    expect(
      looksLikeAsking(
        '아버지가 어디서 오셨는지는 몰라요 그래도 우리한테는 다정하셨고 배를 고치는 일을 하셨어요',
      ),
    ).toBe(false);
  });

  it('is linear: 400,000 characters of anything answer at once', () => {
    for (const text of [
      '가'.repeat(400_000),
      '어디서 '.repeat(100_000),
      '？'.repeat(400_000),
      '요 '.repeat(200_000),
      `${'나'.repeat(399_996)}셨어요`,
      '.'.repeat(400_000),
    ]) {
      const t0 = performance.now();
      looksLikeAsking(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe('round 3: casual Korean, indefinite question words, reported questions, English ASR', () => {
  it.each([
    '어디서 태어났어',
    '결혼은 언제 했어',
    '무슨 일 했어',
    '몇 살에 시집갔어',
    '엄마는',
    '아버지는 어떤 분이었어',
    '그때 뭐 먹고 살았어',
    '언제 왔어',
    '어머니는 어떤 분이셨는지 궁금해요',
    '그때 집이 어땠는지 기억나세요',
    'so where were you born',
    'and your mother',
    'okay and then',
    'what was the house like',
  ])('asks: %s', (q) => expect(looksLikeAsking(q)).toBe(true));

  it.each([
    '우리 아버지는 몇 년 동안 배를 고치셨어요.',
    '어머니는 무슨 일이든 하셨어요.',
    '아버지는 어디서든 주무셨어요.',
    '어머니는 몇 시간씩 걸어서 시장에 가셨어요.',
    '아버지는 어떤 일이든 마다하지 않으셨어요.',
    '삼촌이 누구보다 먼저 오셨어요.',
    '어머니가 뭘 하시든 우리는 따랐어요.',
    '아버지는 몇 년 일하시다가 병이 나셨어요.',
    '어디 갔다 오셨냐고 물으셨어요.',
    '선생님이 누구세요 하고 물으셨어요.',
    '아버지는 어떤 분이셨냐면 말씀이 없으셨어요.',
    '뭐 그냥 그렇게 살았지',
    'When I was young we lived in a little house in Busan, right by the harbour.',
    'and then we walked all the way to Busan with my brother on my back',
    'How we survived that winter I will never know, my mother said.',
  ])('tells: %s', (s) => expect(looksLikeAsking(s)).toBe(false));
});
