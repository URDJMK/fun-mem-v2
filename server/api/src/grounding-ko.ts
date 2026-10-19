import { spokenNumbersToDigits, spokenYearsToDigits } from './speech';

/**
 * The grounding check for model-written drafts, Korean and English.
 *
 * WHAT THIS ANSWERS: "does this text state anything the person did not say, or leave out,
 * flip or move anything they did say?" It is the only thing standing between a language
 * model and a dead person's record, so it is a pure, synchronous function that a test can
 * pin exactly, and it is deliberately BORING.
 *
 * WHAT IT IS NOT, and must never become:
 *
 *  - NOT a similarity score. Character n-gram containment, Jaccard on bigrams and LCS ratio
 *    were all built and measured on this problem, and all three RANK FABRICATIONS ABOVE
 *    HONEST REWRITES. `따뜻한 미소로 맞아 주셨다` differs from the honest rewrite by eight
 *    characters out of sixty, while 하셨다 → 하셨습니다 rewrites every suffix in the
 *    sentence and adds nothing. There is no threshold in that gap.
 *
 *  - NOT an embedding check. `Xenova/bge-m3` is already a dependency of this server and it
 *    is sitting right there, which is exactly why this comment exists. Embeddings measure
 *    TOPICAL similarity, and an invented warm smile in a memory about a mother feeding you
 *    is maximally topically similar to the truth.
 *
 *  - NOT a denylist of bad words. The lists below whitelist the TRANSFORMATIONS a
 *    legitimate tidying may make (endings, particles, spelling of one inflection, spacing,
 *    a spoken number written in digits); they never enumerate the inventions, because
 *    inventions are unbounded and transformations are not.
 *
 * THE DECISIONS IT MAKES. A body is clean only when every one of these holds; each failure
 * is a `Violation` naming what was wrong, so a caller can say exactly that.
 *
 *   invented / number   every word of the body is a word of the source: the same word, the
 *                       same Korean stem with another ending or particle, the same English
 *                       word with one inflection from a CLOSED list (-s -es -ed -d -ing -ly
 *                       -er -est), or the same spoken number in digits. Never a word that
 *                       merely starts with, or sits inside, one they said: "he" does not
 *                       license "hero", 19 does not license 1952, 할머니 is not inside
 *                       외할머니 for this purpose.
 *   negation / hedge    "not", "never", "no", 안, 못, 않-, 없-, 아니-, and "maybe", "about
 *                       forty", "I think", 아마, 쯤 ... are kept in both directions. Deleting
 *                       one adds no word, which is exactly why a bag of words cannot see it.
 *   person              a relative, a gendered noun or a gendered pronoun is never added,
 *                       swapped (she → he, 외할머니 → 할머니) or, for relatives, dropped.
 *   unsupported_sentence every sentence of the body is supported by ONE place in the source
 *                       (one sentence, or two adjacent ones): a long source is not a bag of
 *                       words a model may recombine "My husband beat me." from.
 *   dropped             each turn of the source keeps 90% of its content, and no sentence of
 *                       it disappears.
 *
 * KNOWN HOLES, structural, both inside ONE sentence (or two adjacent ones):
 *
 *  - ROLE SWAP. "Walt was born in Dunmore and Eddie in Scranton" can be inverted with every
 *    word, every person and every sentence in place; so can "my mother worked at the mill and
 *    my father stayed home".
 *  - A SHORTENED SECOND COPY. "I was married before." is every word of "I was married at
 *    nineteen, before I knew what marriage was"; if that sentence is ALSO kept whole, nothing
 *    is missing and nothing is new. (Without the whole copy, the dropped "19" is caught.)
 *  - TWO NUMBERS SWAPPED between two things in one sentence ("a son in 1975 and a daughter in
 *    1978", written the other way round): every number is still there. A role swap too.
 *  - KOREAN NUMBERS THAT ARE ALSO EVERYDAY WORDS. 일 (1, and "work"), 이 (2, and "this"),
 *    만 (10,000, and "only"), 한 (1, and "did") and 네 (4, and "yes") are read as numbers only
 *    beside a counter listed in SINO_COUNTERS / NATIVE_COUNTERS (년, 명, 살, 번, 남매 ...);
 *    beside any other word one of them can stand in for another ("일 반" -> "이 반").
 *
 * The unit is the word and the sentence, not the proposition; nothing short of a parser
 * closes these, and the mitigation is that a person can read the note beside what was said.
 */

/* ── 1. jamo ─────────────────────────────────────────────────────────── */

const SYL_BASE = 0xac00;
const N_JONG = 28;
const N_JUNG = 21;

const CHO = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
];
/** compound nuclei are SPLIT: ㅝ → ㅜㅓ, which is what proves 줬다 ≡ 주었다. */
const JUNG = [
  'ㅏ',
  'ㅐ',
  'ㅑ',
  'ㅒ',
  'ㅓ',
  'ㅔ',
  'ㅕ',
  'ㅖ',
  'ㅗ',
  'ㅗㅏ',
  'ㅗㅐ',
  'ㅗㅣ',
  'ㅛ',
  'ㅜ',
  'ㅜㅓ',
  'ㅜㅔ',
  'ㅜㅣ',
  'ㅠ',
  'ㅡ',
  'ㅡㅣ',
  'ㅣ',
];
/** clusters are SPLIT: ㄶ → ㄴㅎ. */
const JONG = [
  '',
  'ㄱ',
  'ㄲ',
  'ㄱㅅ',
  'ㄴ',
  'ㄴㅈ',
  'ㄴㅎ',
  'ㄷ',
  'ㄹ',
  'ㄹㄱ',
  'ㄹㅁ',
  'ㄹㅂ',
  'ㄹㅅ',
  'ㄹㅌ',
  'ㄹㅍ',
  'ㄹㅎ',
  'ㅁ',
  'ㅂ',
  'ㅂㅅ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
];

const isSyllable = (c: string): boolean => c >= '가' && c <= '힣';

/**
 * Decompose to jamo. Hand-rolled on purpose: Hangul composition is arithmetic,
 * S = 0xAC00 + (L·21 + V)·28 + T, and THIS FUNCTION FAILS OPEN: if it ever returned '' or
 * a constant, every Korean word would match every other and every fabrication would pass.
 * So: no dependency, and a self-test that runs at import and throws.
 */
export function disassemble(s: string): string {
  let out = '';
  for (const ch of s) {
    if (!isSyllable(ch)) {
      out += ch;
      continue;
    }
    const n = ch.charCodeAt(0) - SYL_BASE;
    out +=
      (CHO[Math.floor(n / (N_JUNG * N_JONG))] ?? '') +
      (JUNG[Math.floor(n / N_JONG) % N_JUNG] ?? '') +
      (JONG[n % N_JONG] ?? '');
  }
  return out;
}

/** Fails the process at import rather than the archive at runtime. */
const SELF_TEST: ReadonlyArray<readonly [string, string]> = [
  ['묻', 'ㅁㅜㄷ'],
  ['물', 'ㅁㅜㄹ'], // ㄷ-irregular pair
  ['안', 'ㅇㅏㄴ'],
  ['않', 'ㅇㅏㄴㅎ'], // cluster split
  ['가', 'ㄱㅏ'],
  ['갔', 'ㄱㅏㅆ'], // contracted past
  ['값', 'ㄱㅏㅂㅅ'],
  ['닭', 'ㄷㅏㄹㄱ'],
  ['과', 'ㄱㅗㅏ'],
  ['워', 'ㅇㅜㅓ'],
  ['의', 'ㅇㅡㅣ'],
  ['개', 'ㄱㅐ'],
  ['힣', 'ㅎㅣㅎ'],
];
for (const [input, expected] of SELF_TEST) {
  if (disassemble(input) !== expected) {
    throw new Error(`grounding-ko: jamo self-test failed for "${input}"`);
  }
}

/* ── 2. the closed lists ─────────────────────────────────────────────── */

/** 조사. Longest first, so 에서 beats 에 and 께서 beats 서. */
const JOSA = [
  '에서',
  '에게서',
  '한테서',
  '으로부터',
  '로부터',
  '에게',
  '한테',
  '께서',
  '이라고',
  '라고',
  '이라는',
  '라는',
  '이며',
  '이랑',
  '까지',
  '부터',
  '조차',
  '마저',
  '밖에',
  '처럼',
  '만큼',
  '보다',
  '하고',
  '이나',
  '에다',
  '으로',
  '로서',
  '로써',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '와',
  '과',
  '도',
  '만',
  '로',
  '랑',
  '께',
  '이든지',
  '든지',
  '이든',
  '든',
  '이라도',
  '라도',
  '이요',
  '엔',
  '요',
  '나',
  '야',
  '아',
];
const JOSA_SET = new Set(JOSA);

/**
 * Verb endings, closed and longest first. What remains after one of them is a verb stem
 * with its pre-final endings (시, 었/았/였, 겠), which `koVerb` takes apart in order. A noun
 * particle is NEVER peeled after a verb ending: 돌아왔다 is 돌아오 + 았 + 다, not 돌아 + 와 (a
 * particle) + 았다; reading it the second way made 돌아왔다 ("came back") and 돌아가셨다
 * ("died") the same word.
 */
const FINALS = [
  '습니다',
  '습니까',
  '습니더',
  '심더',
  '니더',
  '십시오',
  '으십시오',
  '으세요',
  '세요',
  '셔요',
  '이에요',
  '어요',
  '아요',
  '여요',
  '에요',
  '예요',
  '어예',
  '아예',
  '데이',
  '예',
  '요',
  '지요',
  '죠',
  '네요',
  '네',
  '군요',
  '군',
  '구나',
  '구먼',
  '거든요',
  '거든',
  '잖아요',
  '잖아',
  '는데요',
  '은데요',
  '던데요',
  '는데',
  '은데',
  '던데',
  '더라고요',
  '더라고',
  '더라',
  '더니',
  '던가',
  '던',
  '대요',
  '래요',
  '냐',
  '니까',
  '으니까',
  '으니',
  '니',
  '나요',
  '까요',
  '까',
  '는다',
  '다',
  '어',
  '아',
  '여',
  '거라',
  '라',
  '자',
  '읍시다',
  '오',
  '소',
  '고서',
  '고',
  '으며',
  '며',
  '으면서',
  '면서',
  '으면',
  '면',
  '어서',
  '아서',
  '여서',
  '서',
  '지만',
  '지',
  '도록',
  '거나',
  '든가',
  '으려고',
  '려고',
  '으러',
  '러',
  '다가',
  '자마자',
  '게끔',
  '게',
  '어도',
  '아도',
  '여도',
  '도',
  '어야',
  '아야',
  '여야',
  '야',
  '다면',
  '라면',
  '길래',
  '느라고',
  '느라',
  '듯이',
  '듯',
  '다고',
  '라고',
  '냐고',
  '자고',
  '다는',
  '라는',
  '다며',
  '라며',
  '대',
  '래',
  '기',
  '음',
  '는',
  '은',
  '을',
].sort((a, b) => b.length - a.length);
/** Endings that take the connective 어/아 into the stem's last syllable: 와서, 해요, 봐도. */
const ABSORB = new Set(['서', '요', '도', '야', '라', '예', '데이']);
/** Endings a noun takes through the copula: 광부예요, 학생이고, 1925년생이세요. */
const COPULA_FINALS = new Set([
  '이에요',
  '에요',
  '예요',
  '이요',
  '요',
  '다',
  '고',
  '며',
  '라고',
  '라서',
  '야',
  '지만',
  '니까',
  '어서',
  '여서',
]);
/**
 * Endings that make an adverb of a verb. 죽도록 일하셨다 is "worked to death", an amount;
 * 죽었다 is a death. A stem said only in one of these forms supports only that form.
 */
const ADVERBIAL = new Set(['도록', '게끔', '게', '듯이', '듯']);
/** Light verbs: 공부하다 is the noun 공부 said as a verb (used for matching, never for a free pass). */
const LIGHT_VERBS = ['당하', '시키', '드리', '받', '하', '되'];
/** Auxiliaries after -어/-아: 물어보다 is 묻다 tried, 해 주다 is 하다 for someone. Never 오/가: 돌아오다 is not 돌다. */
const AUXILIARIES = ['드리', '버리', '보', '주', '놓', '두'];
/** Vowels a past ending fuses into: 가+았 갔, 서+었 섰, 시+었 셨, 오+았 왔, 주+었 줬, 하+였 했, 되+었 됐. */
const FUSED_PAST_VOWELS = new Set([0, 1, 4, 5, 6, 9, 10, 14]);

/**
 * Scaffolding a legitimate restructuring introduces, which asserts NOTHING about the person,
 * by CLASS, because the class decides which endings may follow: 의존명사, pronouns and joining
 * adverbs take particles (것이, 나는, 그리고); auxiliary verbs take verb endings (하셨다, 해 주셨다).
 * A word is free only as its own class: 거지 ("beggar") is not 거 + the verb ending 지, and
 * 나갔다 ("went out") is not 나 + a particle.
 *
 * 있 / 없 / 아니 / 싶 are deliberately ABSENT: they carry polarity and wish. 없었다 → 있었다
 * ("we had no money" → "we had money") and 가고 싶었다 → 갔다 ("wanted to go" → "went") are
 * the most damaging rewrites there are. 전 and 앞 are absent while 뒤 and 후 are present:
 * "1953년 전에" moves a date.
 */
const SCAFFOLD_NOUN = new Set([
  '것',
  '거',
  '수',
  '때',
  '날',
  '일',
  '적',
  '중',
  '곳',
  '분',
  '번',
  '뒤',
  '후',
  '동안',
  '사이',
  '채',
  '뿐',
  '대로',
  '이',
  '그',
  '저',
  '나',
  '내',
  '제',
  '우리',
  '저희',
  '너',
  '당신',
  '자기',
  '이것',
  '그것',
  '저것',
  '이거',
  '그거',
  '저거',
  '그리고',
  '그런데',
  '그래서',
  '하지만',
  '그러나',
  '다시',
  '또',
  '바로',
  '함께',
  '같이',
]);
/** The copula 이 and the auxiliaries; 주/드리/보/버리 only right after -어/-아/-고 (해 주셨다), never as "gave"/"saw". */
const SCAFFOLD_VERB = new Set(['하', '되', '주', '드리', '보', '버리', '같', '이']);
const AUXILIARY_ONLY = new Set(['주', '드리', '보', '버리']);

/** Noun suffixes: honorific, plural, "Mr./Ms.", "and family". */
const NOUN_SUFFIXES = ['님', '들', '씨', '네'];
/** Delimiters that may sit on a case particle (에서는, 에게도, 와는), and the case particles they sit on. */
const STACK_OUTER = new Set([
  '는',
  '은',
  '도',
  '만',
  '요',
  '의',
  '까지',
  '부터',
  '이나',
  '나',
  '라도',
  '이라도',
  '든지',
  '이든지',
  '엔',
]);
const STACK_INNER = [
  '에서',
  '에게',
  '한테',
  '께서',
  '께',
  '에',
  '으로',
  '로',
  '와',
  '과',
  '랑',
  '이랑',
  '하고',
  '까지',
  '부터',
  '처럼',
  '보다',
  '만',
  '조차',
  '마저',
].sort((a, b) => b.length - a.length);
/** Nouns that only look like a scaffold word and a particle: 나이 (age) is not 나 + 이. */
const NOT_SPLIT = new Set(['나이', '그네']);
/** Pronouns and 거, which contract with 는/를/이: 난, 전, 우린, 그건, 그걸, 그게. */
const PRONOUN_LIKE = new Set([
  '나',
  '저',
  '너',
  '우리',
  '저희',
  '그거',
  '이거',
  '저거',
  '거',
  '것',
]);
/** Particles and noun suffixes, longest first. */
const NOUN_TAILS = [...JOSA, ...NOUN_SUFFIXES].sort((a, b) => b.length - a.length);

/**
 * The ONE lexical liberty for Korean: the same referent under a different household word.
 * A model normalises 엄마 → 어머니 constantly. Each class is ONE person; 할머니 and 외할머니 are
 * separate classes because they are separate people. A swap is reported back (`swapped`).
 */
const VARIANT_CLASSES: ReadonlyArray<readonly string[]> = [
  ['어머니', '엄마', '어머님', '어무이', '엄니', '모친', '어미'],
  ['아버지', '아빠', '아부지', '아버님', '부친', '애비'],
  ['할머니', '할매', '할머님', '할무니', '조모'],
  ['할아버지', '할배', '할아버님', '할아부지', '조부'],
  ['외할머니', '외조모'],
  ['외할아버지', '외조부'],
  ['나', '저', '내', '제'],
  ['우리', '저희'],
  ['형', '형님'],
  ['누나', '누님'],
  ['오빠', '오라버니'],
  ['아내', '집사람', '안사람'],
  ['남편', '바깥양반'],
];
const VARIANT = new Map<string, readonly string[]>();
for (const cls of VARIANT_CLASSES) for (const w of cls) VARIANT.set(w, cls);

/** Pure Korean filler the drafting prompt permits dropping (never counted as content). */
const FILLER = new Set([
  '음',
  '어',
  '아',
  '그',
  '뭐',
  '뭐더라',
  '아무튼',
  '하여튼',
  '어쨌든',
  '근데',
  '그니까',
  '저기',
  '막',
  '좀',
  '이제',
  '인제',
  '응',
  '네',
  '에',
  '저',
  '그냥',
  '진짜',
  '정말',
  '엄청',
  '되게',
  '완전',
  '그러니까',
  '있잖아',
  '있잖아요',
  '뭐냐면',
  '뭐냐',
  '뭐랄까',
  '그게',
]);

/* ── 3. the old tokeniser, kept for its callers (claims.ts) ─────────── */

/**
 * Both `[[link]]` and `![[hash]]` are removed: neither is prose to be proved. Nothing inside a
 * link is a bracket, so a run of "[[[[" is read once, not once per bracket.
 */
const LINK_RE = /!?\[\[[^\][]*\]\]/g;
const TOKEN_SPLIT = /[^가-힣一-鿿0-9A-Za-z]+/u;

/** Space-separated words, links removed. The checker itself uses `wordsOf`. */
export function eojeols(text: string): string[] {
  return text
    .normalize('NFC')
    .replace(LINK_RE, ' ')
    .split(TOKEN_SPLIT)
    .filter((s) => s !== '');
}

/* ── 4. the stems of a Korean word ───────────────────────────────────── */

/** Longer than this is not a Korean word but lost spacing: it is matched whole, never taken apart. */
const KO_PEEL_MAX = 24;

const syl = (c: string) => {
  const n = c.charCodeAt(0) - SYL_BASE;
  return {
    l: Math.floor(n / (N_JUNG * N_JONG)),
    v: Math.floor(n / N_JONG) % N_JUNG,
    t: n % N_JONG,
  };
};
const compose = (l: number, v: number, t = 0): string =>
  String.fromCharCode(SYL_BASE + (l * N_JUNG + v) * N_JONG + t);
const lastOf = (s: string): string => s[s.length - 1] ?? '';
/** `s` with the final consonant of its last syllable set to `t` (0 = none). */
const withJong = (s: string, t: number): string => {
  const p = syl(lastOf(s));
  return s.slice(0, -1) + compose(p.l, p.v, t);
};
// jamo indices used below
const T_N = 4; // ㄴ
const T_D = 7; // ㄷ
const T_L = 8; // ㄹ
const T_M = 16; // ㅁ
const T_B = 17; // ㅂ
const T_S = 19; // ㅅ
const T_SS = 20; // ㅆ
const V_A = 0; // ㅏ
const V_EO = 4; // ㅓ
const V_YEO = 6; // ㅕ
const V_O = 8; // ㅗ
const V_WA = 9; // ㅘ
const V_WAE = 10; // ㅙ
const V_OE = 11; // ㅚ
const V_U = 13; // ㅜ
const V_WO = 14; // ㅝ
const V_EU = 18; // ㅡ
const V_I = 20; // ㅣ
const V_AE = 1; // ㅐ
const L_R = 5; // ㄹ
const L_NG = 11; // ㅇ
const L_H = 18; // ㅎ

/**
 * The stems a verb form's last syllable can have absorbed a connective 어/아 into: 봐 ← 보,
 * 와 ← 오, 줘 ← 주, 돼 ← 되, 셔 ← 시, 해 ← 하, 써 ← 쓰, 아파 ← 아프, 불러 ← 부르, 추워 ← 춥,
 * 도와 ← 돕. `strict` leaves out the ㅓ/ㅏ → ㅡ guess, which only a vowel-initial ending licenses.
 */
function uncontract(t: string, strict: boolean): string[] {
  const out = [t];
  const lc = lastOf(t);
  if (!isSyllable(lc)) return out;
  const p = syl(lc);
  if (p.t !== 0) return out;
  const head = t.slice(0, -1);
  const prev = lastOf(head);
  const pp = isSyllable(prev) ? syl(prev) : null;
  const sub = (v: number) => head + compose(p.l, v);
  if (p.v === V_WA || p.v === V_WO) {
    out.push(sub(p.v === V_WA ? V_O : V_U));
    // ㅂ irregular: 도와 ← 돕, 추워 ← 춥
    if (p.l === L_NG && pp && pp.t === 0) out.push(withJong(head, T_B));
  } else if (p.v === V_WAE) out.push(sub(V_OE));
  else if (p.v === V_YEO) out.push(sub(V_I));
  else if (p.v === V_AE && p.l === L_H) out.push(sub(V_A));
  else if (!strict && (p.v === V_EO || (p.v === V_A && head !== ''))) {
    // 르 irregular: 불러 ← 부르, 몰라 ← 모르; else the ㅡ that the ending dropped: 써 ← 쓰, 아파 ← 아프
    if (p.l === L_R && pp && pp.t === T_L) out.push(`${withJong(head, 0)}르`);
    else out.push(sub(V_EU));
  }
  return out;
}

interface KoStems {
  /** every candidate stem, for matching */
  all: Set<string>;
  /** stems as a noun (particles off, or through the copula): what may make a word free as a noun */
  nouns: Set<string>;
  /** stems as a verb (endings off): what may make a word free as an auxiliary */
  verbs: Set<string>;
  /** said as an adverb (죽도록, 크게): supports only the same adverbial form */
  adverbial: boolean;
}

/**
 * The stems of one eojeol, in grammatical order: particles off a noun (one, or a delimiter
 * on a case particle: 부산에서는); or a verb ending, then the honorific 시, the past 었/았/였
 * (or a past fused into the stem's vowel: 갔, 셨, 했), 겠, then an auxiliary (물어보다 → 묻다)
 * or a light verb (공부하다 → 공부). Irregular stems are restored only where the alternation
 * happens (물어 ← 묻, 사는 ← 살, 지어 ← 짓, 도우며 ← 돕).
 *
 * MATCHING IS ON EQUAL STEMS. A word is never "said" because it begins a word that was said,
 * or because some over-peeled piece of it equals a piece of another: 이십 is not 이, 삼십 is
 * not 삼, 부산대 is not 부산.
 */
function koStems(w: string): KoStems {
  const all = new Set<string>([w]);
  const nouns = new Set<string>([w]);
  const verbs = new Set<string>();
  let adverbial = false;
  if (w.length > KO_PEEL_MAX) return { all, nouns, verbs, adverbial };
  // a bare Sino-Korean number is one word and stays one: peeled like a verb ending 삼 would
  // become 사 (3 → 4), 일 → 이 (1 → 2), 십일 → 십이 (11 → 12)
  if (isBareNumber(w)) return { all, nouns, verbs, adverbial };

  // nouns: one particle or suffix; a second only inside a delimiter on a case particle
  // (부산에서+는, 엄마와+는), and never one that leaves a one-syllable stem (사과는 is not 사+과+는)
  for (const t of NOUN_TAILS) {
    if (!(w.length > t.length && w.endsWith(t)) || NOT_SPLIT.has(w)) continue;
    const x = w.slice(0, -t.length);
    // 님/씨/네 follow a name or a person: 김순자씨 → 김순자, never 날씨 → 날
    if (NOUN_SUFFIXES.includes(t) && t !== '들' && x.length < 2) continue;
    nouns.add(x);
    if (!STACK_OUTER.has(t)) continue;
    for (const u of STACK_INNER) {
      if (!(x.length > u.length && x.endsWith(u))) continue;
      const y = x.slice(0, -u.length);
      if (u.length >= 2 || y.length >= 2) nouns.add(y);
    }
  }
  // 난 (나+는), 전 (저+는), 우린, 그건, 그걸; 그게 and 간 게 (거+이)
  const lw = lastOf(w);
  if (isSyllable(lw)) {
    const p = syl(lw);
    if (p.t === T_N || p.t === T_L) {
      const x = withJong(w, 0);
      if (PRONOUN_LIKE.has(x)) nouns.add(x);
    }
    if (lw === '게') {
      const x = `${w.slice(0, -1)}거`;
      if (PRONOUN_LIKE.has(x)) nouns.add(x);
    }
  }

  const seen = new Set<string>();
  /** `s` is a stem with pre-final endings; `vowel`/`nbs`: what the next morpheme began with */
  const verb = (s: string, vowel: boolean, nbs: boolean, depth = 0): void => {
    if (s === '' || depth > 6) return;
    const key = `${s}\u0000${vowel ? 1 : 0}${nbs ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    verbs.add(s);
    const lc = lastOf(s);
    if (!isSyllable(lc)) return;
    const p = syl(lc);
    if (s.length >= 2 && lc === '이') nouns.add(s.slice(0, -1)); // the copula: 학생이었다 → 학생
    for (const l of LIGHT_VERBS)
      if (s.length > l.length && s.endsWith(l)) all.add(s.slice(0, -l.length));
    for (const a of AUXILIARIES) {
      if (!(s.length > a.length && s.endsWith(a))) continue;
      const r = s.slice(0, -a.length);
      const rl = lastOf(r);
      if (!isSyllable(rl) || syl(rl).t !== 0) continue;
      if (rl === '어' || rl === '아' || rl === '여') verb(r.slice(0, -1), true, false, depth + 1);
      else
        for (const c of uncontract(r, false))
          if (c !== r || rl === '해') verb(c, true, false, depth + 1);
    }
    if (s.endsWith('으시') && s.length > 2) verb(s.slice(0, -2), true, false, depth + 1);
    else if (lc === '시' && s.length > 1) verb(s.slice(0, -1), false, true, depth + 1);
    if (lc === '겠' && s.length > 1) verb(s.slice(0, -1), false, false, depth + 1);
    if ((lc === '었' || lc === '았' || lc === '였') && s.length > 1) {
      if (lc === '였') nouns.add(s.slice(0, -1)); // 광부였다 → 광부 (copula 이 + 었)
      verb(s.slice(0, -1), true, false, depth + 1);
    }
    // a past fused into the stem's vowel (갔, 왔, 했, 셨, 됐); never 있 (a stem, not 이 + past)
    if (p.t === T_SS && FUSED_PAST_VOWELS.has(p.v)) {
      const t = withJong(s, 0);
      for (const c of uncontract(t, false)) verb(c, true, false, depth + 1);
    }
    if (vowel && p.t === T_L) verbs.add(withJong(s, T_D)); // 물(어) ← 묻, 들(어) ← 듣
    if (nbs && p.t === 0) verbs.add(withJong(s, T_L)); // 사(는) ← 살, 아(시는) ← 알
    if (vowel && p.t === 0 && /[지나부이그저]$/.test(s)) verbs.add(withJong(s, T_S)); // 지(어) ← 짓
    if (vowel && s.length >= 2 && lc === '우' && syl(lastOf(s.slice(0, -1))).t === 0) {
      verbs.add(withJong(s.slice(0, -1), T_B)); // 도우(며) ← 돕
    }
  };
  const startsVowel = (f: string) => /^[어아여으이에예오]/.test(f);
  const startsNbs = (f: string) => /^[니네는나냐세소습시]/.test(f);
  for (const f of FINALS) {
    if (!(w.length > f.length && w.endsWith(f))) continue;
    const s = w.slice(0, -f.length);
    if (ADVERBIAL.has(f)) adverbial = true;
    if (COPULA_FINALS.has(f)) nouns.add(s);
    verb(s, startsVowel(f), startsNbs(f));
    if (ABSORB.has(f)) for (const c of uncontract(s, true)) if (c !== s) verb(c, true, false);
  }
  // endings in the last syllable's final consonant: 간, 갈, 감 (가 + ㄴ/ㄹ/ㅁ)
  if (isSyllable(lw)) {
    const p = syl(lw);
    if (p.t === T_N || p.t === T_L || p.t === T_M) verb(withJong(w, 0), false, true);
  }
  // ...and before a following syllable: 갑니다, 합시다 (ㅂ), 간다, 인데, 인가 (ㄴ), 갈까, 할게 (ㄹ)
  for (const [tail, jong] of KO_JONG_TAILS) {
    if (!(w.length > tail.length && w.endsWith(tail))) continue;
    const s = w.slice(0, -tail.length);
    const sl = lastOf(s);
    if (!isSyllable(sl) || syl(sl).t !== jong) continue;
    const base = withJong(s, 0);
    // 입니다 (이 + ㅂ니다), 겁니다 (거 + 이 + ㅂ니다)
    if (jong === T_B) nouns.add(base.endsWith('이') && base.length > 1 ? base.slice(0, -1) : base);
    verb(base, false, true);
  }
  for (const x of nouns) all.add(x);
  for (const x of verbs) all.add(x);
  return { all, nouns, verbs, adverbial };
}

const KO_JONG_TAILS: ReadonlyArray<readonly [string, number]> = [
  ['니다', T_B],
  ['니까', T_B],
  ['시다', T_B],
  ['다', T_N],
  ['데', T_N],
  ['데요', T_N],
  ['가', T_N],
  ['가요', T_N],
  ['지', T_N],
  ['지요', T_N],
  ['까', T_L],
  ['까요', T_L],
  ['게', T_L],
  ['게요', T_L],
  ['래', T_L],
  ['래요', T_L],
];

/** Every candidate stem of a Korean word (kept for callers of the old name). */
export function readings(word: string): string[] {
  return [...koStems(word).all];
}

/** A Korean word that asserts nothing: a bare particle, scaffolding as its own class. */
function koScaffold(st: KoStems, w: string, afterConnective: boolean): boolean {
  if (JOSA_SET.has(w)) return true;
  for (const n of st.nouns) if (SCAFFOLD_NOUN.has(n)) return true;
  for (const v of st.verbs) {
    if (SCAFFOLD_VERB.has(v) && (!AUXILIARY_ONLY.has(v) || afterConnective)) return true;
  }
  return false;
}

/** The word before ends the way a verb does before an auxiliary: 해 (주셨다), 가 (보니), 먹고 (싶다). */
const CONNECTIVE_END = /(?:어|아|여|해|와|워|봐|줘|셔|겨|쳐|져|려|러|라|가|서|고|게|지)$/;

/* ── 5. preparing text ───────────────────────────────────────────────── */

const LINK = /(!?)\[\[([^\][|]*)(?:\|([^\][]*))?\]\]/g;

/**
 * What a reader sees of a link: `[[Title|words]]` reads "words", `[[Title]]` reads "Title",
 * an embed `![[hash]]` reads nothing. A link's words are prose like any other, so they are
 * checked like any other: a word hidden in brackets is still a word in the note.
 */
export function shownText(s: string): string {
  return s.replace(LINK, (_m, bang: string, target: string, alias: string | undefined) =>
    bang ? ' ' : (alias ?? target.split('#')[0] ?? ''),
  );
}

// Latin letters with accents, and combining marks: written as escapes so the source stays legible
const HAS_ACCENT = new RegExp('[\\u00c0-\\u024f\\u1e00-\\u1eff\\u0300-\\u036f]');
/** José → jose, Zoë → zoe. Only marks on LATIN letters go: Hangul round-trips through NFD. */
const foldAccents = (s: string): string =>
  HAS_ACCENT.test(s)
    ? s
        .normalize('NFD')
        .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '')
        .normalize('NFC')
    : s;

/**
 * A relative with a prefix is a different person, so the prefix becomes part of the word:
 * "great-grandfather" and "great grandfather" are one word, never "grandfather"; "mother-in-law"
 * is never "mother".
 */
const KIN_COMPOUNDS: ReadonlyArray<readonly [RegExp, string]> = [
  // an ex-husband, a late wife, a first wife are each another person than "my husband"
  [/\b(?:ex|former)[\s-]+(husband|wife|boyfriend|girlfriend|partner)s?\b/g, 'ex$1'],
  [/\blate[\s-]+(husband|wife|father|mother|brother|sister|son|daughter)\b/g, 'late$1'],
  [/\b(first|second|third)[\s-]+(husband|wife)\b/g, '$1$2'],
  [
    /\bgreat(?:[\s-]+great)*[\s-]+grand[\s-]*(mothers?|fathers?|ma|pa|moms?|dads?|parents?|sons?|daughters?|child|children|kids?)\b/g,
    'greatgrand$1',
  ],
  [/\bgreat[\s-]+(aunts?|uncles?)\b/g, 'great$1'],
  [
    /\bgrand[\s-]+(mothers?|fathers?|ma|pa|moms?|dads?|parents?|sons?|daughters?|child|children|kids?)\b/g,
    'grand$1',
  ],
  [
    /\bstep[\s-]+(mothers?|fathers?|moms?|mums?|dads?|parents?|sons?|daughters?|child|children|kids?|brothers?|sisters?)\b/g,
    'step$1',
  ],
  [/\bgod[\s-]+(mothers?|fathers?|parents?|sons?|daughters?|child)\b/g, 'god$1'],
  [/\bhalf[\s-]+(brothers?|sisters?|siblings?)\b/g, 'half$1'],
  [
    /\bfoster[\s-]+(mothers?|fathers?|moms?|dads?|parents?|sons?|daughters?|child|children|brothers?|sisters?)\b/g,
    'foster$1',
  ],
  [
    /\b(mothers?|fathers?|brothers?|sisters?|sons?|daughters?|parents?)[\s-]+in[\s-]+law\b/g,
    '$1inlaw',
  ],
];

/**
 * Contractions are the same words: "didn't" IS "did not" (and was being read as "didn" + "t",
 * which let "didn't" → "did" through as a mere shortening). 's and 'd stand for several words,
 * so they become a marker that is free in a body and matches any of them.
 */
const CLITICS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcan't\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bshan't\b/g, 'shall not'],
  [/\bain't\b/g, 'is not'],
  [/\b([a-z]+)n't\b/g, '$1 not'],
  [/\b([a-z]+)'re\b/g, '$1 are'],
  [/\b([a-z]+)'ve\b/g, '$1 have'],
  [/\b([a-z]+)'ll\b/g, '$1 will'],
  [/\b([a-z]+)'m\b/g, '$1 am'],
  [/\b([a-z]+)'d\b/g, '$1 zzd'],
  [/\blet's\b/g, 'let us'],
  // "he's" is "he is" or "he has"; "mother's" is a possessive: only the first carries a tense
  [
    /\b(he|she|it|that|there|here|what|who|where|how|when|why|this|everything|everybody|everyone|nothing|nobody|someone|somebody|something)'s\b/g,
    '$1 zzc',
  ],
  [/\b([a-z]+)'s\b/g, '$1 zzs'],
  [/\b([a-z]+s)'(?=[\s.,;:!?)]|$)/g, '$1 zzs'],
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
  [/\bdunno\b/g, 'do not know'],
  [/\bkinda\b/g, 'kind of'],
  [/\bsorta\b/g, 'sort of'],
  [/\blemme\b/g, 'let me'],
  [/\bgimme\b/g, 'give me'],
  [/\by'all\b/g, 'you all'],
  [/(^|[^a-z])'cause\b/g, '$1because'],
  [/\bcuz\b/g, 'because'],
  [/(^|[^a-z])'em\b/g, '$1them'],
  [/\bma'am\b/g, 'madam'],
  [/\bo'clock\b/g, 'oclock'],
  [/\bno[\s-]+one\b/g, 'nobody'],
];

/** One word for one answer: "yeah" and "yep" are "yes"; "nope" and "nah" are "no". */
const REPLIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:yeah|yep|yup|yea)\b/g, 'yes'],
  [/\b(?:nope|nah)\b/g, 'no'],
];

/* Korean numbers: 삼 년 and 3년, 열두 살 and 12살, 삼만 원 and 30000원 are each one number. */

const SINO_DIGIT: Record<string, number> = {
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  륙: 6,
  칠: 7,
  팔: 8,
  구: 9,
};
const SINO_UNIT: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const SINO_BIG: Record<string, number> = { 만: 10_000, 억: 100_000_000 };
/** Native numerals: the attributive forms (한, 두, 세, 네, 스무 …) are numbers only before a counter. */
const NATIVE_TENS: ReadonlyArray<readonly [string, number]> = [
  ['스물', 20],
  ['스무', 20],
  ['서른', 30],
  ['마흔', 40],
  ['예순', 60],
  ['일흔', 70],
  ['여든', 80],
  ['아흔', 90],
  ['열', 10],
  ['쉰', 50],
];
const NATIVE_ONES: ReadonlyArray<readonly [string, number]> = [
  ['하나', 1],
  ['다섯', 5],
  ['여섯', 6],
  ['일곱', 7],
  ['여덟', 8],
  ['아홉', 9],
  ['한', 1],
  ['둘', 2],
  ['두', 2],
  ['셋', 3],
  ['세', 3],
  ['석', 3],
  ['넷', 4],
  ['네', 4],
  ['넉', 4],
  ['닷', 5],
  ['엿', 6],
];
/** Native numerals that stand alone as a noun: 동생이 셋, 둘이서, 하나도. (Not 열 "fever", not 쉰 "spoiled".) */
const NATIVE_ALONE = new Set([
  '하나',
  '둘',
  '셋',
  '넷',
  '다섯',
  '여섯',
  '일곱',
  '여덟',
  '아홉',
  '스물',
  '서른',
  '마흔',
  '예순',
  '일흔',
  '여든',
  '아흔',
]);
const SINO_COUNTERS = [
  '년도',
  '년생',
  '개월',
  '주년',
  '퍼센트',
  '학년',
  '년',
  '월',
  '원',
  '세',
  '층',
  '평',
  '회',
  '호',
  '등',
  '초',
  '명',
  '남매',
  '형제',
  '자매',
  '달러',
  '미터',
  '킬로',
];
const NATIVE_COUNTERS = [
  '사람',
  '시간',
  '번째',
  '식구',
  '그릇',
  '가지',
  '군데',
  '남매',
  '형제',
  '자매',
  '켤레',
  '송이',
  '그루',
  '살',
  '명',
  '개',
  '마리',
  '시',
  '번',
  '채',
  '권',
  '잔',
  '병',
  '벌',
  '대',
  '장',
  '달',
  '해',
  '분',
  '척',
  '칸',
  '끼',
];
/** Attached to a one-syllable Sino numeral these read as words, not numbers: 이년, 이분, 이번, 일대. */
const SINO_ATTACHED_SHORT = new Set(['월', '원', '층', '학년', '개월', '남매', '형제', '자매']);
/** Attached to a native numeral this is a word: 세대 is "generation", not three cars. */
const NATIVE_ATTACHED_NOT = new Set(['대']);
/** The Korean War and other dates said as digits: 육이오 is 6·25. */
const KO_NUMBER_NAMES: Record<string, string> = {
  육이오: '6·25',
  사일구: '4·19',
  오일팔: '5·18',
  유월: '6월',
  시월: '10월',
};

/**
 * A whole word that is a number: 삼, 이십, 십일, 열한, 스물. Not 한 and 네, which are also
 * "did" and "yes" (한 is 하 + ㄴ, 네 is an answer), and not the everyday words 일/이/만 told
 * apart from each other by a counter or not at all.
 */
function isBareNumber(w: string): boolean {
  if (w === '한' || w === '네') return false;
  const n = sinoAt(w);
  if (n !== null && n.len === w.length) return true;
  const k = nativeAt(w);
  return k !== null && k.len === w.length;
}

function sinoAt(s: string): { value: number; len: number } | null {
  let i = 0;
  let total = 0;
  let section = 0;
  let digit = -1;
  for (; i < s.length && i < 12; i++) {
    const c = s[i]!;
    const d = SINO_DIGIT[c];
    if (d !== undefined) {
      if (digit >= 0) break; // 이삼 ("two or three") is not 23
      digit = d;
      continue;
    }
    const u = SINO_UNIT[c];
    if (u !== undefined) {
      section += (digit < 0 ? 1 : digit) * u;
      digit = -1;
      continue;
    }
    const b = SINO_BIG[c];
    if (b !== undefined) {
      section += digit < 0 ? 0 : digit;
      total += (section === 0 ? 1 : section) * b;
      section = 0;
      digit = -1;
      continue;
    }
    break;
  }
  if (i === 0) return null;
  return { value: total + section + (digit < 0 ? 0 : digit), len: i };
}

function nativeAt(s: string): { value: number; len: number; last: string } | null {
  let value = 0;
  let len = 0;
  let last = '';
  for (const [w, v] of NATIVE_TENS) {
    if (s.startsWith(w)) {
      value = v;
      len = w.length;
      last = w;
      break;
    }
  }
  for (const [w, v] of NATIVE_ONES) {
    if (s.startsWith(w, len)) {
      value += v;
      len += w.length;
      last = w;
      break;
    }
  }
  return len === 0 ? null : { value, len, last };
}

const counterAt = (s: string, list: readonly string[]): string | null =>
  list.find((c) => s.startsWith(c)) ?? null;
/** What may follow a number said alone: nothing, a particle, the copula. */
const NUMBER_TAIL =
  /^(?:이서|이었|이에|이고|이다|이라|이랑|하고|이|가|은|는|을|를|도|만|였|예|입|의|와|과|랑)/;

function koNumbers(text: string): string {
  const parts = text.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const w = parts[i]!;
    if (w === '' || !HANGUL.test(w)) continue;
    const named = Object.keys(KO_NUMBER_NAMES).find((k) => w.startsWith(k));
    if (named) {
      parts[i] = KO_NUMBER_NAMES[named]! + w.slice(named.length);
      continue;
    }
    // 3만, 1천, 5천만: digits and a Sino unit
    const big = /^(\d+)(만|천|백|억)/.exec(w);
    if (big) {
      const unit = { 만: 10_000, 천: 1000, 백: 100, 억: 100_000_000 }[big[2] as '만']!;
      parts[i] = String(Number(big[1]) * unit) + w.slice(big[0].length);
      continue;
    }
    const next = parts[i + 2] ?? '';
    const sino = sinoAt(w);
    const native = nativeAt(w);
    // a number word on its own, the counter in the next word: 삼 년, 열두 살, 스무 살
    if (sino && sino.len === w.length && counterAt(next, SINO_COUNTERS)) {
      parts[i] = String(sino.value);
      continue;
    }
    if (native && native.len === w.length && counterAt(next, NATIVE_COUNTERS)) {
      parts[i] = String(native.value);
      continue;
    }
    // the counter attached: 삼십년, 열두살이었어요, 오월 (never 이년, 이분, 이번)
    if (sino) {
      const c = counterAt(w.slice(sino.len), SINO_COUNTERS);
      if (c && (sino.len >= 2 || SINO_ATTACHED_SHORT.has(c) || (c === '년' && w[0] !== '이'))) {
        parts[i] = String(sino.value) + w.slice(sino.len);
        continue;
      }
    }
    if (native) {
      const rest = w.slice(native.len);
      const c = counterAt(rest, NATIVE_COUNTERS);
      if (c && !NATIVE_ATTACHED_NOT.has(c)) {
        parts[i] = String(native.value) + rest;
        continue;
      }
      // 동생이 셋, 셋이었어요, 스물다섯이었어요, 둘이서, 하나도 (never 하나님, 둘레, 셋방)
      if (NATIVE_ALONE.has(native.last) && (rest === '' || NUMBER_TAIL.test(rest))) {
        parts[i] = String(native.value) + rest;
      }
    }
  }
  return parts.join('');
}

/** The same text, normalised the same way on both sides: case, accents, contractions, numbers. */
function normalise(raw: string): string {
  let t = shownText(raw.normalize('NFC')).toLowerCase().replace(/[’‘ʼ]/g, "'");
  t = foldAccents(t);
  if (/[a-z]/.test(t)) {
    for (const [re, to] of REPLIES) t = t.replace(re, to);
    for (const [re, to] of KIN_COMPOUNDS) t = t.replace(re, to);
    if (
      t.includes("'") ||
      /\b(?:cannot|gonna|wanna|gotta|dunno|kinda|sorta|lemme|gimme|cuz|no[\s-]+one)\b/.test(t)
    ) {
      for (const [re, to] of CLITICS) t = t.replace(re, to);
    }
    // the speaker said "nineteen sixty-six"; a tidy rewrite may write 1966: one number either way
    t = spokenNumbersToDigits(spokenYearsToDigits(t));
  }
  if (HANGUL.test(t)) t = koNumbers(t);
  return t;
}

/* ── 6. sentences and words ──────────────────────────────────────────── */

type Kind = 'ko' | 'en' | 'num' | 'x';

interface Tok {
  w: string;
  k: Kind;
  /** offsets in the sentence text (-1 for a word made up from part of another) */
  s: number;
  e: number;
  /** free: asserts nothing, so a body may add it (a particle, scaffolding, "the") */
  f: boolean;
}

interface Sent {
  sid: number;
  turn: number;
  text: string;
  toks: Tok[];
  /** where each joined fragment ("He died.") starts in `toks`, when fragments were joined */
  parts?: number[];
}

const WORD = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu;
const RUNS = /\d+|[가-힣]+|[^\d가-힣]+/g;
const HANGUL = /[가-힣]/;
const SENT_BREAK = /(?<=[.!?。…])\s+/;
/** "Mrs." and the "I." of "G.I." do not end a sentence. Tested on the last characters only. */
const ABBREV_END = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|st|jr|sr|mt|vs|etc|\p{L})\.$/u;

const kindOf = (w: string): Kind =>
  /^\d+$/.test(w) ? 'num' : HANGUL.test(w) ? 'ko' : /^[a-z]+(?:'[a-z]+)*$/.test(w) ? 'en' : 'x';

function wordsIn(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    const at = m.index;
    // "1946년에" is a number and a word; "Busan의" is a name and a particle
    if (HANGUL.test(w) && /[^가-힣]/.test(w)) {
      for (const r of w.matchAll(RUNS)) {
        const p = r[0];
        out.push({ w: p, k: kindOf(p), s: at + r.index, e: at + r.index + p.length, f: false });
      }
    } else {
      out.push({ w, k: kindOf(w), s: at, e: at + w.length, f: false });
    }
  }
  return out;
}

/** Sentences in order; a line of the text is a turn. Linear in the length of the text. */
function sentencesOf(text: string): Array<{ turn: number; text: string }> {
  const out: Array<{ turn: number; text: string }> = [];
  const lines = text.split('\n');
  for (let turn = 0; turn < lines.length; turn++) {
    let cur: string[] = [];
    const flush = () => {
      const text = cur.join(' ');
      if (text.trim() !== '') out.push({ turn, text });
      cur = [];
    };
    for (const piece of lines[turn]!.split(SENT_BREAK)) {
      cur.push(piece);
      // the end of THIS piece decides: a growing string is never re-read
      if (!ABBREV_END.test(piece.slice(-6))) flush();
    }
    flush();
  }
  return out;
}

/* ── 7. which words count ────────────────────────────────────────────── */

/**
 * English words a tidy rewrite adds that assert nothing about anyone: free in a body.
 * "yes" is NOT here: "No." answering a question must not come back as "Yes.".
 */
const EN_FREE = new Set(
  (
    'a an the and or but so then also too as of to in on at for with by from into onto that which who whom ' +
    'whose it its this these those there here is was were are am be been being zzs zzc zzd oh well okay ok ' +
    'um uh er ah hmm mm mhm'
  ).split(' '),
);
/** Words that carry no content of their own: never needed to place a sentence or to retain one. */
const EN_LIGHT = new Set([
  ...EN_FREE,
  ...'have has had do does did will would can could shall should may might must yes'.split(' '),
]);
const EN_PRONOUNS = new Set(
  'i me my mine myself we us our ours ourselves you your yours yourself he him his himself she her hers herself they them their theirs themselves'.split(
    ' ',
  ),
);

const NEG_EN = new Set([
  'not',
  'never',
  'no',
  'none',
  'nobody',
  'nothing',
  'nowhere',
  'neither',
  'nor',
  'without',
  'hardly',
  'scarcely',
]);

/** Per-check memory: a Korean word's stems are computed once. */
interface Ctx {
  stems: Map<string, KoStems>;
  budget: number;
}
/** Placement work, in words checked, for one whole check: enough for any real interview. */
const newCtx = (): Ctx => ({ stems: new Map(), budget: 3_000_000 });

function stemsOf(ctx: Ctx, w: string): KoStems {
  let r = ctx.stems.get(w);
  if (!r) {
    r = koStems(w);
    ctx.stems.set(w, r);
  }
  return r;
}

/** Which words of a sentence are free; an auxiliary is free only right after a connective form. */
function flagged(ctx: Ctx, toks: Tok[]): Tok[] {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === 'en') t.f = EN_FREE.has(t.w);
    else if (t.k === 'ko') {
      const prev = toks[i - 1];
      const afterConnective = prev !== undefined && prev.k === 'ko' && CONNECTIVE_END.test(prev.w);
      t.f = koScaffold(stemsOf(ctx, t.w), t.w, afterConnective);
    }
  }
  return toks;
}

/** A word that places a sentence: content, people, negation and numbers; not glue. */
function isSupportWord(t: Tok): boolean {
  if (t.k === 'en') return !EN_LIGHT.has(t.w);
  if (t.k === 'ko') return !t.f && !FILLER.has(t.w);
  return true;
}

/** A word whose loss is a loss: content only (people, negation and hedges have their own checks). */
function isRetainWord(t: Tok): boolean {
  if (t.k === 'en') return !EN_LIGHT.has(t.w) && !EN_PRONOUNS.has(t.w) && !NEG_EN.has(t.w);
  if (t.k === 'ko') return isSupportWord(t) && t.w !== '안' && t.w !== '못';
  return true;
}

/* ── 8. evidence: where each word of one side appears ────────────────── */

interface Ev {
  /** English: inflection key -> sentence ids (ascending) */
  en: Map<string, number[]>;
  /** numbers and other scripts: exact word -> sentence ids */
  ex: Map<string, number[]>;
  /** Korean: every stem of every word (an adverbial word's stems carry a mark) -> sentence ids */
  ko: Map<string, number[]>;
  /** Korean negator class -> sentence ids (않- and 못하- are read through it) */
  neg: Map<string, number[]>;
  /** English person class (1s, 1p, 2, 3m, 3f, 3p) -> sentence ids that refer to one */
  pro: Map<string, number[]>;
  /** English inflection key -> the forms written (for tense: "works" said, "worked" written) */
  forms: Map<string, Set<string>>;
}

/**
 * A pronoun is supported where its person is: "He had big hands." is said by "My father ...
 * had big hands", and "I" by "me". Which "he" it is, and whether "she" became "he", is the
 * people check's question, not this one.
 */
const PRONOUN_CLASS: Record<string, string> = {
  i: '1s',
  me: '1s',
  my: '1s',
  mine: '1s',
  myself: '1s',
  we: '1p',
  us: '1p',
  our: '1p',
  ours: '1p',
  ourselves: '1p',
  you: '2',
  your: '2',
  yours: '2',
  yourself: '2',
  yourselves: '2',
  he: '3m',
  him: '3m',
  his: '3m',
  himself: '3m',
  she: '3f',
  her: '3f',
  hers: '3f',
  herself: '3f',
  they: '3p',
  them: '3p',
  their: '3p',
  theirs: '3p',
  themselves: '3p',
};

function addSid(map: Map<string, number[]>, key: string, sid: number): void {
  const a = map.get(key);
  if (!a) map.set(key, [sid]);
  else if (a[a.length - 1] !== sid) a.push(sid);
}

const IRREGULAR_PLURAL: Record<string, string> = {
  children: 'child',
  men: 'man',
  women: 'woman',
  wives: 'wife',
  lives: 'life',
  feet: 'foot',
  teeth: 'tooth',
  people: 'person',
  grandchildren: 'grandchild',
  stepchildren: 'stepchild',
};

/**
 * The CLOSED list of English inflections: a word and its -s, -es, -ed, -d, -ing, -ly, -er, -est
 * forms share a key (with the usual spelling rules: hoped/hope, stopped/stop, carried/carry,
 * dying/die). Nothing else: "hero" shares no key with "he", "annie" none with "ann".
 */
export function enKeys(w: string): string[] {
  const out = [w];
  const irr = IRREGULAR_PLURAL[w];
  if (irr) out.push(irr);
  const n = w.length;
  if (n < 4) return out;
  const add = (s: string): void => {
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  };
  const stem = (s: string): void => {
    add(s);
    add(`${s}e`);
    if (s.length >= 4 && s[s.length - 1] === s[s.length - 2] && !/[aeiouls]/.test(s[s.length - 1]!))
      add(s.slice(0, -1));
    if (s.endsWith('i')) add(`${s.slice(0, -1)}y`);
  };
  if (w.endsWith('ing') && n >= 6) {
    const s = w.slice(0, -3);
    stem(s);
    if (s.endsWith('y')) add(`${s.slice(0, -1)}ie`);
  }
  if (w.endsWith('ed') && n >= 5) stem(w.slice(0, -2));
  if (w.endsWith('est') && n >= 6) stem(w.slice(0, -3));
  else if (w.endsWith('er') && n >= 5) stem(w.slice(0, -2));
  if (w.endsWith('es') && n >= 5) {
    const s = w.slice(0, -2);
    add(s);
    if (s.endsWith('i')) add(`${s.slice(0, -1)}y`);
  }
  if (w.endsWith('s') && !w.endsWith('ss') && n >= 4) add(w.slice(0, -1));
  if (w.endsWith('ly') && n >= 5) {
    const s = w.slice(0, -2);
    add(s);
    if (s.endsWith('i')) add(`${s.slice(0, -1)}y`);
  }
  return out;
}

/** 's and 'd stand for these. */
const CLITIC_ALT: Record<string, string[]> = {
  zzs: ['is', 'has', 'us'],
  zzc: ['is', 'has'],
  zzd: ['would', 'had', 'did'],
};

/** Korean: a whole word may also be two of theirs written without the space (안 했어요 / 안했어요). */
const KO_JOIN_MAX = 14;
/** Marks the stems of a word said as an adverb (죽도록), which support only that form. */
const ADVERB_MARK = '\u0001';

/**
 * Two words written together (이십 년 / 이십년, 차려 주셨다 / 차려주셨다) are looked up as one
 * word. With a number word in it only the string itself counts: 그때 삼 is 그때삼 and never
 * 그때사 (삼 read as 사 and a noun ending ㅁ, so "three" would be "four"), and 그때 십이 is
 * not 그때십 and a particle 이.
 */
const exactGlue = (a: string, b: string): boolean => isBareNumber(a) || isBareNumber(b);

function addKo(ctx: Ctx, ev: Ev, w: string, sid: number, exact = false): void {
  const st = stemsOf(ctx, w);
  const mark = st.adverbial ? ADVERB_MARK : '';
  for (const x of exact ? [w] : st.all) addSid(ev.ko, x + mark, sid);
}

function buildEv(ctx: Ctx, sents: Sent[], negs: NegEvent[]): Ev {
  const ev: Ev = {
    en: new Map(),
    ex: new Map(),
    ko: new Map(),
    neg: new Map(),
    pro: new Map(),
    forms: new Map(),
  };
  for (const s of sents) {
    for (let i = 0; i < s.toks.length; i++) {
      const t = s.toks[i]!;
      if (t.k === 'en') {
        for (const key of enKeys(t.w)) {
          addSid(ev.en, key, s.sid);
          const f = ev.forms.get(key);
          if (f) f.add(t.w);
          else ev.forms.set(key, new Set([t.w]));
        }
        for (const alt of CLITIC_ALT[t.w] ?? []) addSid(ev.en, alt, s.sid);
        const pc = PRONOUN_CLASS[t.w];
        if (pc) addSid(ev.pro, pc, s.sid);
        else {
          const p = enPerson(t.w);
          if (p && p.g !== 'n') addSid(ev.pro, `3${p.g}`, s.sid);
        }
      } else if (t.k === 'ko') {
        addKo(ctx, ev, t.w, s.sid);
        const nx = s.toks[i + 1];
        if (nx?.k === 'ko' && t.w.length + nx.w.length <= KO_JOIN_MAX) {
          addKo(ctx, ev, t.w + nx.w, s.sid, exactGlue(t.w, nx.w));
        }
      } else {
        addSid(ev.ex, t.w, s.sid);
      }
    }
  }
  for (const n of negs) if (n.ko) addSid(ev.neg, n.cls, n.sid);
  return ev;
}

export type Support = 'scaffold' | 'grounded' | 'variant' | null;

/** Where a word is supported: lists of sentence ids, or free, or nowhere. */
interface Where {
  support: Support;
  lists: number[][];
}
const NOWHERE: Where = { support: null, lists: [] };
const FREE: Where = { support: 'scaffold', lists: [] };

/**
 * 않-, 안 하-, 못 하-: a negation and a light verb, nothing else ("않으셨다", "못했어요"). Read
 * through the source's negators of the same kind; that the negation itself is kept, and about
 * the same thing, is the negation check's job.
 */
function koNegLight(ctx: Ctx, w: string): string | null {
  const light = (rest: string) => {
    if (rest === '') return true;
    const v = stemsOf(ctx, rest).verbs;
    return v.has('하') || v.has('되');
  };
  if (stemsOf(ctx, w).verbs.has('않')) return 'not';
  if (/^안(?:하|해|했|한|할|함|돼|됐|되|된|될)/.test(w) && light(w.slice(1))) return 'not';
  if (/^못(?:하|해|했|한|할|함)/.test(w) && light(w.slice(1))) return 'cannot';
  return null;
}

/**
 * Where a Korean word is supported: some stem of it equal to some stem of theirs. `joined` is
 * a word made of two of the other side's words written together: only a real match counts for
 * it, never a free pass and never a negator.
 */
function koWhere(
  ctx: Ctx,
  w: string,
  ev: Ev,
  joined: boolean,
  free: boolean,
  exact = false,
): Where {
  if (!joined && free) return FREE;
  const st = stemsOf(ctx, w);
  const mark = st.adverbial ? ADVERB_MARK : '';
  const lists: number[][] = [];
  for (const x of exact ? [w] : st.all) {
    const a = ev.ko.get(x + mark);
    if (a) lists.push(a);
  }
  if (lists.length > 0) return { support: 'grounded', lists };
  if (exact) return NOWHERE;
  // household words for the same person, tried LAST so an exact match is never a "swap"
  for (const x of st.nouns) {
    const cls = VARIANT.get(x);
    if (!cls) continue;
    for (const alt of cls) {
      if (alt === x) continue;
      const a = ev.ko.get(alt + mark);
      if (a) lists.push(a);
    }
  }
  if (lists.length > 0) return { support: 'variant', lists };
  if (joined) return NOWHERE;
  const neg = koNegLight(ctx, w);
  const n = neg ? ev.neg.get(neg) : undefined;
  if (n) return { support: 'grounded', lists: [n] };
  return NOWHERE;
}

function enWhere(w: string, ev: Ev): Where {
  if (EN_FREE.has(w)) return FREE;
  const lists: number[][] = [];
  for (const key of enKeys(w)) {
    const a = ev.en.get(key);
    if (a) lists.push(a);
  }
  const pc = PRONOUN_CLASS[w];
  const p = pc ? ev.pro.get(pc) : undefined;
  if (p) lists.push(p);
  return lists.length > 0 ? { support: 'grounded', lists } : NOWHERE;
}

/**
 * Where the word at `i` of `toks` is supported in `ev`. A Korean word may also be half of
 * two of theirs written together, or two of its words may be one of theirs split by a space.
 */
function whereOf(ctx: Ctx, toks: Tok[], i: number, ev: Ev): Where {
  const t = toks[i]!;
  if (t.k === 'en') return enWhere(t.w, ev);
  if (t.k === 'num' || t.k === 'x') {
    const a = ev.ex.get(t.w);
    return a ? { support: 'grounded', lists: [a] } : NOWHERE;
  }
  const own = koWhere(ctx, t.w, ev, false, t.f);
  if (own.support !== null) return own;
  const prev = toks[i - 1];
  const next = toks[i + 1];
  const around: Array<readonly [string, boolean]> = [];
  if (prev?.k === 'ko') around.push([prev.w + t.w, exactGlue(prev.w, t.w)]);
  if (next?.k === 'ko') around.push([t.w + next.w, exactGlue(t.w, next.w)]);
  for (const [joined, exact] of around) {
    if (joined.length > KO_JOIN_MAX) continue;
    const j = koWhere(ctx, joined, ev, true, false, exact);
    if (j.support !== null) return j;
  }
  return NOWHERE;
}

/** A small evidence built from one word, for comparing two words with the same rules. */
function sameWord(ctx: Ctx, a: Tok, b: Tok): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'en') {
    const kb = new Set(enKeys(b.w));
    return enKeys(a.w).some((k) => kb.has(k));
  }
  if (a.k !== 'ko') return a.w === b.w;
  const s: Sent = { sid: 0, turn: 0, text: b.w, toks: [b] };
  if (koWhere(ctx, a.w, buildEv(ctx, [s], []), false, false).support !== null) return true;
  const r: Sent = { sid: 0, turn: 0, text: a.w, toks: [a] };
  return koWhere(ctx, b.w, buildEv(ctx, [r], []), false, false).support !== null;
}

/* ── 9. negation and hedges ──────────────────────────────────────────── */

interface NegEvent {
  cls: string;
  /** the word the negation is about ("talk" in "did not talk"), when there is one */
  head: Tok | null;
  sid: number;
  ko: boolean;
  /** for the report: the negator and its word */
  shown: string;
}

/** Skipped when looking for what a negation is about. */
const EN_HEAD_SKIP = new Set([
  ...EN_LIGHT,
  ...EN_PRONOUNS,
  ...'ever even really quite very much all any anything anyone anybody one just yet still always else zzs zzd'.split(
    ' ',
  ),
]);
const INTERJECTIONS = new Set(['oh', 'well', 'um', 'uh', 'ah', 'yes', 'yeah', 'and', 'but', 'so']);
const CLAUSE_GAP = /[,;:.!?—–()"“”]/;

/** "No." / "No," answering a question is a reply, not a negation of anything in the sentence. */
function isReply(s: Sent, i: number): boolean {
  for (let j = 0; j < i; j++) if (!INTERJECTIONS.has(s.toks[j]!.w)) return false;
  const after = s.text.slice(s.toks[i]!.e).trimStart();
  return after === '' || /^[,.!?;:—–-]/.test(after);
}

function enNegations(s: Sent, out: NegEvent[]): void {
  for (let i = 0; i < s.toks.length; i++) {
    const t = s.toks[i]!;
    if (t.k !== 'en' || !NEG_EN.has(t.w)) continue;
    if (t.w === 'no' && isReply(s, i)) continue;
    let head: Tok | null = null;
    for (let j = i + 1; j < s.toks.length; j++) {
      const u = s.toks[j]!;
      if (CLAUSE_GAP.test(s.text.slice(s.toks[j - 1]!.e, u.s))) break;
      if (u.k === 'en' && (EN_HEAD_SKIP.has(u.w) || NEG_EN.has(u.w))) continue;
      head = u;
      break;
    }
    out.push({ cls: 'not', head, sid: s.sid, ko: false, shown: head ? `${t.w} ${head.w}` : t.w });
  }
}

const AN_VERB =
  /^(?:하|해|했|한|할|함|돼|됐|되|된|될|가|갔|와|왔|오|먹|드|들|보|봤|주|줬|나|났|자|잤|받|맞|쓰|썼|읽|울|웃|계|입|씻|찾|챙|좋|믿|팔|빠|버)/;
const AN_NOUN =
  /^(?:안방|안경|안개|안녕|안전|안쪽|안부|안심|안내|안주|안사람|안팎|안마|안과|안정|안도|안보|안나|안타|안색|안부)/;
const MOT_VERB =
  /^(?:하|해|했|한|할|함|가|갔|와|왔|오|먹|보|봤|자|잤|읽|찾|받|들|드|나|났|쓰|썼|알|살|산|샀|사|만|믿|잊|이기|견디|참)/;
const DONT = /^(?:마라|마요|마세요|마십시오|마|말고|말라|말아|말아요|말아라|말자|맙시다)$/;

/** A made-up word for the part of a Korean word a negation is about ("재미없다" -> 재미). */
const part = (w: string): Tok | null => (w === '' ? null : { w, k: 'ko', s: -1, e: -1, f: false });

function koNegations(s: Sent, out: NegEvent[]): void {
  const ko = s.toks.filter((t) => t.k === 'ko');
  for (let i = 0; i < ko.length; i++) {
    const w = ko[i]!.w;
    const prev = ko[i - 1] ?? null;
    const next = ko[i + 1] ?? null;
    // `before`: the negator comes first ("안 갔어요"), else after ("가지 않았어요")
    const push = (cls: string, head: Tok | null, neg: string, before = false): void => {
      const shown = head === null ? neg : before ? `${neg} ${head.w}` : `${head.w} ${neg}`;
      out.push({ cls, head, sid: s.sid, ko: true, shown });
    };
    const afterJi = prev !== null && prev.w.endsWith('지');
    if (w === '안') push('not', next, '안', true);
    else if (w === '못') push('cannot', afterJi ? prev : next, '못', !afterJi);
    else if (w.length > 1 && w.startsWith('안') && !AN_NOUN.test(w) && AN_VERB.test(w.slice(1)))
      push('not', part(w.slice(1)), '안', true);
    else if (w.length > 1 && w.startsWith('못') && MOT_VERB.test(w.slice(1)))
      push('cannot', afterJi ? prev : part(w.slice(1)), '못', !afterJi);
    for (let at = w.indexOf('않'); at >= 0; at = w.indexOf('않', at + 1)) {
      push('not', at === 0 ? prev : part(w.slice(0, at).replace(/지$/, '')), '않');
    }
    for (let at = w.indexOf('없'); at >= 0; at = w.indexOf('없', at + 1)) {
      push('absent', at === 0 ? prev : part(w.slice(0, at)), '없');
    }
    if (/^(?:아니|아닌|아냐|아녜|아님|아닐|아닙|아뇨)/.test(w)) {
      const reply = i === 0 && /^[\s]*[,.!?…]/.test(s.text.slice(ko[i]!.e));
      if (!reply) push('isnot', prev, '아니');
    }
    if ((afterJi && DONT.test(w)) || w === '말고') push('dont', prev, w);
    if (/모르|몰라|몰랐|모릅/.test(w)) push('unknown', prev, '모르');
  }
}

function negationsOf(sents: Sent[]): NegEvent[] {
  const out: NegEvent[] = [];
  for (const s of sents) {
    enNegations(s, out);
    koNegations(s, out);
  }
  return out;
}

const HEDGE_EN_1 = new Set([
  'maybe',
  'perhaps',
  'probably',
  'possibly',
  'roughly',
  'approximately',
  'apparently',
  'supposedly',
  'presumably',
  'almost',
  'nearly',
  'circa',
]);
/** "about forty", "around 1950", "some twenty", "like ten years": only before a number. */
const HEDGE_EN_NUM = new Set(['about', 'around', 'some', 'like']);
const NUMERIC_WORDS = new Set(['a', 'an', 'half', 'dozen', 'hundred', 'thousand', 'couple']);
const HEDGE_EN_PHRASES: ReadonlyArray<readonly string[]> = [
  ['i', 'think'],
  ['i', 'believe'],
  ['i', 'guess'],
  ['i', 'suppose'],
  ['or', 'so'],
  ['sort', 'of'],
  ['kind', 'of'],
  ['more', 'or', 'less'],
  ['if', 'i', 'remember'],
  ['something', 'like'],
];
/** What was wanted or tried is not what happened: "tried to save him" is not "saved him". */
const MODAL_EN: Record<string, string> = {
  try: 'try',
  tried: 'try',
  tries: 'try',
  trying: 'try',
  want: 'want',
  wanted: 'want',
  wants: 'want',
  wanting: 'want',
  wish: 'wish',
  wished: 'wish',
  hope: 'hope',
  hoped: 'hope',
  hoping: 'hope',
  supposed: 'supposed',
};
/**
 * Modal auxiliaries are kept like hedges: "He could have died" is not "He died", "My father
 * would have been a doctor" is not "was a doctor", "We will move" is not "We moved". 'd
 * (zzd) is "would" or "had": it matches either, and binds nothing when neither is written.
 */
const MODAL_AUX = new Set([
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  'ought',
  'zzd',
]);
/** Conditions and restrictions, kept like negations: if, unless, except, only, until. */
const CONDITION_EN = new Set(['if', 'unless', 'except', 'only', 'until', 'till']);
const MODAL_PHRASES: ReadonlyArray<readonly string[]> = [
  ['going', 'to'],
  ['used', 'to'],
  ['have', 'to'],
  ['has', 'to'],
  ['had', 'to'],
];

/**
 * Who it came from, how often, and how far it went are kept like hedges: "I heard that my
 * uncle died" is not "my uncle died", "In my dream, Tom came home" is not "Tom came home",
 * "He sometimes hit us" is not "He hit us", "She is still alive" is not "She is alive".
 */
const FRAME_EN: Record<string, string> = {};
for (const [lemma, forms] of [
  ['heard', 'hear hears heard hearing'],
  ['say', 'say says said saying'],
  ['told', 'tell tells told telling'],
  ['dream', 'dream dreams dreamed dreamt dreaming'],
  ['imagine', 'imagine imagines imagined imagining'],
  ['think', 'think thinks thought thinking'],
  ['believe', 'believe believes believed'],
  ['read', 'read reads'],
  ['rumor', 'rumor rumors rumour rumours rumored rumoured'],
  ['knowledge', 'knowledge'],
  ['seem', 'seem seems seemed seemingly'],
  ['assume', 'assume assumes assumed assuming'],
  ['claim', 'claim claims claimed claiming'],
  ['reportedly', 'reportedly'],
  ['allegedly', 'allegedly alleged'],
  ['evidently', 'evidently'],
] as const)
  for (const f of forms.split(' ')) FRAME_EN[f] = lemma;
const FREQ_EN = new Set(
  'sometimes usually often always rarely seldom occasionally frequently mostly generally normally regularly constantly typically'.split(
    ' ',
  ),
);
const ASPECT_EN = new Set(
  'still already also first later again once barely merely partly'.split(' '),
);
/** "too young", "too much": a degree, not "also" */
const TOO_DEGREE = new Set(
  'much many little few young old late early far long big small hard bad poor sick tired hot cold busy scared afraid high low short heavy close soon fast slow often well'.split(
    ' ',
  ),
);
/** the same in Korean, by how the word starts (가끔씩 is 가끔) or, for 늘, the whole word */
const FRAME_KO: ReadonlyArray<readonly [RegExp, string]> = [
  [/^소문/, 'frame:소문'],
  [/^꿈/, 'frame:꿈'],
  [/^(?:듣기|들은|들으니)/, 'frame:듣'],
  [/^알기(?:로|에)/, 'frame:알기'],
  [/^생각/, 'frame:생각'],
  [/^혹시/, '혹시'],
  [/^(?:가끔|이따금)/, 'freq:가끔'],
  [/^(?:항상|언제나|늘상?$|맨날)/, 'freq:항상'],
  [/^(?:자주|종종|때때로)/, 'freq:자주'],
  [/^(?:대개|대체로|주로)/, 'freq:대개'],
  [/^(?:매번|매일|날마다)/, 'freq:매일'],
  [/^(?:아직|여전히)/, 'asp:아직'],
  [/^(?:이미|벌써)/, 'asp:이미'],
  [/^처음/, 'asp:처음'],
  [/^나중/, 'asp:나중'],
  [/^다시/, 'asp:다시'],
  [/^(?:겨우|간신히)/, 'deg:겨우'],
  [/^전혀/, 'deg:전혀'],
  [/^절대/, 'deg:절대'],
];

/**
 * "I have lived here fifty years" is not "I lived here", "He was working there" is not "He
 * worked there": the perfect and the progressive are kept like a tense.
 */
const PERFECT_AUX = new Set(['have', 'has', 'had', 'zzc', 'zzd']);
const BE_AUX = new Set(['am', 'is', 'are', 'was', 'were', 'zzc', 'be', 'been', 'being']);
const ASPECT_SKIP = new Set(
  'not never always just already ever also still really only all both often sometimes usually'.split(
    ' ',
  ),
);
const NOT_ING = new Set(
  'nothing something anything everything morning evening during ceiling king ring sing thing wedding spring string'.split(
    ' ',
  ),
);
function aspectAt(t: readonly Tok[], i: number): 'perfect' | 'prog' | null {
  const w = t[i]!.w;
  let k = i + 1;
  while (k < t.length && k <= i + 3 && ASPECT_SKIP.has(t[k]!.w)) k++;
  const v = t[k];
  if (!v || v.k !== 'en') return null;
  if (PERFECT_AUX.has(w)) {
    const participle =
      v.w === 'been' ||
      PARTICIPLE_EN.has(v.w) ||
      IRREGULAR_PAST.has(v.w) ||
      (w !== 'zzc' && v.w.length >= 4 && v.w.endsWith('ed'));
    if (participle) return 'perfect';
  }
  if (BE_AUX.has(w) && v.w.length >= 5 && v.w.endsWith('ing') && !NOT_ING.has(v.w)) return 'prog';
  return null;
}

/** "like I said", "first of all", "you know", "I mean": the speaker clearing the throat */
function asideAt(t: readonly Tok[], i: number): boolean {
  const w = t[i]!.w;
  if (w === 'said') return t[i - 1]?.w === 'i' && /^(?:like|as)$/.test(t[i - 2]?.w ?? '');
  if (w === 'first') return t[i + 1]?.w === 'of' && t[i + 2]?.w === 'all';
  if (w === 'all') return t[i - 1]?.w === 'of' && t[i - 2]?.w === 'first';
  // "you know", "you see", "I mean", "of course"
  if (w === 'know' || w === 'see') return t[i - 1]?.w === 'you';
  if (w === 'mean') return t[i - 1]?.w === 'i';
  if (w === 'course') return t[i - 1]?.w === 'of';
  return false;
}

const hedgeCache = new WeakMap<Sent, string[]>();

/** Hedges (and wishes) of one sentence, as lemmas: "maybe", "about+n", "i think", 아마, 쯤, 싶 ... */
function hedgesOf(s: Sent): string[] {
  const hit = hedgeCache.get(s);
  if (hit) return hit;
  const out: string[] = [];
  hedgeCache.set(s, out);
  const t = s.toks;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.w;
    if (t[i]!.k === 'en') {
      if (HEDGE_EN_1.has(w)) out.push(w);
      const nx = t[i + 1];
      if (HEDGE_EN_NUM.has(w) && nx && (nx.k === 'num' || NUMERIC_WORDS.has(nx.w)))
        out.push('about+n');
      for (const p of HEDGE_EN_PHRASES) {
        if (p[0] === w && p.every((x, k) => t[i + k]?.w === x)) out.push(p.join(' '));
      }
      const modal = MODAL_EN[w];
      if (modal) out.push(`modal:${modal}`);
      if (MODAL_AUX.has(w)) out.push(`modal:${w}`);
      // "If my father had come home..." is not "My father had come home..."
      if (CONDITION_EN.has(w)) out.push(`cond:${w === 'till' ? 'until' : w}`);
      for (const p of MODAL_PHRASES) {
        if (p[0] === w && p.every((x, k) => t[i + k]?.w === x))
          out.push(`modal:${p[0] === 'has' || p[0] === 'had' ? 'have' : p[0]} to`);
      }
      const frame = FRAME_EN[w];
      const aside = asideAt(t, i);
      if (frame && !aside) out.push(`frame:${frame}`);
      if (FREQ_EN.has(w)) out.push(`freq:${w}`);
      if (ASPECT_EN.has(w) && !aside) out.push(`asp:${w}`);
      if (w === 'too' && !TOO_DEGREE.has(t[i + 1]?.w ?? '')) out.push('asp:also');
      const aspect = aspectAt(t, i);
      if (aspect) out.push(`aspect:${aspect}`);
      if (w === 'as' && t[i + 1]?.w === 'well' && t[i + 2]?.w !== 'as') out.push('asp:also');
    } else if (t[i]!.k === 'ko') {
      if (w.startsWith('아마')) out.push('아마');
      if (w.startsWith('글쎄')) out.push('글쎄');
      if (w.includes('쯤')) out.push('쯤');
      if (w.startsWith('정도')) out.push('정도');
      if (/^(?:년|월|일|시)?경(?:에|으로|부터|까지|쯤)?$/.test(w)) out.push('경');
      if (w.includes('무렵')) out.push('무렵');
      if (/(?:인가|던가|었나|았나|였나|일까|을까)$/.test(w)) out.push('인가');
      if (w.startsWith('거의')) out.push('거의');
      if (w.includes('뻔')) out.push('뻔');
      if (w.includes('싶')) out.push('modal:싶');
      if (/려고$/.test(w)) out.push('modal:려고');
      for (const [re, q] of FRAME_KO) if (re.test(w)) out.push(q);
      // 만약 / -면 (if), 만 / 밖에 (only), 이전 / 전에 (before), 옛 (former); a filler (뭐냐면) is none
      if (FILLER.has(w)) continue;
      if (w === '만약' || w === '만일' || w.startsWith('만약에')) out.push('cond:만약');
      if (/(?:으면|면|라면|다면|더라도|어야|아야|여야)$/.test(w) && w.length >= 2)
        out.push('cond:면');
      // the particle 만 after a noun; never the ending 지만 ("but") or 그만 ("enough")
      if (
        w.length >= 2 &&
        /만(?:은|이|을|도|요)?$/.test(w) &&
        !/지만$|^그만/.test(w) &&
        !/^\d/.test(w)
      )
        out.push('cond:만');
      if (w.endsWith('밖에')) out.push('cond:만');
      if (/^이전/.test(w) || /^전(?:에|엔|에는|부터|까지)$/.test(w)) out.push('cond:전');
      if (w === '옛') out.push('cond:옛');
    }
  }
  out.push(...koMood(t));
  return out;
}

/** A past marker: 었/았/였, or a past fused into the stem's vowel (갔, 왔, 했, 셨, 됐); never 있 or 겠. */
function koPast(w: string): boolean {
  if (/[었았였]/.test(w)) return true;
  for (const c of w) {
    if (!isSyllable(c) || c === '겠') continue;
    const p = syl(c);
    if (p.t === T_SS && FUSED_PAST_VOWELS.has(p.v)) return true;
  }
  return false;
}
/** The syllable before the last one has this final consonant (갔+대, 간+대). */
const jongBeforeLast = (w: string, n: number): number => {
  const c = w[w.length - 1 - n];
  return c !== undefined && isSyllable(c) ? syl(c).t : -1;
};
/** What a reporting verb after a quotation starts with: 했어요, 하더라고요, 들었어요, 그러셨어요. */
const REPORTING =
  /^(?:했|해|하|한|할|합|함|들었|들어|듣|그러|그랬|그래|말했|말해|말씀|생각|믿|전해)/;
const FINITE_KO = /(?:요|다|네|죠|지|까|군|구나|니다|니까|세요|예|데이|어|아|여|야)$/;
/** the auxiliary 주다 / 드리다 after an -아/어 form: 빌려 주셨어요, 해줬어요, 가져다 드렸어요 */
const GIVE =
  '(?:주(?:셨|시|신|실|심|십|세|고|던|는|었|어|면|며|니|지|기|자)|줘|줬|줌|드(?:리|려|렸|린|릴|림|립))';
const GIVE_JOINED = new RegExp(`(?:어|아|여|해|려|와|워|봐|셔|겨|쳐|져|내|다)(?:${GIVE}|[준줄]$)`);
const GIVE_ALONE = new RegExp(`^(?:${GIVE}|[준줄]$)`);
const GIVE_AFTER = /(?:어|아|여|해|와|워|봐|셔|겨|쳐|져|려|내|다)$/;

/**
 * Korean tense and mood, per sentence: what a tidy rewrite must keep however it changes the
 * register. 했다, 했어요 and 했습니다 are all `past`; but 갈 거예요 (future) is not 갔어요,
 * 갔을 거예요 (a guess) is not 갔어요, 갔대요 / 갔다고 하더라고요 ("I heard he went") is not
 * 갔어요, 가라고 했어요 ("told me to go") is not 갔어요, 가야 했어요 ("had to go") is not
 * 갔어요, and 아직 살아 계세요 ("is still alive") is not 살아 계셨어요.
 */
function koMood(toks: Tok[]): string[] {
  const ko = toks.filter((t) => t.k === 'ko' && !FILLER.has(t.w));
  const out: string[] = [];
  if (ko.length === 0) return out;
  let cleft = false;
  let heard = false; // the predicate is 간대요 / 가래요: it reports, like 간다고 해요
  for (let i = 0; i < ko.length; i++) {
    const w = ko[i]!.w;
    const next = ko[i + 1]?.w ?? '';
    const lastJong = jongBeforeLast(w, 0);
    const final = i === ko.length - 1;
    // 가라고 했어요 / 가래요 / 가라고 해요 tell one story: the tense that counts is the quote's
    const said = ko[i - 1]?.w ?? '';
    const reports =
      (/(?:다고|라고|냐고|자고)$/.test(said) || (said.length >= 2 && said.endsWith('라'))) &&
      REPORTING.test(w);
    if (koPast(w) && !reports) out.push('ko:past');
    // future and guesses: 갈 거예요, 먹을 겁니다, 하겠다, 갈게요, 간 것 같아요, 갔나 봐요, 갈 듯
    if ((lastJong === T_L || w.endsWith('을')) && /^(?:거|것|겁|게|걸)/.test(next))
      out.push('ko:fut');
    if (w.includes('겠')) out.push('ko:fut');
    // 갈게요, 먹을래요: an ㄹ before 게/래 is a promise or a wish; 살게 됐어요 ("came to live") is not
    const promise = /(?:게|래)(?:요)?$/.exec(w);
    if (promise && promise.index > 0 && jongBeforeLast(w, w.length - promise.index) === T_L)
      if (!/^(?:되|돼|됐|된|될|됩|했|해|하|한|할|합|만들|만드)/.test(next)) out.push('ko:fut');
    if (/^(?:것|거)/.test(w) && /^같/.test(next)) out.push('ko:conj');
    if (/(?:나|는가|ㄴ가)$/.test(w) && /^(?:봐|보|싶)/.test(next)) out.push('ko:conj');
    if (w.includes('듯')) out.push('ko:conj');
    if (w.endsWith('지도') && /^(?:모르|몰)/.test(next)) out.push('ko:conj');
    // quotation and hearsay: 갔다고 했어요, 가라고 하셨어요, 갔대요, 하더라고요, 다던데
    // "밥 먹어라" 하셨어요 and "밥 먹어라"라고 하셨어요 are one command, quoted
    if (
      /라$/.test(w) &&
      w.length >= 2 &&
      (REPORTING.test(next) || /^(?:이라고|라고|하고)$/.test(next))
    )
      out.push('ko:cmd');
    const bareParticle = /^(?:이라고|라고|하고|고)$/.test(w);
    // 하더라고요 is 더라 (below), not a quoted 라고; 학생이라고 / 아니라고 quote a statement
    const quote = /(?:다고|라고|냐고|자고)(?:요)?$/.exec(w);
    if (
      quote &&
      !bareParticle &&
      !/더라고(?:요)?$/.test(w) &&
      (REPORTING.test(next) || i === ko.length - 1)
    ) {
      const command =
        /(?:라고|자고)(?:요)?$/.test(w) && !/(?:이|아니)라고(?:요)?$/.test(w) && !koPast(w);
      out.push(command ? 'ko:cmd' : 'ko:quote');
    }
    // 가래요 (라고 해요: "told me to go") or 의사래요 ("they say he is a doctor"); never 그래요,
    // 노래, 아래, 할래요; which of the two it is, the other side decides (alignZzd)
    if (
      /래(?:요|서|더라|던데)?$/.test(w) &&
      w.length >= 2 &&
      (/래(?:요|서|더라|던데)$/.test(w) || i === ko.length - 1) &&
      !/^(?:그|이|저|요|조|고|노|미|아|모|거|도|유|외|재|초|애|내)래/.test(w)
    ) {
      const c = w[w.lastIndexOf('래') - 1];
      if (c !== undefined && isSyllable(c) && syl(c).t === 0) {
        out.push('ko:rae');
        heard ||= final;
      }
    }
    if (/대(?:요|서|더라|던데)?$/.test(w) && w.length >= 2) {
      const at = w.lastIndexOf('대');
      const before = w[at - 1];
      const bt = before !== undefined && isSyllable(before) ? syl(before).t : -1;
      if (bt === T_SS || before === '는' || (bt === T_N && final)) {
        out.push('ko:quote');
        heard ||= final;
      }
    }
    if (/(?:다더라|다던데|다며|다면서|라더라|라던데|라며|대더라)$/.test(w)) out.push('ko:quote');
    if (/(?:더라|더라고|더라고요|더라구요|던데|던데요|더니)$/.test(w)) out.push('ko:quote');
    // obligation and permission: 가야 했어요 (contracted 가+아야), 해야지, 가도 돼요
    if (
      /야(?:지|죠|만)?$/.test(w) &&
      w.length >= 2 &&
      (/^(?:했|해|하|한|할|합|돼|됐|되|된|될|됩)/.test(next) || /야(?:지|죠)$/.test(w))
    )
      out.push('ko:must');
    if (w.endsWith('도') && w.length >= 2 && /^(?:돼|됐|되|된|될|됩|괜찮)/.test(next))
      out.push('ko:may');
    // doing it FOR someone: 빌려 주셨어요 ("lent") is not 빌리셨어요 ("borrowed"); never 주무셨어요
    if (
      (GIVE_JOINED.test(w) && !w.startsWith('여주시')) ||
      (GIVE_ALONE.test(w) && GIVE_AFTER.test(said))
    )
      out.push('ko:give');
    // 돌아가신 게 1950년이에요 ("his dying was in 1950"): the clause is past, the copula is not tense
    if (lastJong === T_N && !/(?:는|던)$/.test(w) && /^(?:게|건|거|것)/.test(next)) {
      cleft = true;
      out.push('ko:past');
    }
  }
  // the predicate: the sentence's last word, in the present, unless it only reports a quotation
  const last = ko[ko.length - 1]!.w;
  const prev = ko[ko.length - 2]?.w ?? '';
  const reporting = heard || (/(?:다고|라고|냐고|자고)$/.test(prev) && REPORTING.test(last));
  if (!cleft && !reporting && !koPast(last) && !last.includes('겠')) {
    if (FINITE_KO.test(last)) out.push('ko:pres');
    // 밥상 차려주심, 갔다고 함: a note's -ㅁ ending says no tense; the rewrite's is its reading
    else if (jongBeforeLast(last, 0) === T_M) out.push('ko:open');
  }
  return out;
}

/**
 * How two things that were said are linked. A rewrite that joins "He drank. She left." may
 * write "He drank and she left", never "He drank, so she left": a cause, a contrast or an
 * order the speaker did not say is an invention. `seo` is Korean -아서/-어서, a cause or
 * "and then"; `nde` is -는데, which may already be a contrast (약하셨는데 일을 많이 하셨어요
 * is 약하셨지만): it allows one, and is never an invention itself.
 */
type Link = 'cause' | 'contrast' | 'time' | 'seo' | 'nde';
interface LinkAt {
  cls: Link;
  /** the word as written, for "words that were not said" */
  word: string;
}
const LINK_EN: Record<string, Link> = {
  because: 'cause',
  therefore: 'cause',
  thus: 'cause',
  hence: 'cause',
  consequently: 'cause',
  accordingly: 'cause',
  however: 'contrast',
  although: 'contrast',
  though: 'contrast',
  whereas: 'contrast',
  nevertheless: 'contrast',
  nonetheless: 'contrast',
  afterwards: 'time',
  afterward: 'time',
};
/** after "so", these start a clause ("so we moved"); anything else is "so poor", "so much" */
const SO_CLAUSE = new Set(
  (
    'i we he she they it you my our his her their your the a an this that these those there ' +
    'everyone everybody nobody people mother father mom dad mama papa grandma grandpa ' +
    'grandmother grandfather brother sister uncle aunt son daughter husband wife family when ' +
    'after in on at one two three then'
  ).split(' '),
);
const AUX_EN = new Set(
  'did do does was were is are am have has had can could would will'.split(' '),
);
/** "back then", "since then", "by then": a time, not "and then" */
const THEN_TIME = new Set('back since until till by even right just from only'.split(' '));
const LINK_KO_WORD: ReadonlyArray<readonly [RegExp, Link]> = [
  [
    /^(?:그래서|그러니까|그러니|그러므로|따라서|그래가지고|그래갖고|그래가지구|그러다보니|왜냐하면|왜냐면|때문)/,
    'cause',
  ],
  [/^(?:그러나|하지만|그렇지만|그런데|근데|그래도|반면)/, 'contrast'],
  [/^(?:그러자|그다음|그후|그뒤|이후|그러고나서|그러다가)/, 'time'],
];
const SEO_VOWELS = new Set([V_A, V_AE, V_EO, V_YEO, V_WA, V_WAE, V_WO]);
const linkCache = new WeakMap<Sent, LinkAt[]>();
function linksOf(s: Sent): LinkAt[] {
  const hit = linkCache.get(s);
  if (hit) return hit;
  const out: LinkAt[] = [];
  linkCache.set(s, out);
  const t = s.toks;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.w;
    const prev = t[i - 1]?.w ?? '';
    const next = t[i + 1]?.w ?? '';
    if (t[i]!.k === 'en') {
      let cls: Link | undefined = LINK_EN[w];
      if (w === 'so') {
        const alsoSense = AUX_EN.has(next) && !SO_CLAUSE.has(t[i + 2]?.w ?? 'x');
        if (next === 'that' || (SO_CLAUSE.has(next) && !alsoSense && prev !== 'or')) cls = 'cause';
      } else if (w === 'but') {
        if (!/^(?:nothing|all|anything|none)$/.test(prev)) cls = 'contrast';
      } else if (w === 'yet') {
        if (next !== '' && prev !== 'not' && (i === 0 || prev === 'and')) cls = 'contrast';
      } else if (w === 'then') {
        if (next !== '' && !THEN_TIME.has(prev)) cls = 'time';
      } else if (
        (w === 'after' || w === 'before') &&
        next === 'that' &&
        SO_CLAUSE.has(t[i + 2]?.w ?? '')
      ) {
        cls = 'time';
      } else if (w === 'since' && SO_CLAUSE.has(next) && next !== 'then') {
        // "since he drank": a cause or a time, like -아서 ("since 1950" is neither)
        cls = 'seo';
      } else if (w === 'as' && next === 'a' && t[i + 2]?.w === 'result') {
        cls = 'cause';
      } else if (
        w === 'why' &&
        /^(?:zzc|is|was)$/.test(prev) &&
        /^(?:that|which|this)$/.test(t[i - 2]?.w ?? '')
      ) {
        cls = 'cause';
      }
      if (cls) out.push({ cls, word: w });
    } else if (t[i]!.k === 'ko') {
      const joined =
        (w === '그' && /^(?:다음|후|뒤)/.test(next)) ||
        (w === '그래' && /^(?:갖고|가지고)/.test(next))
          ? `${w}${next}`
          : w;
      let cls: Link | undefined;
      for (const [re, c] of LINK_KO_WORD) if (re.test(joined)) cls = c;
      if (!cls && w.length >= 2) {
        // the ending of a clause that runs on: 돌아가셔서, 가니까, 가난했지만, 돌아가시자, 하고 나서
        const before = w[w.length - 2]!;
        if (w.endsWith('서') && isSyllable(before)) {
          const p = syl(before);
          if ((SEO_VOWELS.has(p.v) && p.t === 0) || before === '되') cls = 'seo';
          // 학교에 가서 공부했어요: going somewhere and doing something there is no cause
          // (but 비가 와서 is "because it rained", and 아버지가 돌아가셔서 "because he died")
          if (/(?:가서|와서|가셔서|오셔서)$/.test(w) && /(?:에|로|한테|에게|께|까지)$/.test(prev))
            cls = undefined;
        } else if (/(?:가지고|갖고)$/.test(w) && w.length >= 3) cls = 'seo';
        else if (/(?:니까|므로|느라고?|길래)$/.test(w) && w.length >= 3) cls = 'cause';
        else if (/지만$/.test(w) && w.length >= 3) cls = 'contrast';
        else if (/(?:는데도|은데도|ㄴ데도)$/.test(w)) cls = 'contrast';
        else if (/(?:자마자|시자|고서)$/.test(w)) cls = 'time';
        else if (w.endsWith('고') && /^나(?:서|니|면)/.test(next)) cls = 'time';
        else if (i < t.length - 1 && /(?:는데|은데|던데)$/.test(w)) cls = 'nde';
        else if (
          i < t.length - 1 &&
          w.endsWith('데') &&
          isSyllable(before) &&
          syl(before).t === T_N
        )
          cls = 'nde';
      }
      if (cls) out.push({ cls, word: w });
    }
  }
  return out;
}
/**
 * A link written in the body is one the speaker made there: the same kind of link, or the
 * same word as often ("So, yeah, we left" -> "So we left"). -아서 stands for a cause or
 * "then", -는데 for a contrast.
 */
function linksNotSaid(
  here: LinkAt[],
  there: LinkAt[],
  said: (w: string) => number,
  written: (w: string) => number,
): LinkAt[] {
  const has = new Set(there.map((l) => l.cls));
  return here.filter((l) => {
    if (l.cls === 'nde' || said(l.word) >= written(l.word)) return false;
    if (l.cls === 'seo') return !has.has('seo') && !has.has('cause') && !has.has('time');
    if (l.cls === 'contrast') return !has.has('contrast') && !has.has('nde');
    return !has.has(l.cls) && !has.has('seo');
  });
}

/**
 * What happened, in the order it was said. An event is a verb: in English a past form
 * (drank, moved, was born), in Korean a predicate (돌아가셨어요, 가서, 갔는데). "He drank and
 * she left" is not "She left and he drank"; only a sentence with "because", "when", "after",
 * 전에 ... may put its events in another order, and then the event "because" governs is kept
 * ("We moved because the mine closed" is not "The mine closed because we moved").
 */
interface EventAt {
  i: number;
  keys: readonly string[];
}
const PARTICIPLE_EN = new Set(
  'born gone done taken given known seen written broken stolen chosen driven eaten fallen forgotten frozen grown hidden ridden risen shaken spoken sworn torn worn woken beaten bitten'.split(
    ' ',
  ),
);
const SUBORD_EN = new Set(
  'because since after before when while until till once although though if unless whereas as'.split(
    ' ',
  ),
);
const KO_EVENT_END =
  /(?:고|며|면서|는데|은데|던데|지만|니까|으니|자마자|시자|다가|더니|어서|아서|여서|해서|셔서|가서|와서)$/;
const KO_NOT_EVENT = new Set([
  '사고',
  '광고',
  '창고',
  '최고',
  '보고',
  '신고',
  '경고',
  '참고',
  '재고',
  '원고',
  '그리고',
]);
/** a predicate's verb stems, remembered: a transcript says the same words again and again */
const verbStemMemo = new Map<string, readonly string[]>();
function verbStems(w: string): readonly string[] {
  let v = verbStemMemo.get(w);
  if (!v) {
    const st = koStems(w);
    v = st.verbs.size > 0 ? [...st.verbs] : [...st.all];
    if (verbStemMemo.size > 50_000) verbStemMemo.clear();
    verbStemMemo.set(w, v);
  }
  return v;
}
const eventCache = new WeakMap<Sent, EventAt[]>();
function eventsOf(s: Sent): EventAt[] {
  const hit = eventCache.get(s);
  if (hit) return hit;
  const out: EventAt[] = [];
  eventCache.set(s, out);
  const t = s.toks;
  let lastKo = -1;
  for (let i = 0; i < t.length; i++) if (t[i]!.k === 'ko') lastKo = i;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.w;
    if (t[i]!.k === 'en') {
      if (IRREGULAR_PAST.has(w) || PARTICIPLE_EN.has(w) || (w.length >= 5 && w.endsWith('ed')))
        out.push({ i, keys: enKeys(w) });
    } else if (t[i]!.k === 'ko' && w.length >= 2 && !FILLER.has(w) && !KO_NOT_EVENT.has(w)) {
      if (koPast(w) || KO_EVENT_END.test(w) || (i === lastKo && FINITE_KO.test(w)))
        out.push({ i, keys: verbStems(w) });
    }
  }
  return out;
}
const sameEvent = (a: EventAt, b: EventAt): boolean => a.keys.some((k) => b.keys.includes(k));
const hasSubord = (s: Sent): boolean =>
  s.toks.some(
    (t) =>
      (t.k === 'en' && SUBORD_EN.has(t.w)) ||
      (t.k === 'ko' && /^(?:전에|전엔|전까지|전에는)$/.test(t.w)),
  );
/** the first event after token i of s: what "because" (or "after") is about */
const governed = (s: Sent, i: number): EventAt | undefined => eventsOf(s).find((e) => e.i > i);
function orderBroken(here: Sent, span: Sent[]): boolean {
  const mine = eventsOf(here);
  if (mine.length === 0) return false;
  if (hasSubord(here) || span.some(hasSubord)) {
    // the order is free, what each "because" governs is not
    for (let i = 0; i < here.toks.length; i++) {
      const t = here.toks[i]!;
      if (t.k !== 'en' || !SUBORD_EN.has(t.w) || t.w === 'as') continue;
      const g = governed(here, i);
      if (!g) continue;
      const theirs: EventAt[] = [];
      for (const x of span)
        x.toks.forEach((u, k) => {
          if (u.k === 'en' && u.w === t.w) {
            const h = governed(x, k);
            if (h) theirs.push(h);
          }
        });
      if (theirs.length > 0 && !theirs.some((h) => sameEvent(g, h))) return true;
    }
    return false;
  }
  const said = span.flatMap((x) => eventsOf(x));
  let at = 0;
  for (const e of mine) {
    let j = -1;
    for (let k = at; k < said.length; k++)
      if (sameEvent(e, said[k]!)) {
        j = k;
        break;
      }
    if (j >= 0) {
      at = j + 1;
      continue;
    }
    for (let k = 0; k < at; k++) if (sameEvent(e, said[k]!)) return true;
  }
  return false;
}

/**
 * Where to and where from: "He moved to Boston" is not "He moved from Boston", 부산에서 왔어요
 * ("came from Busan") is not 부산으로 왔어요 ("came to Busan"). The same noun keeps a
 * preposition (or particle) of the same kind; 에 and 에서 are one place unless something moves.
 */
const DIR_EN: Record<string, string> = {
  to: 'to',
  into: 'to',
  onto: 'to',
  toward: 'to',
  towards: 'to',
  from: 'from',
  with: 'with',
  for: 'for',
  by: 'by',
  at: 'at',
  in: 'at',
  on: 'at',
};
const DIR_SKIP = new Set(
  'the a an my our his her their your its this that these those some every each all both old little big new zzs'.split(
    ' ',
  ),
);
const DIR_KO =
  /^(.+?)(에게서|한테서|으로부터|로부터|에서부터|에서|부터|에게|한테|께|에|으로|로|까지)(?:는|도|만)?$/;
const KO_RO_ADVERB = new Set(
  '서로 따로 새로 스스로 정말로 절대로 별로 주로 실제로 그대로 제대로 바로 도로 진짜로 실로 억지로 저절로 홀로 함부로 대로 그래도 아마도 하나도 조금도'.split(
    ' ',
  ),
);
/** what a Korean particle may mean: 에 is "to" or "at", 에서 "from" or "at" */
const KO_DIR_ROLE: Record<string, readonly string[]> = {
  에게서: ['from'],
  한테서: ['from'],
  으로부터: ['from'],
  로부터: ['from'],
  에서부터: ['from'],
  부터: ['from'],
  에서: ['from', 'at'],
  에게: ['to'],
  한테: ['to'],
  께: ['to'],
  에: ['to', 'at'],
  으로: ['to'],
  로: ['to'],
  까지: ['to'],
};
/** verbs of going somewhere: with one on both sides, 에 is "to" and 에서 is "from" */
const KO_MOTION_STEMS = new Set(
  '가 오 떠나 이사하 올라가 올라오 내려가 내려오 돌아가 돌아오 나가 나오 들어가 들어오 건너가 건너오 다니 옮기 데려가 데려오 찾아가 찾아오 도착하 출발하 피난가 피난하 넘어가 넘어오 들르'.split(
    ' ',
  ),
);
interface DirAt {
  obj: string;
  /** the preposition's kind, or the particle */
  part: string;
  ko: boolean;
  word: string;
}
const dirCache = new WeakMap<Sent, { moves: boolean; dirs: DirAt[] }>();
function dirsOf(s: Sent): { moves: boolean; dirs: DirAt[] } {
  const hit = dirCache.get(s);
  if (hit) return hit;
  const dirs: DirAt[] = [];
  let moves = false;
  const t = s.toks;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.w;
    if (t[i]!.k === 'en') {
      const role = DIR_EN[w];
      if (!role) continue;
      let k = i + 1;
      while (k < t.length && k <= i + 3 && DIR_SKIP.has(t[k]!.w)) k++;
      const o = t[k];
      if (o && o.k === 'en' && !DIR_EN[o.w])
        dirs.push({ obj: o.w, part: role, ko: false, word: w });
    } else if (t[i]!.k === 'ko') {
      if (!moves && verbStems(w).some((v) => KO_MOTION_STEMS.has(v))) moves = true;
      if (KO_RO_ADVERB.has(w)) continue;
      const m = DIR_KO.exec(w);
      if (m) dirs.push({ obj: m[1]!, part: m[2]!, ko: true, word: w });
    }
  }
  const out = { moves, dirs };
  dirCache.set(s, out);
  return out;
}
const rolesOf = (d: DirAt, moving: boolean): readonly string[] => {
  if (!d.ko) return [d.part];
  const r = KO_DIR_ROLE[d.part] ?? [];
  return moving && r.length > 1 ? [r[0]!] : r;
};
/** the body's words that point the other way from what was said there */
function dirsTurned(here: Sent, span: Sent[]): string[] {
  const mine = dirsOf(here);
  const theirs = span.map((x) => dirsOf(x));
  if (mine.dirs.length === 0 || theirs.every((x) => x.dirs.length === 0)) return [];
  const out: string[] = [];
  for (const d of mine.dirs) {
    let seen = false;
    let fits = false;
    for (const x of theirs)
      for (const e of x.dirs) {
        if (e.obj !== d.obj || e.ko !== d.ko) continue;
        seen = true;
        const moving = mine.moves && x.moves;
        const a = rolesOf(d, moving);
        const b = rolesOf(e, moving);
        if (a.some((r) => b.includes(r))) fits = true;
      }
    if (seen && !fits) out.push(d.word);
  }
  return out;
}

/**
 * "My mother IS still alive" is not "WAS still alive", and "She is my wife" is not "She was":
 * the tense of what was said is a fact about now. Read from the auxiliaries, the -ed form and
 * the common irregular pasts (never "hit", "put", "read": the same in both tenses).
 */
const PRESENT_AUX = new Set(['is', 'are', 'am', 'zzc', 'has', 'have', 'do', 'does']);
const PAST_AUX = new Set(['was', 'were', 'had', 'did']);
/** after these an -ed word is a state ("was tired", "got married"), not a past action */
const STATE_BEFORE = new Set([
  ...'is are am was were be been being zzc get gets got getting feel feels felt seem seems seemed look looks looked become became stay stayed a an the very so too'.split(
    ' ',
  ),
]);
const IRREGULAR_PAST = new Set(
  (
    'went came saw took gave got made said told knew thought found left felt became began brought bought built caught ' +
    'chose drank drove ate fell fought flew forgot froze grew heard held hid kept led lent lay lost meant met paid ran ' +
    'rang rode rose sang sank sat sent shook shot slept sold spent stood stole struck swam taught threw understood woke ' +
    'wore won wrote drew broke spoke stuck swore tore wept sought fed bled fled slid spun sprang dealt knelt lit'
  ).split(' '),
);
type Tense = 'pres' | 'past';
const tenseCache = new WeakMap<Sent, Set<Tense>>();
function tensesOf(s: Sent): Set<Tense> {
  const hit = tenseCache.get(s);
  if (hit) return hit;
  const out = new Set<Tense>();
  tenseCache.set(s, out);
  const t = s.toks;
  for (let i = 0; i < t.length; i++) {
    if (t[i]!.k !== 'en') continue;
    const w = t[i]!.w;
    const prev = t[i - 1]?.w ?? '';
    if (PRESENT_AUX.has(w)) {
      // "could have died", "would have been": a modal's perfect, not the present
      if (w === 'have' && MODAL_AUX.has(prev)) continue;
      out.add('pres');
    } else if (PAST_AUX.has(w) || IRREGULAR_PAST.has(w)) out.add('past');
    else if (w.length >= 5 && w.endsWith('ed') && !STATE_BEFORE.has(prev)) out.add('past');
  }
  return out;
}

/**
 * 'd is "would" or "had": make it the other side's "would" if there is one, else let it bind
 * nothing. Korean 래 is a quoted command (가래요) or a quoted statement (의사래요): make it
 * the other side's; a note's tenseless -ㅁ (차려주심) takes the other side's tense.
 */
function alignZzd(a: Set<string>, b: Set<string>): void {
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    if (x.has('modal:zzd') && !y.has('modal:zzd')) {
      x.delete('modal:zzd');
      if (y.has('modal:would')) x.add('modal:would');
    }
    if (x.has('ko:rae') && !y.has('ko:rae')) {
      x.delete('ko:rae');
      x.add(y.has('ko:cmd') && !y.has('ko:quote') ? 'ko:cmd' : 'ko:quote');
    }
    if (x.has('ko:open') && !y.has('ko:open')) {
      x.delete('ko:open');
      for (const t of ['ko:past', 'ko:pres']) if (y.has(t)) x.add(t);
    }
  }
}
const qualifiers = (sents: Sent[]): Set<string> => {
  const m = new Set<string>();
  for (const s of sents) for (const h of hedgesOf(s)) m.add(h);
  return m;
};
/** a name the model can act on when it is asked to try again */
const KO_MOOD_SHOWN: Record<string, string> = {
  'ko:past': 'past tense (했다)',
  'ko:pres': 'present tense (한다, 해요)',
  'ko:fut': 'future (할 거예요, 하겠다)',
  'ko:conj': 'a guess (한 것 같다, 했나 보다)',
  'ko:quote': 'hearsay or a quotation (했대요, 했다고 하다, 하더라)',
  'ko:cmd': 'a quoted request (하라고 하다, 하래요)',
  'ko:rae': 'hearsay (하래요)',
  'ko:must': 'had to (해야 했다)',
  'ko:may': 'was allowed to (해도 됐다)',
  'ko:give': 'did it for someone (해 주다, 해 드리다)',
  'ko:open': 'no tense',
};
const showQualifier = (h: string): string =>
  KO_MOOD_SHOWN[h] ??
  h
    .replace(/^(?:modal|cond|frame|freq|asp|deg):/, '')
    .replace('aspect:perfect', 'have done (the perfect)')
    .replace('aspect:prog', 'was doing (the progressive)')
    .replace('about+n', 'about/around (a number)');

/* ── 10. people ──────────────────────────────────────────────────────── */

type Gender = 'm' | 'f' | 'n';

/** class, gender, and every word for that one person. A prefix makes another person. */
const KIN_EN: ReadonlyArray<readonly [string, Gender, string]> = [
  ['mother', 'f', 'mother mothers mom moms mum mums mommy mummy mama momma mamma ma'],
  ['father', 'm', 'father fathers dad dads daddy papa pa dada'],
  [
    'grandmother',
    'f',
    'grandmother grandmothers grandma grandmas granny grannie nana gran grandmom nan grammy',
  ],
  [
    'grandfather',
    'm',
    'grandfather grandfathers grandpa grandpas granddad grandad gramps grampa granda',
  ],
  ['greatgrandmother', 'f', 'greatgrandmother greatgrandmothers greatgrandma'],
  ['greatgrandfather', 'm', 'greatgrandfather greatgrandfathers greatgrandpa'],
  ['stepmother', 'f', 'stepmother stepmothers stepmom stepmum'],
  ['stepfather', 'm', 'stepfather stepfathers stepdad'],
  ['godmother', 'f', 'godmother godmothers'],
  ['godfather', 'm', 'godfather godfathers'],
  ['fostermother', 'f', 'fostermother fostermom'],
  ['fosterfather', 'm', 'fosterfather fosterdad'],
  ['motherinlaw', 'f', 'motherinlaw mothersinlaw'],
  ['fatherinlaw', 'm', 'fatherinlaw fathersinlaw'],
  ['sisterinlaw', 'f', 'sisterinlaw sistersinlaw'],
  ['brotherinlaw', 'm', 'brotherinlaw brothersinlaw'],
  ['soninlaw', 'm', 'soninlaw sonsinlaw'],
  ['daughterinlaw', 'f', 'daughterinlaw daughtersinlaw'],
  ['parentinlaw', 'n', 'parentinlaw parentsinlaw'],
  ['sister', 'f', 'sister sisters sis'],
  ['brother', 'm', 'brother brothers bro'],
  ['halfsister', 'f', 'halfsister halfsisters'],
  ['halfbrother', 'm', 'halfbrother halfbrothers'],
  ['stepsister', 'f', 'stepsister stepsisters'],
  ['stepbrother', 'm', 'stepbrother stepbrothers'],
  ['aunt', 'f', 'aunt aunts auntie aunty aunties'],
  ['uncle', 'm', 'uncle uncles'],
  ['greataunt', 'f', 'greataunt greataunts'],
  ['greatuncle', 'm', 'greatuncle greatuncles'],
  ['son', 'm', 'son sons'],
  ['daughter', 'f', 'daughter daughters'],
  ['stepson', 'm', 'stepson stepsons'],
  ['stepdaughter', 'f', 'stepdaughter stepdaughters'],
  ['grandson', 'm', 'grandson grandsons'],
  ['granddaughter', 'f', 'granddaughter granddaughters'],
  ['grandchild', 'n', 'grandchild grandchildren grandkid grandkids'],
  ['wife', 'f', 'wife wives'],
  ['husband', 'm', 'husband husbands'],
  ['exhusband', 'm', 'exhusband'],
  ['exwife', 'f', 'exwife'],
  ['exboyfriend', 'm', 'exboyfriend'],
  ['exgirlfriend', 'f', 'exgirlfriend'],
  ['expartner', 'n', 'expartner'],
  ['latehusband', 'm', 'latehusband'],
  ['latewife', 'f', 'latewife'],
  ['latefather', 'm', 'latefather'],
  ['latemother', 'f', 'latemother'],
  ['latebrother', 'm', 'latebrother'],
  ['latesister', 'f', 'latesister'],
  ['lateson', 'm', 'lateson'],
  ['latedaughter', 'f', 'latedaughter'],
  ['firsthusband', 'm', 'firsthusband'],
  ['secondhusband', 'm', 'secondhusband'],
  ['thirdhusband', 'm', 'thirdhusband'],
  ['firstwife', 'f', 'firstwife'],
  ['secondwife', 'f', 'secondwife'],
  ['thirdwife', 'f', 'thirdwife'],
  ['widow', 'f', 'widow widows'],
  ['widower', 'm', 'widower widowers'],
  ['niece', 'f', 'niece nieces'],
  ['nephew', 'm', 'nephew nephews'],
  ['cousin', 'n', 'cousin cousins'],
  ['parent', 'n', 'parent parents'],
  ['sibling', 'n', 'sibling siblings'],
  ['fiance', 'n', 'fiance fiancee'],
  ['boyfriend', 'm', 'boyfriend boyfriends'],
  ['girlfriend', 'f', 'girlfriend girlfriends'],
  ['bride', 'f', 'bride brides'],
  ['groom', 'm', 'groom grooms bridegroom'],
];
/** Gendered nouns that are not relatives: never added or swapped, but a rewrite may leave one out. */
const GENERIC_EN: ReadonlyArray<readonly [string, Gender, string]> = [
  ['man', 'm', 'man men gentleman gentlemen'],
  ['woman', 'f', 'woman women'],
  ['boy', 'm', 'boy boys'],
  ['girl', 'f', 'girl girls'],
  ['lady', 'f', 'lady ladies'],
  ['mr', 'm', 'mr mister'],
  ['mrs', 'f', 'mrs'],
  ['ms', 'f', 'ms'],
  ['sir', 'm', 'sir'],
  ['madam', 'f', 'madam'],
];
const PRONOUN_GENDER: Record<string, Gender> = {
  he: 'm',
  him: 'm',
  his: 'm',
  himself: 'm',
  she: 'f',
  her: 'f',
  hers: 'f',
  herself: 'f',
};

const KIN_KO: ReadonlyArray<readonly [string, Gender, string]> = [
  ['어머니', 'f', '어머니 엄마 어머님 어무이 엄니 모친 어미 어멈'],
  ['아버지', 'm', '아버지 아빠 아부지 아버님 부친 애비 아비'],
  ['할머니', 'f', '할머니 할매 할머님 할무니 조모 친할머니'],
  ['할아버지', 'm', '할아버지 할배 할아버님 할아부지 조부 친할아버지'],
  ['외할머니', 'f', '외할머니 외조모 외할매'],
  ['외할아버지', 'm', '외할아버지 외조부 외할배'],
  ['큰아버지', 'm', '큰아버지 큰아버님 백부'],
  ['큰어머니', 'f', '큰어머니 큰어머님 백모 큰엄마'],
  ['작은아버지', 'm', '작은아버지 숙부 작은아빠'],
  ['작은어머니', 'f', '작은어머니 숙모 작은엄마'],
  ['고모', 'f', '고모'],
  ['고모부', 'm', '고모부'],
  ['이모', 'f', '이모'],
  ['이모부', 'm', '이모부'],
  ['삼촌', 'm', '삼촌'],
  ['외삼촌', 'm', '외삼촌'],
  ['외숙모', 'f', '외숙모'],
  ['시어머니', 'f', '시어머니 시어머님 시모'],
  ['시아버지', 'm', '시아버지 시아버님 시부'],
  ['장모', 'f', '장모 장모님'],
  ['장인', 'm', '장인어른'],
  ['새어머니', 'f', '새어머니 계모 새엄마'],
  ['새아버지', 'm', '새아버지 계부 새아빠'],
  ['형', 'm', '형 형님'],
  ['오빠', 'm', '오빠 오라버니'],
  ['누나', 'f', '누나 누님'],
  ['언니', 'f', '언니'],
  ['동생', 'n', '동생'],
  ['남동생', 'm', '남동생'],
  ['여동생', 'f', '여동생'],
  ['형제', 'n', '형제'],
  ['자매', 'f', '자매'],
  ['아들', 'm', '아들'],
  ['딸', 'f', '딸'],
  ['큰아들', 'm', '큰아들 장남'],
  ['큰딸', 'f', '큰딸 장녀'],
  ['막내아들', 'm', '막내아들'],
  ['막내딸', 'f', '막내딸'],
  ['막내', 'n', '막내'],
  ['큰애', 'n', '큰애'],
  ['남편', 'm', '남편 바깥양반 신랑'],
  ['전남편', 'm', '전남편'],
  ['전처', 'f', '전처 전부인 전와이프'],
  ['아내', 'f', '아내 집사람 안사람 마누라 와이프'],
  ['며느리', 'f', '며느리'],
  ['사위', 'm', '사위'],
  ['손자', 'm', '손자'],
  ['손녀', 'f', '손녀'],
  ['손주', 'n', '손주'],
  ['조카', 'n', '조카'],
  ['사촌', 'n', '사촌'],
  ['시동생', 'n', '시동생'],
  ['시누이', 'f', '시누이 시누'],
  ['올케', 'f', '올케'],
  ['형수', 'f', '형수'],
  ['매형', 'm', '매형'],
  ['매부', 'm', '매부'],
  ['처남', 'm', '처남'],
  ['처제', 'f', '처제'],
];
const GENERIC_KO: ReadonlyArray<readonly [string, Gender, string]> = [
  ['남자', 'm', '남자'],
  ['여자', 'f', '여자'],
];

interface Person {
  cls: string;
  g: Gender;
  kin: boolean;
}
const lexicon = (rows: ReadonlyArray<readonly [string, Gender, string]>, kin: boolean) => {
  const m = new Map<string, Person>();
  for (const [cls, g, words] of rows) for (const w of words.split(' ')) m.set(w, { cls, g, kin });
  return m;
};
const PEOPLE_EN = new Map([...lexicon(GENERIC_EN, false), ...lexicon(KIN_EN, true)]);
const PEOPLE_KO = new Map([...lexicon(GENERIC_KO, false), ...lexicon(KIN_KO, true)]);

/** What may follow a Korean noun for a person: particles, 님, 들, the copula. Longest first. */
const KO_NOUN_TAIL = [
  ...JOSA,
  '이었습니다',
  '였습니다',
  '이었어요',
  '였어요',
  '이었는데',
  '였는데',
  '이에요',
  '예요',
  '입니다',
  '이었다',
  '였다',
  '이었고',
  '였고',
  '이었지',
  '였지',
  '이지만',
  '이세요',
  '셨어요',
  '이다',
  '이야',
  '이고',
  '인데',
  '님',
  '들',
  '네',
  '야',
  '고',
  '씨',
  '셨다',
  '셨고',
  '셨는데',
  '이셨다',
  '이셨어요',
  '이셨고',
  '이십니다',
  '십니다',
  '이라서',
  '라서',
  '인지',
  '인가',
  '이었던',
  '였던',
  '이던',
  '던',
  '인',
  '이니까',
  '이면',
  '이라면',
  '라면',
  '이어서',
  '여서',
].sort((a, b) => b.length - a.length);

/**
 * Is `rest`, the rest of a Korean word after a noun, nothing but particles, 님/씨/네/들 and
 * the copula? 이모가, 김순자씨가, 어머니께서는, 아버지였다: yes. 이모부가 (the aunt's husband),
 * 아들딸, 손자며느리, 삼촌댁: no, the word goes on to name someone else.
 */
export function isNounTail(rest: string): boolean {
  if (rest === '') return true;
  if (rest.length > 12) return false;
  const reach = new Array<boolean>(rest.length + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < rest.length; i++) {
    if (!reach[i]) continue;
    for (const t of KO_NOUN_TAIL) if (rest.startsWith(t, i)) reach[i + t.length] = true;
  }
  return reach[rest.length]!;
}

function koPerson(w: string): Person | undefined {
  let base = w;
  for (let k = 0; k < 4; k++) {
    const hit = PEOPLE_KO.get(base);
    if (hit) return hit;
    const tail = KO_NOUN_TAIL.find((x) => base.length > x.length && base.endsWith(x));
    if (!tail) break;
    base = base.slice(0, -tail.length);
  }
  const hit = PEOPLE_KO.get(base);
  if (hit) return hit;
  // "우리어머니": the space left out
  const own = /^(?:우리|내|제|저희|나의)(.+)$/.exec(base);
  return own ? koPerson(own[1]!) : undefined;
}

function enPerson(w: string): Person | undefined {
  const direct = PEOPLE_EN.get(w);
  if (direct) return direct;
  for (const k of enKeys(w)) {
    const p = PEOPLE_EN.get(k);
    if (p) return p;
  }
  return undefined;
}

/**
 * Names said in the middle of an English sentence ("I lost two friends, Eddie Marks and a boy
 * from Ohio"), from the text AS WRITTEN, where capitals still exist. The first word of a
 * sentence is skipped: it is capitalised whatever it is. Folded like every other word.
 */
const NUMBER_WORD =
  /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)$/;

function namesIn(raw: string): string[] {
  const out = new Set<string>();
  const text = foldAccents(shownText(raw.normalize('NFC')).replace(/[’‘ʼ]/g, "'"));
  for (const line of text.split('\n')) {
    for (const sentence of line.split(SENT_BREAK)) {
      // Latin letters only: "Ralphs에서" is the name Ralphs and a Korean particle
      const words = [...sentence.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)*/g)];
      for (let i = 1; i < words.length; i++) {
        const w = words[i]![0];
        if (!/^[A-Z][a-z]/.test(w) || w === 'I') continue;
        const before = sentence.slice(0, words[i]!.index).trimEnd();
        // after "Mr." / a quotation mark / a colon a capital says nothing
        if (/(?:[.:"“]|\b(?:mr|mrs|ms|dr|st)\.?)$/i.test(before)) continue;
        const lw = w.toLowerCase().replace(/'s$/, '');
        // "World War Two", "Route Sixty-Six": a number word, which both sides write as digits
        if (NUMBER_WORD.test(lw)) continue;
        out.add(lw);
      }
    }
  }
  return [...out];
}

interface PeopleCount {
  cls: Map<string, number>;
  kin: Set<string>;
  noun: Record<Gender, number>;
  pron: Record<Gender, number>;
  /** for the report: a word of each class as it was written */
  shown: Map<string, string>;
  /** who is speaking and of whom: I, we, you, he, she, they (저, 우리, 너, 그, 그녀, 그들) */
  persons: Map<Who, { n: number; shown: string }>;
}

/**
 * The speaker is "I": "I was born in Busan" is not "He was born in Busan", 제 어머니 is not
 * 그의 어머니, 저는 is not 당신은. Counted in both languages; 그 is a person only with a
 * particle (그는, 그의), never in 그 사람, 그때.
 */
type Who =
  | 'i'
  | 'we'
  | 'you'
  | 'he'
  | 'she'
  | 'they'
  | 'ko-i'
  | 'ko-we'
  | 'ko-you'
  | 'ko-he'
  | 'ko-she'
  | 'ko-they';
const PERSON_EN: Record<string, Who> = {};
for (const [p, ws] of [
  ['i', 'i me my mine myself'],
  ['we', 'we us our ours ourselves'],
  ['you', 'you your yours yourself yourselves'],
  ['he', 'he him his himself'],
  ['she', 'she her hers herself'],
  ['they', 'they them their theirs themselves'],
] as const)
  for (const w of ws.split(' ')) PERSON_EN[w] = p;
const PARTICLE =
  '(?:는|은|가|이|도|를|을|의|에게|한테|께|만|랑|이랑|하고|와|과|보다|처럼|부터|까지|들|들은|들이|들을|들의|끼리)';
const PERSON_KO: ReadonlyArray<readonly [RegExp, Who]> = [
  [new RegExp(`^(?:저|나)${PARTICLE}$|^(?:제|제가|내|내가)$`), 'ko-i'],
  [new RegExp(`^(?:우리|저희)${PARTICLE}?$`), 'ko-we'],
  [new RegExp(`^(?:너|당신|자네)${PARTICLE}?$|^네가$`), 'ko-you'],
  [new RegExp(`^그녀${PARTICLE}?$`), 'ko-she'],
  [new RegExp(`^그들${PARTICLE}?$`), 'ko-they'],
  [new RegExp(`^그(?:는|가|를|의|에게|한테|도|와|랑)$|^그분${PARTICLE}?$`), 'ko-he'],
];
const FIRST_PERSON: readonly Who[] = ['i', 'we', 'ko-i', 'ko-we'];
const OTHER_PERSON: readonly Who[] = [
  'you',
  'he',
  'she',
  'they',
  'ko-you',
  'ko-he',
  'ko-she',
  'ko-they',
];
function personOf(t: readonly Tok[], i: number): Who | undefined {
  const w = t[i]!.w;
  if (t[i]!.k === 'en') {
    const p = PERSON_EN[w];
    // "you know", "you see", "thank you", "mind you": nobody is addressed
    if (
      p === 'you' &&
      (/^(?:know|see)$/.test(t[i + 1]?.w ?? '') || /^(?:thank|mind)$/.test(t[i - 1]?.w ?? ''))
    )
      return undefined;
    return p;
  }
  if (t[i]!.k !== 'ko') return undefined;
  for (const [re, p] of PERSON_KO) if (re.test(w)) return p;
  return undefined;
}

function peopleOf(sents: Sent[]): PeopleCount {
  const out: PeopleCount = {
    cls: new Map(),
    kin: new Set(),
    noun: { m: 0, f: 0, n: 0 },
    pron: { m: 0, f: 0, n: 0 },
    shown: new Map(),
    persons: new Map(),
  };
  for (const s of sents) {
    for (let i = 0; i < s.toks.length; i++) {
      const per = personOf(s.toks, i);
      if (per) {
        const had = out.persons.get(per);
        if (had) had.n++;
        else out.persons.set(per, { n: 1, shown: s.toks[i]!.w });
      }
    }
    for (const t of s.toks) {
      if (t.k === 'en') {
        const g = PRONOUN_GENDER[t.w];
        if (g) {
          out.pron[g]++;
          continue;
        }
      }
      const p = t.k === 'en' ? enPerson(t.w) : t.k === 'ko' ? koPerson(t.w) : undefined;
      if (!p) continue;
      out.cls.set(p.cls, (out.cls.get(p.cls) ?? 0) + 1);
      if (p.kin) out.kin.add(p.cls);
      out.noun[p.g]++;
      if (!out.shown.has(p.cls)) out.shown.set(p.cls, t.w);
    }
  }
  return out;
}

/* ── 11. one side of the comparison ──────────────────────────────────── */

interface Side {
  sents: Sent[];
  negs: NegEvent[];
  ev: Ev;
}

/**
 * Sentences, with fragments ("Yes.", "Mrs.", "Slowly.") joined to their neighbour in the same
 * turn: a fragment cannot place anything on its own, and a rewrite moves them freely.
 */
function sideOf(ctx: Ctx, raw: string): Side {
  const pieces = sentencesOf(normalise(raw)).map((p) => ({
    ...p,
    toks: flagged(ctx, wordsIn(p.text)),
  }));
  type Piece = { turn: number; text: string; toks: Tok[]; parts?: number[] };
  const merged: Piece[] = [];
  let carry: Piece | null = null;
  const weight = (toks: Tok[]) => toks.filter((t) => isSupportWord(t)).length;
  for (const p of pieces) {
    let cur: Piece = p;
    if (carry && carry.turn === p.turn) {
      const off = carry.text.length + 1;
      cur = {
        turn: p.turn,
        text: `${carry.text} ${p.text}`,
        toks: [...carry.toks, ...p.toks.map((t) => ({ ...t, s: t.s + off, e: t.e + off }))],
        parts: [...(carry.parts ?? [0]), carry.toks.length],
      };
    } else if (carry) {
      merged.push(carry);
    }
    carry = null;
    if (weight(cur.toks) < 2) carry = cur;
    else merged.push(cur);
  }
  if (carry) {
    const last = merged[merged.length - 1];
    if (last && last.turn === carry.turn) {
      const off = last.text.length + 1;
      last.text = `${last.text} ${carry.text}`;
      last.parts = [...(last.parts ?? [0]), last.toks.length];
      last.toks.push(...carry.toks.map((t) => ({ ...t, s: t.s + off, e: t.e + off })));
    } else merged.push(carry);
  }
  const sents: Sent[] = merged.map((m, sid) => ({ sid, ...m }));
  const negs = negationsOf(sents);
  return { sents, negs, ev: buildEv(ctx, sents, negs) };
}

/* ── 12. placing a sentence ──────────────────────────────────────────── */

const has = (lists: number[][], sid: number): boolean => {
  for (const a of lists) {
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = a[mid]!;
      if (v === sid) return true;
      if (v < sid) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  return false;
};

/**
 * The best window of `width` adjacent sentences of the other side for these words: how many of
 * them it holds, and where it starts. Reaching `need` is enough. Candidates come from the rarest
 * words only: a window that holds `need` of `n` words must hold one of the `n - need + 1`
 * rarest. Bounded by the shared budget; out of budget, the answer is "not placed".
 */
function place(
  ctx: Ctx,
  wheres: Where[],
  need: number,
  width: number,
  /** a place that holds the words must ALSO satisfy this (same tense, same "maybe"...) */
  fits?: (start: number) => boolean,
  /** no place before this sentence (what comes after what was already placed) */
  minStart = 0,
): { held: number; start: number; fits: boolean } {
  const total = wheres.length;
  let best = { held: 0, start: -1, fits: false };
  let first: { held: number; start: number } | null = null;
  const live = wheres
    .map((w, i) => ({ i, size: w.lists.reduce((n, a) => n + a.length, 0) }))
    .filter((x) => x.size > 0);
  if (live.length < need) return { held: live.length, start: -1, fits: false };
  live.sort((a, b) => a.size - b.size);
  const tried = new Set<number>();
  for (const seed of live.slice(0, Math.min(total, live.length) - need + 1)) {
    for (const a of wheres[seed.i]!.lists) {
      // the lists are in order: begin at the first place that may start at minStart
      let lo = 0;
      let hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid]! < minStart) lo = mid + 1;
        else hi = mid;
      }
      for (let x = lo; x < a.length; x++) {
        const sid = a[x]!;
        for (let start = sid - width + 1; start <= sid; start++) {
          if (start < minStart || tried.has(start)) continue;
          tried.add(start);
          ctx.budget -= total * width;
          if (ctx.budget < 0) return first ? { ...first, fits: false } : best;
          let held = 0;
          for (const w of wheres) {
            for (let k = 0; k < width; k++) {
              if (has(w.lists, start + k)) {
                held++;
                break;
              }
            }
          }
          if (held > best.held) best = { held, start, fits: false };
          if (held < need) continue;
          // the same words can stand in two places; it is enough that one of them fits
          if (!fits || fits(start)) return { held, start, fits: true };
          first ??= { held, start };
        }
      }
    }
  }
  return first ? { ...first, fits: false } : best;
}

/* ── 13. the report ──────────────────────────────────────────────────── */

export type ViolationKind =
  'negation' | 'hedge' | 'person' | 'number' | 'unsupported_sentence' | 'dropped' | 'invented';

export interface Violation {
  kind: ViolationKind;
  /** what exactly, in plain words, for the model's retry and for logs */
  detail: string;
}

export interface GroundingReport {
  /** Body words that nothing the person said supports. Empty = every word is theirs. */
  readonly ungrounded: string[];
  /** Body words that matched only through a household-word swap (엄마 → 어머니). */
  readonly swapped: string[];
  /** Fraction of the person's content words that survived into the body (a LOSS measure). */
  readonly retention: number;
  /** The person's content words the body dropped. */
  readonly lost: string[];
  /** Everything that is wrong, by kind. Empty = the body may be used. */
  readonly violations: Violation[];
}

const SHORT = 110;
const clip = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > SHORT ? `${t.slice(0, SHORT - 1)}…` : t;
};
const listOf = (ws: string[], n = 8): string =>
  ws.length <= n ? ws.join(', ') : `${ws.slice(0, n).join(', ')} …`;
/** A few sentences, quoted; never a whole transcript in one message. */
const quoted = (ss: string[], n = 4): string =>
  ss.length <= n
    ? ss.map((u) => `"${u}"`).join(' ')
    : `${ss
        .slice(0, n)
        .map((u) => `"${u}"`)
        .join(' ')} … and ${ss.length - n} more`;

/** Each turn keeps this much of its content; a sentence this much (within a few sentences). */
/**
 * What a tidy-up may clear from speech. Fillers may all go ("well", "yeah", 막, 그냥; "you
 * know" and "I mean" are read as asides). Intensifiers ("just", "even", "really", 너무, 아주)
 * may go one in ten, as before: "I just got married" is not "I got married". Any other word
 * the person said ("secretly", "instead", "sometimes", 계속) is kept, and one is enough to
 * refuse: the real outputs keep every one.
 */
const FILLER_FREE = new Set(
  (
    'like well so oh yeah yep yes okay ok anyway anyways gosh boy whatever ' +
    '참 막 좀 그냥 이제 인제 뭐 저기 있잖아 말이야 그러니까 근데 그런데 그리고 그러고 그래서 ' +
    '아무튼 하여튼 어쨌든 사실 솔직히 물론'
  ).split(' '),
);
const INTENSIFIER = new Set(
  (
    'just even really very actually basically literally honestly totally pretty quite real ' +
    'certainly definitely obviously surely truly simply completely entirely fully absolutely ' +
    'seriously frankly now right ' +
    '너무 아주 진짜 정말 되게 엄청 완전 무척 매우 몹시 굉장히 상당히 꽤 제법 또 이렇게 그렇게 ' +
    '저렇게 한번'
  ).split(' '),
);
const TURN_KEEP = 0.9;
const SENTENCE_KEEP = 0.6;
const SENTENCE_SUPPORT = 0.9;

type Mode = 'body' | 'title';

function analyse(rawSource: string, rawClaim: string, mode: Mode): GroundingReport {
  const ctx = newCtx();
  const src = sideOf(ctx, rawSource);
  const cl = sideOf(ctx, rawClaim);
  const violations: Violation[] = [];

  /* 1. every word of the body */
  const unsaid = new Set<string>();
  const unsaidNumbers = new Set<string>();
  const swaps = new Set<string>();
  const support = new Map<Sent, Where[]>();
  for (const s of cl.sents) {
    // each word once per sentence: "he said, he said" places nothing twice
    const ws = new Map<string, Where>();
    s.toks.forEach((t, i) => {
      const w = whereOf(ctx, s.toks, i, src.ev);
      if (w.support === null) (t.k === 'num' ? unsaidNumbers : unsaid).add(t.w);
      else if (w.support === 'variant') swaps.add(t.w);
      if (isSupportWord(t) && (!ws.has(t.w) || ws.get(t.w)!.support === null)) ws.set(t.w, w);
    });
    support.set(s, [...ws.values()]);
  }
  // a word supported in one place is not "unsaid" because a neighbour differed in another
  const ungrounded = [...unsaid];
  const numbers = [...unsaidNumbers];
  const swapped = [...swaps];
  // a word said in one tense and written in the other: "he works" -> "he worked"
  const flips = new Set<string>();
  for (const s of cl.sents) {
    s.toks.forEach((t, i) => {
      if (t.k !== 'en' || src.ev.forms.get(t.w)?.has(t.w)) return;
      const past =
        t.w.length >= 5 && t.w.endsWith('ed') && !STATE_BEFORE.has(s.toks[i - 1]?.w ?? '');
      const present = t.w.length >= 4 && t.w.endsWith('s') && !t.w.endsWith('ss');
      if (!past && !present) return;
      const said = enKeys(t.w).flatMap((k) => [...(src.ev.forms.get(k) ?? [])]);
      if (said.length === 0 || said.some((f) => f.endsWith('ing'))) return;
      const saidPast = said.some((f) => f.endsWith('ed'));
      const saidOther = said.some((f) => !f.endsWith('ed'));
      if ((past && !saidPast && saidOther) || (present && saidPast && !saidOther)) flips.add(t.w);
    });
  }
  if (flips.size > 0)
    violations.push({ kind: 'hedge', detail: `the tense changed: ${listOf([...flips])}` });
  if (ungrounded.length > 0)
    violations.push({
      kind: 'invented',
      detail: `words that were not said: ${listOf(ungrounded)}`,
    });
  if (numbers.length > 0)
    violations.push({ kind: 'number', detail: `numbers that were not said: ${listOf(numbers)}` });

  /* 1b. numbers are facts: none said more often than the speaker said it ("she was three" ->
     "she was four" when "four brothers" is elsewhere), and, in a body, none of theirs left out */
  const tally = (sents: Sent[]) => {
    const m = new Map<string, number>();
    for (const s of sents)
      for (const t of s.toks) if (/\d/.test(t.w)) m.set(t.w, (m.get(t.w) ?? 0) + 1);
    return m;
  };
  const na = tally(src.sents);
  const nb = tally(cl.sents);
  const extra = [...nb].filter(([n, c]) => (na.get(n) ?? 0) > 0 && c > na.get(n)!).map(([n]) => n);
  if (extra.length > 0)
    violations.push({
      kind: 'number',
      detail: `numbers written more often than they were said: ${listOf(extra)}`,
    });
  if (mode === 'body') {
    const missing = [...na.keys()].filter((n) => !nb.has(n));
    if (missing.length > 0)
      violations.push({
        kind: 'dropped',
        detail: `numbers the speaker said are missing: ${listOf(missing)}`,
      });
    // a name said in the middle of a sentence ("Eddie Marks", "Mrs. Han") is a fact too
    const said = new Set(
      cl.sents.flatMap((s) => s.toks.flatMap((t) => (t.k === 'en' ? enKeys(t.w) : [t.w]))),
    );
    const names = namesIn(rawSource).filter((n) => !enKeys(n).some((k) => said.has(k)));
    if (names.length > 0)
      violations.push({
        kind: 'dropped',
        detail: `names the speaker said are missing: ${listOf(names)}`,
      });
  }

  /* 2. people */
  const pa = peopleOf(src.sents);
  const pb = peopleOf(cl.sents);
  const added: string[] = [];
  const more: string[] = [];
  for (const [c, n] of pb.cls) {
    const had = pa.cls.get(c) ?? 0;
    if (n > had) (had === 0 ? added : more).push(pb.shown.get(c) ?? c);
  }
  if (added.length > 0)
    violations.push({
      kind: 'person',
      detail: `a person the speaker did not name: ${listOf(added)}`,
    });
  // "She kept the books" -> "My mother kept the books": who "she" was is a guess
  if (more.length > 0)
    violations.push({
      kind: 'person',
      detail: `named more often than the speaker named them (a "he" or "she" made into a name?): ${listOf(more)}`,
    });
  if (mode === 'body') {
    const dropped = [...pa.kin]
      .filter((c) => (pb.cls.get(c) ?? 0) === 0)
      .map((c) => pa.shown.get(c) ?? c);
    if (dropped.length > 0)
      violations.push({
        kind: 'person',
        detail: `a relative the speaker named is missing: ${listOf(dropped)}`,
      });
  }
  // the speaker made into someone else ("I was born in Busan" -> "He was born in Busan", 제
  // 어머니 -> 그의 어머니): fewer "I" and "my", and a "he", "she", "they" (그, 그녀) more than
  // the mentions of a person it may stand for that went ("My mother left. My mother cried."
  // -> "My mother left. She cried." is a pronoun, not a new person); "you" (너, 당신) never
  const firstOf = (p: PeopleCount) =>
    FIRST_PERSON.reduce((n, c) => n + (p.persons.get(c)?.n ?? 0), 0);
  const fewerI = firstOf(pb) < firstOf(pa);
  const named = new Set(namesIn(rawSource));
  const nameCount = (side: Side) => {
    let n = 0;
    for (const x of side.sents) for (const t of x.toks) if (t.k === 'en' && named.has(t.w)) n++;
    return n;
  };
  const namesGone = Math.max(0, nameCount(src) - nameCount(cl));
  const gone = (g: Gender) => Math.max(0, pa.noun[g] - pb.noun[g]);
  const stands: Record<Who, number> = {
    i: 0,
    we: 0,
    'ko-i': 0,
    'ko-we': 0,
    you: 0,
    'ko-you': 0,
    he: gone('m') + namesGone,
    she: gone('f') + namesGone,
    they: gone('m') + gone('f') + gone('n') + namesGone,
    'ko-he': gone('m') + gone('f') + gone('n'),
    'ko-she': gone('f'),
    'ko-they': gone('m') + gone('f') + gone('n'),
  };
  const others: string[] = [];
  for (const c of OTHER_PERSON) {
    const a = pa.persons.get(c)?.n ?? 0;
    const b = pb.persons.get(c);
    if (!b || b.n <= a) continue;
    const addressed = c === 'you' || c === 'ko-you';
    const korean = c === 'ko-he' || c === 'ko-she' || c === 'ko-they';
    if (
      (addressed && (a === 0 || fewerI)) ||
      (fewerI && b.n - a > stands[c]) ||
      (korean && a === 0 && pb.noun.m + pb.noun.f + pb.noun.n === 0)
    )
      others.push(b.shown);
  }
  if (others.length > 0)
    violations.push({
      kind: 'person',
      detail: `the speaker, or someone they named, made into ${listOf(others)}`,
    });
  const dm = pa.pron.m - pb.pron.m;
  const df = pa.pron.f - pb.pron.f;
  if ((dm < 0 && df > 0) || (df < 0 && dm > 0)) {
    violations.push({
      kind: 'person',
      detail: dm < 0 ? '"she/her" became "he/his"' : '"he/his" became "she/her"',
    });
  } else {
    if (dm < 0 && pb.noun.m === 0)
      violations.push({
        kind: 'person',
        detail: '"he/him/his" for someone the speaker did not name',
      });
    if (df < 0 && pb.noun.f === 0)
      violations.push({ kind: 'person', detail: '"she/her" for someone the speaker did not name' });
  }

  /* 3. negation: every one kept, about the same word, none added */
  const pool = new Map<string, NegEvent[]>();
  for (const o of src.negs) {
    const list = pool.get(o.cls);
    if (list) list.push(o);
    else pool.set(o.cls, [o]);
  }
  const sameCache = new Map<string, boolean>();
  const same = (a: Tok, b: Tok): boolean => {
    const key = `${a.k}\u0000${a.w}\u0000${b.w}`;
    let v = sameCache.get(key);
    if (v === undefined) {
      v = sameWord(ctx, a, b);
      sameCache.set(key, v);
    }
    return v;
  };
  // the same head word first (an index), then the same word in another form (a bounded scan:
  // a text of ten thousand "not"s is not an interview)
  const used = new Set<NegEvent>();
  const byHead = new Map<string, NegEvent[]>();
  for (const o of src.negs) {
    const key = `${o.cls}\u0000${o.head?.w ?? ''}`;
    const list = byHead.get(key);
    if (list) list.push(o);
    else byHead.set(key, [o]);
  }
  const take = (list: NegEvent[] | undefined): NegEvent | null => {
    while (list && list.length > 0) {
      const o = list.pop()!;
      if (!used.has(o)) return o;
    }
    return null;
  };
  const negAdded: string[] = [];
  for (const n of cl.negs) {
    let m = take(byHead.get(`${n.cls}\u0000${n.head?.w ?? ''}`));
    if (!m) {
      const list = pool.get(n.cls) ?? [];
      let scanned = 0;
      for (const o of list) {
        if (used.has(o)) continue;
        if (++scanned > 64) break;
        if (o.head === null || n.head === null || same(n.head, o.head)) {
          m = o;
          break;
        }
      }
    }
    if (m) used.add(m);
    else negAdded.push(n.shown);
  }
  const negMissing = src.negs.filter((o) => !used.has(o));
  if (negAdded.length > 0)
    violations.push({
      kind: 'negation',
      detail: `a negation the speaker did not say: ${listOf(negAdded)}`,
    });
  if (mode === 'body' && negMissing.length > 0)
    violations.push({
      kind: 'negation',
      detail: `a negation the speaker said is missing: ${listOf(negMissing.map((n) => n.shown))}`,
    });

  /* 4. hedges, wishes and modals ("maybe", "I think", "could have", 아마, 싶): the same ones
   *    (the ones gone missing are counted after step 6: a sentence left out whole is said once) */
  if (mode === 'body') {
    const qa = qualifiers(src.sents);
    const qb = qualifiers(cl.sents);
    alignZzd(qa, qb);
    const addH = [...qb].filter((h) => !qa.has(h));
    if (addH.length > 0)
      violations.push({
        kind: 'hedge',
        detail: `"${addH.map(showQualifier).join('", "')}" was not said`,
      });
  }

  /* 5. every sentence of the body from ONE place in what was said */
  const unplaced: string[] = [];
  // negations per sentence, counted once: a per-sentence scan of all of them was quadratic
  const negsIn = (negs: NegEvent[]) => {
    const m = new Map<number, number>();
    for (const n of negs) m.set(n.sid, (m.get(n.sid) ?? 0) + 1);
    return m;
  };
  const srcNegs = negsIn(src.negs);
  const clNegs = negsIn(cl.negs);
  // one violation per kind, however many sentences: never a message per sentence of a transcript
  const negMoved: string[] = [];
  const qualMoved: string[] = [];
  const tenseChanged: string[] = [];
  const pronounMismatch: string[] = [];
  const linkAdded: string[] = [];
  const outOfOrder: string[] = [];
  const dirTurned: string[] = [];
  let upTo = 0;
  const firstHolding = (ws: Where[], start: number, width: number): number => {
    for (let k = start; k < start + width; k++) if (ws.some((w) => has(w.lists, k))) return k;
    return -1;
  };
  for (const s of cl.sents) {
    const ws = support.get(s)!;
    if (ws.length < 2) continue;
    const need = mode === 'title' ? ws.length : Math.ceil(SENTENCE_SUPPORT * ws.length);
    const { held, start } = place(ctx, ws, need, 2);
    if (held < need) {
      unplaced.push(clip(s.text));
      continue;
    }
    // what it says about not, maybe, the tense and he/she must be said in that place too:
    // the one sentence it comes from when one is enough, else two; any such place will do
    if (start >= 0) {
      const problems = (span: Sent[]) => {
        const out: {
          neg?: true;
          qual?: string[];
          tense?: true;
          pron?: true;
          link?: LinkAt[];
          order?: true;
          dir?: string[];
        } = {};
        if (mode === 'body') {
          if (orderBroken(s, span)) out.order = true;
          const turned = dirsTurned(s, span);
          if (turned.length > 0) out.dir = turned;
        }
        const linked = linksNotSaid(
          linksOf(s),
          span.flatMap((x) => linksOf(x)),
          (w) => span.reduce((n, x) => n + x.toks.filter((t) => t.w === w).length, 0),
          (w) => s.toks.filter((t) => t.w === w).length,
        );
        if (linked.length > 0) out.link = linked;
        if (mode === 'body') {
          const negHere = clNegs.get(s.sid) ?? 0;
          const negThere = span.reduce((n, x) => n + (srcNegs.get(x.sid) ?? 0), 0);
          if (negHere > negThere) out.neg = true;
          const qHere = qualifiers([s]);
          const qThere = qualifiers(span);
          alignZzd(qHere, qThere);
          const moved = [...qHere].filter((h) => !qThere.has(h));
          if (moved.length > 0) out.qual = moved;
          const tHere = tensesOf(s);
          const tThere = new Set(span.flatMap((x) => [...tensesOf(x)]));
          if (
            (tHere.has('past') && !tThere.has('past') && tThere.has('pres')) ||
            (tHere.has('pres') && !tThere.has('pres') && tThere.has('past'))
          )
            out.tense = true;
        }
        const here = peopleOf([s]);
        const there = peopleOf(span);
        const swapIn =
          (here.pron.m > there.pron.m && here.pron.f < there.pron.f) ||
          (here.pron.f > there.pron.f && here.pron.m < there.pron.m);
        const nobody =
          (here.pron.m > there.pron.m && there.pron.m + there.noun.m === 0) ||
          (here.pron.f > there.pron.f && there.pron.f + there.noun.f === 0);
        if (swapIn || nobody) out.pron = true;
        return out;
      };
      const clean = (p: ReturnType<typeof problems>) =>
        !p.neg && !p.qual && !p.tense && !p.pron && !p.link && !p.order && !p.dir;
      const one = place(ctx, ws, need, 1, (st) => clean(problems(src.sents.slice(st, st + 1))));
      const two = one.fits
        ? one
        : place(ctx, ws, need, 2, (st) => clean(problems(src.sents.slice(st, st + 2))));
      if (!two.fits) {
        const span =
          one.held >= need && one.start >= 0
            ? src.sents.slice(one.start, one.start + 1)
            : src.sents.slice(start, start + 2);
        const p = problems(span);
        if (p.neg) negMoved.push(clip(s.text));
        if (p.qual) qualMoved.push(`${p.qual.map(showQualifier).join(', ')}: ${clip(s.text)}`);
        if (p.tense) tenseChanged.push(clip(s.text));
        if (p.pron) pronounMismatch.push(clip(s.text));
        // (said as sentences that were not said so, never as "words that were not said": the
        // words are the speaker's, and `ungrounded` is what other callers read)
        if (p.link) linkAdded.push(`${p.link.map((l) => l.word).join(', ')}: ${clip(s.text)}`);
        if (p.order) outOfOrder.push(clip(s.text));
        if (p.dir) dirTurned.push(`${p.dir.join(', ')}: ${clip(s.text)}`);
      }
      // and after what came before it: "My father died. We moved." is not "We moved. My father
      // died." (a place before the last one is taken only when no place after it holds the words)
      if (mode === 'body') {
        const win = one.fits
          ? { start: one.start, width: 1 }
          : two.fits
            ? { start: two.start, width: 2 }
            : one.held >= need && one.start >= 0
              ? { start: one.start, width: 1 }
              : { start, width: 2 };
        let lo = firstHolding(ws, win.start, win.width);
        if (lo >= 0 && lo < upTo) {
          const again = place(
            ctx,
            ws,
            need,
            2,
            (st) => clean(problems(src.sents.slice(st, st + 2))),
            upTo,
          );
          const lo2 =
            again.held >= need && again.start >= 0 ? firstHolding(ws, again.start, 2) : -1;
          if (lo2 >= upTo) lo = lo2;
          else outOfOrder.push(clip(s.text));
        }
        if (lo >= 0) upTo = Math.max(upTo, lo);
      }
    }
  }
  if (negMoved.length > 0)
    violations.push({ kind: 'negation', detail: `a negation moved into: ${quoted(negMoved)}` });
  if (qualMoved.length > 0)
    violations.push({ kind: 'hedge', detail: `moved into another sentence: ${quoted(qualMoved)}` });
  if (tenseChanged.length > 0)
    violations.push({ kind: 'hedge', detail: `the tense changed in: ${quoted(tenseChanged)}` });
  if (pronounMismatch.length > 0)
    violations.push({
      kind: 'person',
      detail: `"he" and "she" do not match what was said in: ${quoted(pronounMismatch)}`,
    });
  if (linkAdded.length > 0)
    violations.push({
      kind: 'unsupported_sentence',
      detail: `a cause, a contrast or an order the speaker did not say: ${quoted(linkAdded)}`,
    });
  if (dirTurned.length > 0)
    violations.push({
      kind: 'unsupported_sentence',
      detail: `where to and where from changed in: ${quoted(dirTurned)}`,
    });
  if (outOfOrder.length > 0)
    violations.push({
      kind: 'unsupported_sentence',
      detail: `not in the order it was said: ${quoted([...new Set(outOfOrder)])}`,
    });
  // 5c. a sentence said once is written once ("My father hit me." twice is two beatings)
  if (mode === 'body') {
    const key = (x: Sent) => x.toks.map((t) => t.w).join(' ');
    const said = new Map<string, number>();
    for (const x of src.sents) said.set(key(x), (said.get(key(x)) ?? 0) + 1);
    const written = new Map<string, number>();
    const twice: string[] = [];
    for (const x of cl.sents) {
      if ((support.get(x)?.length ?? 0) < 2) continue;
      const k = key(x);
      const n = (written.get(k) ?? 0) + 1;
      written.set(k, n);
      if (n > Math.max(1, said.get(k) ?? 0)) twice.push(clip(x.text));
    }
    if (twice.length > 0)
      violations.push({
        kind: 'unsupported_sentence',
        detail: `said once, written twice: ${quoted(twice)}`,
      });
  }
  if (unplaced.length > 0)
    violations.push({
      kind: 'unsupported_sentence',
      detail: `not said in any one place: ${quoted(unplaced)}`,
    });

  /* 6. what was said is kept: each turn, and each sentence */
  const allWords = new Set<string>();
  const allFound = new Set<string>();
  if (mode === 'body') {
    const turns = new Map<number, { total: Set<string>; found: Set<string> }>();
    const short: string[] = [];
    const leftOut = new Set<Sent>();
    const qualGone: string[] = [];
    for (const s of src.sents) {
      const byWord = new Map<string, Where>();
      const turn = turns.get(s.turn) ?? { total: new Set<string>(), found: new Set<string>() };
      turns.set(s.turn, turn);
      s.toks.forEach((t, i) => {
        if (!isRetainWord(t) || asideAt(s.toks, i)) return;
        const w = whereOf(ctx, s.toks, i, cl.ev);
        turn.total.add(t.w);
        allWords.add(t.w);
        if (w.support !== null) {
          turn.found.add(t.w);
          allFound.add(t.w);
        }
        if (!byWord.has(t.w) || byWord.get(t.w)!.support === null) byWord.set(t.w, w);
      });
      const words = [...byWord.values()];
      // "He died." is one word, and it is kept like any other sentence
      if (words.length === 0) continue;
      const need = Math.ceil(SENTENCE_KEEP * words.length);
      const width = Math.max(2, Math.ceil(words.length / 6));
      // its "maybe", "could have", 갈 거예요 are still there, where it was said (in any place
      // that holds its words: the same words can stand in two places)
      const qHere = qualifiers([s]);
      // one sentence of slack each side: a long sentence a rewrite split in three still counts
      const missingAt = (st: number) => {
        const qThere = qualifiers(cl.sents.slice(Math.max(0, st - 1), st + width + 1));
        const q = new Set(qHere);
        alignZzd(q, qThere);
        return [...q].filter((h) => !qThere.has(h));
      };
      const at = place(
        ctx,
        words,
        need,
        width,
        qHere.size > 0 ? (st) => missingAt(st).length === 0 : undefined,
      );
      if (at.held < need) {
        short.push(clip(s.text));
        leftOut.add(s);
        continue;
      }
      // a fragment joined to its neighbour ("He died. My mother sold fish.") is still said:
      // one of its words stands where the sentence was placed
      if (s.parts && at.start >= 0) {
        const near = (w: Where) => {
          for (let k = Math.max(0, at.start - 1); k < at.start + width + 1; k++)
            if (has(w.lists, k)) return true;
          return false;
        };
        for (let p = 0; p < s.parts.length; p++) {
          const from = s.parts[p]!;
          const to = s.parts[p + 1] ?? s.toks.length;
          const own: Where[] = [];
          for (let k = from; k < to; k++) {
            const w = byWord.get(s.toks[k]!.w);
            if (w && isRetainWord(s.toks[k]!) && !asideAt(s.toks, k)) own.push(w);
          }
          if (own.length === 0 || own.some(near)) continue;
          const a = s.toks[from]!;
          const b = s.toks[to - 1]!;
          short.push(clip(s.text.slice(a.s, b.e)));
        }
      }
      if (!at.fits && at.start >= 0) {
        const gone = missingAt(at.start);
        if (gone.length > 0)
          qualGone.push(`${gone.map(showQualifier).join(', ')}: ${clip(s.text)}`);
      }
    }
    if (short.length > 0)
      violations.push({ kind: 'dropped', detail: `left out: ${quoted(short)}` });
    // step 4's missing ones; a sentence left out whole has its tense and mood said once, by
    // "left out" (its 아마 or "maybe" is still named)
    const qa = qualifiers(src.sents);
    const qb = qualifiers(cl.sents);
    alignZzd(qa, qb);
    const kept = qualifiers(src.sents.filter((s) => !leftOut.has(s)));
    alignZzd(kept, qualifiers(cl.sents));
    const lostH = [...qa].filter((h) => !qb.has(h) && (!h.startsWith('ko:') || kept.has(h)));
    if (lostH.length > 0)
      violations.push({
        kind: 'hedge',
        detail: `the speaker's "${lostH.map(showQualifier).join('", "')}" is missing`,
      });
    if (qualGone.length > 0)
      violations.push({ kind: 'hedge', detail: `missing where it was said: ${quoted(qualGone)}` });
    for (const [turn, { total, found }] of turns) {
      if (total.size === 0) continue;
      const gone = [...total].filter((w) => !found.has(w));
      const vital = gone.filter((w) => !FILLER_FREE.has(w) && !INTENSIFIER.has(w));
      // intensifiers, one in ten of the words that are not fillers
      let size = 0;
      for (const w of total) if (!FILLER_FREE.has(w)) size++;
      const toned = gone.filter((w) => INTENSIFIER.has(w));
      const keptShare = size === 0 ? 1 : (size - toned.length) / size;
      if (vital.length > 0) {
        violations.push({
          kind: 'dropped',
          detail: `turn ${turn + 1} lost words the speaker said: ${listOf(vital)}`,
        });
      } else if (size <= 2 ? toned.length > 0 : keptShare < TURN_KEEP) {
        violations.push({
          kind: 'dropped',
          detail: `turn ${turn + 1} lost too much (${Math.round(keptShare * 100)}% kept): ${listOf(toned)}`,
        });
      }
    }
  }
  const lost = [...allWords].filter((w) => !allFound.has(w));

  return {
    ungrounded: [...ungrounded, ...numbers],
    swapped,
    retention: allWords.size === 0 ? 1 : allFound.size / allWords.size,
    lost,
    violations,
  };
}

/**
 * The whole check, in one call. Pure, synchronous, no I/O, linear in the length of the text.
 *
 * `source` is what the person said or typed (one line per turn). `claim` is what the model
 * wrote. Order is not symmetric and never should be: a draft must be provable from their
 * words, and their words owe a draft nothing except that none of them is lost.
 */
export function checkGrounding(rawSource: string, rawClaim: string): GroundingReport {
  return analyse(rawSource, rawClaim, 'body');
}

/**
 * The check for a TITLE: a label, not the record, so it may leave things out; but every word,
 * number and person in it is one the speaker said, it adds no negation, and it comes from one
 * place in what they said (no "Born in Seoul in 1950" stitched from two answers).
 */
export function checkTitle(
  rawSource: string,
  rawTitle: string,
): { ungrounded: string[]; violations: Violation[] } {
  const r = analyse(rawSource, rawTitle, 'title');
  return { ungrounded: r.ungrounded, violations: r.violations };
}
