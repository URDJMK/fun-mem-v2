import { spokenNumbersToDigits, spokenYearsToDigits } from './speech';

/**
 * The grounding check for model-written drafts.
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
 *    HONEST REWRITES. An invented "with a warm smile" changes a few characters of a
 *    sentence, while an honest tidy-up that writes "nineteen sixty-six" as 1966 and "didn't"
 *    as "did not" changes more of it and adds nothing. There is no threshold in that gap.
 *
 *  - NOT an embedding check. `Xenova/bge-m3` is already a dependency of this server and it
 *    is sitting right there, which is exactly why this comment exists. Embeddings measure
 *    TOPICAL similarity, and an invented warm smile in a memory about a mother feeding you
 *    is maximally topically similar to the truth.
 *
 *  - NOT a denylist of bad words. The lists below whitelist the TRANSFORMATIONS a
 *    legitimate tidying may make (one inflection from a closed list, a contraction, a
 *    spoken number written in digits); they never enumerate the inventions, because
 *    inventions are unbounded and transformations are not.
 *
 * ENGLISH ONLY. Every rule below is an English rule. A word in another script (Han,
 * Cyrillic, Greek, Arabic, Devanagari ...) is read by none of them, so it is held to the
 * strictest one: it is an opaque word, matched only by the very same word, never free, and
 * kept like any other content word. A rewrite may copy it; adding, dropping or changing one
 * is refused. No rule claims it, so no check skips it.
 *
 * THE DECISIONS IT MAKES. A body is clean only when every one of these holds; each failure
 * is a `Violation` naming what was wrong, so a caller can say exactly that.
 *
 *   invented / number   every word of the body is a word of the source: the same word, the
 *                       same English word with one inflection from a CLOSED list (-s -es
 *                       -ed -d -ing -ly -er -est), or the same spoken number in digits.
 *                       Never a word that merely starts with, or sits inside, one they said:
 *                       "he" does not license "hero", 19 does not license 1952, "mother"
 *                       does not license "grandmother".
 *   negation / hedge    "not", "never", "no", and "maybe", "about forty", "I think" ... are
 *                       kept in both directions. Deleting one adds no word, which is
 *                       exactly why a bag of words cannot see it.
 *   person              a relative, a gendered noun or a gendered pronoun is never added,
 *                       swapped (she → he, grandmother → mother) or, for relatives, dropped.
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
 *  - WORDS IN ANOTHER SCRIPT are compared as written and kept in the order written, but what
 *    they say is never read: the holes above are theirs too.
 *
 * The unit is the word and the sentence, not the proposition; nothing short of a parser
 * closes these, and the mitigation is that a person can read the note beside what was said.
 */

/* ── 1. the old tokeniser, kept for its callers (claims.ts) ─────────── */

/**
 * Both `[[link]]` and `![[hash]]` are removed: neither is prose to be proved. Nothing inside a
 * link is a bracket, so a run of "[[[[" is read once, not once per bracket.
 */
const LINK_RE = /!?\[\[[^\][]*\]\]/g;
/**
 * A word: a run of ASCII letters and digits, or of the letters and digits (with their marks) of
 * a script other than Latin. A word in another script is kept whole, never read as spacing; an
 * accented Latin letter, punctuation and symbols separate words, as they always have here.
 */
const WORD_RUN =
  /(?:[0-9A-Za-z]|(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{N}]\p{M}*)+/gu;

/** The words of a text, links removed. The checker itself reads words with `wordsIn`. */
export function textWords(text: string): string[] {
  return [...text.normalize('NFC').replace(LINK_RE, ' ').matchAll(WORD_RUN)].map((m) => m[0]);
}

/* ── 2. preparing text ───────────────────────────────────────────────── */

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
/** José → jose, Zoë → zoe. Only marks on LATIN letters go: a word in another script keeps its own. */
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
  return t;
}

/* ── 3. sentences and words ──────────────────────────────────────────── */

/**
 * An English word, a number, or any other word: a word in another script, "1940s". The last
 * has no rule of its own, so it is matched only by the very same word.
 */
type Kind = 'en' | 'num' | 'x';

interface Tok {
  w: string;
  k: Kind;
  /** offsets in the sentence text */
  s: number;
  e: number;
  /** free: asserts nothing, so a body may add it ("the", "and") */
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

/** A word in any script: letters, their marks and digits, with an apostrophe inside ("didn't"). */
const WORD = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu;
const SENT_BREAK = /(?<=[.!?。…])\s+/;
/** "Mrs." and the "I." of "G.I." do not end a sentence. Tested on the last characters only. */
const ABBREV_END = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|st|jr|sr|mt|vs|etc|\p{L})\.$/u;

const kindOf = (w: string): Kind =>
  /^\d+$/.test(w) ? 'num' : /^[a-z]+(?:'[a-z]+)*$/.test(w) ? 'en' : 'x';

function wordsIn(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    out.push({ w, k: kindOf(w), s: m.index, e: m.index + w.length, f: false });
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

/* ── 4. which words count ────────────────────────────────────────────── */

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

/** Per-check state: the placement budget every sentence of one check draws on. */
interface Ctx {
  budget: number;
}
/** Placement work, in words checked, for one whole check: enough for any real interview. */
const newCtx = (): Ctx => ({ budget: 3_000_000 });

/** Which words of a sentence are free: English glue only. A word with no rule is never free. */
function flagged(toks: Tok[]): Tok[] {
  for (const t of toks) if (t.k === 'en') t.f = EN_FREE.has(t.w);
  return toks;
}

/** A word that places a sentence: content, people, negation and numbers; not glue. */
function isSupportWord(t: Tok): boolean {
  if (t.k === 'en') return !EN_LIGHT.has(t.w);
  return true;
}

/**
 * A word whose loss is a loss: content only (people, negation and hedges have their own
 * checks). A number, and a word with no rule (another script), is always content.
 */
function isRetainWord(t: Tok): boolean {
  if (t.k === 'en') return !EN_LIGHT.has(t.w) && !EN_PRONOUNS.has(t.w) && !NEG_EN.has(t.w);
  return true;
}

/* ── 5. evidence: where each word of one side appears ────────────────── */

interface Ev {
  /** English: inflection key -> sentence ids (ascending) */
  en: Map<string, number[]>;
  /** numbers and every word with no rule (another script, "1940s"): exact word -> sentence ids */
  ex: Map<string, number[]>;
  /** English person class (1s, 1p, 2, 3m, 3f, 3p) -> sentence ids that refer to one */
  pro: Map<string, number[]>;
  /** English inflection key -> the forms written (for tense: "works" said, "worked" written) */
  forms: Map<string, Set<string>>;
}

// Every table a word of the text is looked up in is a Map, never a plain object: "constructor"
// is an English word, and on a plain object it finds Object's own constructor and the check fails.

/**
 * A pronoun is supported where its person is: "He had big hands." is said by "My father ...
 * had big hands", and "I" by "me". Which "he" it is, and whether "she" became "he", is the
 * people check's question, not this one.
 */
const PRONOUN_CLASS = new Map<string, string>(
  Object.entries<string>({
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
  }),
);

function addSid(map: Map<string, number[]>, key: string, sid: number): void {
  const a = map.get(key);
  if (!a) map.set(key, [sid]);
  else if (a[a.length - 1] !== sid) a.push(sid);
}

const IRREGULAR_PLURAL = new Map<string, string>(
  Object.entries<string>({
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
  }),
);

/**
 * The CLOSED list of English inflections: a word and its -s, -es, -ed, -d, -ing, -ly, -er, -est
 * forms share a key (with the usual spelling rules: hoped/hope, stopped/stop, carried/carry,
 * dying/die). Nothing else: "hero" shares no key with "he", "annie" none with "ann".
 */
function enKeys(w: string): string[] {
  const out = [w];
  const irr = IRREGULAR_PLURAL.get(w);
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
const CLITIC_ALT = new Map<string, string[]>(
  Object.entries<string[]>({
    zzs: ['is', 'has', 'us'],
    zzc: ['is', 'has'],
    zzd: ['would', 'had', 'did'],
  }),
);

function buildEv(sents: Sent[]): Ev {
  const ev: Ev = {
    en: new Map(),
    ex: new Map(),
    pro: new Map(),
    forms: new Map(),
  };
  for (const s of sents) {
    for (const t of s.toks) {
      if (t.k === 'en') {
        for (const key of enKeys(t.w)) {
          addSid(ev.en, key, s.sid);
          const f = ev.forms.get(key);
          if (f) f.add(t.w);
          else ev.forms.set(key, new Set([t.w]));
        }
        for (const alt of CLITIC_ALT.get(t.w) ?? []) addSid(ev.en, alt, s.sid);
        const pc = PRONOUN_CLASS.get(t.w);
        if (pc) addSid(ev.pro, pc, s.sid);
        else {
          const p = enPerson(t.w);
          if (p && p.g !== 'n') addSid(ev.pro, `3${p.g}`, s.sid);
        }
      } else {
        addSid(ev.ex, t.w, s.sid);
      }
    }
  }
  return ev;
}

export type Support = 'scaffold' | 'grounded' | null;

/** Where a word is supported: lists of sentence ids, or free, or nowhere. */
interface Where {
  support: Support;
  lists: number[][];
}
const NOWHERE: Where = { support: null, lists: [] };
const FREE: Where = { support: 'scaffold', lists: [] };

function enWhere(w: string, ev: Ev): Where {
  if (EN_FREE.has(w)) return FREE;
  const lists: number[][] = [];
  for (const key of enKeys(w)) {
    const a = ev.en.get(key);
    if (a) lists.push(a);
  }
  const pc = PRONOUN_CLASS.get(w);
  const p = pc ? ev.pro.get(pc) : undefined;
  if (p) lists.push(p);
  return lists.length > 0 ? { support: 'grounded', lists } : NOWHERE;
}

/**
 * Where a word is supported in `ev`: an English word through its inflections (and a pronoun
 * through its person); a number, and a word with no rule, only where the very same word is.
 */
function whereOf(t: Tok, ev: Ev): Where {
  if (t.k === 'en') return enWhere(t.w, ev);
  const a = ev.ex.get(t.w);
  return a ? { support: 'grounded', lists: [a] } : NOWHERE;
}

/** Two words are one word: the same English inflection key, or else the very same word. */
function sameWord(a: Tok, b: Tok): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'en') {
    const kb = new Set(enKeys(b.w));
    return enKeys(a.w).some((k) => kb.has(k));
  }
  return a.w === b.w;
}

/* ── 6. negation and hedges ──────────────────────────────────────────── */

interface NegEvent {
  cls: string;
  /** the word the negation is about ("talk" in "did not talk"), when there is one */
  head: Tok | null;
  sid: number;
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
    out.push({ cls: 'not', head, sid: s.sid, shown: head ? `${t.w} ${head.w}` : t.w });
  }
}

function negationsOf(sents: Sent[]): NegEvent[] {
  const out: NegEvent[] = [];
  for (const s of sents) enNegations(s, out);
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
const MODAL_EN = new Map<string, string>(
  Object.entries<string>({
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
  }),
);
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
const FRAME_EN = new Map<string, string>();
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
  for (const f of forms.split(' ')) FRAME_EN.set(f, lemma);
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

/** Hedges (and wishes) of one sentence, as lemmas: "maybe", "about+n", "i think", "modal:try" ... */
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
      const modal = MODAL_EN.get(w);
      if (modal) out.push(`modal:${modal}`);
      if (MODAL_AUX.has(w)) out.push(`modal:${w}`);
      // "If my father had come home..." is not "My father had come home..."
      if (CONDITION_EN.has(w)) out.push(`cond:${w === 'till' ? 'until' : w}`);
      for (const p of MODAL_PHRASES) {
        if (p[0] === w && p.every((x, k) => t[i + k]?.w === x))
          out.push(`modal:${p[0] === 'has' || p[0] === 'had' ? 'have' : p[0]} to`);
      }
      const frame = FRAME_EN.get(w);
      const aside = asideAt(t, i);
      if (frame && !aside) out.push(`frame:${frame}`);
      if (FREQ_EN.has(w)) out.push(`freq:${w}`);
      if (ASPECT_EN.has(w) && !aside) out.push(`asp:${w}`);
      if (w === 'too' && !TOO_DEGREE.has(t[i + 1]?.w ?? '')) out.push('asp:also');
      const aspect = aspectAt(t, i);
      if (aspect) out.push(`aspect:${aspect}`);
      if (w === 'as' && t[i + 1]?.w === 'well' && t[i + 2]?.w !== 'as') out.push('asp:also');
    }
  }
  return out;
}

/**
 * How two things that were said are linked. A rewrite that joins "He drank. She left." may
 * write "He drank and she left", never "He drank, so she left": a cause, a contrast or an
 * order the speaker did not say is an invention. `causeOrTime` is "since" ("since he
 * drank"), which may be either: said, it allows a cause or an order; written, it needs one.
 */
type Link = 'cause' | 'contrast' | 'time' | 'causeOrTime';
interface LinkAt {
  cls: Link;
  /** the word as written, for "words that were not said" */
  word: string;
}
const LINK_EN = new Map<string, Link>(
  Object.entries<Link>({
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
  }),
);
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
      let cls: Link | undefined = LINK_EN.get(w);
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
        // "since he drank": a cause or a time ("since 1950" is neither)
        cls = 'causeOrTime';
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
    }
  }
  return out;
}
/**
 * A link written in the body is one the speaker made there: the same kind of link, or the
 * same word as often ("So, yeah, we left" -> "So we left"). "since" stands for a cause or
 * "then".
 */
function linksNotSaid(
  here: LinkAt[],
  there: LinkAt[],
  said: (w: string) => number,
  written: (w: string) => number,
): LinkAt[] {
  const has = new Set(there.map((l) => l.cls));
  return here.filter((l) => {
    if (said(l.word) >= written(l.word)) return false;
    if (l.cls === 'causeOrTime')
      return !has.has('causeOrTime') && !has.has('cause') && !has.has('time');
    if (l.cls === 'contrast') return !has.has('contrast');
    return !has.has(l.cls) && !has.has('causeOrTime');
  });
}

/**
 * What happened, in the order it was said. An event is a verb in a past form (drank, moved,
 * was born). "He drank and she left" is not "She left and he drank"; only a sentence with
 * "because", "when", "after" ... may put its events in another order, and then the event
 * "because" governs is kept ("We moved because the mine closed" is not "The mine closed
 * because we moved").
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
const eventCache = new WeakMap<Sent, EventAt[]>();
function eventsOf(s: Sent): EventAt[] {
  const hit = eventCache.get(s);
  if (hit) return hit;
  const out: EventAt[] = [];
  eventCache.set(s, out);
  const t = s.toks;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.w;
    if (t[i]!.k === 'en') {
      if (IRREGULAR_PAST.has(w) || PARTICIPLE_EN.has(w) || (w.length >= 5 && w.endsWith('ed')))
        out.push({ i, keys: enKeys(w) });
    }
  }
  return out;
}
const sameEvent = (a: EventAt, b: EventAt): boolean => a.keys.some((k) => b.keys.includes(k));
const hasSubord = (s: Sent): boolean => s.toks.some((t) => t.k === 'en' && SUBORD_EN.has(t.w));
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
 * Where to and where from: "He moved to Boston" is not "He moved from Boston". The same noun
 * keeps a preposition of the same kind ("in", "on" and "at" are one).
 */
const DIR_EN = new Map<string, string>(
  Object.entries<string>({
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
  }),
);
const DIR_SKIP = new Set(
  'the a an my our his her their your its this that these those some every each all both old little big new zzs'.split(
    ' ',
  ),
);
interface DirAt {
  obj: string;
  /** the preposition's kind */
  part: string;
  word: string;
}
const dirCache = new WeakMap<Sent, DirAt[]>();
function dirsOf(s: Sent): DirAt[] {
  const hit = dirCache.get(s);
  if (hit) return hit;
  const dirs: DirAt[] = [];
  const t = s.toks;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.w;
    if (t[i]!.k !== 'en') continue;
    const role = DIR_EN.get(w);
    if (!role) continue;
    let k = i + 1;
    while (k < t.length && k <= i + 3 && DIR_SKIP.has(t[k]!.w)) k++;
    const o = t[k];
    if (o && o.k === 'en' && !DIR_EN.has(o.w)) dirs.push({ obj: o.w, part: role, word: w });
  }
  dirCache.set(s, dirs);
  return dirs;
}
/** the body's words that point the other way from what was said there */
function dirsTurned(here: Sent, span: Sent[]): string[] {
  const mine = dirsOf(here);
  const theirs = span.map((x) => dirsOf(x));
  if (mine.length === 0 || theirs.every((x) => x.length === 0)) return [];
  const out: string[] = [];
  for (const d of mine) {
    let seen = false;
    let fits = false;
    for (const x of theirs)
      for (const e of x) {
        if (e.obj !== d.obj) continue;
        seen = true;
        if (e.part === d.part) fits = true;
      }
    if (seen && !fits) out.push(d.word);
  }
  return out;
}

/**
 * Words in another script: no rule reads them, so the order they were said in is all that can
 * be kept, and it is. "A B C" may come back as "A B C", split, or joined to the sentence beside
 * it, never as "A C B", and never with a word twice: moving one of those words (a negation, a
 * name, a number beside it) to another verb or into the next sentence, or saying it again,
 * changes what was said without changing a word. A sentence with a word in another script is
 * kept in order whole: its numbers and its other words with no English rule too.
 */
const FOREIGN_LETTER = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;
const foreignCache = new WeakMap<Sent, string[]>();
function foreignOf(s: Sent): string[] {
  const hit = foreignCache.get(s);
  if (hit) return hit;
  const out = s.toks.some((t) => t.k === 'x' && FOREIGN_LETTER.test(t.w))
    ? s.toks.filter((t) => t.k !== 'en').map((t) => t.w)
    : [];
  foreignCache.set(s, out);
  return out;
}
/** `a` stands in `b` as one run, in order. Knuth-Morris-Pratt: linear in both. */
function isRun(a: readonly string[], b: readonly string[]): boolean {
  if (a.length > b.length) return false;
  const fail = new Array<number>(a.length).fill(0);
  for (let i = 1, k = 0; i < a.length; i++) {
    while (k > 0 && a[i] !== a[k]) k = fail[k - 1]!;
    if (a[i] === a[k]) k++;
    fail[i] = k;
  }
  for (let i = 0, k = 0; i < b.length; i++) {
    while (k > 0 && b[i] !== a[k]) k = fail[k - 1]!;
    if (b[i] === a[k]) k++;
    if (k === a.length) return true;
  }
  return false;
}
/** the body sentence's words in another script are not one run of the words said there */
function foreignMoved(here: Sent, span: Sent[]): boolean {
  const mine = foreignOf(here);
  if (mine.length === 0) return false;
  const theirs = span.flatMap((x) => foreignOf(x));
  return !isRun(mine, theirs);
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
 * nothing.
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
  }
}
const qualifiers = (sents: Sent[]): Set<string> => {
  const m = new Set<string>();
  for (const s of sents) for (const h of hedgesOf(s)) m.add(h);
  return m;
};
/** a name the model can act on when it is asked to try again */
const showQualifier = (h: string): string =>
  h
    .replace(/^(?:modal|cond|frame|freq|asp):/, '')
    .replace('aspect:perfect', 'have done (the perfect)')
    .replace('aspect:prog', 'was doing (the progressive)')
    .replace('about+n', 'about/around (a number)');

/* ── 7. people ───────────────────────────────────────────────────────── */

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
const PRONOUN_GENDER = new Map<string, Gender>(
  Object.entries<Gender>({
    he: 'm',
    him: 'm',
    his: 'm',
    himself: 'm',
    she: 'f',
    her: 'f',
    hers: 'f',
    herself: 'f',
  }),
);

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
      // Latin letters only: a name is read from the Latin letters it is written in
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
  /** who is speaking and of whom: I, we, you, he, she, they */
  persons: Map<Who, { n: number; shown: string }>;
}

/**
 * The speaker is "I": "I was born in Busan" is not "He was born in Busan", "my mother" is not
 * "his mother", "I helped her" is not "You helped her".
 */
type Who = 'i' | 'we' | 'you' | 'he' | 'she' | 'they';
const PERSON_EN = new Map<string, Who>();
for (const [p, ws] of [
  ['i', 'i me my mine myself'],
  ['we', 'we us our ours ourselves'],
  ['you', 'you your yours yourself yourselves'],
  ['he', 'he him his himself'],
  ['she', 'she her hers herself'],
  ['they', 'they them their theirs themselves'],
] as const)
  for (const w of ws.split(' ')) PERSON_EN.set(w, p);
const FIRST_PERSON: readonly Who[] = ['i', 'we'];
const OTHER_PERSON: readonly Who[] = ['you', 'he', 'she', 'they'];
function personOf(t: readonly Tok[], i: number): Who | undefined {
  if (t[i]!.k !== 'en') return undefined;
  const p = PERSON_EN.get(t[i]!.w);
  // "you know", "you see", "thank you", "mind you": nobody is addressed
  if (
    p === 'you' &&
    (/^(?:know|see)$/.test(t[i + 1]?.w ?? '') || /^(?:thank|mind)$/.test(t[i - 1]?.w ?? ''))
  )
    return undefined;
  return p;
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
        const g = PRONOUN_GENDER.get(t.w);
        if (g) {
          out.pron[g]++;
          continue;
        }
      }
      const p = t.k === 'en' ? enPerson(t.w) : undefined;
      if (!p) continue;
      out.cls.set(p.cls, (out.cls.get(p.cls) ?? 0) + 1);
      if (p.kin) out.kin.add(p.cls);
      out.noun[p.g]++;
      if (!out.shown.has(p.cls)) out.shown.set(p.cls, t.w);
    }
  }
  return out;
}

/* ── 8. one side of the comparison ───────────────────────────────────── */

interface Side {
  sents: Sent[];
  negs: NegEvent[];
  ev: Ev;
}

/**
 * Sentences, with fragments ("Yes.", "Mrs.", "Slowly.") joined to their neighbour in the same
 * turn: a fragment cannot place anything on its own, and a rewrite moves them freely.
 */
function sideOf(raw: string): Side {
  const pieces = sentencesOf(normalise(raw)).map((p) => ({
    ...p,
    toks: flagged(wordsIn(p.text)),
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
  return { sents, negs, ev: buildEv(sents) };
}

/* ── 9. placing a sentence ───────────────────────────────────────────── */

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

/* ── 10. the report ──────────────────────────────────────────────────── */

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
 * What a tidy-up may clear from speech. Fillers may all go ("well", "yeah"; "you know" and
 * "I mean" are read as asides). Intensifiers ("just", "even", "really") may go one in ten, as
 * before: "I just got married" is not "I got married". Any other word the person said
 * ("secretly", "instead", "sometimes", any word in another script) is kept, and one is enough
 * to refuse: the real outputs keep every one.
 */
const FILLER_FREE = new Set(
  'like well so oh yeah yep yes okay ok anyway anyways gosh boy whatever'.split(' '),
);
const INTENSIFIER = new Set(
  (
    'just even really very actually basically literally honestly totally pretty quite real ' +
    'certainly definitely obviously surely truly simply completely entirely fully absolutely ' +
    'seriously frankly now right'
  ).split(' '),
);
const TURN_KEEP = 0.9;
const SENTENCE_KEEP = 0.6;
const SENTENCE_SUPPORT = 0.9;

type Mode = 'body' | 'title';

function analyse(rawSource: string, rawClaim: string, mode: Mode): GroundingReport {
  const ctx = newCtx();
  const src = sideOf(rawSource);
  const cl = sideOf(rawClaim);
  const violations: Violation[] = [];

  /* 1. every word of the body */
  const unsaid = new Set<string>();
  const unsaidNumbers = new Set<string>();
  const support = new Map<Sent, Where[]>();
  for (const s of cl.sents) {
    // each word once per sentence: "he said, he said" places nothing twice
    const ws = new Map<string, Where>();
    for (const t of s.toks) {
      const w = whereOf(t, src.ev);
      if (w.support === null) (t.k === 'num' ? unsaidNumbers : unsaid).add(t.w);
      if (isSupportWord(t) && (!ws.has(t.w) || ws.get(t.w)!.support === null)) ws.set(t.w, w);
    }
    support.set(s, [...ws.values()]);
  }
  // a word supported in one place is not "unsaid" because a neighbour differed in another
  const ungrounded = [...unsaid];
  const numbers = [...unsaidNumbers];
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
  // the speaker made into someone else ("I was born in Busan" -> "He was born in Busan"):
  // fewer "I" and "my", and a "he", "she", "they" more than the mentions of a person it may
  // stand for that went ("My mother left. My mother cried." -> "My mother left. She cried."
  // is a pronoun, not a new person); "you" never
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
    you: 0,
    he: gone('m') + namesGone,
    she: gone('f') + namesGone,
    they: gone('m') + gone('f') + gone('n') + namesGone,
  };
  const others: string[] = [];
  for (const c of OTHER_PERSON) {
    const a = pa.persons.get(c)?.n ?? 0;
    const b = pb.persons.get(c);
    if (!b || b.n <= a) continue;
    if ((c === 'you' && (a === 0 || fewerI)) || (fewerI && b.n - a > stands[c]))
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
      v = sameWord(a, b);
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

  /* 4. hedges, wishes and modals ("maybe", "I think", "could have"): the same ones
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
  const foreignOut: string[] = [];
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
          foreign?: true;
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
        if (foreignMoved(s, span)) out.foreign = true;
        return out;
      };
      const clean = (p: ReturnType<typeof problems>) =>
        !p.neg && !p.qual && !p.tense && !p.pron && !p.link && !p.order && !p.dir && !p.foreign;
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
        if (p.foreign) foreignOut.push(clip(s.text));
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
  // 5b. ...and across the whole text, those words in the order they were said, none of them
  // more often (a sentence split in two and turned round, a word said again as its own sentence)
  {
    const said = src.sents.flatMap((x) => foreignOf(x));
    const known = new Set(said);
    let k = 0;
    for (const s of cl.sents) {
      let moved = false;
      for (const w of foreignOf(s)) {
        if (!known.has(w)) continue; // a word never said is "invented", not moved
        while (k < said.length && said[k] !== w) k++;
        if (k === said.length) {
          moved = true;
          break;
        }
        k++;
      }
      if (moved) {
        foreignOut.push(clip(s.text));
        break;
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
  if (foreignOut.length > 0)
    violations.push({
      kind: 'unsupported_sentence',
      detail: `words in another script moved or said again: ${quoted([...new Set(foreignOut)])}`,
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
    const qualGone: string[] = [];
    for (const s of src.sents) {
      const byWord = new Map<string, Where>();
      const turn = turns.get(s.turn) ?? { total: new Set<string>(), found: new Set<string>() };
      turns.set(s.turn, turn);
      s.toks.forEach((t, i) => {
        if (!isRetainWord(t) || asideAt(s.toks, i)) return;
        const w = whereOf(t, cl.ev);
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
      // its "maybe" and "could have" are still there, where it was said (in any place that
      // holds its words: the same words can stand in two places)
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
    // step 4's missing ones (a sentence left out whole still has its "maybe" named)
    const qa = qualifiers(src.sents);
    const qb = qualifiers(cl.sents);
    alignZzd(qa, qb);
    const lostH = [...qa].filter((h) => !qb.has(h));
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
