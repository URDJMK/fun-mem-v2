import type { EvidenceBlock } from './types';
import type { ValidationResult } from './validate';

/**
 * FM-026 unit 5 — abstention. DoD 2.
 *
 * The forbidden shortcut is "abstain only on empty retrieval". Empty retrieval
 * is the trivial instance of gate B, never the definition.
 *
 * Nor can the gate be a threshold on the fused score, and this is arithmetic
 * rather than taste: RRF gives `score = Σ WEIGHTS[leg]/(60+rank)`, so a vector
 * hit at rank 1 contributes 1/61 whether its true cosine is 0.95 or 0.15 —
 * indistinguishable from a title-substring hit at rank 1. The raw per-leg
 * cosine never leaves the SQL. Any number compared against `score` is therefore
 * a magic constant that means nothing, which is why the hardening PRD froze
 * abstention on LEG COMPOSITION instead.
 */

/**
 * Legs that indicate the chunk's CONTENT matched. A title hit means a note is
 * named after the query; a date hit means it happened around then. Both are
 * legitimate search results and neither is evidence of a fact.
 */
const CONTENT_LEGS = new Set(['ts', 'pgroonga', 'vector']);

/** Below this share of relevant evidence fitting the window, the answer would be built on a fragment. */
const MIN_FIT_RATIO = 0.5;

/**
 * The content-bearing terms of a question, with interrogatives and Korean
 * particles stripped from the tail.
 *
 * Korean is agglutinative, so `수영을` (swimming + object marker) must match
 * `수영` in the evidence or every question misses. Only the trailing particle
 * is trimmed — never an internal one — because `할머니는` vs `할머니가` is the
 * distinction the quote proof deliberately preserves elsewhere.
 */
// Matched as a PREFIX, not an exact word. Korean fuses the interrogative into
// the predicate — 언제였나요, 어디였어요, 누구세요 — so an exact-match list drops
// `언제` and then treats `언제였나요` as a content term the evidence must
// contain, which refuses perfectly answerable questions.
/**
 * Korean is SOV, so the predicate is the FINAL token. Only that token is tested
 * for a conjugated tail.
 *
 * Applying the suffix test to every token was badly wrong in this product:
 * 아버지, 할아버지 and 누나 all end in a "predicate" syllable, so gate D stopped
 * requiring the very subject the question was about. A family-memory archive
 * asked "할아버지 첫 직장은?" would have had its discriminating noun silently
 * exempted.
 */
const PREDICATE_TAIL = /(요|다|까|죠|네|군|나|자|래|지)$/;

const INTERROGATIVE_STEMS = [
  '언제',
  '어디',
  '누가',
  '누구',
  '무엇',
  '무슨',
  '왜',
  '어떻게',
  '얼마나',
  '몇',
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
];
const isInterrogative = (w: string) =>
  INTERROGATIVE_STEMS.some((s) => w.toLowerCase().startsWith(s));
const TRAILING_PARTICLE = /(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터)$/;

/** Hangul syllables, plus CJK ideographs — 한자 is normal in older Korean records. */
const CJK = /[\uac00-\ud7af\u4e00-\u9fff\u3400-\u4dbf]/;

export function contentTerms(question: string): string[] {
  const tokens = question
    // NFC FIRST. `search.ts` normalises the query it retrieves with, so an NFD
    // question would be measured against NFC evidence and every term would look
    // uncovered — turning a useful refusal into a blanket one.
    .normalize('NFC')
    .replace(/[?？.!,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // INTERROGATIVE TEST BEFORE PARTICLE STRIPPING. `누가` ends in the subject
    // particle 가; stripping first leaves `누`, which is not an interrogative
    // stem and becomes a junk term the evidence can never contain — buying the
    // gate a free miss on the most common Korean "who" question.
    .filter((w) => !isInterrogative(w))
    .map((w) => w.replace(TRAILING_PARTICLE, ''))
    .filter((w) => w.length > 0 && !isInterrogative(w))
    .filter((w) => {
      // A one-syllable Hangul word is usually the SUBJECT of the question —
      // 색, 집, 병 — so a length>=2 filter tuned to English throws away exactly
      // the term that matters. CJK ideographs count the same way: older Korean
      // records write names and places in 한자, and a Latin floor applied to
      // them silently emptied the term list, which disabled the gate entirely.
      return CJK.test(w) ? w.length >= 1 : w.length >= 3;
    });

  // Only the last token may be the predicate.
  const last = tokens[tokens.length - 1];
  return last !== undefined && tokens.length > 1 && PREDICATE_TAIL.test(last)
    ? tokens.slice(0, -1)
    : tokens;
}

/**
 * Korean verbs conjugate, so a question's `태어나셨어요` never matches the
 * evidence's `태어나셨다` literally. Comparing a short stem is the cheapest
 * honest approximation — and it errs toward COVERAGE, i.e. toward answering,
 * which is why the gate abstains on the ratio rather than on any single term.
 */
/**
 * Korean predicates carry their conjugation on the tail. Nouns essentially
 * never end in these, so the test is one-sided in the direction that matters:
 * a misclassified noun would be dropped from the requirement and make the gate
 * more permissive, and these endings do not occur on the nouns a family
 * question is built from.
 */
const STEM_LEN = 3;
function covers(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true;
  return term.length > STEM_LEN && haystack.includes(term.slice(0, STEM_LEN));
}

export interface AbstentionDecision {
  abstain: boolean;
  reason: string;
  message?: string;
}

/**
 * Journey 6.4. The offer is what makes the abstention USEFUL — FR-084 asks for
 * a useful abstention, and a bare refusal fails that half of the DoD.
 */
const ABSTAIN_MESSAGE =
  '기록에 이 질문에 답할 만한 내용이 충분하지 않습니다. 가족에게 여쭤보시겠어요?';

export function decideAbstention(
  evidence: EvidenceBlock[],
  fitted: number,
  relevant: number,
  validation: ValidationResult,
  // FM-027: the question. FM-026's gates were all evidence-centric — "is what
  // we retrieved real and well-formed?" — and none asked "does it answer what
  // was asked?", so a gap-question with strong on-topic evidence was answered
  // confidently. Optional so existing callers keep compiling; the topical gate
  // is skipped when it is absent, which is stated rather than silent.
  question?: string,
): AbstentionDecision {
  const abstain = (reason: string): AbstentionDecision => ({
    abstain: true,
    reason,
    message: ABSTAIN_MESSAGE,
  });

  // Gate A — admission by leg composition.
  const contentful = evidence.filter((b) => b.legs.some((l) => CONTENT_LEGS.has(l)));
  if (contentful.length === 0) {
    return abstain(
      evidence.length === 0
        ? 'no evidence retrieved'
        : 'leg composition: only metadata legs matched, no content leg',
    );
  }

  // Gate B — budget fit. Non-empty, high-scoring retrieval still abstains when
  // most of what the question needed did not fit the window.
  if (relevant > 0 && fitted / relevant < MIN_FIT_RATIO) {
    return abstain(`budget fit: ${fitted} of ${relevant} relevant chunks fitted`);
  }

  // Gate C — validator survival. Citations existed but none checked out.
  if (validation.accepted.length === 0) {
    return abstain('no claim survived validation');
  }

  // Gate D — TOPICAL. FM-026's three gates all asked "is what we retrieved real
  // and well-formed?"; none asked "does it answer what was ASKED?". Measured
  // against the shipped pipeline: given genuine, on-topic, content-leg,
  // budget-fitting evidence about the right person, it returned three accepted
  // quote claims and abstain=false for a fact appearing nowhere in that
  // evidence. Strong evidence about the right subject is exactly what makes a
  // gap-question dangerous — every earlier gate is satisfied.
  //
  // Deliberately crude, and crude in the safe direction. This is lexical
  // coverage of the question's content terms, not comprehension: no model is
  // available (D-47) and a model-free "understanding" check would be a lie. It
  // catches the case that matters — the question asks about something the
  // evidence never mentions — and abstains when unsure.
  if (question !== undefined) {
    const terms = contentTerms(question);
    if (terms.length === 0) {
      // Nothing checkable. Skipping the gate here answered the LEAST specified
      // input of all with confident cited claims, which is the wrong direction
      // for a grounding guarantee: an unverifiable question is refused.
      return abstain('topical gap: the question carries no checkable content terms');
    }
    {
      const haystack = evidence.map((b) => b.content).join(' ');
      // NOUNS decide, predicates do not. A question's answer lives in its nouns
      // — 색, 수영, 직장, 결혼식 — while the predicate is only how the asking is
      // phrased, and Korean has many ways to say the same thing: a note reading
      // "1940년 대구 출생" plainly answers "어디서 태어나셨어요?", but no lexical
      // rule can match 출생 to 태어나다. Requiring the verb too refuses
      // questions the archive obviously answers, which is a product defect, not
      // caution.
      //
      // Known limitation, recorded rather than hidden: a question whose
      // DISCRIMINATING term is the verb — "할머니가 언제 돌아가셨어요?" — is
      // under-refused, because 할머니 alone satisfies the gate. Carried.
      const uncovered = terms.filter((t) => !covers(haystack, t));
      // NEARLY-FULL coverage, not a majority. A realistic fixture broke the
      // majority rule: asked "어머니는 무슨 색을 좋아하셨어요?", a note that
      // never mentions colour but does say she 좋아하셨고 (about food) scored
      // 2 of 3 and answered. The verb matched while the SUBJECT of the question
      // did not — and it is the subject that decides whether the archive can
      // answer at all. One miss is tolerated only once a question carries four
      // or more content terms, where a phrasing difference is likely.
      const allowedMisses = Math.floor(terms.length / 4);
      if (uncovered.length > allowedMisses) {
        return abstain(
          `topical gap: the evidence never mentions ${uncovered.map((t) => `'${t}'`).join(', ')}`,
        );
      }
    }
  }

  return { abstain: false, reason: 'evidence admitted, fitted, and validated' };
}
