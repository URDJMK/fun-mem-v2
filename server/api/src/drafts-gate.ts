import { validateNoteTitle, type EntityType } from '@funmem/core';
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
import {
  checkGrounding,
  checkTitle,
  textWords,
  shownText,
  type GroundingReport,
} from './grounding-check';

/**
 * THE GATE.
 *
 * The model drafts freely. Then this runs, mechanically, on the result — and
 * anything it cannot prove against the contributor's own words is DISCARDED,
 * with the deterministic composer's draft returned in its place and a note
 * saying so.
 *
 * That asymmetry is the whole design. `DeterministicComposer` already ships,
 * already works, and is already covered by 16 tests, so it is a real
 * implementation rather than a degraded mode. The model is therefore strictly
 * upside: on a good day the contributor gets fluent prose built from their own
 * sentences; on a bad day they get exactly what they get today. There is no
 * outcome in which the model makes the archive worse, because the only way its
 * prose reaches a note is by being provable.
 *
 * WHAT THE MODEL IS ALLOWED TO PRODUCE — two fields, and only two:
 *
 *   title    proposed, then checked (arbiter + grounding); falls back per-field
 *   body     proposed, then checked; failure discards the WHOLE draft
 *
 * Everything else is RE-DERIVED here from the contributor's text and never read
 * from the model at all:
 *
 *   occurred `readFuzzyDate` — measured 1/6 valid from the model against the
 *            regex's exact compliance, and FR-062's rule that a year-only
 *            memory must never sprout a month is a rule about restraint, which
 *            is the one thing a fluent model will not supply. A model asked for
 *            a date produces one.
 *   type     `readType` — there is no prose to check a type against, so there
 *            is nothing for this gate to prove. A wrong `person` distorts the
 *            sky and the people list at once.
 *   notes    written by code, from what the check actually found. See below.
 *   links    `linkKnownTitles` — it only ever links to a title that exists.
 *   embed    `![[contentHash]]` — a content-addressed identity. A hallucinated
 *            hash is a broken image.
 *
 * WHY THE MODEL'S `notes` ARE DISCARDED ENTIRELY. `notes[]` is the one field
 * that is model-authored free text by construction, so the grounding check
 * cannot apply to it — and it is rendered at the exact moment the contributor
 * decides whether to save. An injected "Reviewed — save it as it is" would
 * appear in the same list, in the same voice, as this system's own
 * explanations. Code knows strictly more about what happened to this draft than
 * the model does, so the model's version buys nothing and costs the only
 * unchecked channel to the human at the only moment it matters.
 *
 * WHY THERE IS NO REPAIR LOOP. Re-prompting with the offending words named is
 * cheap and does work. It is still not here: it doubles a 10s latency for a
 * second coin flip, and the floor without it is already an acceptable draft.
 * "Discard and fall back" is one code path with one outcome, and one code path
 * is what a check protecting a dead person's record should be.
 */

/* ── what the model may hand us ──────────────────────────────────────── */

/**
 * A photograph description is NOT part of `DraftResult` and must not be, so it
 * arrives beside it. A description of a photograph cannot be grounded in the
 * contributor's words — there are none, or they are about something else — so
 * it is not prose this gate can prove. It is handled by a different rule, and
 * lands in the body under a label. See `photoBlock`.
 */
export interface DraftCandidate extends DraftResult {
  readonly photo?: string | null;
}

export interface GateOutcome {
  accepted: DraftResult | null;
  why: string[];
}

/* ── what the contributor is told, all of it ─────────────────────────── */

const SAY = {
  /** shown when the model's draft was kept */
  kept: 'Tidied by the AI, then checked by a program to make sure nothing was added that you did not write.',
  keptCaveat:
    'Please still read it and correct anything that is wrong. Nothing is saved until you save it.',
  /** shown when the model's draft was thrown away */
  rejectedInvention: (ws: string[]) =>
    `The AI's draft contained words you did not write, so it was not used: ${ws.join(', ')}.`,
  rejectedLoss: (ws: string[]) =>
    `The AI's draft left out some of what you wrote, so it was not used: ${ws.join(', ')}.`,
  rejectedLossSentence: "The AI's draft left out a whole sentence you wrote, so it was not used.",
  rejectedNegation:
    'The AI\'s draft left out or added a "not" or a "never", which could reverse the meaning, so it was not used.',
  rejectedHedge:
    'The AI\'s draft changed your doubt, tense or condition ("maybe", "could", "if", "was"), so it was not used. What you were not sure of stays as you wrote it.',
  rejectedPerson: "The AI's draft named a person differently from you, so it was not used.",
  rejectedSentence:
    "The AI's draft had a sentence you did not write in any one place, so it was not used.",
  rejectedTail: 'Below is what you wrote, as you wrote it.',
  titleFallback:
    "The AI's title had words you did not write, so the title was taken from your first sentence.",
  photoLabel: 'Photo description — written by an AI looking at the photograph. It is not a memory.',
  photoAdded:
    'The photo description was written by an AI from the photograph alone, so it is set apart in a quote. If it is wrong, delete it and write your own.',
  photoDropped: 'The photo description was not added: it read as if it recognised a person.',
  photoUnread: 'The photo description was not added: it is in a script the check cannot read.',
  photoOnly:
    'You did not write anything, so the text is left empty. Write a line and it will be kept as you wrote it.',
} as const;

/** A hard cap on how many offending words are read back. */
const NAME_LIMIT = 8;
const names = (ws: string[]): string[] =>
  ws.length <= NAME_LIMIT ? ws : [...ws.slice(0, NAME_LIMIT), `and ${ws.length - NAME_LIMIT} more`];

/**
 * One sentence per kind of problem, most concrete first: an invented word is named, a
 * reversed "not" is described. The checker's own `detail` is for the model and logs.
 */
function whyOf(report: GroundingReport): string[] {
  const kinds = new Set(report.violations.map((v) => v.kind));
  const out: string[] = [];
  if (kinds.has('invented') || kinds.has('number'))
    out.push(SAY.rejectedInvention(names(report.ungrounded)));
  if (kinds.has('person')) out.push(SAY.rejectedPerson);
  if (kinds.has('negation')) out.push(SAY.rejectedNegation);
  if (kinds.has('hedge')) out.push(SAY.rejectedHedge);
  if (kinds.has('unsupported_sentence')) out.push(SAY.rejectedSentence);
  if (kinds.has('dropped'))
    out.push(
      report.lost.length > 0 ? SAY.rejectedLoss(names(report.lost)) : SAY.rejectedLossSentence,
    );
  return out;
}

/* ── the photograph rule ─────────────────────────────────────────────── */

/**
 * Kinship and identity words. A vision model writing "Mother is smiling" has
 * IDENTIFIED a person in a photograph — which is the single fabrication a
 * photograph invites and the one a grieving family is least able to doubt.
 * A description may say what is visible. It may not say who anyone is.
 */
const PHOTO_DENY =
  /\b(?:(?:grand|step|god)?(?:mother|father|ma|pa)s?|mom|mum|mommy|mummy|mama|mamas|dad|daddy|papa|granny|nana|granddad|grandad|(?:grand)?(?:son|daughter)s?|grandchild(?:ren)?|brothers?|sisters?|husbands?|wife|wives|aunts?|aunties?|uncles?|cousins?|nieces?|nephews?|family|deceased|the late|passed away)\b/i;
/** Any run of digits: a year, an age or a count read off a photograph is a guess. */
const PHOTO_DIGITS = /\d/;
/** A letter of another script: the rule above cannot read a word holding one, so it cannot vouch for it. */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;
const PHOTO_MAX = 200;

/**
 * A machine-made description, marked as machine-made IN THE STORED TEXT.
 *
 * The marker is a blockquote inside `body`, not a `notes[]` entry, and that is
 * the point: `notes[]` is discarded when the contributor saves, while `body` is
 * what `/ask` will later retrieve and cite. A sentence a machine wrote about a
 * dead person must still say so on its face after every living person who saw
 * the draft has forgotten there was a draft.
 */
function photoBlock(raw: string | null | undefined): { block: string; note: string } | null {
  if (typeof raw !== 'string') return null;
  const text = stripInvisible(raw)
    .replace(/!?\[\[[^\][]*\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  if (OTHER_SCRIPT.test(text)) return { block: '', note: SAY.photoUnread };
  if (text.length > PHOTO_MAX || PHOTO_DENY.test(text) || PHOTO_DIGITS.test(text)) {
    return { block: '', note: SAY.photoDropped };
  }
  return { block: `> **${SAY.photoLabel}**\n> ${text}`, note: SAY.photoAdded };
}

/* ── the gate ────────────────────────────────────────────────────────── */

const TITLE_MAX = 60;
/**
 * The model's links are discarded and re-derived; what stays is what a reader would have
 * seen: `[[Title|words]]` -> words, `[[Title]]` -> Title, an embed -> nothing. (Taking the
 * inside of the brackets whole left a literal "Title|words" in the saved note.)
 */
const unlink = (s: string): string => shownText(s);

/**
 * Wikilink targets the CONTRIBUTOR typed themselves.
 *
 * The model's links are discarded wholesale — it will invent `[[Grandma]]` for
 * an archive with no such note — and `linkKnownTitles` re-derives from the real
 * title list afterwards. But a link the contributor typed to a note that does
 * not exist YET is a deliberate act (it is how you plan the next memory), so
 * their targets are added to the list `linkKnownTitles` is allowed to use.
 */
function contributorLinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/!?\[\[([^\]|#]+)/g)) {
    const t = (m[1] ?? '').trim();
    if (t !== '') out.push(t);
  }
  return out;
}

/*
 * How much of the contributor's own content must survive is decided in grounding-check.ts:
 * every word of each turn but fillers ("you know") and one intensifier in ten ("really"),
 * and every sentence, one-word ones too (it was 50% of the whole text, then 90% of each
 * turn, which let a rewrite drop "He died." or "I heard that" from a long answer and still
 * pass). All 46 recorded real-model proposals keep every word.
 */

export class GroundingGate {
  /**
   * Rides in `providerVersion` as `claude-cli-<ver>+grounded-5`.
   *
   * BUMP IT whenever `SCAFFOLD`, the word lists or the retention rules change. A
   * draft's auditability depends on knowing which rules approved it — the same
   * reason `modelVersion` rides on every embedding row. "Which model wrote this"
   * is only half the question.
   *
   * 2: negation, hedges, people and numbers are must-keep; whole words only (no
   * prefix or substring); every sentence from one place; 90% of each turn kept.
   * 3: modals, tense and conditions are kept (could have died, is → was, if/unless).
   * 4: who it came from, how often and how far are kept (I heard that, in my dream,
   * sometimes, still); a turn may lose fillers, a tenth of its intensifiers and nothing
   * else; a one-word sentence is kept like any other. Joining sentences adds no cause,
   * contrast or order (so, but, then); sentences keep the order they were said in, each
   * said once; to/from keep their direction. The speaker stays "I" (no "he", "she",
   * "you" in their place); "have done" and "was doing" are kept like a tense.
   * 5: English only: a word in a script these rules do not read is compared exactly and
   * kept in order; every word-keyed table is a Map, so "constructor" is just a word.
   */
  readonly gateVersion = 'grounded-5';

  check(candidate: DraftCandidate, req: DraftRequest): GateOutcome {
    const source = stripInvisible(req.text).normalize('NFC');
    const hasWords = source.trim() !== '';
    const photo = photoBlock(candidate.photo);

    /* fields the model never gets a say in */
    const occurred: string | null = readFuzzyDate(source);
    const type: EntityType = readType(source, req.media !== null);
    const embed = req.media?.contentHash ? `![[${req.media.contentHash}]]` : '';

    /* --- body: the check that can discard the whole draft --- */
    const proposed = unlink(stripInvisible(candidate.body)).trim();
    const why: string[] = [];

    if (!hasWords) {
      /**
       * No words means no evidence, and no evidence means nothing can be
       * proved. This is not an edge case to be softened — it is the check
       * working: a photograph with no account attached to it is a `source`,
       * and the honest draft of one is empty.
       */
      if (proposed !== '') {
        return {
          accepted: null,
          why: [SAY.rejectedInvention(names(textWords(proposed).slice(0, NAME_LIMIT)))],
        };
      }
      const notes: string[] = [SAY.photoOnly];
      if (photo) notes.push(photo.note);
      return {
        accepted: {
          title: readTitle(source, req.media?.filename ?? null),
          type,
          occurred,
          body: [embed, photo?.block ?? ''].filter((s) => s !== '').join('\n\n'),
          notes,
        },
        why: [],
      };
    }

    const report = checkGrounding(source, proposed);

    // anything wrong at all discards the draft: an invented word, a dropped sentence, a
    // reversed "not", a moved "maybe", a different relative, a sentence from nowhere
    if (report.violations.length > 0) {
      return { accepted: null, why: [...whyOf(report), SAY.rejectedTail] };
    }

    /* --- title: checked with the same rules (a label may leave things out), falls back alone --- */
    const proposedTitle = unlink(stripInvisible(candidate.title)).replace(/\s+/g, ' ').trim();
    let title = '';
    let titleFellBack = false;
    const titleCheck = proposedTitle === '' ? null : checkTitle(source, proposedTitle);
    if (
      proposedTitle !== '' &&
      proposedTitle.length <= TITLE_MAX &&
      validateNoteTitle(proposedTitle) === null &&
      titleCheck !== null &&
      titleCheck.ungrounded.length === 0 &&
      titleCheck.violations.length === 0
    ) {
      title = proposedTitle;
    } else {
      title = readTitle(source, req.media?.filename ?? null);
      titleFellBack = proposedTitle !== '';
    }

    /* --- links and embed, re-derived --- */
    const { body: linked, linked: hits } = linkKnownTitles(proposed, [
      ...req.titles,
      ...contributorLinkTargets(source),
    ]);

    const notes: string[] = [SAY.kept, SAY.keptCaveat];
    if (titleFellBack) notes.push(SAY.titleFallback);
    if (hits.length > 0) notes.push(DRAFT_NOTES.linked(hits));
    notes.push(occurred ? DRAFT_NOTES.date(occurred) : DRAFT_NOTES.dateNone);
    if (photo) notes.push(photo.note);

    return {
      accepted: {
        title,
        type,
        occurred,
        body: [embed, photo?.block ?? '', linked].filter((s) => s !== '').join('\n\n'),
        notes,
      },
      why,
    };
  }
}
