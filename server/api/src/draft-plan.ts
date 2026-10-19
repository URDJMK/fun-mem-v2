/**
 * FM-072 — "let the app write the memory for me", with a model, safely.
 *
 * THE IDEA IN ONE LINE: the model never writes prose. It writes a PLAN over the
 * contributor's own words, expressed entirely as integers and enum tags, and
 * the server applies it.
 *
 * The alternative — let a model write Korean prose and then check whether the
 * prose is grounded — was measured twice on this codebase and both measurements
 * came back with the same shape of answer: the check is good but not total.
 * Character n-gram similarity ranks fabrications ABOVE honest re-conjugations.
 * Morpheme containment catches every invented noun but cannot catch a sentence
 * assembled entirely from the contributor's own words in a new arrangement
 * ("할머니가 국수를 삶아 주셨다" + "마당에 평상이 있었다" -> "할머니가 마당에서
 * 국수를 삶아 주셨다", zero novel morphemes, one invented place-relation).
 *
 * A plan closes that hole structurally rather than statistically:
 *
 *   INV-1  COVERAGE   every source token appears exactly once in the output,
 *                     or is dropped and is a member of the closed FILLER set.
 *   INV-2  CONTIGUITY every output sentence is one ascending contiguous run of
 *                     source token ids. There is no join, no move-a-word, no
 *                     cross-sentence recombination — the operation does not
 *                     exist in the schema, so it cannot be requested.
 *   INV-3  CLOSED     the only characters in the body that were not copied from
 *          VOCABULARY the source are ' ', '\n', ',', '.', '?', '!' and the `to`
 *                     side of the ENDINGS table below. Nothing else can enter.
 *   INV-4  ENDINGS    an ending rewrite touches only the final token of a
 *                     sentence, only when that token literally ends with the
 *                     rule's `from`, and only ever replaces a politeness or
 *                     nominaliser ending. The stem is preserved byte for byte.
 *   INV-5  NO PROSE   the model emits no free text ANYWHERE — not in `body`,
 *                     not in `title`, not in `notes`. `notes` is rendered by
 *                     the server from what the plan actually did.
 *   INV-6  READABLE   a run may end only where a Korean sentence can end, so a
 *                     split cannot produce "집에 갔는데." — broken grammar the
 *                     ENDINGS table has no honest way to repair.
 *   INV-7  NO MERGE   splitting the contributor's sentences is allowed; joining
 *                     two of them is not. A full stop they typed is a boundary
 *                     no run may span.
 *
 * So the worst a captured or confused model can do is a BAD REARRANGEMENT of
 * the family's own words. That is visible in the diff, reversible in one edit,
 * and — unlike an invented sentence — it is not a new claim about a dead
 * person. Fabrication is not detected here. It is unrepresentable.
 *
 * WHAT THE MODEL IS ACTUALLY FOR, then: splitting a run-on voice-typed
 * paragraph into sentences, putting them in an order that reads, normalising
 * 해요체 to the archive's 문어체 '-다', dropping hesitation noise, choosing which
 * span is the title and which token is the date, and picking the entity type.
 * That is genuinely most of what "다듬어 줘" means, and none of it requires the
 * power to write a sentence.
 *
 * WHAT WE GAVE UP, deliberately, and it is worth naming: the model may not add
 * subject honorific -시- where the contributor did not write it (갔다 -> 가셨다).
 * Honorification is not a fact about the world, so it would be safe by INV-3's
 * logic — but choosing WHICH verb takes it requires knowing whose action each
 * verb is, and a misplaced -시- in a record about a dead person misattributes
 * agency. The contributor adds it in the editor if they want it. A tidier
 * register is not worth a guess about who did what.
 */

import { ENTITY_TYPES, canonicalTitle, validateNoteTitle, type EntityType } from '@funmem/core';
import { stripInvisible } from '@funmem/persona';
import {
  linkKnownTitles,
  readFuzzyDate,
  readTitle,
  readType,
  type DraftRequest,
  type DraftResult,
} from './drafts';

export const PLAN_VERSION = 'editplan-1';

/* ── the source, as numbered tokens ──────────────────────────────────── */

export interface Token {
  /** 1-based; this is the only handle the model is ever given. */
  id: number;
  /** the word core: `raw` minus a trailing punctuation run */
  text: string;
  /** exactly as the contributor typed it, for the diff the contributor reads */
  raw: string;
  /**
   * The trailing punctuation run the contributor typed after this word.
   *
   * Kept, not discarded, because it is the load-bearing evidence for INV-7: a
   * full stop is the contributor saying "this thought ends here", and a plan
   * that spans it is merging two of their sentences into one.
   */
  ends: string;
}

const SENTENCE_PUNCT = /[.!?…。]/u;

/**
 * Split the contributor's text into numbered eojeol.
 *
 * WHY EOJEOL AND NOT CHARACTER OFFSETS. Both were considered; offsets lose. A
 * model asked for `[start, end)` into mixed Hangul/ASCII text gets them wrong
 * often enough that the repair loop becomes the common path, and an off-by-one
 * offset silently produces a MUTILATED Korean word — 어머니가 -> 어머니 changes a
 * subject marker, 안 -> ∅ flips a negation. Token ids cannot be off by a
 * fraction of a word. The cost is that no operation can reach inside a word
 * except the two that are checked to be lossless (`space`, and the ENDINGS
 * suffix rewrite).
 *
 * Trailing punctuation is peeled off the core because the plan re-supplies
 * terminators from the closed set. A token containing `[[` is left alone so a
 * wikilink the contributor typed themselves survives with its brackets.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) break;
    const start = i;
    while (i < src.length && !/\s/.test(src[i]!)) i++;
    const raw = src.slice(start, i);
    let text = raw;
    let ends = '';
    if (!raw.includes('[[')) {
      const m = /[.,!?…、。·:;]+$/u.exec(raw);
      if (m && m.index > 0) {
        text = raw.slice(0, m.index);
        ends = m[0];
      }
    }
    out.push({ id: out.length + 1, text, raw, ends });
  }
  return out;
}

/** The block the model reads. One token per line: `<id>\t<text>`. */
export function numberedSource(tokens: Token[]): string {
  return tokens.map((t) => `${t.id}\t${t.text}`).join('\n');
}

/* ── the closed tables: the entire non-source vocabulary ─────────────── */

export interface EndingRule {
  id: string;
  /** must be a literal suffix of the sentence's final token */
  from: string;
  to: string;
  /**
   * `tense` marks the rules that turn a tenseless nominalised ending into a
   * past-tense verb (차려주심 -> 차려주셨다). That IS an inference — a small one,
   * in a corpus of memories that are all past, but an inference. Using one
   * forces a Korean note saying so, so the contributor is told rather than
   * merely not lied to.
   */
  risk: 'safe' | 'tense';
  /** the syllable before `from` must carry the fused past marker ㅆ */
  ssBefore?: boolean;
}

/**
 * 해요체 / 합니다체 / 해체 / 메모체 -> the archive's 문어체 '-다'.
 *
 * Every rule replaces a politeness or nominaliser ending and nothing else. The
 * past-tense markers 았/었/였/셨/했 are carried into `to` rather than stripped,
 * so no rule can change WHEN something happened. Bare `아요`/`어요` are
 * deliberately absent: 몰라요 -> 몰다 is what a naive strip produces, and a
 * mangled verb in a dead person's record is worse than an unpolished one.
 */
export const ENDINGS: readonly EndingRule[] = [
  { id: 'E01', from: '습니다', to: '다', risk: 'safe' },
  // 해요체/해체/메모체 on a PAST stem. The condition is not a longer suffix but a
  // jamo one: Korean fuses the past marker into the stem syllable (가 + 았 ->
  // 갔), so a table of literal `았어요`/`었어요` misses 갔어요, 왔어요, 샀어요,
  // 줬어요 — measured: two of six live plans were rejected for exactly this.
  // `ssBefore` asks the one question that covers all of them: does the syllable
  // before the ending carry the jongseong ㅆ?
  { id: 'E02', from: '어요', to: '다', risk: 'safe', ssBefore: true },
  { id: 'E03', from: '아요', to: '다', risk: 'safe', ssBefore: true },
  { id: 'E04', from: '어', to: '다', risk: 'safe', ssBefore: true },
  { id: 'E05', from: '죠', to: '다', risk: 'safe', ssBefore: true },
  { id: 'E06', from: '지요', to: '다', risk: 'safe', ssBefore: true },
  { id: 'E07', from: '음', to: '다', risk: 'safe', ssBefore: true },
  { id: 'E08', from: '네요', to: '다', risk: 'safe' },
  { id: 'E09', from: '이에요', to: '이다', risk: 'safe' },
  { id: 'E10', from: '아니에요', to: '아니다', risk: 'safe' },
  { id: 'E11', from: '예요', to: '다', risk: 'safe' },
  // the common 형용사 present tense, where there is no ㅆ to key on
  { id: 'E12', from: '없어요', to: '없다', risk: 'safe' },
  { id: 'E13', from: '좋아요', to: '좋다', risk: 'safe' },
  { id: 'E14', from: '싫어요', to: '싫다', risk: 'safe' },
  { id: 'E15', from: '많아요', to: '많다', risk: 'safe' },
  { id: 'E16', from: '같아요', to: '같다', risk: 'safe' },
  // 메모체. Enumerated as whole honorific verb endings rather than a bare `심`,
  // because `심` is also the tail of ordinary nouns — 관심, 조심, 중심 — and the
  // bare rule turns 관심 into 관셨다. A closed list of verb endings cannot.
  // There is deliberately no `함 -> 했다`: 포함, 위함, 인함 make it unsafe by the
  // same argument, and no list of exceptions closes it.
  { id: 'E20', from: '주심', to: '주셨다', risk: 'tense' },
  { id: 'E21', from: '하심', to: '하셨다', risk: 'tense' },
  { id: 'E22', from: '계심', to: '계셨다', risk: 'tense' },
  { id: 'E23', from: '오심', to: '오셨다', risk: 'tense' },
  { id: 'E24', from: '가심', to: '가셨다', risk: 'tense' },
  { id: 'E25', from: '보심', to: '보셨다', risk: 'tense' },
  { id: 'E26', from: '드심', to: '드셨다', risk: 'tense' },
  { id: 'E27', from: '되심', to: '되셨다', risk: 'tense' },
];

/** jongseong ㅆ (index 20) — the fused past-tense marker: 갔, 왔, 았, 었, 였, 셨, 했. */
function hasSsJongseong(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.codePointAt(0)!;
  if (c < 0xac00 || c > 0xd7a3) return false;
  return (c - 0xac00) % 28 === 20;
}

/** Does this rule actually fit this word? The only precondition anything checks. */
export function endingFits(text: string, r: EndingRule): boolean {
  if (!text.endsWith(r.from) || text.length <= r.from.length) return false;
  if (r.ssBefore === true && !hasSsJongseong(text[text.length - r.from.length - 1])) return false;
  return true;
}

/**
 * The register rewrite the SERVER performs on its own when the plan asks for
 * none.
 *
 * Measured on six live CLI runs: the model applied the right rule in four and
 * silently forgot it in two, leaving 해요체 in the record. Forgetting is not a
 * safety failure, but it is the difference between a draft worth accepting and
 * one worth retyping — and the choice does not need a model at all. The
 * sentence-final token is known, the table is closed, and the longest match is
 * unambiguous. So the server applies it, and `tense` rules are excluded because
 * those are the only two that decide something the contributor did not write.
 */
function autoEnding(text: string): EndingRule | undefined {
  let best: EndingRule | undefined;
  for (const r of ENDINGS) {
    if (r.risk !== 'safe') continue;
    if (!endingFits(text, r)) continue;
    if (best === undefined || r.from.length > best.from.length) best = r;
  }
  return best;
}

const ENDING_BY_ID = new Map(ENDINGS.map((e) => [e.id, e]));

/**
 * Tokens the plan is allowed to DELETE.
 *
 * A drop is the one operation that removes meaning, so the set is closed and
 * short. 안 and 못 are the reason it is closed at all: a model that may delete
 * an arbitrary token may flip a negation, and "아무것도 안 물어보셨다" ->
 * "아무것도 물어보셨다" is a fabrication of the exact kind this file exists to
 * make impossible. It is not on the list, so it cannot happen.
 *
 * An exact immediate repetition (stutter) is droppable too — see `validatePlan`.
 */
export const FILLER: ReadonlySet<string> = new Set([
  '음',
  '흠',
  '아',
  '어',
  '에',
  '뭐더라',
  '뭐랄까',
  '아무튼',
  '어쨌든',
  '아이고',
  '그러니까',
]);

const TERMINATORS = new Set(['.', '?', '!', '']);

/**
 * Characters a Korean sentence may end on.
 *
 * This is a READABILITY invariant, not a safety one, and it is the one place
 * the plan schema had to grow a rule after being tried on real prose. A split
 * that lands mid-clause — "…집에 갔는데." — is grammatically broken Korean, and
 * the ENDINGS table cannot repair a connective ending (-는데, -고, -면서)
 * because turning one into a terminal ending means CHOOSING a tense and a
 * politeness level the contributor did not write. So instead of repairing the
 * cut, the cut is forbidden: a sentence may only end where the contributor's
 * own word already ends one, or where an ENDINGS rule makes it end one.
 *
 * The final sentence of the plan is exempt, because the contributor's text ends
 * where it ends — sometimes on 할머니가, in the inverted word order people
 * actually speak in — and refusing that would mean refusing the memory.
 */
const SENT_FINAL: ReadonlySet<string> = new Set([
  '다',
  '요',
  '까',
  '네',
  '죠',
  '음',
  '심',
  '함',
  '어',
  '아',
  '지',
  '라',
  '오',
  '군',
]);

/* ── the plan: the model's entire output surface ─────────────────────── */

export interface PlanSentence {
  /** inclusive token-id range; INV-2 lives here */
  from: number;
  to: number;
  /** blank line before this sentence */
  para?: boolean;
  /** ENDINGS id applied to the LAST surviving token of the run */
  ending?: string;
  /** token ids inside [from, to] to delete; must be FILLER or a stutter */
  drop?: number[];
  /** token ids inside [from, to] after which to place a comma */
  comma?: number[];
  /** '.' | '?' | '!' | '' */
  terminator?: string;
}

export interface PlanSpacing {
  id: number;
  /** cut positions inside the token's text; parts are re-joined with a space */
  cuts: number[];
}

export interface EditPlan {
  sentences: PlanSentence[];
  /** inclusive token-id range quoted verbatim as the note title */
  title?: { from: number; to: number } | null;
  /** the token that carries the memory's date */
  dateToken?: number | null;
  type?: string | null;
  spacing?: PlanSpacing[];
  /** token ids of a line that does not read like a memory (see the note below) */
  oddLine?: number[];
}

/**
 * Tolerant extraction. Six of six CLI responses in the prompt study came back
 * fenced despite the prompt forbidding it, so the parser strips fences and
 * takes the outermost balanced object rather than trusting the model to obey.
 */
export function parsePlan(raw: string): EditPlan | null {
  const s = raw.replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const v: unknown = JSON.parse(s.slice(start, i + 1));
        return v !== null && typeof v === 'object' ? normalizePlan(v as EditPlan) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * `null` and "absent" are the same thing here.
 *
 * Not cosmetic: the schema shows `"ending":null` as the ordinary value, and
 * every live plan came back with it. A validator that only tested `!== undefined`
 * rejected eight of nine correct plans with `unknown ending id "null"` — a
 * rejection that would have sent every one of them to the deterministic
 * fallback while looking, in the logs, like the model had failed.
 */
function normalizePlan(p: EditPlan): EditPlan {
  const drop = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
  return {
    ...p,
    sentences: (Array.isArray(p.sentences) ? p.sentences : []).map((s) => ({
      ...s,
      ending: drop(s.ending),
      drop: drop(s.drop),
      comma: drop(s.comma),
      terminator: drop(s.terminator),
    })),
    title: drop(p.title),
    dateToken: drop(p.dateToken),
    type: drop(p.type),
    spacing: drop(p.spacing),
    oddLine: drop(p.oddLine),
  };
}

/* ── validation: every invariant, checked, before anything is rendered ── */

export interface PlanRejection {
  ok: false;
  /**
   * Machine-readable and quotable back to the model in the single repair pass.
   * These strings are never shown to a contributor.
   */
  why: string[];
}
export interface PlanAccepted {
  ok: true;
  plan: EditPlan;
}

const isIntArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n));

export function validatePlan(plan: EditPlan, tokens: Token[]): PlanAccepted | PlanRejection {
  const why: string[] = [];
  const n = tokens.length;
  const byId = new Map(tokens.map((t) => [t.id, t]));

  if (!Array.isArray(plan.sentences) || plan.sentences.length === 0) {
    return { ok: false, why: ['sentences must be a non-empty array'] };
  }

  /** INV-1: exactly-once coverage of every source token. */
  const seen = new Uint8Array(n + 1);
  const dropped = new Set<number>();
  const spaced = new Set<number>();
  const endingOn = new Set<number>();

  for (const [si, s] of plan.sentences.entries()) {
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to)) {
      why.push(`sentence ${si}: from/to must be integers`);
      continue;
    }
    if (s.from < 1 || s.to > n || s.from > s.to) {
      why.push(`sentence ${si}: [${s.from}, ${s.to}] is outside 1..${n} or reversed`);
      continue;
    }
    for (let id = s.from; id <= s.to; id++) {
      if (seen[id] === 1) why.push(`token ${id} appears in more than one sentence`);
      seen[id] = 1;
    }

    if (s.terminator !== undefined && !TERMINATORS.has(s.terminator)) {
      why.push(`sentence ${si}: terminator must be one of . ? ! or ""`);
    }

    if (s.drop !== undefined) {
      if (!isIntArray(s.drop)) why.push(`sentence ${si}: drop must be an array of token ids`);
      else {
        for (const id of s.drop) {
          if (id < s.from || id > s.to) {
            why.push(`sentence ${si}: dropped token ${id} is outside this sentence`);
            continue;
          }
          const t = byId.get(id)!;
          const prev = byId.get(id - 1);
          const stutter = prev !== undefined && prev.text === t.text && id - 1 >= s.from;
          if (!FILLER.has(t.text) && !stutter) {
            // the load-bearing refusal: only noise may be deleted
            why.push(`token ${id} ("${t.text}") is not filler and may not be dropped`);
            continue;
          }
          dropped.add(id);
        }
      }
    }

    if (s.comma !== undefined) {
      if (!isIntArray(s.comma)) why.push(`sentence ${si}: comma must be an array of token ids`);
      else {
        for (const id of s.comma) {
          if (id < s.from || id >= s.to) {
            why.push(`sentence ${si}: comma after token ${id} is outside this sentence`);
          }
        }
      }
    }

    /**
     * INV-7: the contributor's own sentence boundaries are inviolable.
     *
     * SPLITTING IS ALLOWED. MERGING IS NOT. A full stop the contributor typed
     * is them saying "this thought ends here", and spanning it joins two
     * separate statements into one — which is exactly the recombination that
     * every text-level grounding check was measured to be blind to
     * ("할머니가 국수를 삶아 주셨다." + "마당에 평상이 있었다." -> one sentence
     * asserting where the noodles were made). Zero novel morphemes, one new
     * claim. Here the plan simply cannot express it.
     */
    for (let id = s.from; id < s.to; id++) {
      const t = byId.get(id);
      if (t !== undefined && SENTENCE_PUNCT.test(t.ends)) {
        why.push(
          `sentence ${si}: token ${id} ("${t.raw}") already ends a sentence — a run may not span it`,
        );
      }
    }

    /** INV-6: a sentence may only end where a sentence can end. */
    if (s.to !== n) {
      let last = s.to;
      while (last >= s.from && (s.drop ?? []).includes(last)) last--;
      const t = last >= s.from ? byId.get(last) : undefined;
      const rule = s.ending === undefined ? undefined : ENDING_BY_ID.get(s.ending);
      const rewritten =
        t !== undefined &&
        ((rule !== undefined && endingFits(t.text, rule)) || autoEnding(t.text) !== undefined);
      const ok =
        t === undefined ||
        // the contributor put a full stop here themselves: 이야기. is a
        // sentence because they said so, whatever its final syllable is
        SENTENCE_PUNCT.test(t.ends) ||
        rewritten ||
        t.text.includes('[[') ||
        SENT_FINAL.has(t.text[t.text.length - 1]!);
      if (!ok) {
        why.push(
          `sentence ${si}: "${t.text}" cannot end a sentence — cut somewhere a sentence already ends, or leave the run joined`,
        );
      }
    }

    if (s.ending !== undefined) {
      const rule = ENDING_BY_ID.get(s.ending);
      if (rule === undefined) {
        why.push(`sentence ${si}: unknown ending id "${s.ending}"`);
      } else {
        // INV-4: the rule applies to the last SURVIVING token of the run
        let last = s.to;
        while (last >= s.from && dropped.has(last)) last--;
        const t = last >= s.from ? byId.get(last) : undefined;
        if (t === undefined) {
          why.push(`sentence ${si}: nothing left to apply an ending to`);
        } else if (!endingFits(t.text, rule)) {
          why.push(
            `sentence ${si}: token ${last} ("${t.text}") does not end with "${rule.from}", so ${rule.id} does not apply`,
          );
        } else {
          endingOn.add(last);
        }
      }
    }
  }

  for (let id = 1; id <= n; id++) {
    if (seen[id] !== 1)
      why.push(`token ${id} ("${byId.get(id)!.text}") is missing from the output`);
  }

  /** `space` may only re-cut a token losslessly. */
  if (plan.spacing !== undefined) {
    if (!Array.isArray(plan.spacing)) why.push('spacing must be an array');
    else
      for (const sp of plan.spacing) {
        const t = byId.get(sp.id);
        if (t === undefined) {
          why.push(`spacing: no token ${sp.id}`);
          continue;
        }
        if (endingOn.has(sp.id)) {
          why.push(`spacing: token ${sp.id} already carries an ending rewrite`);
          continue;
        }
        if (!isIntArray(sp.cuts) || sp.cuts.length === 0) {
          why.push(`spacing: token ${sp.id} needs at least one cut`);
          continue;
        }
        let prev = 0;
        let bad = false;
        for (const c of sp.cuts) {
          if (c <= prev || c >= t.text.length) bad = true;
          prev = c;
        }
        if (bad) why.push(`spacing: cuts for token ${sp.id} must be strictly inside the word`);
        else spaced.add(sp.id);
      }
  }

  if (plan.title !== undefined && plan.title !== null) {
    const { from, to } = plan.title;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > n || from > to) {
      why.push('title: span is outside the source or reversed');
    }
  }

  if (plan.dateToken !== undefined && plan.dateToken !== null && !byId.has(plan.dateToken)) {
    why.push(`dateToken: no token ${plan.dateToken}`);
  }

  if (plan.type !== undefined && plan.type !== null) {
    if (!(ENTITY_TYPES as readonly string[]).includes(plan.type)) {
      why.push(`type: "${plan.type}" is not one of ${ENTITY_TYPES.join(', ')}`);
    }
  }

  if (plan.oddLine !== undefined && !isIntArray(plan.oddLine)) {
    why.push('oddLine must be an array of token ids');
  }

  return why.length === 0 ? { ok: true, plan } : { ok: false, why: why.slice(0, 12) };
}

/* ── application: the server writes the prose, from the plan ──────────── */

export interface AppliedPlan {
  body: string;
  title: string;
  type: EntityType;
  occurred: string | null;
  notes: string[];
  /** for the contributor-facing diff, and for the audit row */
  did: {
    sentences: number;
    reordered: boolean;
    endings: string[];
    dropped: string[];
    respaced: number;
    linked: string[];
    tenseInferred: boolean;
    oddLine: boolean;
  };
}

const NOTE = {
  KEPT_ALL: '적어 주신 낱말은 하나도 지우지 않았어요.',
  NO_ADD:
    '없는 이야기는 보태지 않았어요. 이 초안에 있는 말은 전부 적어 주신 말이에요. 문장 나누기와 차례, 말투만 손봤어요.',
  SPLIT: (k: number) => `이어진 글을 ${k}개의 문장으로 나누었어요.`,
  ORDER: '문장 차례를 바꾸었어요. 원래 차례가 맞으면 되돌려 주세요.',
  ENDING: '말투만 기록용 ‘-다’로 바꾸었어요. 낱말은 그대로예요.',
  TENSE:
    '‘-심’으로 끝난 문장을 ‘-셨다’로 바꾸면서 지난 일로 적었어요. 지난 일이 아니면 고쳐 주세요.',
  FILLER: (w: string[]) => `말버릇처럼 보이는 말만 덜어 냈어요: ${w.join(', ')}`,
  SPACING: '띄어쓰기만 손봤어요.',
  TITLE: (t: string) => `제목은 적어 주신 말에서 그대로 옮겼어요: “${t}”`,
  TITLE_NONE: '제목을 짓지 못했어요. 직접 적어 주세요.',
  DATE: (d: string) => `글에서 날짜를 찾았어요: ${d}`,
  DATE_NONE: '날짜는 비워 두었어요. 기억나지 않아도 괜찮아요.',
  LINKED: (l: string[]) => `이미 있는 기록과 연결했어요: ${l.map((x) => `[[${x}]]`).join(', ')}`,
  PHOTO_IN: '사진을 본문에 넣었어요.',
  PHOTO_LATER: '사진은 저장할 때 이 기억에 붙어요.',
  ODD_LINE:
    '기억이 아니라 프로그램에게 시키는 말처럼 보이는 줄이 있었어요. 지우지 않고 그대로 두었으니, 필요 없으면 지우고 저장해 주세요.',
  PHOTO_AI:
    '사진 설명은 사람이 아니라 프로그램이 사진을 보고 적은 것이에요. 가족의 기억이 아니라서 본문과 따로 두었어요.',
} as const;

/**
 * Render the plan. This function — not the model — writes every character of
 * the body, and it can only write source tokens plus the closed vocabulary.
 */
export function applyPlan(plan: EditPlan, tokens: Token[], req: DraftRequest): AppliedPlan {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const spacing = new Map((plan.spacing ?? []).map((s) => [s.id, s.cuts]));

  const endings: string[] = [];
  const droppedWords: string[] = [];
  let tenseInferred = false;

  const paragraphs: string[][] = [[]];
  let reordered = false;
  let cursor = 0;

  for (const s of plan.sentences) {
    if (s.from < cursor) reordered = true;
    cursor = s.from;

    const drop = new Set(s.drop ?? []);
    const comma = new Set(s.comma ?? []);
    let rule = s.ending === undefined ? undefined : ENDING_BY_ID.get(s.ending);
    let lastId = s.to;
    while (lastId >= s.from && drop.has(lastId)) lastId--;

    const words: string[] = [];
    for (let id = s.from; id <= s.to; id++) {
      const t = byId.get(id)!;
      if (drop.has(id)) {
        droppedWords.push(t.text);
        continue;
      }
      let w = t.text;
      const cuts = spacing.get(id);
      if (cuts !== undefined) {
        const parts: string[] = [];
        let prev = 0;
        for (const c of cuts) {
          parts.push(w.slice(prev, c));
          prev = c;
        }
        parts.push(w.slice(prev));
        w = parts.join(' ');
      }
      if (id === lastId && (rule === undefined || !endingFits(t.text, rule))) {
        // the plan named no rule, or named one that does not fit: the server
        // picks the longest SAFE match itself, or leaves the word alone
        rule = autoEnding(t.text);
      }
      if (id === lastId && rule !== undefined && endingFits(t.text, rule)) {
        w = t.text.slice(0, t.text.length - rule.from.length) + rule.to;
        endings.push(rule.id);
        if (rule.risk === 'tense') tenseInferred = true;
      }
      const ownComma = (byId.get(id)?.ends ?? '').includes(',');
      words.push(comma.has(id) || (ownComma && id !== lastId) ? `${w},` : w);
    }
    if (words.length === 0) continue;

    // the contributor's own terminator wins; the plan only chooses one where
    // they left the thought unpunctuated
    const own = byId.get(lastId)?.ends ?? '';
    const kept = SENTENCE_PUNCT.exec(own);
    const sentence = words.join(' ') + (kept !== null ? kept[0] : (s.terminator ?? '.'));
    if (s.para === true && paragraphs[paragraphs.length - 1]!.length > 0) paragraphs.push([]);
    paragraphs[paragraphs.length - 1]!.push(sentence);
  }

  const prose = paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join(' '))
    .join('\n\n');

  /* title — a verbatim quote of a source span, then the shipped arbiter */
  let title = '';
  if (plan.title !== undefined && plan.title !== null) {
    const raw = tokens
      .filter((t) => t.id >= plan.title!.from && t.id <= plan.title!.to)
      .map((t) => t.text)
      .join(' ');
    const cleaned = canonicalTitle(
      raw
        .replace(/[[\]#^|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ).slice(0, 60);
    if (cleaned !== '' && validateNoteTitle(cleaned) === null) title = cleaned;
  }
  if (title === '') title = readTitle(req.text, req.media?.filename ?? null);

  /* occurred — the model may only POINT at a token; the shipped reader decides */
  let occurred: string | null = null;
  if (plan.dateToken !== undefined && plan.dateToken !== null) {
    const t = byId.get(plan.dateToken);
    const owner = plan.sentences.find((s) => plan.dateToken! >= s.from && plan.dateToken! <= s.to);
    if (t !== undefined && owner !== undefined) {
      const scope = tokens
        .filter((x) => x.id >= owner.from && x.id <= owner.to)
        .map((x) => x.text)
        .join(' ');
      const d = readFuzzyDate(scope);
      // the year the reader found must be the year the model pointed at
      if (d !== null && t.text.includes(d.replace(/^~/, '').slice(0, 4))) occurred = d;
    }
  }
  if (occurred === null) occurred = readFuzzyDate(req.text);

  const type: EntityType =
    plan.type !== undefined &&
    plan.type !== null &&
    (ENTITY_TYPES as readonly string[]).includes(plan.type)
      ? (plan.type as EntityType)
      : readType(req.text, req.media !== null);

  const embed = req.media?.contentHash ? `![[${req.media.contentHash}]]\n\n` : '';
  const { body: linkedProse, linked } = linkKnownTitles(prose, req.titles);

  /* notes — written HERE, from what actually happened, never by the model */
  const notes: string[] = [];
  notes.push(title === '' ? NOTE.TITLE_NONE : NOTE.TITLE(title));
  notes.push(occurred === null ? NOTE.DATE_NONE : NOTE.DATE(occurred));
  if (plan.sentences.length > 1) notes.push(NOTE.SPLIT(plan.sentences.length));
  if (reordered) notes.push(NOTE.ORDER);
  if (endings.length > 0) notes.push(NOTE.ENDING);
  if (tenseInferred) notes.push(NOTE.TENSE);
  if (droppedWords.length > 0) notes.push(NOTE.FILLER([...new Set(droppedWords)]));
  else notes.push(NOTE.KEPT_ALL);
  if (spacing.size > 0) notes.push(NOTE.SPACING);
  if (linked.length > 0) notes.push(NOTE.LINKED(linked));
  if (req.media?.contentHash) notes.push(NOTE.PHOTO_IN);
  else if (req.media) notes.push(NOTE.PHOTO_LATER);
  const oddLine = Array.isArray(plan.oddLine) && plan.oddLine.length > 0;
  if (oddLine) notes.push(NOTE.ODD_LINE);
  notes.push(NOTE.NO_ADD);

  return {
    body: embed + linkedProse,
    title,
    type,
    occurred,
    notes,
    did: {
      sentences: plan.sentences.length,
      reordered,
      endings,
      dropped: [...new Set(droppedWords)],
      respaced: spacing.size,
      linked,
      tenseInferred,
      oddLine,
    },
  };
}

/* ── the gate: an independent proof, run on the rendered result ───────── */

/**
 * `GroundingGate` (see drafts-claude.ts) re-checked WITHOUT reference to the
 * plan.
 *
 * This is deliberate duplication. `validatePlan` proves the plan is legal;
 * this proves the STRING that came out is legal, by the definition that
 * matters: every run of Hangul/Latin/digits in the body either occurs in the
 * contributor's text, or is a source token with one ENDINGS rule applied.
 * A bug in `applyPlan` — an off-by-one slice, a stray concatenation — is
 * exactly the kind of defect the plan validator cannot see, and it is the only
 * remaining way a character the contributor did not type could reach the body.
 *
 * It is cheap (one pass, a Set) and it is the required non-optional dependency
 * of `ClaudeCliDraftProvider`, so there is no code path that returns a body
 * this function has not approved.
 */
export class EditPlanGate {
  readonly gateVersion = PLAN_VERSION;

  check(
    candidate: DraftResult,
    req: DraftRequest,
  ): { accepted: DraftResult | null; why: string[] } {
    const src = stripInvisible(req.text).normalize('NFC');
    const body = stripInvisible(candidate.body).normalize('NFC');
    const why: string[] = [];

    // strip what the server itself is allowed to have added
    const prose = body.replace(/!\[\[[0-9a-f]{16,}\]\]/g, ' ').replace(/\[\[|\]\]/g, ' ');

    for (const m of prose.matchAll(/[\p{Script=Hangul}A-Za-z0-9]+/gu)) {
      const w = m[0];
      if (src.includes(w)) continue;
      if (
        ENDINGS.some((e) => w.endsWith(e.to) && src.includes(w.slice(0, -e.to.length) + e.from))
      ) {
        continue;
      }
      why.push(`"${w}" does not occur in the contributor's text`);
      if (why.length >= 5) break;
    }

    for (const t of candidate.title === '' ? [] : [candidate.title]) {
      if (!src.includes(t.replace(/\s+/g, ' ').trim()) && !src.includes(t)) {
        // a title assembled from a token span may differ from the source only
        // by the spacing this file re-supplied; compare with spacing removed
        if (t.replace(/\s/g, '') !== '' && !src.replace(/\s/g, '').includes(t.replace(/\s/g, ''))) {
          why.push(`title "${t}" is not a quotation of the contributor's text`);
        }
      }
    }

    return why.length === 0 ? { accepted: candidate, why: [] } : { accepted: null, why };
  }
}

/* ── the photograph: quarantined, never mixed into the memory ─────────── */

/**
 * A machine-written description of a photograph is NOT a memory and must never
 * be laundered into one. It does not go in `body`, it does not contribute to
 * `title`, `occurred` or `type`, and it does not pass through the plan (there
 * is no source text to plan over — every word of it would be invented, which is
 * exactly what the rest of this file exists to forbid).
 *
 * It rides beside the draft, off by default, with the Korean sentence that says
 * who wrote it. If the contributor opts in, the server — not the model — wraps
 * it in the marker below, so the attribution cannot be edited away by accident
 * and survives into the markdown export.
 */
export const PHOTO_AI_MARKER =
  '> 🖼 프로그램이 사진을 보고 적은 설명입니다. 가족의 기억이 아닙니다.';

export function quarantinePhotoDescription(text: string): string {
  const clean = stripInvisible(text)
    .normalize('NFC')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 400)
    .trim();
  return clean === '' ? '' : `${PHOTO_AI_MARKER}\n> ${clean}`;
}
