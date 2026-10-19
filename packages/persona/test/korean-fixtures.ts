/**
 * FM-027 — realistic Korean family testimony.
 *
 * The earlier fixtures were textbook Korean: clean spacing, terminal
 * punctuation on every sentence, one register throughout. Real memory notes in
 * this product are transcribed speech from elderly relatives, and they differ
 * in ways the code actually has to survive:
 *
 *   - honorific and speech-level mixing (하셨다 / 하셨어요 / 했지) inside one note
 *   - 조사 fused to names and places (부산에서, 할머니가, 결혼식은)
 *   - dates in several forms: 1965년, 65년, 예순다섯, 단기 4298년
 *   - inconsistent spacing — 붙여쓰기 is normal in handwriting and transcription
 *   - dialect (부산 사투리: 했다 아이가, ~노, ~예)
 *   - transcribed speech with NO terminal punctuation for whole paragraphs
 *   - 한자 for names and places, still common in older records
 *
 * A pipeline tuned to the clean version can look correct and then fail on every
 * real note. These fixtures exist so the tests exercise what the product will
 * actually be handed.
 */

/** Two relatives, one wedding, materially different accounts. FR-083's fixture. */
export const WEDDING = {
  question: '할머니 결혼식은 언제였나요?',
  /** Mother's account — polite speech level, spacing inconsistent, 한자 place name. */
  mother: [
    '어머니께 들은 이야기입니다',
    '',
    '할머니 결혼식은 1965년 봄에 釜山에서 있었어요 그때 어머니는 아직 학생이셨고',
    '외갓집 식구들이 다 모여서 잔치를 크게 했다고 하셨어요',
    '사진이 한 장 남아 있는데 뒷면에 六五年 봄이라고 적혀 있습니다',
  ].join('\n'),
  /**
   * Uncle's account — dialect, no terminal punctuation, different year AND
   * place. He NAMES the subject once ("할머니 결혼식 말이가"), because a
   * transcript that only says 그거는 is unretrievable by any content leg, and a
   * fixture nothing can retrieve tests nothing.
   */
  uncle: [
    '삼촌 구술',
    '',
    '할머니 결혼식 말이가 그거는 1967년이라 대구에서 했다 아이가',
    '내가 그때 국민학교 다녔는데 기차 타고 갔던 기억이 생생하다 카이',
    '봄이 아이고 가을이었다 감나무에 감이 달려 있었으니까',
  ].join('\n'),
};

/** A note that answers what it is asked, for positive controls. */
export const BIRTH = {
  question: '할머니는 어디서 태어나셨어요?',
  body: [
    '할머니 약력',
    '',
    '할머니는 1943년 부산에서 태어나셨다 어릴 때는 영도에 사셨고',
    '바닷가에서 자주 노셨다고 하셨어요 형제는 다섯이었는데 할머니가 셋째셨다',
  ].join('\n'),
};

/**
 * Gap-questions against REALISTIC evidence: the note is genuinely about the
 * right person and richly detailed, and simply does not contain the answer.
 * This is what makes a gap-question dangerous — every earlier gate is satisfied.
 */
export const GAPS: Array<{ question: string; body: string }> = [
  {
    question: '할머니가 수영은 언제 배우셨어요?',
    body: [
      '할머니는 1943년 부산에서 태어나셨다 영도 바닷가 근처에 사셨고',
      '어릴 때 이야기를 자주 들려주셨어요 형제는 다섯이었다',
    ].join('\n'),
  },
  {
    question: '할아버지 첫 직장은 어디였어요?',
    body: [
      '할아버지는 1940년 대구 출생이시고 결혼은 1965년에 하셨다',
      '군대는 육군으로 다녀오셨고 자식은 넷을 두셨어요',
    ].join('\n'),
  },
  {
    question: '어머니는 무슨 색을 좋아하셨어요?',
    body: [
      '어머니는 서울에서 대학을 다니셨고 매일 아침 산책을 하셨다',
      '음식은 담백한 걸 좋아하셨고 김치는 직접 담그셨어요',
    ].join('\n'),
  },
];

/** A long note, built from realistic prose rather than a repeated syllable. */
export function verboseTestimony(paragraphs: number): string {
  const lines = [
    '할머니 결혼식은 1965년 봄에 釜山에서 있었어요',
    '그날 아침부터 비가 왔다고 하셨는데 오후에는 개었다고 합니다',
    '외갓집 식구들이 다 모였고 동네 사람들도 구경을 왔다고 하셨어요',
    '음식은 국수를 삶았고 떡도 크게 했다 카더라',
    '할아버지는 양복을 빌려 입으셨다고 들었습니다',
  ];
  return Array.from(
    { length: paragraphs },
    (_, i) => `## 기억 ${i + 1}\n\n${lines.join(' ')} ${lines.join(' ')}`,
  ).join('\n\n');
}
