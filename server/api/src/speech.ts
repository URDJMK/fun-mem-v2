/**
 * Things that are true of SPOKEN language and false of written language,
 * handled in code so the model never has to be trusted with them:
 *
 *   cleanSpeech           disfluencies out ("um", "I, I", ", you know,")
 *   capitalizeSentences   a capital at the start of a turn and after each sentence end
 *   spokenYearsToDigits   "nineteen sixty-six" -> "1966", but never a price or a quantity
 *   readEnglishDate       a fuzzy date out of English prose
 *
 * Why in code: both are PROVABLE transformations. Removing "um" cannot add a
 * fact; reading "nineteen sixty-six" as 1966 is arithmetic. A model asked to do
 * either is a model that might also "helpfully" do something else.
 *
 * Every pattern here runs on text of any length in linear time: no pattern has two
 * unbounded quantifiers that can share characters, and every look at the context of a
 * match reads a bounded slice.
 */

/* ── disfluency ──────────────────────────────────────────────────────── */

// words a person repeats by stammering ("I, I", "and and"), never for meaning
const STAMMER = '(?:i|we|he|she|they|it|and|but|so|the|a|my|just|then|you)';

/**
 * A full stop that ends an abbreviation or an initial, not a sentence: "Elm St. and Fifth Ave.
 * near the river", "the Co. for thirty years", "at 9 a.m. and", "J. R. R. Tolkien".
 */
const ABBREVIATION =
  /(?:\b(?:st|ave|rd|blvd|ln|co|corp|inc|ltd|mr|mrs|ms|mx|dr|prof|sr|jr|mt|ft|vol|dept|univ|gen|col|lt|sgt|capt|rev|fr|hon|approx|etc|vs|est|jan|feb|mar|apr|aug|sept|sep|oct|nov|dec)|\b[a-z]|\b(?:[a-z]\.){1,3}[a-z])$/i;

/** A capital at the start of the text and after each sentence end. Nothing else changes. */
export function capitalizeSentences(t: string): string {
  return t.replace(
    /(^|[.!?]\s+|\n)(["'“‘(]?)([a-z])/g,
    (m: string, a: string, q: string, c: string, at: number, whole: string) =>
      a.startsWith('.') && ABBREVIATION.test(whole.slice(Math.max(0, at - 8), at))
        ? m
        : a + q + c.toUpperCase(),
  );
}

/** words after which a sentence cannot pause: a conjunction, article, preposition, possessive or subject */
const NEEDS_FOLLOWER =
  /^(?:and|but|or|so|that|because|if|when|while|as|the|a|an|of|in|on|at|to|with|for|from|by|my|our|his|her|their|your|its|is|was|were|are|had|have|i|we|he|she|they|it)$/i;
/** words that carry on a phrase ("there, you know, BY the water"), as opposed to starting a clause ("got through, you know, PEOPLE helped") */
const CONTINUES =
  /^(?:by|in|on|at|to|of|for|from|with|near|into|onto|under|over|behind|across|and|but|or)$/i;

/**
 * Whitespace runs of two or more become one character (a newline if the run held one).
 * Several patterns below begin with `\s*` or `\s+`; on a long run with no punctuation after
 * it each of those tries every start position and rescans the rest: quadratic. A run of one
 * cannot be. Removing fillers can make a long run ("um um um ..." leaves one), so this is also
 * done again after them.
 */
const squash = (x: string): string => x.replace(/\s{2,}/g, (m) => (m.includes('\n') ? '\n' : ' '));

const hasWords = (t: string): boolean => /[\p{L}\p{N}]/u.test(t);

export interface CleanOptions {
  /** capital at the start and after sentence ends (default true); off for a fragment of a turn */
  capitalize?: boolean;
  /**
   * When the words are ONLY fillers ("Mm-hm.", "음."), keep them as they were instead of
   * returning nothing (default true): a turn that was said is never made empty. "Mm-hm" on its
   * own is often the answer "yes".
   */
  keepFillerOnly?: boolean;
}

/**
 * Um, Uh and Uhm are also Korean family names (엄, 어): "His name was Um Jae-sun", "We met Mr. Um
 * at church". A capitalised one is a NAME when a title stands before it, a capitalised word
 * (not "I") follows it, or it sits in the middle of a sentence; a filler starts a sentence or
 * stands between commas. Reads a bounded slice on each side.
 */
const TITLE_BEFORE = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Miss|Mister|Madam|Sir|Aunt|Uncle)\.?\s+$/i;
function isName(word: string, whole: string, from: number, to: number): boolean {
  if (!/^(?:Um|Uh|Uhm)$/.test(word)) return false;
  const before = whole.slice(Math.max(0, from - 12), from);
  const after = whole.slice(to, to + 16);
  if (TITLE_BEFORE.test(before)) return true;
  if (/^\s+\p{Lu}/u.test(after) && !/^\s+I(?:\b|['’])/.test(after)) return true;
  return /[\p{L}\p{N}]\s+$/u.test(before) && !/^[,;]/.test(after);
}

/** words a person repeats by stammering across a comma; "I told you, you have to" and "she hit it, it broke" are two clauses */
const COMMA_STAMMER = /^(?:i|we|he|she|they|the|a|and|but|so|my|just)$/i;

const NUMBERISH =
  /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/i;
const MONTH_OR_DAY =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|spring|summer|autumn|fall|winter)\b/i;
const PHRASE_START =
  /^(?:my|your|his|her|our|their|the|a|an|in|on|at|to|from|with|for|by|this|that|those|these)$/i;

/**
 * Does ", I mean, …" CORRECT what came just before? "In 1950, I mean, 1951", "My mother, I mean,
 * my stepmother", "in March, I mean, in May", "John, I mean, Jim": then it is meaning, and stays.
 * "He was, I mean, a kind man" only hedges. Bounded slices of the text on each side.
 */
function corrects(before: string, after: string): boolean {
  const phrase = before.split(/[,.;!?]/).pop() ?? '';
  const next = /^\s*([\p{L}\p{N}'’]+)/u.exec(after)?.[1] ?? '';
  if (next === '') return false;
  if (/^(?:not|no)$/i.test(next)) return true;
  if (NUMBERISH.test(next) && NUMBERISH.test(phrase)) return true;
  if (MONTH_OR_DAY.test(next) && MONTH_OR_DAY.test(phrase)) return true;
  if (PHRASE_START.test(next) && phrase.toLowerCase().split(/\s+/).includes(next.toLowerCase()))
    return true;
  const last = phrase.trim().split(/\s+/).pop() ?? '';
  return (
    /^\p{Lu}/u.test(next) && next !== 'I' && /^\p{Lu}/u.test(last) && phrase.trim().includes(' ')
  );
}

/**
 * Clean-verbatim: remove what carries no meaning, change nothing else.
 *
 * Deliberately narrow. "like", "well", "so" and "sort of" are left alone: each
 * is sometimes a filler and sometimes the speaker's meaning, and deleting the
 * wrong one rewrites the testimony.
 */
export function cleanSpeech(input: string, opts: CleanOptions = {}): string {
  const { capitalize = true, keepFillerOnly = true } = opts;
  let t = squash(input);

  // a filler enclosed by commas takes both commas with it ("he, uh, offered"), unless the commas
  // separate a correction or a list: "Sixty, um, sixty-one" keeps one
  t = t.replace(
    /\s*,\s*(?:um+|uh+|uhm|erm|hmm+|mhm)\s*,\s*/gi,
    (m: string, at: number, whole: string) =>
      corrects(
        whole.slice(Math.max(0, at - 60), at),
        whole.slice(at + m.length, at + m.length + 40),
      )
        ? ', '
        : ' ',
  );
  // a filler that is a sentence of its own takes its full stop with it: "Um. I think…" is "I
  // think…", never ". I think…"
  t = t.replace(
    /(^|[.!?…]\s+)(?:um+|uh+|uhm|erm|hmm+|mhm|mm-?hm+)[.!?…]+(?=\s|$)/gi,
    // only a title makes it a name here: the capital after "Um." starts the next sentence
    (m: string, lead: string, at: number, whole: string) =>
      /^(?:Um|Uh|Uhm)/.test(m.slice(lead.length)) &&
      TITLE_BEFORE.test(whole.slice(Math.max(0, at + lead.length - 12), at + lead.length))
        ? m
        : lead,
  );
  // English filler interjections
  t = t.replace(
    /(^|[\s,;.!?(])(?:um+|uh+|uhm|erm|hmm+|mhm|mm-?hm+)(?=$|[\s,;.!?)])[,;]?/gi,
    (m: string, lead: string, at: number, whole: string) => {
      const word = m.slice(lead.length).replace(/[,;]$/, '');
      if (isName(word, whole, at + lead.length, at + m.length)) return m;
      // "he only ever said hmm when I asked": a sound named between two words is a word
      if (
        /^(?:hmm+|mhm|mm-?hm+)$/i.test(word) &&
        /[\p{L}\p{N}] $/u.test(whole.slice(Math.max(0, at - 2), at + lead.length)) &&
        /^ [\p{L}\p{N}]/u.test(whole.slice(at + m.length, at + m.length + 2))
      ) {
        return m;
      }
      return lead;
    },
  );
  // removing "um um um ..." leaves one long run of spaces: shorten it before the patterns below see it
  t = squash(t);
  // between two clauses ("we got through, you know, people helped") one comma stays; after a
  // word that needs a follower ("and, you know, a barn") both go. The pattern starts AT the
  // comma, and the word before it is found by walking back: a pattern that began with the word
  // would rescan a long unbroken run from every position, which is quadratic.
  t = t.replace(
    /\s*,\s*(?:you know|i mean|you see)\s*,\s*/gi,
    (m: string, at: number, whole: string) => {
      if (
        /i mean/i.test(m) &&
        corrects(
          whole.slice(Math.max(0, at - 60), at),
          whole.slice(at + m.length, at + m.length + 40),
        )
      ) {
        return m;
      }
      let from = at;
      while (from > 0 && !/[\s,]/.test(whole[from - 1]!)) from--;
      const prev = whole.slice(from, at);
      const next = /^[A-Za-z']+/.exec(whole.slice(at + m.length, at + m.length + 24))?.[0] ?? '';
      return prev === '' || NEEDS_FOLLOWER.test(prev) || CONTINUES.test(next) ? ' ' : ', ';
    },
  );
  t = t.replace(/(^|[.!?]\s+)(?:you know|i mean)\s*,\s*/gi, '$1');
  t = squash(t);
  // Stammered repeats, up to a triple. Only the SAME spelling ("A, a" is a grade and an
  // article), and "so so" without a comma is "so-so", a word with a meaning.
  const rep = new RegExp(`\\b(${STAMMER})\\b(\\s*,\\s*|\\s+)\\1\\b`, 'gi');
  for (let i = 0; i < 2; i++) {
    t = t.replace(rep, (m: string, w: string, sep: string, at: number, whole: string) => {
      if (m.slice(m.length - w.length) !== w) return m;
      if (w.toLowerCase() === 'so' && !sep.includes(',')) return m;
      // "So, so." at the end of a sentence is "so-so", an answer
      if (
        w.toLowerCase() === 'so' &&
        /^\s*(?:[.!?…]|$)/.test(whole.slice(at + m.length, at + m.length + 3))
      )
        return m;
      if (sep.includes(',') && !COMMA_STAMMER.test(w)) return m;
      return w;
    });
  }
  // Korean fillers, only when they stand alone
  t = t.replace(/(^|\s)(?:어+|음+|으음+|흠+)(?=[\s,.…]|$)[,.…]*/g, '$1');

  t = squash(t)
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/(^|[.!?]\s+),\s*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  // a mark left in front by a removed filler ("Mm-hm. That is right." -> ". That is right."), never
  // one the speaker's own text began with ("...and that is how we ended up in Daegu.")
  if (!/^\s*[.,;:!?…]/.test(input)) t = t.replace(/^[.,;:!?…]+\s*/, '');
  if (!hasWords(t)) {
    // nothing but fillers: what was said stays said
    if (!keepFillerOnly) return '';
    const said = squash(input).trim();
    return hasWords(said) ? said : t;
  }
  return capitalize ? capitalizeSentences(t) : t;
}

/* ── spoken numbers ──────────────────────────────────────────────────── */

const ONES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const key = (o: Record<string, number>) => Object.keys(o).join('|');
const SEP = String.raw`[\s-]+`;

// the second half of a year: "sixty-six", "sixty", "ten", "seventeen"
const TAIL = String.raw`(?:(${key(TENS)})(?:${SEP}(${key(ONES)}))?|(${key(TEENS)}))`;
// what can follow "two thousand (and)" or "nineteen hundred (and)": "twenty-one", "twelve", "five"
const SMALL = String.raw`(?:(${key(TENS)})(?:${SEP}(${key(ONES)}))?|(${key(TEENS)})|(${key(ONES)}))`;

const smallValue = (tens?: string, ones?: string, teen?: string, one?: string): number =>
  tens
    ? TENS[tens.toLowerCase()]! + (ones ? ONES[ones.toLowerCase()]! : 0)
    : teen
      ? TEENS[teen.toLowerCase()]!
      : one
        ? ONES[one.toLowerCase()]!
        : 0;

/** After one of these a number is money: "we paid nineteen fifty", "it cost two thousand". */
const MONEY_VERB =
  /^(?:paid|pay|pays|paying|cost|costs|costing|price|priced|charged|charge|charges|spent|spend|spending|earned|earn|earns|worth|sold|sell|sells|bought|buy|owed|owe|lent|borrowed|saved|wage|wages|salary|rent)$/i;
/** After one of these a number is money when the sentence talks about money: "sold it for nineteen fifty". */
const MONEY_PREP = /^(?:for|of|at)$/i;
const MONEY_WORD =
  /(?:[$₩€£]|\b(?:dollars?|bucks|cents?|pounds?|won|euros?|yen|quid|price|prices|cost|costs|paid|pay|wages?|salary|rent|sold|bought|money)\b)/i;
/**
 * After these ("around 1970", "about nineteen fifty") a number is a YEAR unless the sentence
 * speaks of money outright: "Sometime around 1970 we bought the shop" is a date, "He paid around
 * 1950 for the cow" a price. Buying and selling alone do not make a number money.
 */
const APPROX_PREP = /^(?:about|around|nearly|almost|roughly|approximately|only|just|over|under)$/i;
const STRONG_MONEY_WORD =
  /(?:[$₩€£¥]|\b(?:dollars?|bucks|cents?|pounds?|euros?|yen|quid|price|prices|cost|costs|paid|pay|wages?|salary|money)\b|\d\s*won\b)/i;
/** A noun within two words after a number makes it a quantity: "two thousand people", "eighteen hundred acres". */
const QUANTITY =
  /^(?:dollars?|bucks|cents?|pounds?|won|euros?|yen|quid|grand|cows?|cattle|chickens?|hens?|pigs?|sheep|goats?|horses?|head|fish|people|persons?|men|women|kids|children|students|graduates|soldiers|workers|families|households|houses|homes|acres?|hectares?|pyeong|years?|months?|weeks?|days?|hours?|minutes?|seconds?|miles?|kilomet(?:er|re)s?|km|meters?|metres?|feet|foot|ft|inches|kilos?|kilograms?|kg|grams?|tons?|tonnes?|lbs?|gallons?|liters?|litres?|bags?|boxes|sacks?|bushels?|trees|times|percent|%|words|pages|copies|items|units|rooms|steps|hundred|thousand|million|billion)$/i;
/** An address is not a year either: "1946 Main Street". */
const ADDRESS =
  /^(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|way|place|court|highway)$/i;
/** A bare "two thousand" or "nineteen hundred" is a year only after one of these. */
const BARE_YEAR_LEAD =
  /^(?:in|since|until|till|from|by|during|around|about|before|after|of|year)$/i;

/** The word just before `at`, lower-cased ('' if none). Reads at most 30 characters. */
function wordBefore(whole: string, at: number): string {
  const m = /([A-Za-z'’]+)[\s,]*$/.exec(whole.slice(Math.max(0, at - 30), at));
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * Up to two words just after `at`. Reads at most 50 characters. A comma ends the number's phrase:
 * in "nineteen fifty, four years later" and "In 1950, two years after the war" the "years" belong
 * to the next phrase, and the year stays a year.
 */
function wordsAfter(whole: string, at: number): string[] {
  // a hyphen too: "twenty twenty-dollar bills"
  const m = /^[\s-]*([A-Za-z'’%]+)(?:[\s-]+([A-Za-z'’%]+))?/.exec(whole.slice(at, at + 50));
  return m ? [m[1]!, m[2] ?? ''].filter((w) => w !== '') : [];
}

/** The sentence around [from, to), at most 200 characters each side. */
function sentenceAround(whole: string, from: number, to: number): string {
  const left = whole.slice(Math.max(0, from - 200), from);
  const right = whole.slice(to, to + 200);
  const cut = Math.max(left.lastIndexOf('.'), left.lastIndexOf('!'), left.lastIndexOf('?'));
  const ends = [right.indexOf('.'), right.indexOf('!'), right.indexOf('?')].filter((i) => i >= 0);
  return `${left.slice(cut + 1)} ${whole.slice(from, to)} ${right.slice(0, ends.length ? Math.min(...ends) : right.length)}`;
}

/**
 * Is the number written at [from, to) a price or a quantity rather than a year? `bare` is a
 * round number with nothing after it ("two thousand", "nineteen hundred"), which is a year
 * only in phrases like "in two thousand".
 */
export function isQuantityContext(whole: string, from: number, to: number, bare = false): boolean {
  const after = wordsAfter(whole, to);
  if (after.some((w) => QUANTITY.test(w) || ADDRESS.test(w))) return true;
  const before = wordBefore(whole, from);
  if (MONEY_VERB.test(before)) return true;
  if (MONEY_PREP.test(before) && MONEY_WORD.test(sentenceAround(whole, from, to))) return true;
  if (APPROX_PREP.test(before) && STRONG_MONEY_WORD.test(sentenceAround(whole, from, to)))
    return true;
  return bare && !BARE_YEAR_LEAD.test(before);
}

/**
 * "nineteen sixty-six" -> 1966, "nineteen oh five" -> 1905, "twenty twenty-one"
 * -> 2021, "two thousand and twenty-one" -> 2021, "nineteen hundred and twelve" -> 1912.
 *
 * "twenty five" is NOT a year (it is 25), so a bare ones-word after "twenty" is
 * never converted; only a tens or teens word makes a year. A price or a quantity is
 * never a year: "we paid nineteen fifty for that cow", "two thousand people",
 * "eighteen hundred acres", "for nineteen hundred dollars" all stay words.
 */
export function spokenYearsToDigits(text: string): string {
  let t = text;
  // two thousand (and) twenty-one / twelve / five / nothing
  t = t.replace(
    // "and" only with a number after it: "in two thousand and then we moved" keeps its "and"
    new RegExp(String.raw`\btwo${SEP}thousand(?:(?:${SEP}and)?${SEP}${SMALL})?\b`, 'gi'),
    (
      m: string,
      tens: string | undefined,
      ones: string | undefined,
      teen: string | undefined,
      one: string | undefined,
      at: number,
      whole: string,
    ) => {
      const n = 2000 + smallValue(tens, ones, teen, one);
      const bare = !tens && !teen && !one;
      if (n > 2049 || isQuantityContext(whole, at, at + m.length, bare)) return m;
      return String(n);
    },
  );
  // (nineteen|eighteen) hundred (and) twelve / forty-six / nothing
  t = t.replace(
    new RegExp(
      String.raw`\b(nineteen|eighteen)${SEP}hundred(?:(?:${SEP}and)?${SEP}${SMALL})?\b`,
      'gi',
    ),
    (
      m: string,
      c: string,
      tens: string | undefined,
      ones: string | undefined,
      teen: string | undefined,
      one: string | undefined,
      at: number,
      whole: string,
    ) => {
      const base = c.toLowerCase() === 'nineteen' ? 1900 : 1800;
      const bare = !tens && !teen && !one;
      if (isQuantityContext(whole, at, at + m.length, bare)) return m;
      return String(base + smallValue(tens, ones, teen, one));
    },
  );
  // (nineteen|eighteen) oh five
  t = t.replace(
    new RegExp(String.raw`\b(nineteen|eighteen)${SEP}(?:oh|zero)${SEP}(${key(ONES)})\b`, 'gi'),
    (m: string, c: string, o: string, at: number, whole: string) =>
      isQuantityContext(whole, at, at + m.length)
        ? m
        : String((c.toLowerCase() === 'nineteen' ? 1900 : 1800) + ONES[o.toLowerCase()]!),
  );
  // (nineteen|eighteen|twenty) <tens [ones] | teens>
  t = t.replace(
    new RegExp(String.raw`\b(nineteen|eighteen|twenty)${SEP}${TAIL}\b`, 'gi'),
    (
      m: string,
      c: string,
      tens: string | undefined,
      ones: string | undefined,
      teen: string | undefined,
      at: number,
      whole: string,
    ) => {
      const base = { nineteen: 1900, eighteen: 1800, twenty: 2000 }[c.toLowerCase() as 'nineteen']!;
      const tail = teen
        ? TEENS[teen.toLowerCase()]!
        : TENS[tens!.toLowerCase()]! + (ones ? ONES[ones.toLowerCase()]! : 0);
      // "twenty twenty" is 2020 but "twenty thirty cows" is not worth a guess: cap at 2029
      if (base === 2000 && tail > 29) return m;
      if (isQuantityContext(whole, at, at + m.length)) return m;
      return String(base + tail);
    },
  );
  return t;
}

/**
 * "forty" -> 40, "forty-two" -> 42, "two hundred fifty" -> 250, "fifteen" -> 15.
 *
 * "one" is left alone on purpose ("no one", "one day", "the one who" are not
 * quantities). Run `spokenYearsToDigits` FIRST, so "nineteen eighty-four" becomes
 * 1984 rather than 19 and 84.
 */
export function spokenNumbersToDigits(text: string): string {
  let t = text;
  t = t.replace(
    new RegExp(
      String.raw`\b(${key(ONES)})${SEP}hundred(?:${SEP}(?:and${SEP})?(${key(TENS)})(?:${SEP}(${key(ONES)}))?)?\b`,
      'gi',
    ),
    (_m, h: string, tens?: string, ones?: string) =>
      String(
        ONES[h.toLowerCase()]! * 100 +
          (tens ? TENS[tens.toLowerCase()]! : 0) +
          (ones ? ONES[ones.toLowerCase()]! : 0),
      ),
  );
  t = t.replace(
    new RegExp(String.raw`\b(${key(TENS)})(?:${SEP}(${key(ONES)}))?\b`, 'gi'),
    (_m, tens: string, ones?: string) =>
      String(TENS[tens.toLowerCase()]! + (ones ? ONES[ones.toLowerCase()]! : 0)),
  );
  t = t.replace(new RegExp(String.raw`\b(${key(TEENS)})\b`, 'gi'), (_m, w: string) =>
    String(TEENS[w.toLowerCase()]!),
  );
  t = t.replace(/\b(two|three|four|five|six|seven|eight|nine)\b/gi, (_m, w: string) =>
    String(ONES[w.toLowerCase()]!),
  );
  return t;
}

/* ── dates ───────────────────────────────────────────────────────────── */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
// A full month name never takes a full stop: "in May. 1951 was the year…" is two sentences.
const MONTH_WORDS =
  'January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
const MONTH_RE = `(${MONTH_WORDS})`;
// month + year with NO day must start with a capital: "may" and "march" are also words
const MONTH_CAP = `(${MONTH_WORDS})`;
const YEAR = String.raw`(1[89]\d{2}|20[0-4]\d)`;
const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
];
const ORDINAL_DAY: Record<string, number> = Object.fromEntries([
  ...ORDINALS.map((w, i) => [w, i + 1] as const),
  ...ORDINALS.slice(0, 9).map((w, i) => [`twenty-${w}`, 21 + i] as const),
  ['thirtieth', 30] as const,
  ['thirty-first', 31] as const,
]);
// compound ordinals first, so "twenty-first" is not read as "twenty" and "first"
const ORDINAL_RE = Object.keys(ORDINAL_DAY)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace('-', '[- ]'))
  .join('|');
const DAY = String.raw`(\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_RE})`;
const pad = (n: number | string) => String(n).padStart(2, '0');
const monthNo = (m: string): string =>
  pad(MONTHS.findIndex((x) => x.startsWith(m.replace('.', '').toLowerCase().slice(0, 3))) + 1);
const dayNo = (d: string): string => {
  const w = d.toLowerCase().replace(' ', '-');
  return pad(ORDINAL_DAY[w] ?? parseInt(d, 10));
};

const HEDGE =
  /\b(?:around|about|roughly|approximately|circa|maybe|perhaps|probably|possibly|i think|i believe|i guess|i suppose|somewhere|or so)\b/i;

/**
 * The EARLIEST date mentioned in English prose, as raw fuzzy text, or null.
 * Same rules as the Korean reader: null is the common answer; a year alone never
 * grows a month; `~` appears only when the speaker hedged next to the date.
 */
export function readEnglishDate(input: string): string | null {
  const text = spokenYearsToDigits(input);
  const found: Array<{ at: number; len: number; raw: string }> = [];
  const add = (
    re: RegExp,
    build: (m: RegExpExecArray) => string,
    keep: (m: RegExpExecArray) => boolean = () => true,
  ) => {
    for (const m of text.matchAll(re)) {
      const x = m as RegExpExecArray;
      if (keep(x)) found.push({ at: x.index, len: x[0].length, raw: build(x) });
    }
  };

  // March 15th, 1987   /   March 15 1987   /   June the fifteenth, 1967
  add(
    new RegExp(String.raw`\b${MONTH_RE}\s+(?:the\s+)?${DAY},?\s+(?:of\s+)?${YEAR}\b`, 'gi'),
    (m) => `${m[3]}-${monthNo(m[1]!)}-${dayNo(m[2]!)}`,
  );
  // 15th of March, 1987   /   the fifteenth of June, 1967
  add(
    new RegExp(String.raw`\b${DAY}\s+of\s+${MONTH_RE},?\s+${YEAR}\b`, 'gi'),
    (m) => `${m[3]}-${monthNo(m[2]!)}-${dayNo(m[1]!)}`,
  );
  // June of 1967  /  June, 1967  /  June 1967
  add(
    new RegExp(String.raw`\b${MONTH_CAP}(?:,\s*|\s+)(?:of\s+)?${YEAR}\b`, 'g'),
    (m) => `${m[2]}-${monthNo(m[1]!)}`,
  );
  // a bare year that is not a quantity ("1500 feet", "$2000", "1950 dollars", "1946 Main Street")
  add(
    new RegExp(String.raw`(?<![\d$.,])${YEAR}(?![\d,.]?\d)(?![가-힣A-Za-z])`, 'g'),
    (m) => m[1]!,
    (m) => !isQuantityContext(text, m.index, m.index + m[0].length),
  );

  found.sort((a, b) => a.at - b.at);
  const first = found[0];
  if (!first) return null;
  // A hedge counts only when it sits NEXT TO the date. "maybe fifteen miles an hour"
  // and "I dream about that barn" say nothing about how sure the speaker is of a year.
  const before = text
    .slice(Math.max(0, first.at - 24), first.at)
    .split(/[.!?]\s/)
    .pop()!;
  const after = text.slice(first.at + first.len, first.at + first.len + 24).split(/[.!?]\s/)[0]!;
  const alternative = /^\s*,?\s*or\s+(?:'?\d{2}|\d{4})\b/i.test(after);
  const approx = alternative || HEDGE.test(`${before} ${after}`) ? '~' : '';
  return approx + first.raw;
}
