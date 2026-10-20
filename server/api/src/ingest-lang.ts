import { stripInvisible } from '@funmem/persona';
import { validateNoteTitle } from '@funmem/core';
import { shownText } from './grounding-check';
import { checkTitleFacts } from './title-check';
import { formatClock } from './clock';

/**
 * The words ingestion writes, and the titles it accepts: which sentences the reviewer is
 * shown, what the saved-note footer says, and what counts as an acceptable title.
 *
 * All of it is English: v2 reads and writes English only (docs/adr/0003). The footer is
 * written into the saved note, so it is not a display string: it is a permanent sentence in
 * someone's archive.
 *
 * Words in a script these rules do not read (Greek, Cyrillic, Arabic, Han, …) are OPAQUE:
 * kept exactly as they were said, never translated, and never let past a check because no
 * rule here understands them.
 */

/**
 * A letter of a script other than the Latin alphabet: a word holding one is opaque to these
 * rules. (Letters every script shares, like "µ", are not counted.)
 */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;

/* ── speaker labels ──────────────────────────────────────────────────── */

/**
 * Labels that name a ROLE or a voice, never a person: what a transcription tool or a
 * hand-typed transcript calls someone it does not know. Anything else ("Grandpa Tae",
 * "Mom") is the name the family used, and is written as who told the memory.
 */
const GENERIC_LABEL = new RegExp(
  String.raw`^(?:speaker|spk|spkr|voice|person|participant|interviewee|interviewer|respondent|narrator|subject|guest|host|moderator|unknown(?:\s*speaker)?|questions?|answers?|caller|user|q|a|b|c|d|s|p)(?:[\s_\-#.:]*(?:\d+|[a-z]))?$`,
  'i',
);

/**
 * A speaker id as a person would read it: the transcript reader renames an id that collides
 * with one it assigns itself or with an object property ("constructor" -> "constructor
 * (speaker)"); the name is still the part before that.
 */
export const labelOf = (id: unknown): string =>
  typeof id === 'string' ? id.replace(/ \(speaker\)$/, '') : '';

/** Is this speaker label a person's name (as opposed to "SPEAKER_01", "Speaker 2", "Q")? */
export function isPersonLabel(label: unknown): boolean {
  const t = cleanLabel(labelOf(label));
  if (t === '' || !/\p{L}/u.test(t)) return false;
  if (/^\p{L}$/u.test(t)) return false;
  return !GENERIC_LABEL.test(t);
}

/* ── strings ─────────────────────────────────────────────────────────── */

export interface Strings {
  kept: string;
  keptCaveat: string;
  dateFound: (d: string) => string;
  noDate: string;
  linked: string;
  /** why the AI's rewrite was not used, one sentence per kind of problem (each without the tail) */
  rejectedInvention: (words: string[]) => string;
  rejectedLoss: string;
  rejectedNegation: string;
  rejectedHedge: string;
  rejectedPerson: string;
  rejectedSentence: string;
  /** the AI put a whole stretch of the interview into one note */
  rejectedTooBig: string;
  /** what the reviewer sees instead: "Showing what was said, as spoken." */
  rejectedShown: string;
  notTidied: string;
  /** the note that gathers one-line replies */
  shortTitle: string;
  shortNote: string;
  /** shown to the reviewer: this memory may disagree with a note that already exists */
  conflict: (title: string, existing: string) => string;
  /** the source line saved into the note, with the interviewer's question when there was one */
  footer: (
    start: number | null,
    end: number | null,
    question?: string | null,
    /** where it came from: the file or interview's own name, and who told it */
    from?: { source?: string | null; teller?: string | null },
  ) => string;
}

const when = (start: number | null, end: number | null): string =>
  start === null
    ? ''
    : end === null
      ? ` (${formatClock(start)})`
      : ` (${formatClock(start)}–${formatClock(end)})`;

/**
 * The interviewer's question, quoted, ABOVE the source line. An answer like
 * "Small. We had it at the church" is a fragment on its own; the question is what
 * makes it a memory. It is labelled as the question (the interviewer's words,
 * never testimony) and sits in the footer, outside the part the grounding check
 * vouches for.
 */
const asked = (q: string | null | undefined, label: string): string => {
  const t = (typeof q === 'string' ? q : '').replace(/\s+/g, ' ').trim();
  // the pipeline decides WHICH turn is the question; a short one ("When?") is still the question
  if (t === '') return '';
  return `> ${label}: “${t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t}”\n`;
};

/**
 * A name or file name that is safe to write into a note: one line, no links, no markdown quote.
 * Total: anything that is not a string (a speaker id that collided with `Object.prototype`, a
 * number) is ''.
 */
export const cleanLabel = (s: unknown, max = 80): string => {
  if (typeof s !== 'string') return '';
  const t = s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\[\[|\]\]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/^[\s>#]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const list = (ws: string[]): string => (ws.length <= 6 ? ws : [...ws.slice(0, 6), '…']).join(', ');

export const STRINGS: Strings = {
  kept: 'Tidied by the AI, then checked by a program to make sure nothing was added that was not said.',
  keptCaveat:
    'Please still read it and correct anything that is wrong. Nothing is saved until you save it.',
  dateFound: (d) => `Found a date in what was said: ${d}`,
  noDate: 'No date given. It is fine if it is not remembered.',
  linked: 'Linked to notes that already exist.',
  rejectedInvention: (ws) =>
    `The AI's rewrite contained words that were not said, so it was not used: ${list(ws)}.`,
  rejectedLoss: "The AI's rewrite left out part of what was said, so it was not used.",
  rejectedNegation:
    'The AI\'s rewrite left out or added a "not" or a "never", which could reverse the meaning, so it was not used.',
  rejectedHedge:
    'The AI\'s rewrite changed the speaker\'s doubt, tense or condition ("maybe", "could", "if", "was"), so it was not used.',
  rejectedPerson:
    "The AI's rewrite named a person differently from the speaker, so it was not used.",
  rejectedSentence:
    "The AI's rewrite had a sentence the speaker did not say in any one place, so it was not used.",
  rejectedTooBig: 'The AI put too much into one note, so it was not used.',
  rejectedShown: 'Showing what was said, as spoken.',
  notTidied: 'The AI did not tidy this part, so it is shown as spoken.',
  shortTitle: 'Short answers',
  shortNote:
    'Short replies are gathered in this one note, each with the question it answered, so that none is lost.',
  conflict: (title, existing) =>
    `This may disagree with the existing note "${title}", which says: “${existing}”. Both are kept, and the note marks the disagreement.`,
  footer: (s, e, q, from) => {
    const src = cleanLabel(from?.source);
    const who = cleanLabel(from?.teller, 60);
    return `${asked(q, 'Question')}> From ${src ? `“${src}”` : 'the interview transcript'}${who ? ` · told by ${who}` : ''}${when(s, e)}`;
  },
};

/* ── titles ──────────────────────────────────────────────────────────── */

export const TITLE_MAX = 60;

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const tokens = (s: string): string[] => s.match(TOKEN) ?? [];

/** words after which an English phrase cannot stop ("…fishing town on the") */
const DANGLING = new Set(
  (
    'the a an of on in at to and or but with for by from that my his her our their your its he she it they we i you ' +
    'did do does was were is are had has have not so as if when because which who would could will can how what ' +
    'where why whom whose than then there here about after before until through into onto over under between ' +
    'around during without within while though although since nor behind beside beyond toward ' +
    'towards across along among against near past more less most every each some any both very ' +
    'such too also just even really quite rather whose ' +
    // other languages in Latin letters: a title never ends on "de", "la", "und" either
    'de del la el los las en y e o al con por para que se un una le les du des et ou au aux pour ' +
    'dans sur der die das und oder mit von zu im am ein eine di il lo gli ed per su com do da os um uma ' +
    // a title or place word that needs the name after it ("…moved to St", "…met Mr")
    'mr mrs ms dr st mt prof capt sgt rev fr gen col lt'
  ).split(' '),
);
/** a complete label may end on these ("I miss her", "The house we lived in", "Life after") */
const MAY_END = new Set(
  'her it you in on about over there here after before since around then under more too'.split(' '),
);

/** Does an English phrase end on a word that needs a follower? */
function endsDangling(t: string, label: boolean): boolean {
  const last = tokens(t).at(-1)?.toLowerCase();
  if (last === undefined) return false;
  return DANGLING.has(last) && !(label && MAY_END.has(last));
}

/** An injected instruction is never a memory's name. */
const INSTRUCTION =
  /\b(?:ignore|disregard)\b[\s\S]*\b(?:rules?|instructions?|above|previous|prompt|system)\b|\bsystem prompt\b|\bas an ai\b/i;

/**
 * A model-written title, or null.
 *
 * TITLES MAY BE NEW WORDS. The body is held to "provable from what was said"
 * because it is the record; a title is a label that names it, and a label that
 * only reuses the speaker's own words ("I was born in 1941 in a small fishing
 * town on the south") is a sentence, not a name. But a title may not state a new
 * FACT, so beside its SHAPE it is checked by `checkTitleFacts` against the speaker's
 * words (`source`): no number, name, relative or heavy fact ("prison", "murdered",
 * "secret") the speaker did not say.
 *
 *   - in the Latin alphabet: a letter of another script is one these rules cannot
 *     read, so a title holding one is not used (the speaker's own words name the
 *     memory instead), and a title can never come back translated;
 *   - a plain phrase: no link syntax, no markup, no invisible characters, no
 *     trailing full stop, not ending mid-phrase ("Sundays at the"), within
 *     `TITLE_MAX`, and acceptable to `validateNoteTitle` (titles are spliced into
 *     other notes by rename cascades, so that validator is the law).
 *
 * `source` is optional for old callers; the pipeline always passes it.
 */
export function acceptTitle(raw: unknown, source?: string): string | null {
  if (typeof raw !== 'string') return null;
  const t = stripInvisible(raw)
    .normalize('NFC')
    .replace(/[[\]#^|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\.+$/, '')
    .trim()
    // "Yes My father played the flute": an answer word glued to the real start
    .replace(/^(?:[Yy]es|[Yy]eah|[Ww]ell|[Ss]o|[Oo]h|[Oo]kay|[Rr]ight)[,.!]?\s+(?=\p{Lu})/u, '')
    .trim();
  if (t === '' || t.length > TITLE_MAX) return null;
  // a label, never an address: nobody's memory is titled with a link
  if (/https?:|www\.|\w@\w|\.(?:com|org|net|io)\b/i.test(t)) return null;
  if (/[<>`*_~]/.test(t) || INSTRUCTION.test(t)) return null;
  if (OTHER_SCRIPT.test(t) || !/[A-Za-z]/.test(t)) return null;
  if (endsDangling(t, true)) return null;
  if (source !== undefined && !checkTitleFacts(t, source).ok) return null;
  return validateNoteTitle(t) === null ? t : null;
}

const LEAD_FILLER =
  /^(?:(?:um+|uh+|er+|ah+|hmm+|well|so|and|but|you know what|you know|like i said|as i said|i mean|the thing is|okay|oh)[,.]?\s+)+/i;

/** sentence-opening answer words: "Yes." "Well." on their own say nothing to name a memory by */
const ACK = new Set(
  'yes yeah yep yup no nope nah right well okay ok so oh sure mm mmm hmm uh um ah alright true exactly indeed'.split(
    ' ',
  ),
);

/**
 * A period that does not end a sentence: "Mrs.", "St. Louis", "Ford Motor Co.", "the U.S. Army",
 * "5 a.m. every day" (a single Latin letter), and "No." before a number ("Room No. 12"; alone it
 * is the answer "No."). Read on the last characters of a piece only.
 */
const ABBREV_END =
  /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|st|jr|sr|mt|vs|etc|co|inc|ltd|ave|rd|blvd|prof|gen|col|capt|lt|sgt|rev|fr|ft|[a-z])\.["”’')\]]*$/iu;

/** split into sentences, keeping each one's own punctuation; an abbreviation does not split */
const sentencesOf = (t: string): string[] => {
  const pieces = t.split(/(?<=[.!?…]["”’')\]]*)\s+/);
  const out: string[] = [];
  let cur = '';
  pieces.forEach((piece, i) => {
    cur = cur === '' ? piece : `${cur} ${piece}`;
    const tail = piece.slice(-10);
    const next = pieces[i + 1];
    const goesOn =
      next !== undefined &&
      (ABBREV_END.test(tail) || (/(?:^|[^\p{L}])no\.$/iu.test(tail) && /^\d/.test(next)));
    if (!goesOn) {
      if (cur.trim() !== '') out.push(cur.trim());
      cur = '';
    }
  });
  return out;
};

/** sentences about the conversation, not the memory: "That is right." "Let me think." */
const TALK =
  /^(?:that(?:'s| is| was) (?:right|true|it|so|correct)|that is how it was|i remember(?: that| it)?|i (?:don't|do not|can't|cannot) (?:know|remember|recall|say)|i (?:don't |do not )?(?:think|guess|suppose|believe) so|i'm not sure|i am not sure|not that i (?:remember|recall|know of)|let me (?:think|see|remember)|let's see|where (?:do|shall|should|can) i (?:start|begin)|how (?:can|do|should|shall) i (?:explain|say|put) (?:it|this|that)|what can i say|you know what|who knows)$/i;
/** a request to someone in the room ("Pass me the photo") */
const REQUEST_IN_ROOM = /^(?:pass|hand|give|get) me\b/i;

/** a sentence of nothing but these says only "yes" or "no": "No, not at all." */
const ANSWER_ONLY = new Set(
  (
    'yes yeah yep yup no nope nah not never at all really of course sure absolutely definitely ' +
    'certainly exactly indeed right okay ok well so oh maybe perhaps quite totally ever'
  ).split(' '),
);

const isAck = (sentence: string): boolean => {
  const ws = tokens(sentence);
  if (ws.length === 0) return false;
  if (ws.length <= 3 && ACK.has(ws[0]!.toLowerCase())) return true;
  // "No, not at all." is the answer, not what the memory is about (the title was «Not at all»)
  if (ws.length <= 5 && ws.every((w) => ANSWER_ONLY.has(w.toLowerCase()))) return true;
  const plain = sentence
    .replace(/[^\p{L}\p{N}'’\s]+/gu, ' ')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (TALK.test(plain)) return true;
  return ws.length <= 6 && REQUEST_IN_ROOM.test(plain);
};

/**
 * The title when the model offered none we can use, from the speaker's own words:
 *
 *   - leading fillers out, and leading answer words ("Yes." "Well.") skipped when more
 *     follows;
 *   - the first sentence that says something (3+ words), preferring a statement to a
 *     question, and a sentence these rules can read (no letter of another script) to one
 *     they cannot, cut at its own end;
 *   - too long: cut at the last clause boundary that still leaves 4 words (a comma,
 *     "and", "but", "because"), else at the last word boundary;
 *   - a CUT title never ends on a word that needs a follower ("…fishing town on the"),
 *     but a sentence that ended by itself is left whole ("I miss her").
 *
 * A memory told entirely in another script is titled with its own first words, as said.
 */
export function fallbackTitle(raw: unknown): string {
  if (typeof raw !== 'string') return 'A memory';
  // a link reads as its words ([[Title|words]] is "words"), as a reader sees it
  const text = shownText(raw.normalize('NFC'))
    .replace(/[[\]#^|<>`*_~]/g, ' ')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD_FILLER, '');
  const all = sentencesOf(text);
  let i = 0;
  while (i < all.length - 1 && isAck(all[i]!)) i++;
  const rest = all.slice(i);
  const enough = (x: string): boolean => tokens(x).length >= 3;
  const isQuestion = (x: string): boolean => /\?["”’')\]]*$/.test(x);
  const readable = (x: string): boolean => !OTHER_SCRIPT.test(x);
  let t =
    rest.find((x) => enough(x) && readable(x) && !isQuestion(x)) ??
    rest.find((x) => enough(x) && !isQuestion(x)) ??
    rest.find(enough) ??
    rest[0] ??
    text;
  // the sentence's own opening fillers and answer words ("And in the evenings…", "Right, I…")
  t = t.replace(LEAD_FILLER, '');
  // ("No. 12 was our house" keeps its "No.": before a number it is a number sign)
  t = t.replace(
    /^(?:yes|yeah|no(?!\.\s*\d)|well|so|oh|okay|ok|right|sure)[,.!]?\s+(?=(?:\S+\s+){2}\S)/i,
    '',
  );
  t = t.replace(/[\s.!?…,;:'"’”)\]-]+$/, '').trim();

  let cut = false;
  if (t.length > TITLE_MAX) {
    cut = true;
    // a long sentence reads best cut where a clause ends ("My mother sold fish at the market"),
    // not wherever the character limit falls ("… and she came home after")
    const clause =
      /,|;|\s(?:and|but|so|because|when|while|after|before|until|which|where|though|although|since|y|e|o|pero|porque|et|mais|und|aber|ma|perché|mas)\s/gi;
    let best = -1;
    for (let m = clause.exec(t); m && m.index <= TITLE_MAX; m = clause.exec(t)) {
      if (tokens(t.slice(0, m.index)).length >= 4) best = m.index;
    }
    if (best > 0) {
      t = t.slice(0, best);
    } else {
      const slice = t.slice(0, TITLE_MAX + 1);
      const sp = slice.lastIndexOf(' ');
      t = sp > 12 ? slice.slice(0, sp) : t.slice(0, TITLE_MAX);
      // a cut that ends on a word needing a follower ("…to school every") is trimmed below and
      // reads whole; one that ends on a content word may be mid-phrase ("…town on the south",
      // "…every morning to carry"), and is cut back to before that phrase
      const prep = endsDangling(t, false)
        ? -1
        : t.search(
            /\s(?:in|on|at|of|from|with|for|by|to|behind|beside|near|under|over|into|through|than|de|en|con|para|à|dans|mit|von)\s[^\s]+(?:\s[^\s]+){0,2}$/i,
          );
      if (prep > 20) t = t.slice(0, prep);
    }
  }
  t = t.replace(/[\s,;:\-–—.]+$/, '').trim();
  // a cut phrase never ends on a word that needs a follower ("…fishing town on the")
  if (cut) {
    while (tokens(t).length > 1 && endsDangling(t, false)) {
      t = t.replace(/\s*\S+$/, '').replace(/[\s,;:\-–—]+$/, '');
    }
  }
  if (t !== '') t = t[0]!.toUpperCase() + t.slice(1);
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX).trimEnd();
  if (/[\p{L}\p{N}]/u.test(t) && validateNoteTitle(t) === null) return t;
  // never an empty title (nor one of punctuation or an invisible character): the text's own first
  // words, and a plain label when it has none
  const words = (text.match(TOKEN) ?? []).slice(0, 8).join(' ').slice(0, TITLE_MAX).trim();
  if (words !== '' && validateNoteTitle(words) === null) {
    return words[0]!.toUpperCase() + words.slice(1);
  }
  return 'A memory';
}
