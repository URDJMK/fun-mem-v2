/**
 * FM-072 — "let the app write the memory for me", with a model, safely.
 *
 * THE IDEA IN ONE LINE: the model never writes prose. It writes a PLAN over the
 * contributor's own words, expressed entirely as integers and enum tags, and
 * the server applies it.
 *
 * The alternative — let a model write prose and then check whether the prose
 * is grounded — was measured twice on this codebase and both measurements
 * came back with the same shape of answer: the check is good but not total.
 * Character n-gram similarity ranks fabrications ABOVE honest rewordings. Word
 * containment catches every invented noun but cannot catch a sentence
 * assembled entirely from the contributor's own words in a new arrangement
 * ("Grandma boiled noodles for us." + "There was a bench in the yard." ->
 * "Grandma boiled noodles for us in the yard.", zero novel words, one invented
 * place-relation).
 *
 * A plan closes that hole structurally rather than statistically:
 *
 *   INV-1  COVERAGE   every source token appears exactly once in the output,
 *                     or is dropped and repeats the token right before it
 *                     (a stutter).
 *   INV-2  CONTIGUITY every output sentence is one ascending contiguous run of
 *                     source token ids. There is no join, no move-a-word, no
 *                     cross-sentence recombination — the operation does not
 *                     exist in the schema, so it cannot be requested.
 *   INV-3  CLOSED     the only characters in the body that were not copied from
 *          VOCABULARY the source are ' ', '\n', ',', '.', '?' and '!'. Nothing
 *                     else can enter, and no word is cut or rewritten: a space
 *                     put inside a word makes new words ("the rapist" out of
 *                     "therapist").
 *   INV-4  NO PROSE   the model emits no free text ANYWHERE — not in `body`,
 *                     not in `title`, not in `notes`. `notes` is rendered by
 *                     the server from what the plan actually did.
 *   INV-5  READABLE   a run may end only where the contributor's own words
 *                     already end a sentence, so a cut cannot produce "…we went
 *                     home and." — broken grammar nothing here may repair.
 *   INV-6  NO MERGE   joining two of the contributor's sentences is not
 *                     allowed. A full stop they typed is a boundary no run may
 *                     span.
 *
 * So the worst a captured or confused model can do is a BAD REARRANGEMENT of
 * the family's own words. That is visible in the diff, reversible in one edit,
 * and — unlike an invented sentence — it is not a new claim about a dead
 * person. Fabrication is not detected here. It is unrepresentable.
 *
 * WHAT THE MODEL IS ACTUALLY FOR, then: putting the contributor's sentences in
 * an order that reads, breaking them into paragraphs, adding the commas and the
 * last full stop a voice-typed paragraph lacks, dropping a stutter, choosing
 * which span is the title and which token is the date, and picking the entity
 * type. None of it requires the power to write a sentence.
 */

import { ENTITY_TYPES, canonicalTitle, validateNoteTitle, type EntityType } from '@funmem/core';
import { stripInvisible } from '@funmem/persona';
import {
  DRAFT_NOTES,
  linkKnownTitles,
  readFuzzyDate,
  readTitle,
  readType,
  type DraftRequest,
  type DraftResult,
} from './drafts';

export const PLAN_VERSION = 'editplan-2';

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
   * Kept, not discarded, because it is the load-bearing evidence for INV-6: a
   * full stop is the contributor saying "this thought ends here", and a plan
   * that spans it is merging two of their sentences into one.
   */
  ends: string;
}

const SENTENCE_PUNCT = /[.!?…]/;

/**
 * Split the contributor's text into numbered words.
 *
 * WHY WORDS AND NOT CHARACTER OFFSETS. Both were considered; offsets lose. A
 * model asked for `[start, end)` into the text gets them wrong often enough
 * that the repair loop becomes the common path, and an off-by-one offset
 * silently produces a MUTILATED word — "wasn't" -> "was" flips a negation.
 * Token ids cannot be off by a fraction of a word, and no operation reaches
 * inside a word at all.
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
      const m = /[.,!?…·:;]+$/u.exec(raw);
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

const TERMINATORS = new Set(['.', '?', '!', '']);

/* ── the plan: the model's entire output surface ─────────────────────── */

export interface PlanSentence {
  /** inclusive token-id range; INV-2 lives here */
  from: number;
  to: number;
  /** blank line before this sentence */
  para?: boolean;
  /** always absent or null: no word is ever rewritten (a plan that names one is refused) */
  ending?: string;
  /**
   * Token ids inside [from, to] to delete; each must repeat the token right before it.
   *
   * A drop is the one operation that removes meaning, so it is closed: a model that may
   * delete an arbitrary token may flip a negation, and "he did not ask me anything" ->
   * "he did ask me anything" is a fabrication of the exact kind this file exists to make
   * impossible. Only a stutter ("the the") may go.
   */
  drop?: number[];
  /** token ids inside [from, to] after which to place a comma */
  comma?: number[];
  /** '.' | '?' | '!' | '' */
  terminator?: string;
}

/** A re-cut of one word. Never allowed: kept in the schema only so a plan that asks is refused. */
export interface PlanSpacing {
  id: number;
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
          if (!stutter) {
            // the load-bearing refusal: only a repetition may be deleted
            why.push(
              `token ${id} ("${t.text}") does not repeat the word before it and may not be dropped`,
            );
          }
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
     * INV-6: the contributor's own sentence boundaries are inviolable.
     *
     * A full stop the contributor typed is them saying "this thought ends here",
     * and spanning it joins two separate statements into one — which is exactly
     * the recombination that every text-level grounding check was measured to be
     * blind to ("Grandma boiled noodles for us." + "There was a bench in the
     * yard." -> one sentence asserting where the noodles were made). Zero novel
     * words, one new claim. Here the plan simply cannot express it.
     */
    for (let id = s.from; id < s.to; id++) {
      const t = byId.get(id);
      if (t !== undefined && SENTENCE_PUNCT.test(t.ends)) {
        why.push(
          `sentence ${si}: token ${id} ("${t.raw}") already ends a sentence — a run may not span it`,
        );
      }
    }

    /**
     * INV-5: a sentence may only end where a sentence already ends: where the
     * contributor put a full stop themselves, or on a link they typed. The final
     * sentence of the plan is exempt, because the contributor's text ends where it
     * ends, and refusing that would mean refusing the memory.
     */
    if (s.to !== n) {
      let last = s.to;
      while (last >= s.from && (s.drop ?? []).includes(last)) last--;
      const t = last >= s.from ? byId.get(last) : undefined;
      const ok = t === undefined || SENTENCE_PUNCT.test(t.ends) || t.text.includes('[[');
      if (!ok) {
        why.push(
          `sentence ${si}: "${t.text}" cannot end a sentence — cut somewhere a sentence already ends, or leave the run joined`,
        );
      }
    }

    // INV-3: no word is rewritten
    if (s.ending !== undefined) {
      why.push(`sentence ${si}: "ending" must be null — no word is rewritten`);
    }
  }

  for (let id = 1; id <= n; id++) {
    if (seen[id] !== 1)
      why.push(`token ${id} ("${byId.get(id)!.text}") is missing from the output`);
  }

  // INV-3: no word is cut either
  if (plan.spacing !== undefined) {
    if (!Array.isArray(plan.spacing)) why.push('spacing must be an array');
    else if (plan.spacing.length > 0) why.push('spacing must be empty — no word is cut');
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
    dropped: string[];
    linked: string[];
    oddLine: boolean;
  };
}

const NOTE = {
  KEPT_ALL: 'Not one word you wrote was taken out.',
  NO_ADD:
    'Nothing was added: every word in this draft is one you wrote. Only the sentences and their order were arranged.',
  SENTENCES: (k: number) => `The text is set out in ${k} sentences.`,
  ORDER: 'The order of the sentences was changed. If the original order is right, change it back.',
  STUTTER: (w: string[]) => `Only words said twice in a row were taken out: ${w.join(', ')}`,
  TITLE: (t: string) => `The title is taken word for word from what you wrote: “${t}”`,
  ODD_LINE:
    'One line reads like an instruction to a program rather than a memory. It was left as it is; delete it before saving if it is not wanted.',
  PHOTO_AI:
    'The photo description was written by a program looking at the photograph, not by a person. It is not a family memory, so it is kept apart from the text.',
} as const;

/**
 * Render the plan. This function — not the model — writes every character of
 * the body, and it can only write source tokens plus the closed vocabulary.
 */
export function applyPlan(plan: EditPlan, tokens: Token[], req: DraftRequest): AppliedPlan {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const droppedWords: string[] = [];

  const paragraphs: string[][] = [[]];
  let reordered = false;
  let cursor = 0;

  for (const s of plan.sentences) {
    if (s.from < cursor) reordered = true;
    cursor = s.from;

    const drop = new Set(s.drop ?? []);
    const comma = new Set(s.comma ?? []);
    let lastId = s.to;
    while (lastId >= s.from && drop.has(lastId)) lastId--;

    const words: string[] = [];
    for (let id = s.from; id <= s.to; id++) {
      const t = byId.get(id)!;
      if (drop.has(id)) {
        droppedWords.push(t.text);
        continue;
      }
      const ownComma = (byId.get(id)?.ends ?? '').includes(',');
      words.push(comma.has(id) || (ownComma && id !== lastId) ? `${t.text},` : t.text);
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
  notes.push(title === '' ? DRAFT_NOTES.titleNone : NOTE.TITLE(title));
  notes.push(occurred === null ? DRAFT_NOTES.dateNone : DRAFT_NOTES.date(occurred));
  if (plan.sentences.length > 1) notes.push(NOTE.SENTENCES(plan.sentences.length));
  if (reordered) notes.push(NOTE.ORDER);
  if (droppedWords.length > 0) notes.push(NOTE.STUTTER([...new Set(droppedWords)]));
  else notes.push(NOTE.KEPT_ALL);
  if (linked.length > 0) notes.push(DRAFT_NOTES.linked(linked));
  if (req.media?.contentHash) notes.push(DRAFT_NOTES.photoIn);
  else if (req.media) notes.push(DRAFT_NOTES.photoLater);
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
      dropped: [...new Set(droppedWords)],
      linked,
      oddLine,
    },
  };
}

/* ── the gate: an independent proof, run on the rendered result ───────── */

/**
 * A run of characters the check compares: ASCII letters and digits, and every letter
 * or digit of a script other than the Latin alphabet (opaque words, compared exactly).
 */
const RUN =
  /(?:[A-Za-z0-9]|(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}|(?![0-9])\p{Nd})+/gu;

/**
 * `GroundingGate` (see drafts-claude.ts) re-checked WITHOUT reference to the
 * plan.
 *
 * This is deliberate duplication. `validatePlan` proves the plan is legal;
 * this proves the STRING that came out is legal, by the definition that
 * matters: every run of letters and digits in the body occurs in the
 * contributor's text. A bug in `applyPlan` — an off-by-one slice, a stray
 * concatenation — is exactly the kind of defect the plan validator cannot see,
 * and it is the only remaining way a character the contributor did not type
 * could reach the body.
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

    for (const m of prose.matchAll(RUN)) {
      const w = m[0];
      if (src.includes(w)) continue;
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
 * It rides beside the draft, off by default, with the sentence that says who
 * wrote it. If the contributor opts in, the server — not the model — wraps it
 * in the marker below, so the attribution cannot be edited away by accident
 * and survives into the markdown export.
 */
export const PHOTO_AI_MARKER =
  '> 🖼 A description written by a program looking at the photograph. It is not a family memory.';

export function quarantinePhotoDescription(text: string): string {
  const clean = stripInvisible(text)
    .normalize('NFC')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 400)
    .trim();
  return clean === '' ? '' : `${PHOTO_AI_MARKER}\n> ${clean}`;
}
