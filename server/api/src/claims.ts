import { checkGrounding, textWords } from './grounding-check';
import { spokenNumbersToDigits, spokenYearsToDigits } from './speech';

/**
 * Comparing what a note SAYS, sentence by sentence, with no model involved.
 *
 * Two jobs share this file because they share one question — "is this sentence
 * the same as, a variant of, or a contradiction of that one?":
 *
 *   planEdit        an edit may ADD to a note; it may not remove, reword or
 *                   replace a sentence that is already there. A correction is
 *                   not allowed to erase what it corrects (policy A: both
 *                   claims stay, and the disagreement is marked).
 *   compareClaims   the deterministic half of conflict detection: two sentences
 *                   about the same thing that give different years or numbers.
 *
 * WHAT THIS DOES NOT DO, stated once. It cannot tell that "Walt put the frog in
 * the hat" contradicts "Eddie ... put a frog in the hat": that needs meaning, and
 * the project already measured that embeddings cannot supply it (two opposite
 * statements of one event are semantically SIMILAR). That case goes to the model
 * as a judge, and its answer is checked against the text before it is believed.
 * Everything here is conservative on purpose: a missed conflict is caught by the
 * judge or left plain; a false alarm puts a "disagreement" label on a true note.
 */

/* ── lines and sentences ─────────────────────────────────────────────── */

/** A system-written line recording that two claims disagree. */
export const MARKER_PREFIX = '> ⚠';
export const isMarkerLine = (line: string): boolean => line.trimStart().startsWith(MARKER_PREFIX);

export interface Unit {
  text: string;
  /** a `>` line: source footer or disagreement marker, never a sentence of testimony */
  quote: boolean;
}

/** Sentences of prose, and whole `>` lines, in order. */
export function unitsOf(body: string): Unit[] {
  const out: Unit[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    if (t.startsWith('>')) {
      out.push({ text: t, quote: true });
      continue;
    }
    for (const s of t.split(/(?<=[.!?。…])\s+/)) {
      const x = s.trim();
      if (x) out.push({ text: x, quote: false });
    }
  }
  return out;
}

/**
 * What a reader sees: `[[Title|words]]` -> words, `[[Title]]` -> Title, embeds -> nothing.
 *
 * No part of a link may hold a "[" (a title cannot: the API refuses it), so every group stops
 * at the next "[" or "]". Two open-ended groups side by side let a run of unclosed "[[" take
 * cubic time: 4,000 characters froze the whole server for 10 s, and any member could plant
 * such a note for the next import to trip over (review round 3, F5).
 */
export function displayText(s: string): string {
  if (!s.includes('[[')) return s;
  return s.replace(
    /(!?)\[\[([^\]|#^[]*)(?:[#^][^\]|[]*)?(?:\|([^\][]*))?\]\]/g,
    (_m, bang: string, target: string, alias?: string) => (bang ? '' : (alias ?? target)),
  );
}

/**
 * What a reader sees, as plain words: links shown as their words, and no markup (HTML tags,
 * **bold**, ~~strike~~, `code`, a leading heading/quote/list mark). For text written into a
 * marker line, which must not render as anything but the words it quotes.
 */
export function plainText(s: string): string {
  // each group stops where another could begin ("[", "(", "<"): linear on any run of them
  return displayText(s)
    .replace(/!\[[^\][]*\]\([^()[\]]*\)/g, ' ')
    .replace(/\[([^\][]*)\]\([^()[\]]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^<>]*>/g, ' ')
    .replace(/[*~`]+/g, '')
    .replace(/(^|[\s(])_+|(?<!_)_+(?=[\s).,!?;:]|$)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>+\s*|[-+]\s+)/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

/** Comparison key: what a reader sees, minus case, punctuation and spacing. */
export const norm = (s: string): string =>
  displayText(s)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** A claim in a note: told by the note's own text, or merely RECORDED in a disagreement line. */
export interface ClaimUnit {
  text: string;
  recorded: boolean;
}

/**
 * The sentences a person actually told, plus the claims quoted inside disagreement
 * markers. The two are kept apart because they are not equal witnesses: a note's own
 * text is what the note SAYS; a marker only records that someone said otherwise.
 */
export function claimUnits(body: string): ClaimUnit[] {
  const out: ClaimUnit[] = [];
  for (const u of unitsOf(body)) {
    if (!u.quote) out.push({ text: u.text, recorded: false });
    else if (isMarkerLine(u.text))
      out.push(...quotedIn(u.text).map((text) => ({ text, recorded: true })));
  }
  return out;
}

export const claimsOf = (body: string): string[] => claimUnits(body).map((c) => c.text);

/** The “…” passages of a marker line. */
export function quotedIn(line: string): string[] {
  // a quote ends at the next mark of either kind: a run of "“" stays linear
  return [...line.matchAll(/“([^“”]+)”/g)].map((m) => m[1]!.trim());
}

/* ── words, numbers, names ───────────────────────────────────────────── */

const spoken = (s: string): string => spokenNumbersToDigits(spokenYearsToDigits(s));

/** The words that carry a sentence's meaning: no short function words, no numbers. */
export function contentWords(sentence: string): string[] {
  // brackets left over after the links are read (an unclosed "[[") are never words, and the word
  // splitter's own link pattern is quadratic on a run of them: they go first
  const t = displayText(spoken(sentence)).replace(/[[\]]/g, ' ').toLowerCase();
  return [...new Set(textWords(t).filter((w) => !/\d/.test(w) && w.length >= 4))];
}

/** "y1984" for a year, "n42" for any other number: only like is compared with like. */
export function numbersOf(sentence: string): Set<string> {
  const out = new Set<string>();
  for (const m of spoken(displayText(sentence)).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, '');
    const n = Number(raw);
    out.add(/^\d{4}$/.test(raw) && n >= 1800 && n <= 2099 ? `y${raw}` : `n${raw}`);
  }
  return out;
}

const NOT_NAMES = new Set(
  (
    'the and but she her his him they them their there that this these those then when where what who why how while ' +
    'with without after before because though although every some once still also just even only very really much many ' +
    'such our your mine mom dad mrs mister sunday monday tuesday wednesday thursday friday saturday january february march ' +
    'april may june july august september october november december yes small later finally eventually'
  ).split(' '),
);
const AFTER_NAME =
  /^(?:was|is|had|did|said|put|took|went|got|would|could|gave|hid|built|wanted|died|lived|married|sold|moved|came|left|made|told|asked|worked|used|ran|sang|baked|became|loved|liked|taught|spilled|drove|never|always|also|then)\b/;

/** Capitalised words that look like a person or place name. Heuristic by design. */
export function namesOf(sentence: string): Set<string> {
  const out = new Set<string>();
  const t = displayText(sentence);
  for (const m of t.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const w = m[0];
    if (NOT_NAMES.has(w.toLowerCase())) continue;
    // the first word of a sentence is only a name when a verb follows it
    if (m.index === 0 && !AFTER_NAME.test(t.slice(w.length).trimStart())) continue;
    out.add(w.toLowerCase());
  }
  return out;
}

/* ── comparing two claims ────────────────────────────────────────────── */

const subset = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x));

/**
 * The most of one sentence a comparison reads. Nobody says 2,000 characters without a full
 * stop; a pasted wall of text, or a planted one, must not make one comparison take seconds.
 */
const MAX_SENTENCE = 2_000;
/** ...and the most clauses with a number it pairs up (every pair is compared) */
const MAX_NUMERIC_CLAUSES = 40;
const capped = (s: string): string => (s.length > MAX_SENTENCE ? s.slice(0, MAX_SENTENCE) : s);

/** How much of the shorter sentence's meaning the other one also carries. */
export function overlap(a: string, b: string): { shared: number; ratio: number } {
  const ca = contentWords(capped(a));
  const cb = contentWords(capped(b));
  if (ca.length === 0 || cb.length === 0) return { shared: 0, ratio: 0 };
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  const missing = new Set(checkGrounding(long.join(' '), short.join(' ')).ungrounded);
  const shared = short.filter((w) => !missing.has(w)).length;
  return { shared, ratio: shared / short.length };
}

export type Relation = 'unrelated' | 'related' | 'same' | 'conflict';

/** Different numbers of the SAME kind (year vs year, count vs count). A year is never compared with an age. */
function numbersDiffer(a: string, b: string): boolean {
  const na = numbersOf(a);
  const nb = numbersOf(b);
  for (const kind of ['y', 'n']) {
    const A = new Set([...na].filter((x) => x.startsWith(kind)));
    const B = new Set([...nb].filter((x) => x.startsWith(kind)));
    if (A.size > 0 && B.size > 0 && !subset(A, B) && !subset(B, A)) return true;
  }
  return false;
}

/* ── one fact per clause: who, what happened, which numbers ──────────── */

/*
 * WHY THE NUMBER CHECK IS STRICT. A check that fires on "the same words, a different year"
 * marks innocent notes as disagreeing, and in a family archive that is most of them: "My
 * mother was born in Daegu in 1905" / "My father was born in Daegu in 1903" share every word
 * but the person. A MISSED disagreement leaves two plain sentences side by side, which is
 * where we started; a FALSE one puts a warning on a true memory, in front of the family. So a
 * clash is declared only when two clauses agree on ALL of:
 *
 *   WHO    the same people in the same places: "my mother" is not "my father", "my first son"
 *          is not "my second son", "I" is not "Sunja", "the drought" is not "the flood".
 *          Pronouns, family words (with whose they are and first/eldest/...), names and the
 *          clause's other subject words all count, as subject and (people only) as object:
 *          "I lost my husband" is not "I lost my son".
 *   WHAT   the same event: the same event verbs (bought is not sold, born is not died, moved
 *          in is not moved out), and the rest of the words mostly shared (at least 0.6 of the
 *          shorter clause).
 *   WHICH  a number of the same kind AND unit (a year with a year, "four children" with "five
 *          children", never twelve hours with thirty years, never an age with a year), stated
 *          plainly ("around 1950", "the 1950s", "after 1950" are not points) and different.
 *          A label is not a quantity ("part 7 of my story", "room 12").
 *   WHEN   a different YEAR only counts for what happens once: born, died, married, graduated,
 *          retired, sold the farm, the flood. "We lived in Scranton in 1950" and "...in 1960"
 *          are both true; so are two trips to Busan, two raises, two visits. A different COUNT
 *          only counts at the same time: "In 1950 we had 12 cows" / "In 1960 we had 20 cows"
 *          are two moments, and "40 jars every winter" / "50 jars in 1970" are a habit and a
 *          year. When the year AND the count differ, it is a different moment, never a clash.
 *   WHOSE  an "I", a "we" or a "my mother" is the teller's. Two texts' first person is the same
 *          person only when they are known to be told by the same person (Eddie's "I was born
 *          in 1946" is not his brother Walt's "I was born in 1950"); a known teller's "I" is
 *          that teller ("I was born...", told by Grandma Sunja, is about Sunja). "He", "she"
 *          and "it" are only taken to mean the same within one text.
 *
 * and neither clause is negated or a question. Anything less is left to the judge, or to
 * nobody. The teller's name is NOT put in front of an "I" claim as words: "Sunja" + "my sister
 * married in 1958" is not "Sunja married in 1952".
 */

interface Num {
  kind: 'year' | 'count';
  /** what is counted, singular ("child", "year"); '' when nothing says */
  unit: string;
  value: number;
  /** "around 1950", "the 1950s", "after 1950", "1950 or 1951": not a point to compare */
  approx: boolean;
}

interface Fact {
  /** who or what the clause is about */
  subject: Set<string>;
  /** the people it also involves (family words and names after the verb) */
  objects: Set<string>;
  /** what happened, as event keys ("born", "sold", "moved_in") */
  verbs: Set<string>;
  /** it happens once to its subject (a birth, a death, a wedding, the flood): a year can clash */
  once: boolean;
  /** "every winter", "always": a habit, not one moment */
  habitual: boolean;
  /**
   * Said of NOW, the day it was told: "I am 82", "I have three grandchildren". True when said,
   * and different a year later.
   */
  present: boolean;
  /** the rest of its words, for "mostly the same words" */
  words: string[];
  numbers: Num[];
  /** negated, or a question: not a plain statement of fact */
  skip: boolean;
}

/**
 * What is known about who told two texts, for "WHOSE" above. Without it (an edit to one note,
 * the assistant comparing search results) both are taken as one voice, as before.
 */
export interface Voices {
  /** both texts are known to be told by the same person: their "I", "we", "my mother" agree */
  sameTeller: boolean;
  /** one and the same text: its "he", "she" and "it" agree */
  sameText: boolean;
  /** who told each text, when known by name: an "I" is then that person */
  tellerA?: string | null;
  tellerB?: string | null;
}
const ONE_VOICE: Voices = { sameTeller: true, sameText: true };

/** family words, spelled the way the comparison compares them */
const KIN_EN: Record<string, string> = {};
for (const [norm1, forms] of Object.entries({
  mother: 'mother mothers mom moms mum mama mamma mommy mummy ma',
  father: 'father fathers dad dads daddy papa pa pop',
  grandmother: 'grandmother grandmothers grandma grandmas granny gran nana',
  grandfather: 'grandfather grandfathers grandpa grandpas granddad grandad gramps',
  parents: 'parent parents',
  brother: 'brother brothers',
  sister: 'sister sisters',
  sibling: 'sibling siblings',
  son: 'son sons',
  daughter: 'daughter daughters',
  child: 'child children kid kids',
  grandson: 'grandson grandsons',
  granddaughter: 'granddaughter granddaughters',
  grandchild: 'grandchild grandchildren grandkid grandkids',
  aunt: 'aunt aunts auntie aunty',
  uncle: 'uncle uncles',
  cousin: 'cousin cousins',
  nephew: 'nephew nephews',
  niece: 'niece nieces',
  wife: 'wife wives',
  husband: 'husband husbands',
  stepmother: 'stepmother stepmom',
  stepfather: 'stepfather stepdad',
  family: 'family families',
})) {
  for (const f of forms.split(' ')) KIN_EN[f] = norm1;
}
/** "my brothers" are not "my brother": a plural family word is its own subject */
const KIN_PLURAL = new Set(
  'mothers moms fathers dads grandmothers grandmas grandfathers grandpas brothers sisters siblings sons daughters children kids grandsons granddaughters grandchildren grandkids aunts uncles cousins nephews nieces wives husbands families'.split(
    ' ',
  ),
);
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;
/** words that tell one relative from another of the same kind ("my FIRST son") */
const KIN_MODIFIERS = new Set(
  'first second third fourth fifth sixth eldest oldest elder older big youngest younger little baby middle twin step half'.split(
    ' ',
  ),
);
const PRONOUN_EN: Record<string, string> = {
  i: 'i',
  me: 'i',
  myself: 'i',
  we: 'we',
  us: 'we',
  ourselves: 'we',
  he: 'he',
  him: 'he',
  himself: 'he',
  she: 'she',
  herself: 'she',
  they: 'they',
  them: 'they',
  themselves: 'they',
  you: 'you',
  yourself: 'you',
  // "It stayed with me..." is not a person called It
  it: 'it',
  itself: 'it',
};
/** whose relative it is ("our mother" is the family's, as "my mother" is) */
const OWNER_EN: Record<string, string> = {
  my: 'i',
  our: 'i',
  his: 'he',
  her: 'she',
  their: 'they',
  your: 'you',
  its: 'it',
};
/** whose thing it is ("our farm") */
const POSSESSOR_EN: Record<string, string> = {
  my: 'i',
  our: 'we',
  his: 'he',
  her: 'she',
  their: 'they',
  your: 'you',
  its: 'it',
};
/** the first person: the teller's own (see "WHOSE") */
const FIRST_PERSON = /^(?:i|we)(?::|$)/;
/** a pronoun nothing in the text resolves: only the same text can say it is the same one */
const UNRESOLVED = /^(?:he|she|they|you|it)(?::|$)/;
/** not a name, though capitalised at the start of a sentence */
const NOT_A_PERSON = new Set(
  'everyone everybody nobody someone somebody anyone anybody people none each either neither'.split(
    ' ',
  ),
);
const AUX_EN = new Set(
  'am is are was were be been being has have had do does did will would can could shall should may might must'.split(
    ' ',
  ),
);
const VERBS_EN = new Set(
  (
    'born died dies die passed married marry wed divorced separated lost widowed bought buy sold sell built build ' +
    'started start began begin opened founded joined retired retire quit stopped closed moved move came come went go ' +
    'returned arrived left leave settled graduated enrolled entered worked work lived live stayed met served enlisted ' +
    'drafted put took gave got made told asked ran sang baked became loved liked taught spilled drove hid kept said ' +
    'remember remembered think thought knew know saw see called raised grew'
  ).split(' '),
);
const NOT_VERB_ED = new Set('hundred red bed seed shed sled need'.split(' '));
/** words that never tell two subjects apart */
const STOP_EN = new Set(
  (
    'the a an and or but so then well yes no oh now just also even still only very really in on at to of for from ' +
    'with by into onto over under about around after before during since until till through when while where that ' +
    'this these those there here which who whom whose what why how year years day days time times morning evening ' +
    'night summer winter spring fall autumn week weeks month months later earlier once again ago back first last ' +
    'next every each some many much few lot lots all both one other another same such own late dear poor beloved ' +
    'old new big small little whole entire um uh like'
  ).split(' '),
);
const PLACE_PREPS = new Set(
  'in at on to from near into onto of around across outside inside toward towards through past via'.split(
    ' ',
  ),
);
/** what happened, from the verb forms only: a noun ("the funeral") is not the event */
const EVENTS_EN: Array<[string, RegExp]> = [
  ['born', /\bborn\b/],
  ['died', /\b(?:died|dies|die|dying|passed away|passed on|killed)\b/],
  ['married', /\b(?:married|marry|marries|marrying|wed|weds|wedded)\b/],
  ['divorced', /\b(?:divorced|divorce|separated)\b/],
  ['lost', /\b(?:lost|lose|loses|losing|widowed)\b/],
  ['bought', /\b(?:bought|buy|buys|buying|purchased)\b/],
  ['sold', /\b(?:sold|sell|sells|selling)\b/],
  ['built', /\b(?:built|build|builds)\b/],
  [
    'started',
    /\b(?:started|start|starts|began|begin|begins|opened|founded|joined|hired)\b|\bgot\s+(?:(?:a|an|his|her|my|their|our|the|first|new)\s+){0,2}job\b/,
  ],
  // "when she had a baby": one birth of several, not "Mom had four children"
  [
    'gave_birth',
    /\bgave birth\b|\bhad\s+(?:(?:a|another|her|his|their|our|first|second|third|baby)\s+){0,2}(?:baby|child|son|daughter|boy|girl)\b/,
  ],
  ['retired', /\b(?:retired|retire|retires)\b/],
  // "I quit smoking in 1980", "the store closed in 1990": stopping something is no retirement
  ['stopped', /\b(?:quit|quits|stopped|closed|fired)\b/],
  ['moved_in', /\bmov(?:ed|e|es|ing)\s+(?:in|into|to|here|there|back)\b|\b(?:arrived|settled)\b/],
  ['moved_out', /\bmov(?:ed|e|es|ing)\s+(?:out|away|from)\b|\b(?:left|leave|leaves|leaving)\b/],
  ['went', /\b(?:went|goes|gone|sailed)\b/],
  ['came', /\b(?:came|comes|come|coming|returned|return|returns)\b/],
  ['graduated', /\b(?:graduated|graduates)\b/],
  ['enrolled', /\b(?:enrolled|entered|enters)\b/],
  ['worked', /\b(?:worked|works|working)\b/],
  ['lived', /\b(?:lived|lives|living|stayed)\b/],
  ['met', /\b(?:met|meets)\b/],
  ['enlisted', /\b(?:enlisted|drafted)\b/],
  ['discharged', /\bdischarged\b/],
  ['served', /\bserved\b/],
  ['baptised', /\b(?:baptised|baptized|christened)\b/],
  // "came to America" is emigrating, once; "came to Seoul" can happen every year
  [
    'emigrated',
    /\b(?:emigrated|immigrated)\b|\bcame (?:over\b|to (?:this country|america|the (?:united )?states|the us|canada|england|britain|australia|new zealand|hawaii)\b)/,
  ],
];
const MOVED_EN = /\bmov(?:ed|e|es|ing)\b/;
/**
 * What happens to ONE PERSON once in a life, so a different year is a different account (see
 * "WHEN"): born, died, married, graduated, emigrated, retired, and the milestones of baptism and
 * military service. Not: lived, worked, went, came, moved, met, served, started, stopped,
 * divorced, enrolled: two of those years can both be true (review round 3, F9: "We bought a car
 * in 1955" and "...in 1962", "My sister divorced in 1980" and "...in 1995").
 */
const ONCE = new Set(
  'born died married graduated emigrated retired baptised enlisted discharged'.split(' '),
);
/**
 * Starting school and leaving home happen once; starting a business, a job or a class, or moving
 * house, can happen again ("I left home at 16" / "...at 17" is one moment told twice).
 */
const MILESTONE_EN =
  /\b(?:started|start|starts|began|begin|begins)\s+(?:school|kindergarten|first grade|primary school|elementary school)\b|\b(?:left|leave|leaves|leaving)\s+home\b/;
/**
 * A place that closes once, when something says which ("the textile factory in Daegu"); "the
 * store closed in 1980" and "...in 1990" may be two stores, or one that opened again.
 */
const INSTITUTIONS = new Set(
  'factory mill store shop plant mine school church company business restaurant bank hospital market theater theatre cinema office firm'.split(
    ' ',
  ),
);
/**
 * ...and what happens once to one particular THING or person: selling THE farm (not "a car", nor
 * "the cows"), building OUR house, losing one's husband (not one's job).
 */
const ONCE_WITH_OBJECT = new Set('bought sold built started lost'.split(' '));
/** one-off events a life can hold more than one of: "the war" may be either of two, unless named */
const QUALIFY_NOUNS = new Set('war fire'.split(' '));
/** a family word that can be any of several people ("my brother"): one of them by name or rank only */
const KIN_MANY = new Set(
  'son daughter child brother sister sibling cousin uncle aunt nephew niece grandson granddaughter grandchild'.split(
    ' ',
  ),
);
/** subjects a family's story has more than one of: a pet, a priest, a teacher, a friend */
const NOT_ONE_PERSON = new Set(
  'dog cat cow horse pig puppy kitten bird chicken pet priest pastor minister teacher doctor nurse neighbor neighbour friend boss landlord maid servant soldier'.split(
    ' ',
  ),
);
/** events that happen again and again: an age or a count "when we moved" is one of many moments */
const POINT_EVENTS = new Set(
  'moved moved_in moved_out went came started stopped bought sold built lost met enrolled entered enlisted discharged divorced gave_birth'.split(
    ' ',
  ),
);
/**
 * "sold the farm", "bought our house", "started working at the factory": one particular thing
 * (its head word is the group's last). "a car", "a business", "the cows" are not.
 */
const ONE_THING_EN =
  /\b(?:sold|sell|sells|selling|bought|buy|buys|buying|purchased|built|build|builds|started|start|starts|began|begin|begins|opened|founded|joined)\s+(?:off\s+|up\s+|out\s+|working\s+|work\s+|to work\s+)?(?:at\s+|in\s+|with\s+|for\s+)?(?:the|our|my|his|her|their|its|this|that|[a-z]+'s)\s+(?:(?:old|new|big|small|little|family|first|only|whole)\s+)?([a-z]+)\b/;
const ONE_THING_PASSIVE_EN =
  /^(?:the|our|my|his|her|their|its|this|that|[a-z]+'s)\s+(?:(?:old|new|big|small|little|family|first|only|whole)\s+)?([a-z]+)(?:\s+(?:on|in|at|of|near|by)\s+[a-z]+(?:\s+[a-z]+)?)?\s+(?:was|got)\s+(?:sold|bought|built)\b/;
const pluralNoun = (w: string): boolean => /s$/.test(w) && !/(?:ss|us|is)$/.test(w);
/** a subject that is itself a one-off event, when something says which: "the Vietnam War", "our wedding" */
const ONCE_NOUNS = new Set(
  'flood fire war funeral wedding earthquake typhoon hurricane accident crash explosion burial revolution eruption'.split(
    ' ',
  ),
);
const HABITUAL_EN = /\b(?:every|each|always|usually|often|sometimes|whenever|used to)\b/;
/**
 * A clause about NOW (see Fact.present): a present or future verb, or a word for the time of
 * telling. "Sunja is 81" and her own "I am 82" a year later are both true; so are "I have three
 * children" and, after a birth, "four" (review round 3, F1: a marker on nearly every re-interview).
 */
const PRESENT_EN =
  /\b(?:am|is|are|has|have|'m|'re|'ve|will|'ll|turned|turns|lives|owns|nowadays|currently|today|this year|next year)\b|(?<!^)\bnow\b/;
/** the word before a number that makes it a label: "part 7", "room 12", "route 66" */
const LABEL_BEFORE =
  /(?:\b(?:part|parts|chapter|page|pages|number|no|room|route|flight|bus|line|apartment|apt|unit|platform|gate|track|highway|exit|block|ward|bed|lot|plot|box|section|volume|vol|episode|season|verse|psalm|hymn|channel|station|item|step|level|floor|ticket|grade|class|company|regiment|battalion|platoon|division|squad|troop)\.?\s*|#\s*)$/i;
/**
 * Words that make a four-digit number an amount, not a year. An explicit list on purpose:
 * "In 1950 things got hard" must stay a year (a plural noun after it is not enough).
 */
const AMOUNT_EN = new Set(
  'won dollars dollar bucks pounds yen euros cents francs marks chickens cows pigs sheep goats hens ducks people men women soldiers workers students days hours minutes miles kilometers km meters feet acres books trees bags boxes jars eggs bottles sacks bushels'.split(
    ' ',
  ),
);
/** a house number: "25 Main Street" is an address, not twenty-five of anything */
const LABEL_AFTER =
  /^\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Place|Pl|Court|Ct|Terrace|Highway|Hwy)\b/;
const NEGATED_EN = /\b(?:not|never|no|nobody|nothing|none|neither|nor|cannot|without)\b|n['’]t\b/i;
/**
 * A wish, a plan, an attempt, hearsay or a condition: not a statement that it happened, so it is
 * skipped like a negation. "Minho wanted to retire in 1980" does not disagree with "Minho retired
 * in 1985", and "My mother wanted six children, but she had four" AGREES with "four" (review
 * round 3, F3). A hedge on one's own memory ("I think", "maybe") is still a statement.
 */
const UNREAL_EN =
  /\b(?:wants?|wanted|wish(?:es|ed)?|hopes?|hoped|plans?|planned|intends?|intended|meant to|tr(?:y|ies|ied) to|attempted|going to|gonna|supposed to|due to|expected to|scheduled to|almost|nearly|if|unless|whether|said to|thought to|they say|people say|i heard|we heard|heard that|was told|were told|supposedly|apparently|rumou?red|(?:could|would|should|might|may|must) have|would be|had (?:he|she|they|i|we|it|dad|mom|mother|father) (?:lived|been|stayed|gone|known|survived))\b/i;
/** the word after a number that is not what it counts ("forty OLD cows") */
const NUM_ADJ = new Set(
  'little small big young more other whole full good new extra grown beautiful healthy lovely great fine wonderful dairy milking fat brown black white red'.split(
    ' ',
  ),
);

/*
 * "About", "more than", "or so": a number that is not a point (review round 3, F2: "more than
 * thirty" and "30 or so" passed for exact). Bounds count too: "more than 30" and "32" can both
 * be true.
 */
const APPROX_BEFORE =
  /(?:\b(?:around|about|approximately|approx|roughly|circa|ca|maybe|perhaps|probably|nearly|almost|over|under|some|early|mid|late|before|after|since|until|till|by|from|through|between|or|to|than|least|most|like|upwards of|more or less|give or take)\s*[-–]?\s*|~\s*|[-–]\s*)$/i;
const APPROX_AFTER =
  /^(?:s\b|['’]s\b|\s*(?:or|to|-|–)\s*\d|-?\s*(?:something|odd|ish)\b|\s*(?:\S+\s+)?(?:or so|or thereabouts|or more|or less|give or take|more or less|odd)\b|\s*,?\s*(?:roughly|approximately|approx|circa)\b)/i;

const singular = (w: string): string =>
  w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

function numbersWithUnits(text: string): Num[] {
  const out: Num[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    // a few words either side is all any rule below reads: a window, so a long run of numbers
    // stays linear (slicing the whole rest of the text per number was quadratic)
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const suffix = /^[^\s\d.,!?;:)"”]*/.exec(after)![0];
    // "2nd", "3rd": which one, not how many (the family-word modifiers carry it)
    if (/^(?:st|nd|rd|th)$/i.test(suffix)) continue;
    // "part 7 of my story", "room 12", "25 Main Street": a name for something, not how many
    if (LABEL_BEFORE.test(before) || LABEL_AFTER.test(after)) continue;
    const approx = APPROX_BEFORE.test(before) || APPROX_AFTER.test(after);
    // what it counts: the English word right after it
    let unit = '';
    let amount = /\$\s*$/.test(before);
    const words = [...after.matchAll(/[A-Za-z][A-Za-z'’-]*/g)]
      .slice(0, 3)
      .map((x) => x[0].toLowerCase());
    // only a word that FOLLOWS the number directly can say what it counts
    const direct = /^\s+[A-Za-z]/.test(after);
    let k = 0;
    while (direct && k < words.length && NUM_ADJ.has(words[k]!)) k++;
    const w = direct ? words[k] : undefined;
    // checked before the stop words: "days" says nothing about who, but "1950 days" is a count
    if (w && (AMOUNT_EN.has(w) || (KIN_PLURAL.has(w) && w in KIN_EN))) amount = true;
    if (w && (amount || (!STOP_EN.has(w) && !AUX_EN.has(w)))) {
      unit = KIN_EN[w] ?? singular(w.replace(/['’]s$/, ''));
      if (unit === 'year' && words[k + 1] === 'old') unit = 'age';
    }
    // a year is a bare four-digit number: "2000 won" and "1950 days" are amounts (review round
    // 3, F10: "sold the cow for 2000 won" disagreed with "in 1950")
    const isYear = /^\d{4}$/.test(raw) && value >= 1800 && value <= 2099 && !amount;
    if (isYear) {
      out.push({ kind: 'year', unit: '', value, approx });
      continue;
    }
    out.push({ kind: 'count', unit, value, approx });
  }
  return out;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * How two clauses' numbers of one kind compare, unit by unit: `differ` when some unit both
 * give has values neither side contains in full, `agree` when every shared unit agrees, `none`
 * when they share no unit (or only an approximate one).
 */
function relate(a: Num[], b: Num[], kind: Num['kind']): 'differ' | 'agree' | 'none' {
  const groups = (ns: Num[]) => {
    const m = new Map<string, { values: Set<number>; approx: boolean }>();
    for (const n of ns) {
      if (n.kind !== kind) continue;
      const g = m.get(n.unit) ?? { values: new Set<number>(), approx: false };
      g.values.add(n.value);
      g.approx ||= n.approx;
      m.set(n.unit, g);
    }
    return m;
  };
  const A = groups(a);
  const B = groups(b);
  let shared = false;
  for (const [unit, ga] of A) {
    const gb = B.get(unit);
    if (!gb || ga.approx || gb.approx) continue;
    shared = true;
    const aInB = [...ga.values].every((v) => gb.values.has(v));
    const bInA = [...gb.values].every((v) => ga.values.has(v));
    if (!aInB && !bInA) return 'differ';
  }
  return shared ? 'agree' : 'none';
}

/** the plain years of a clause, as one key: "" when it names none */
const yearsKey = (ns: Num[]): string =>
  [...new Set(ns.filter((n) => n.kind === 'year' && !n.approx).map((n) => n.value))]
    .sort()
    .join(',');

/**
 * The numbers clash ("WHICH" and "WHEN" above): a different year for something that happens
 * once, or a different count at the same time, and never both at once (that is two moments).
 */
function numbersClash(x: Fact, y: Fact): boolean {
  // said of NOW: only comparable at a moment both name ("in 2025 I am 81" / "in 2025 I am 82")
  if (
    (x.present || y.present) &&
    (yearsKey(x.numbers) === '' || yearsKey(x.numbers) !== yearsKey(y.numbers))
  )
    return false;
  const years = relate(x.numbers, y.numbers, 'year');
  const counts = relate(x.numbers, y.numbers, 'count');
  if (years === 'differ') return x.once && y.once && counts !== 'differ';
  if (counts !== 'differ') return false;
  // a count is a fact about one moment: the same year (or none on either side) and the same
  // habit, or an event that happens once ("I was 20 when I married" / "I was 22 when I married").
  // An age at something that happens again ("I was 12 when we moved" / "...15 when we moved") is
  // two moments (review round 3, F9)
  const again = (f: Fact) => !f.once && [...f.verbs].some((v) => POINT_EVENTS.has(v));
  const sameMoment =
    yearsKey(x.numbers) === yearsKey(y.numbers) &&
    x.habitual === y.habitual &&
    !again(x) &&
    !again(y);
  return sameMoment || (x.once && y.once);
}

/**
 * Every token of `ts` that is a teller's "I" becomes that teller's names (see "WHOSE"), with the
 * family word of the teller's label as a title ("Grandma Sunja": sunja, @t:grandmother).
 */
function asTeller(ts: Set<string>, names: string[], titles: readonly string[] = []): Set<string> {
  if (names.length === 0) return ts;
  const owner = [...names].sort().join('+');
  const out = new Set<string>();
  for (const t of ts) {
    if (t === 'i') {
      names.forEach((n) => out.add(n));
      titles.forEach((k) => out.add(`@t:${k}`));
    } else if (t.startsWith('i:')) out.add(`${owner}:${t.slice(2)}`);
    else out.add(t);
  }
  return out;
}

/**
 * A mention of the teller by part of her names is her: "Sunja" in a note, told about "Sunja
 * Kim". A family name alone ("Kim") is anybody in the family, so it is not.
 */
function asNamed(ts: Set<string>, names: string[]): Set<string> {
  if (names.length === 0) return ts;
  const surname = names.length >= 2 ? names[names.length - 1] : null;
  const hits = [...ts].filter((t) => names.some((n) => sameName(t, n)));
  if (hits.length === 0 || hits.every((t) => t === surname)) return ts;
  const out = new Set([...ts].filter((t) => !hits.includes(t)));
  names.forEach((n) => out.add(n));
  return out;
}

/** The same people: the same names and family words; a title on one side only does not differ. */
function samePeople(rawA: Set<string>, rawB: Set<string>): boolean {
  const a = byName(rawA);
  const b = byName(rawB);
  const ta = [...a].filter((t) => t.startsWith('@t:'));
  const tb = [...b].filter((t) => t.startsWith('@t:'));
  if (ta.length > 0 && tb.length > 0 && !sameSet(new Set(ta), new Set(tb))) return false;
  return sameSet(
    new Set([...a].filter((t) => !t.startsWith('@t:'))),
    new Set([...b].filter((t) => !t.startsWith('@t:'))),
  );
}
/**
 * Someone with a name is that name: a family word beside it only says how they are related, so
 * "my uncle Joe" and "Uncle Joe" are one man (a family word alone, "my uncle", stays whose it is).
 */
function byName(ts: Set<string>): Set<string> {
  const named = [...ts].some(
    (t) => !t.includes(':') && !t.startsWith('=') && !(t in PRONOUN_EN) && !NOT_ONE_PERSON.has(t),
  );
  if (!named) return ts;
  return new Set(
    [...ts].map((t) => {
      const kin = t.startsWith('@t:') ? null : /^[^:]+:([^#+]+)(?:#.*)?$/.exec(t);
      return kin ? `@t:${kin[1]}` : t;
    }),
  );
}

/** words of a speaker label that say what someone was in the recording, not who */
const ROLE_WORDS = new Set(
  'speaker interviewee interviewer narrator teller guest host participant respondent unknown person voice'.split(
    ' ',
  ),
);
/** what a person is called by, never who: "Mr. Kim" is Kim */
const HONORIFICS = new Set(
  'mr mrs ms miss mx dr doctor prof professor rev reverend sir madam dame lady lord captain sgt'.split(
    ' ',
  ),
);
/** the words that tell a father from a son of one name: "Joe Sr." is not "Joe Jr." */
const GENERATION = new Set('jr junior sr senior ii iii iv'.split(' '));

/**
 * The names a teller goes by, as the facts spell names: "Grandma Sunja" -> ["sunja"], "Walt
 * Kowalski" -> ["walt", "kowalski"], "José García" -> ["josé", "garcía"]. Family words,
 * honorifics ("Mr.", "Dr."), "Jr." and role words ("Speaker") are not names: they say how the
 * teller is related, or what, not who. A label is a name in any case ("grandma sunja" typed in
 * lower case is the footer's "Grandma Sunja", review round 3 F11); a TITLE is not (`asTitle`:
 * only its capitalised words are names, "Grandma Sunja story").
 */
export function tellerNames(teller: string | null | undefined, asTitle = false): string[] {
  if (typeof teller !== 'string') return [];
  const out: string[] = [];
  for (const raw of teller.normalize('NFC').split(/[^\p{L}'’]+/u)) {
    let w = raw.replace(/['’]s$/, '');
    if (!asTitle && /^(?:\p{Ll}{2,}|\p{Lu}{2,})$/u.test(w))
      w = `${w[0]!.toUpperCase()}${w.slice(1).toLowerCase()}`;
    if (/^\p{Lu}\p{Ll}+$/u.test(w)) {
      const l = w.toLowerCase();
      if (
        !(l in KIN_EN) &&
        !(l in PRONOUN_EN) &&
        !(l in OWNER_EN) &&
        !STOP_EN.has(l) &&
        !NOT_NAMES.has(l) &&
        !ROLE_WORDS.has(l) &&
        !HONORIFICS.has(l) &&
        !GENERATION.has(l)
      )
        out.push(l);
    }
  }
  return [...new Set(out)];
}

/** Who a label (or a title) says someone is: names, the family words it calls them by, Jr./Sr. */
interface Identity {
  /** the label as one key, as `tellerVoice` spells it */
  key: string;
  names: string[];
  kin: Set<string>;
  generation: Set<string>;
}
const IDENTITIES = new Map<string, Identity>();
function identityOf(label: string, asTitle = false): Identity {
  const k = `${asTitle ? 't' : 'l'}${label}`;
  const hit = IDENTITIES.get(k);
  if (hit) return hit;
  const id = readIdentity(label, asTitle);
  if (IDENTITIES.size >= 1000) IDENTITIES.clear();
  IDENTITIES.set(k, id);
  return id;
}
function readIdentity(label: string, asTitle: boolean): Identity {
  const kin = new Set<string>();
  const generation = new Set<string>();
  for (const raw of label.normalize('NFC').split(/[^\p{L}'’]+/u)) {
    const l = raw.toLowerCase().replace(/['’]s$/, '');
    if (l in KIN_EN) kin.add(KIN_EN[l]!);
    else if (GENERATION.has(l)) generation.add(l === 'junior' ? 'jr' : l === 'senior' ? 'sr' : l);
  }
  const key = label.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return { key, names: tellerNames(label, asTitle), kin, generation };
}
/** Every name of `a` is one of `b`'s. */
const namesIn = (a: readonly string[], b: readonly string[]): boolean =>
  a.every((x) => b.some((y) => sameName(y, x) || sameName(x, y)));
/**
 * Two labels can be one person: names that agree (one holds all of the other's), no two different
 * family words ("Aunt Sunja" is not "Grandma Sunja") and the same Jr./Sr. A label with no name
 * ("Grandma", "Mom") is nobody in particular: it is never taken to be the same person as another
 * text's teller (review round 3, F6).
 */
function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.names.length === 0 || b.names.length === 0) return false;
  if (a.kin.size > 0 && b.kin.size > 0 && !sameSet(a.kin, b.kin)) return false;
  if (!sameSet(a.generation, b.generation)) return false;
  return namesIn(a.names, b.names) || namesIn(b.names, a.names);
}

/**
 * The teller named by `a` can be the person `b` names: another teller's label, or a note's title
 * (`bIsTitle`: "Sunja Kim", "Grandma Sunja story"; "Jaesung Kim" is not "Sunja Kim").
 */
export function samePerson(
  a: string | null | undefined,
  b: string | null | undefined,
  bIsTitle = false,
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return sameIdentity(identityOf(a), identityOf(b, bIsTitle));
}

/* ── what a sentence is about: whom to show the judge, and what to believe ── */

/**
 * Words that never make two sentences about the same thing: function words, pronouns, the verbs
 * of telling and remembering. Counted as shared ("those", "there", "were", and the teller's own
 * name that every claim of hers is framed with), they made each of her sentences "about" any
 * sentence that names her: the judge's twelve calls went on "I loved those Sundays" and the page
 * then blamed the AI (review round 3, F4).
 */
const NOT_TOPIC_EN = new Set([
  ...STOP_EN,
  ...AUX_EN,
  ...Object.keys(PRONOUN_EN),
  ...Object.keys(OWNER_EN),
  ...(
    'those there these this that which with from into onto upon here been being well okay whom whose than ' +
    'because although though unless whether would could should might must shall does will have having ' +
    'said says say saying told tell tells telling remember remembered remembers think thinks thought ' +
    'know knows knew maybe perhaps always never ever something nothing anything everything thing things anyway'
  ).split(' '),
]);

/** A word as names and labels are compared: lower case, no "'s". */
const wordKey = (w: string): string => w.toLowerCase().replace(/['’]s$/, '');

/** Every word of a text, as `wordKey` spells it. */
function wordKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of displayText(capped(text))
    .normalize('NFC')
    .split(/[^\p{L}\p{N}'’]+/u)) {
    const k = wordKey(raw.replace(/^['’]+/, ''));
    if (k !== '') out.add(k);
  }
  return out;
}

const sameName = (key: string, name: string): boolean => key === name;

/** Who tells a claim, as the topic test reads it. */
export interface TellerWords {
  /** every word of the teller's label ("grandma", "sunja"): what frames each claim, never a topic */
  label: ReadonlySet<string>;
  /** the names that say it is her ("sunja"; a family word alone never does) */
  names: readonly string[];
}

export function tellerWords(teller: string | null | undefined): TellerWords {
  if (typeof teller !== 'string' || teller.trim() === '') return { label: new Set(), names: [] };
  const names = tellerNames(teller);
  return { label: wordKeys(teller), names };
}

/** The text names the teller: one of her names is one of its words. */
export function namesTeller(text: string, who: TellerWords): boolean {
  if (who.names.length === 0) return false;
  const keys = wordKeys(text);
  return [...keys].some((k) => who.names.some((n) => sameName(k, n)));
}

/** What happened in a sentence, by its verbs: "born", "died", "married", "moved_in"... */
export function eventsOf(sentence: string): Set<string> {
  const t = spoken(displayText(capped(sentence)));
  return verbKeys(t.toLowerCase().replace(/’/g, "'"));
}

/** The words of a sentence that can say what it is about. */
function topicWords(sentence: string, label: ReadonlySet<string>): string[] {
  const words = contentWords(capped(sentence)).filter((w) => {
    const k = wordKey(w);
    return !label.has(k) && !NOT_TOPIC_EN.has(k);
  });
  if (words.length === 0) return words;
  // ...and none the grounding check would let any text add ("those", "were")
  const needed = new Set(checkGrounding('', words.join(' ')).ungrounded);
  return words.filter((w) => needed.has(w));
}

/** How much two sentences share that says what they are about. */
export interface Topic {
  /** shared words that are neither free words nor the teller's own label */
  shared: number;
  /** topic words of the shorter side */
  shorter: number;
  /** the sentence names the teller */
  named: boolean;
}

export function topicOverlap(claim: string, sentence: string, who: TellerWords): Topic {
  const named = namesTeller(sentence, who);
  const ta = topicWords(claim, who.label);
  const tb = topicWords(sentence, who.label);
  if (ta.length === 0 || tb.length === 0) return { shared: 0, shorter: 0, named };
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const missing = new Set(checkGrounding(long.join(' '), short.join(' ')).ungrounded);
  return { shared: short.filter((w) => !missing.has(w)).length, shorter: short.length, named };
}

/**
 * The sentence is about what the claim is about: they share a word that says so and, unless they
 * share two, are about the same person (`person`: known from outside, the passage's title or
 * teller; or the sentence names her). A third of the shorter one's topic is shared.
 */
export function aboutTheSame(t: Topic, person = false): boolean {
  const p = person || t.named ? 1 : 0;
  return t.shared >= 1 && t.shared + p >= 2 && (t.shared + p) / (t.shorter + p) >= 0.34;
}

const hasAny = (ts: Set<string>, re: RegExp): boolean => [...ts].some((t) => re.test(t));

/** the event keys of a lower-cased text */
function verbKeys(text: string): Set<string> {
  const keys = new Set(EVENTS_EN.filter(([, re]) => re.test(text)).map(([k]) => k));
  if (!keys.has('moved_in') && !keys.has('moved_out') && MOVED_EN.test(text)) keys.add('moved');
  return keys;
}

type Who = { subject: Set<string>; inherit: boolean };

/** One English clause. `inherited` is the subject of the clause before it in the sentence. */
function englishFact(clause: string, sentenceStart: boolean, inherited: Set<string>): Fact & Who {
  const text = spoken(clause);
  const lower = text.toLowerCase().replace(/’/g, "'");
  const toks = [
    ...text.matchAll(/[A-Za-z][A-Za-z'’]*|\d+(?:st|nd|rd|th)\b|\d[\d,]*(?:\.\d+)?/g),
  ].map((m) => {
    const raw = m[0].replace(/’/g, "'");
    return { raw, w: raw.toLowerCase(), at: m.index };
  });
  const isVerb = (w: string) =>
    AUX_EN.has(w) ||
    VERBS_EN.has(w) ||
    (/^[a-z]{3,}ed$/.test(w) && !NOT_VERB_ED.has(w) && !(w in KIN_EN));
  let v = toks.findIndex((t) => isVerb(t.w));
  if (v < 0) v = toks.length;

  const isName = (i: number): boolean => {
    const t = toks[i]!;
    const bare = t.raw.replace(/'s$/, '');
    if (!/^[A-Z][a-z]+$/.test(bare) || bare.length < 2) return false;
    const w = bare.toLowerCase();
    if (
      w in KIN_EN ||
      w in PRONOUN_EN ||
      w in OWNER_EN ||
      NOT_NAMES.has(w) ||
      NOT_A_PERSON.has(w) ||
      STOP_EN.has(w) ||
      isVerb(w)
    )
      return false;
    if (i > 0 && PLACE_PREPS.has(toks[i - 1]!.w)) return false; // "born in Daegu": a place
    // the first word of a sentence is a name only before a verb, or as an owner ("Sunja's")
    if (i === 0 && sentenceStart)
      return t.raw.endsWith("'s") || (toks[1] !== undefined && isVerb(toks[1].w));
    return true;
  };

  /** people (and, in the subject, things) named in toks[from, to) */
  const people = (from: number, to: number, asSubject: boolean): Set<string> => {
    const out = new Set<string>();
    let companion = false;
    for (let i = from; i < to; i++) {
      const t = toks[i]!;
      // "came to America in 1912 with his brother": who came along is detail, not who it is
      // about ("I lost my husband" / "I lost my son" are still two facts)
      if (!asSubject) {
        if (t.w === 'with') companion = true;
        else if (AUX_EN.has(t.w) || VERBS_EN.has(t.w) || /\d/.test(t.w)) companion = false;
        if (companion) continue;
      }
      const kin = KIN_EN[t.w];
      if (kin) {
        // whose relative, and which one: "my first son", "Sunja's eldest daughter"
        const mods: string[] = [];
        let owner = 'i';
        let owned = false;
        for (let j = i - 1; j >= Math.max(from, i - 3); j--) {
          const p = toks[j]!;
          if (KIN_MODIFIERS.has(p.w) || ORDINAL.test(p.w)) mods.push(p.w);
          else if (p.w in OWNER_EN) {
            owner = OWNER_EN[p.w]!;
            owned = true;
            break;
          } else if (p.raw.endsWith("'s") && /^[A-Z]/.test(p.raw)) {
            owner = p.w.replace(/'s$/, '');
            owned = true;
            break;
          } else break;
        }
        // "Grandma Sunja", "Uncle Joe": a family word right before a name, nobody's, is what the
        // person is called, not one more relative (review round 3, F6 and F11)
        if (!owned && mods.length === 0 && !KIN_PLURAL.has(t.w) && i + 1 < to && isName(i + 1)) {
          out.add(`@t:${kin}`);
          continue;
        }
        const plural = KIN_PLURAL.has(t.w) ? '+' : '';
        out.add(`${owner}:${kin}${plural}${mods.length ? `#${mods.sort().join('+')}` : ''}`);
        continue;
      }
      const next = toks[i + 1];
      const ownsKin =
        next !== undefined &&
        (next.w in KIN_EN || KIN_MODIFIERS.has(next.w) || ORDINAL.test(next.w));
      if (asSubject && t.w in PRONOUN_EN && !(t.w === 'her' && ownsKin)) {
        out.add(PRONOUN_EN[t.w]!);
        continue;
      }
      if (t.w in OWNER_EN) {
        if (asSubject && !ownsKin) out.add(POSSESSOR_EN[t.w]!);
        continue;
      }
      if (isName(i)) {
        if (!(t.raw.endsWith("'s") && ownsKin)) out.add(t.w.replace(/'s$/, ''));
        continue;
      }
      if (
        asSubject &&
        !/\d/.test(t.w) &&
        t.w.length >= 3 &&
        !STOP_EN.has(t.w) &&
        !KIN_MODIFIERS.has(t.w) &&
        !isVerb(t.w)
      ) {
        out.add(singular(t.w.replace(/'s$/, '')));
      }
    }
    return out;
  };

  // "and sold the cows", "who was born there": the subject is the one before
  const inherit = v === 0 || (toks[0] !== undefined && /^(?:who|that|which)$/.test(toks[0].w));
  const subject = inherit ? new Set(inherited) : people(0, v, true);
  const predicate = v < toks.length ? text.slice(toks[v]!.at) : '';
  const verbs = verbKeys(lower);
  const objects = people(v, toks.length, false);
  const once = happensOnce(verbs, subject, thingOfEn(lower), objects.size > 0);
  return {
    subject,
    inherit,
    objects,
    verbs,
    once,
    habitual: HABITUAL_EN.test(lower),
    // a birth or a death is one past moment, whatever the tense of the sentence it is told in
    present: PRESENT_EN.test(lower) && !once,
    words: contentWords(predicate),
    numbers: numbersWithUnits(text),
    skip: NEGATED_EN.test(lower) || UNREAL_EN.test(lower),
  };
}

/**
 * One person: a name, a pronoun, a family word there is one of (mother, husband) or one of
 * several picked out by name or rank ("my eldest son", "my brother Jaesung"). Not "my brother"
 * (which one?), "my cousins", "our dog", "the priest".
 */
function onePerson(subject: Set<string>): boolean {
  if (subject.size === 0) return false;
  const named = [...subject].some(
    (t) => !t.includes(':') && !(t in PRONOUN_EN) && !NOT_ONE_PERSON.has(t),
  );
  for (const t of subject) {
    if (NOT_ONE_PERSON.has(t)) return false;
    const kin = /^[^:]+:([^#+]+)(\+)?(#.*)?$/.exec(t);
    if (!kin || t.startsWith('@t:')) continue;
    if (kin[2]) return false; // "my brothers"
    if (KIN_MANY.has(kin[1]!) && !kin[3] && !named) return false;
  }
  return true;
}

/**
 * See "WHEN": an event that happens once to one person ("born", "died"), to one thing ("sold the
 * farm") or one person lost ("lost my husband"), or a subject that is itself a one-off event
 * that something names ("the Vietnam War", "our wedding"; "the war" alone may be either of two).
 */
function happensOnce(
  verbs: Set<string>,
  subject: Set<string>,
  thing: 'one' | 'many' | 'milestone' | null = null,
  personObject = false,
): boolean {
  if ([...subject].some((s) => ONCE_NOUNS.has(s) && (!QUALIFY_NOUNS.has(s) || subject.size >= 2)))
    return true;
  for (const v of verbs) {
    const milestone = (v === 'started' || v === 'moved_out') && thing === 'milestone';
    if ((ONCE.has(v) || milestone) && onePerson(subject)) return true;
    if (v === 'lost' ? personObject : ONCE_WITH_OBJECT.has(v) && thing === 'one') return true;
    // "the textile factory in Daegu closed": a place named closely enough to be one place
    if (v === 'stopped' && subject.size >= 2 && [...subject].some((s) => INSTITUTIONS.has(s)))
      return true;
  }
  return false;
}
/** which thing a clause sells, buys or builds: one particular thing, several, or nothing said */
function thingOfEn(lower: string): 'one' | 'many' | 'milestone' | null {
  if (MILESTONE_EN.test(lower)) return 'milestone';
  const m = ONE_THING_EN.exec(lower) ?? ONE_THING_PASSIVE_EN.exec(lower);
  return m ? (pluralNoun(m[1]!) ? 'many' : 'one') : null;
}

/** A long sentence split where one fact ends and another begins. */
// not "so" in "30 or so" (the approximation must stay with its number)
const CLAUSE_SPLIT = /[,;:]|\b(?:and|but|because|(?<!\bor\s)so|although|though|while|which)\b/i;

const hasVerb = (piece: string): boolean =>
  [...piece.toLowerCase().matchAll(/[a-z][a-z']*/g)].some(
    (m) =>
      AUX_EN.has(m[0]) ||
      VERBS_EN.has(m[0]) ||
      (/^[a-z]{3,}ed$/.test(m[0]) && !NOT_VERB_ED.has(m[0])),
  );

/**
 * The clauses of a sentence, each a Fact. A piece without a verb is part of its neighbour
 * ("In 1950, we moved" is one clause, "My mother, who..., moved" keeps its subject).
 */
/** A sentence's clauses as the facts are read from them: split, and verbless pieces joined on. */
function clausePieces(display: string): string[] {
  // "between 4 and 6" is one range, not two clauses
  const pieces = display
    .replace(/\bbetween\s+(\S+)\s+and\s+/gi, 'between $1 to ')
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const merged: string[] = [];
  let carry = '';
  for (const p of pieces) {
    if (!hasVerb(p)) {
      carry = carry ? `${carry} ${p}` : p;
      continue;
    }
    merged.push(carry ? `${carry} ${p}` : p);
    carry = '';
  }
  if (carry) {
    if (merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${carry}`;
    else merged.push(carry);
  }
  return merged;
}

function clauseFacts(sentence: string): Fact[] {
  const display = displayText(sentence);
  if (display.includes('?')) return []; // a question states nothing
  const merged = clausePieces(display);
  const out: Fact[] = [];
  let previous = new Set<string>();
  merged.forEach((piece, i) => {
    const f = englishFact(
      piece,
      i === 0 && display.trimStart().startsWith(piece.slice(0, 8)),
      previous,
    );
    previous = f.subject;
    out.push(f);
  });
  return out;
}

const FACTS = new Map<string, Fact[]>();
/** the clauses of a sentence that carry a number, memoised (compareClaims runs pairwise) */
function numericFacts(sentence: string): Fact[] {
  const hit = FACTS.get(sentence);
  if (hit) return hit;
  const facts = clauseFacts(capped(sentence))
    .filter((f) => f.numbers.length > 0)
    .slice(0, MAX_NUMERIC_CLAUSES);
  if (FACTS.size >= 10_000) FACTS.clear();
  FACTS.set(sentence, facts);
  return facts;
}

/** Two clauses state the same fact with different numbers: see "WHY THE NUMBER CHECK IS STRICT". */
/** How each text's "I" and names are read (see "WHOSE"): worked out once per pair of texts. */
interface Whose {
  namesA: string[];
  namesB: string[];
  titlesA: string[];
  titlesB: string[];
  sameTeller: boolean;
  sameText: boolean;
}
function whoseOf(voices: Voices): Whose {
  const ia = typeof voices.tellerA === 'string' ? identityOf(voices.tellerA) : null;
  const ib = typeof voices.tellerB === 'string' ? identityOf(voices.tellerB) : null;
  let namesA = ia?.names ?? [];
  let namesB = ib?.names ?? [];
  if (ia && ib && !voices.sameText && ia.key !== ib.key) {
    if (sameIdentity(ia, ib)) {
      // "Walt" and "Walt Kowalski": one person, by all of the names either uses
      namesA = [...new Set([...namesA, ...namesB])];
      namesB = namesA;
    } else if (namesB.length > 0) {
      // two people who share a name ("Aunt Sunja", "Grandma Sunja"; "Joe Sr.", "Joe Jr."): the
      // other text's "I" is its own teller, never this one (review round 3, F6)
      namesB = [`=${ib.key}`];
    }
  }
  return {
    namesA,
    namesB,
    titlesA: ia ? [...ia.kin] : [],
    titlesB: ib ? [...ib.kin] : [],
    sameTeller: voices.sameTeller,
    sameText: voices.sameText,
  };
}

function clash(x: Fact, y: Fact, w: Whose): boolean {
  if (x.skip || y.skip) return false;
  // WHOSE: a known teller's "I" is that teller; any first person left is only the same person
  // when both texts are known to be one teller's, and an unresolved "he" only within one text.
  // A mention of a teller by part of her names is her ("Sunja" for the teller "Sunja Kim").
  const read = (ts: Set<string>, names: string[], titles: string[]) =>
    asNamed(asNamed(asTeller(ts, names, titles), w.namesA), w.namesB);
  const subA = read(x.subject, w.namesA, w.titlesA);
  const subB = read(y.subject, w.namesB, w.titlesB);
  const objA = read(x.objects, w.namesA, w.titlesA);
  const objB = read(y.objects, w.namesB, w.titlesB);
  for (const ts of [subA, subB, objA, objB]) {
    if (!w.sameTeller && hasAny(ts, FIRST_PERSON)) return false;
    if (!w.sameText && hasAny(ts, UNRESOLVED)) return false;
  }
  // No subject at all ("Born in 1921 in Daegu.") is not "the same subject": two such sentences
  // may be two people's (one told by Sunja, the other by Minho)
  if (subA.size === 0 || subB.size === 0) return false;
  if (!samePeople(subA, subB) || !samePeople(objA, objB)) return false;
  if (!sameSet(x.verbs, y.verbs)) return false;
  if (x.words.length === 0 || y.words.length === 0) {
    // nothing else said ("The flood was in 1972"): the event verb, or a subject that is itself
    // the event, must name what happened
    if (x.words.length !== y.words.length || (x.verbs.size === 0 && !x.once)) return false;
  } else {
    const o = overlap(x.words.join(' '), y.words.join(' '));
    if (o.shared < 1 || o.ratio < 0.6) return false;
  }
  return numbersClash(x, y);
}

/**
 * The words that make a claim worth checking: its content words, and the short ones that
 * still say who ("Dad", "Mom", "Tom") and the numbers. "Dad died in 1985." is a claim, though
 * it has only one word of four letters.
 */
export function factWords(full: string): string[] {
  const sentence = capped(full);
  const out = new Set(contentWords(sentence));
  const text = spoken(displayText(sentence));
  for (const m of text.matchAll(/[A-Za-z][A-Za-z'’]*|\d[\d,]*/g)) {
    const raw = m[0].replace(/['’]s$/, '');
    const w = raw.toLowerCase();
    if (/^\d/.test(raw)) out.add(raw.replace(/,/g, ''));
    else if (w.length >= 2 && w in KIN_EN) out.add(w);
    else if (
      /^[A-Z][a-z]{2}$/.test(raw) &&
      !STOP_EN.has(w) &&
      !NOT_NAMES.has(w) &&
      !(w in PRONOUN_EN) &&
      !(w in OWNER_EN) &&
      !AUX_EN.has(w)
    )
      out.add(w);
  }
  return [...out];
}

/**
 * The claim only repeats the sentence: every one of its words and numbers is already there.
 * Measured from the CLAIM's side: "Dad worked at the steel mill until he died in 1985" does
 * not repeat "Dad worked at the steel mill in Bethlehem", though all of that sentence is in it.
 */
export function restates(fullClaim: string, fullSentence: string): boolean {
  const claim = capped(fullClaim);
  const sentence = capped(fullSentence);
  const theirs = numbersOf(sentence);
  if (![...numbersOf(claim)].every((n) => theirs.has(n))) return false;
  // read as a reader sees it ("[[Busan]]" says Busan), with no bracket left to slow the reader
  const seen = (s: string) => displayText(s).replace(/[[\]]/g, ' ');
  const pieces = clausePieces(seen(sentence)).map((p) => ({ p, n: numbersOf(p) }));
  // each clause of the claim, words AND numbers, in ONE clause of the sentence: "I was born in
  // Busan" is not in "Sunja was born in Daegu and moved to Busan when she was ten" (review
  // round 3, F8: the bag of words hid the very sentence that contradicts it)
  return clausePieces(seen(claim)).every((c) => {
    const nums = [...numbersOf(c)];
    const words = factWords(c).filter((w) => !/^\d/.test(w));
    return pieces.some(
      ({ p, n }) =>
        nums.every((x) => n.has(x)) &&
        (words.length === 0 || checkGrounding(p, words.join(' ')).ungrounded.length === 0),
    );
  });
}

/**
 * The "conflict" of `compareClaims` alone: some clause of each states the same fact with a
 * different number. All a check against the archive needs, without the word overlap that the
 * other relations cost (an interview's every sentence is weighed against its earlier memories).
 */
export function numbersConflict(a: string, b: string, voices: Voices = ONE_VOICE): boolean {
  const fa = numericFacts(a);
  if (fa.length === 0) return false;
  const fb = numericFacts(b);
  if (fb.length === 0) return false;
  const w = whoseOf(voices);
  return fa.some((x) => fb.some((y) => clash(x, y, w)));
}

/**
 * How two sentences relate:
 *   conflict   some clause of each states the SAME fact (who, what, which number) with a
 *              different number: see "WHY THE NUMBER CHECK IS STRICT" above
 *   same       nearly all of the shorter one's words are in the other, with no differing number
 *   related    they share words (a judge may look; this check does not decide)
 *   unrelated  they do not
 */
export function compareClaims(
  a: string,
  b: string,
  voices: Voices = ONE_VOICE,
): { relation: Relation; shared: number; ratio: number } {
  const { shared, ratio } = overlap(a, b);
  if (numbersConflict(a, b, voices)) return { relation: 'conflict', shared, ratio };
  if (shared < 2 || ratio < 0.5) return { relation: 'unrelated', shared, ratio };
  return { relation: ratio >= 0.85 && !numbersDiffer(a, b) ? 'same' : 'related', shared, ratio };
}

/* ── editing: add, never replace ─────────────────────────────────────── */

export interface Correction {
  /** the sentence the editor wrote in place of `old` */
  neu: string;
  /** the existing sentence it would have erased */
  old: string;
}

export type EditPlan =
  | { ok: true; body: string; corrections: Correction[] }
  | { ok: false; kind: 'removed' | 'reworded' | 'quote-removed'; refusal: string };

const short = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Decide what an edit may do to the text that is already there.
 *
 *   keeps every existing sentence and `>` line     -> fine, it only ADDED
 *   replaces a sentence with one that differs in a  -> a CORRECTION: put the old
 *     year or number                                   sentence back; the caller
 *                                                      records the new one as a
 *                                                      marked disagreement
 *   rewords a sentence                              -> refused (an existing
 *                                                      sentence is somebody's
 *                                                      words; link with
 *                                                      [[Title|the words as written]])
 *   removes a sentence or a `>` line                -> refused
 *
 * Comparison is on what a READER sees, so `[[My Aunt Mae|Aunt Mae]]` is the same
 * sentence as "Aunt Mae" but `[[My Aunt Mae]]` is not.
 */
/** The numbers of a sentence (written or spoken), as one list; the words with every number masked. */
const numberless = (sentence: string): { words: string; numbers: string } => {
  const text = spoken(displayText(capped(sentence)));
  return {
    words: norm(text.replace(/\d[\d,.]*/g, ' # ')),
    numbers: [...numbersOf(text)].sort().join(' '),
  };
};

/** Two sentences say the same words apart from their numbers, and the numbers really differ. */
function sameButNumbers(a: string, b: string): boolean {
  const x = numberless(a);
  const y = numberless(b);
  return x.words === y.words && x.numbers !== y.numbers;
}

export function planEdit(oldBody: string, proposedBody: string): EditPlan {
  const oldUnits = unitsOf(oldBody);
  const newUnits = unitsOf(proposedBody);

  // COUNTED, not a set: a sentence said twice is two sentences, and dropping one copy of it
  // is removing a sentence ("He was a good man. ... He was a good man.")
  const unmatched = (from: Unit[], against: Unit[]): Unit[] => {
    const left = new Map<string, number>();
    for (const u of against) left.set(norm(u.text), (left.get(norm(u.text)) ?? 0) + 1);
    return from.filter((u) => {
      const k = norm(u.text);
      const n = left.get(k) ?? 0;
      if (n === 0) return true;
      left.set(k, n - 1);
      return false;
    });
  };
  const removed = unmatched(oldUnits, newUnits);
  if (removed.length === 0) return { ok: true, body: proposedBody, corrections: [] };

  const addedSentences = unmatched(newUnits, oldUnits).filter((u) => !u.quote);
  const used = new Set<string>();
  const corrections: Correction[] = [];
  let body = proposedBody;

  for (const r of removed) {
    if (r.quote) {
      return {
        ok: false,
        kind: 'quote-removed',
        refusal: `Refused: your new body removes or changes a line that starts with ">" ("${short(r.text)}"). Those lines record where a note came from and where accounts disagree; they must stay exactly as they are. Send the COMPLETE body with them unchanged.`,
      };
    }
    // the same sentence with other numbers is a correction, whatever its verb: "We lived in
    // Scranton in 1950" -> "...in 1951" (the marker test is stricter: it no longer clashes on a
    // year of something that can happen twice, and this path was refusing those corrections)
    const renumbered = addedSentences.find(
      (n) => !used.has(n.text) && sameButNumbers(n.text, r.text),
    );
    // ...else the added sentence that is most like the one that vanished
    let best: { n: Unit; shared: number } | null = renumbered
      ? { n: renumbered, shared: Number.POSITIVE_INFINITY }
      : null;
    for (const n of renumbered ? [] : addedSentences) {
      if (used.has(n.text)) continue;
      const { shared, ratio } = overlap(n.text, r.text);
      if (shared >= 2 && ratio >= 0.5 && (best === null || shared > best.shared))
        best = { n, shared };
    }
    if (best === null) {
      return {
        ok: false,
        kind: 'removed',
        refusal: `Refused: your new body removes an existing sentence ("${short(r.text)}"). The assistant cannot remove text from a note. Send the COMPLETE body: the existing text exactly as it is, plus your addition as NEW sentences. (To remove something, edit the note yourself or delete it.)`,
      };
    }
    if (!renumbered && compareClaims(best.n.text, r.text).relation !== 'conflict') {
      return {
        ok: false,
        kind: 'reworded',
        refusal: `Refused: your new body rewords an existing sentence ("${short(r.text)}"). Keep existing sentences exactly as written and add new information as NEW sentences. To link a note, wrap the words that are already there: [[Exact Title|the words as written]], so the sentence reads the same.`,
      };
    }
    used.add(best.n.text);
    corrections.push({ neu: best.n.text, old: r.text });
    body = body.replace(best.n.text, r.text); // the original goes back where the replacement stood
  }
  return { ok: true, body, corrections };
}

export interface ParsedMarker {
  kind: 'two-accounts' | 'other-note';
  when?: string;
  by?: string;
  /** the claim that was added (two-accounts only) */
  claim?: string;
  /** what the note's own text, or the other note, says */
  existing: string;
  /** the other note's title (other-note only) */
  note?: string;
}

/** A disagreement line as plain data, so nothing has to re-read prose to understand it. */
export function parseMarker(line: string): ParsedMarker | null {
  if (!isMarkerLine(line)) return null;
  const q = quotedIn(line);
  const parts = line.split(' · ');
  const when = parts[1]?.trim();
  const by = parts[2]?.split(/:\s/)[0]?.trim();
  const note = /\[\[([^\]]+)\]\]/.exec(parts[0] ?? '')?.[1];
  if (note !== undefined) {
    return q.length >= 1
      ? { kind: 'other-note', when, by, existing: q[q.length - 1]!, note }
      : null;
  }
  return q.length >= 2 ? { kind: 'two-accounts', when, by, claim: q[0]!, existing: q[1]! } : null;
}

/** Remove one sentence from a body and tidy the gap. */
export function withoutSentence(body: string, sentence: string): string {
  return body
    .replace(sentence, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Append `>` lines to the end of a body, joining an existing blockquote or starting one. */
export function withLines(body: string, lines: string[]): string {
  if (lines.length === 0) return body;
  const trimmed = body.trimEnd();
  const lastLine = trimmed.split('\n').pop() ?? '';
  const sep = trimmed === '' ? '' : lastLine.trimStart().startsWith('>') ? '\n' : '\n\n';
  return `${trimmed}${sep}${lines.join('\n')}`;
}
