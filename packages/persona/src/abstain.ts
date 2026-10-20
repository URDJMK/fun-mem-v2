import { hasOpaqueText } from './opaque';
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

// Matched as a PREFIX, not an exact word, so `whose`, `whom` and `whenever` go
// with their stems instead of being left behind as terms the evidence can never
// contain. (It takes `whole` and `however` too; that is how the gate has always
// read them.)
const INTERROGATIVE_STEMS = ['what', 'when', 'where', 'who', 'why', 'how'];
const isInterrogative = (w: string) =>
  INTERROGATIVE_STEMS.some((s) => w.toLowerCase().startsWith(s));

/** Shorter words are filler (`is`, `of`, `to`), not content. */
const MIN_TERM_LEN = 3;

/**
 * The content-bearing terms of a question, with interrogatives stripped.
 *
 * A word in a script the English rules do not cover (see opaque.ts) is kept
 * whatever its length. The floor exists to drop English filler; a short word in
 * another script is as likely to be the very thing the question is about, and
 * dropping it would exempt that word from the check.
 */
export function contentTerms(question: string): string[] {
  // NFC FIRST. `search.ts` normalises the query it retrieves with, so an NFD
  // question would be measured against NFC evidence and every term would look
  // uncovered — turning a useful refusal into a blanket one.
  const words = question
    .normalize('NFC')
    .replace(/[?.!,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.filter((w) => !isInterrogative(w) && (w.length >= MIN_TERM_LEN || hasOpaqueText(w)));
}

/**
 * English inflects, so a question's `swimming` never matches the evidence's
 * `swim` literally. Comparing a short stem is the cheapest honest approximation
 * — and it errs toward COVERAGE, i.e. toward answering, which is why the gate
 * abstains on the ratio rather than on any single term. Text in a script the
 * English rules do not cover has no stem to compare, so it is matched exactly.
 */
const STEM_LEN = 3;
function covers(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true;
  if (hasOpaqueText(term)) return false;
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
  'There is not enough in the records to answer this. Would you like to ask your family?';

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
    // A question needs at least one SUBSTANTIVE term. A short word in another
    // script is kept as a term (see contentTerms) but, being a letter or a
    // particle that any text of its language contains, finding it proves nothing;
    // a question made only of such words is as unverifiable as one with no words.
    if (!terms.some((t) => t.length >= MIN_TERM_LEN)) {
      // Nothing checkable. Skipping the gate here answered the LEAST specified
      // input of all with confident cited claims, which is the wrong direction
      // for a grounding guarantee: an unverifiable question is refused.
      return abstain('topical gap: the question carries no checkable content terms');
    }
    {
      const haystack = evidence.map((b) => b.content).join(' ');
      // Matching is lexical and case-sensitive, so `Dad` in the question does
      // not match `dad` in the evidence, and a spelled-out year does not match
      // its digits. Recorded rather than hidden: both under-answer, neither
      // over-answers, which is the safe direction. Carried.
      const uncovered = terms.filter((t) => !covers(haystack, t));
      // NEARLY-FULL coverage, not a majority. A realistic fixture broke the
      // majority rule: a note that never mentions the colour a mother liked, but
      // does say she liked her food, matched the question's verb and none of its
      // subject, and a majority let it answer. It is the subject that decides
      // whether the archive can answer at all. One miss is tolerated only once a
      // question carries four or more content terms, where a phrasing difference
      // is likely.
      //
      // That allowance is for English phrasing only. A word in a script the
      // English rules do not cover may never be missed, and it does not count
      // toward the allowance either: otherwise padding a question with short
      // words in another script, which are easy to cover, would buy a miss on the
      // words that matter.
      const missedOpaque = uncovered.filter(hasOpaqueText);
      const allowedMisses = Math.floor(terms.filter((t) => !hasOpaqueText(t)).length / 4);
      if (missedOpaque.length > 0 || uncovered.length > allowedMisses) {
        return abstain(
          `topical gap: the evidence never mentions ${uncovered.map((t) => `'${t}'`).join(', ')}`,
        );
      }
    }
  }

  return { abstain: false, reason: 'evidence admitted, fitted, and validated' };
}
