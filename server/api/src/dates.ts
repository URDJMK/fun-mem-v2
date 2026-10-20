import { parseFuzzyDate } from '@funmem/core';
import { readEnglishDate, spokenYearsToDigits } from './speech';

/**
 * The date of a memory, or null. A wrong date on a family timeline is worse than none: a
 * cow bought for "nineteen fifty" must not file the story under 1950, the recording's own
 * date ("Today is the eighteenth of October, two thousand and twenty-six") is not a memory's
 * date, and "my grandmother, who was born in eighteen ninety-eight, made kimchi every
 * November" is not a story of 1898.
 *
 * Rules, in the order they act:
 *   - the text is read SENTENCE BY SENTENCE; `>` lines (footers) are not text;
 *   - a sentence about the recording itself ("today is", "this interview was recorded") is skipped;
 *   - numbers that only look like years are masked first, spoken or in digits: prices and
 *     quantities ("nineteen hundred dollars", "1946 chickens", "$2000"), addresses ("1946 Main
 *     Street"), things with a number ("Room 1912", "Flight 1946", "jersey number 1984"), phone
 *     numbers ("555-1946", "010-1946-5523");
 *   - a year the speaker rejects ("not 1950, it was 1951"), reports as someone else's ("everyone
 *     says 1950"), meets only as today's date ("it is 2026 now") or has not reached ("I hope to
 *     see 2030") is not the memory's date;
 *   - spans (since/until/from/between), ranges ("1950-53") and decades ("the 1960s") are time
 *     claims but not events: they never BECOME the date, and they count as a second year when
 *     another year is named ("guessing which year the speaker meant would put a star in the
 *     wrong decade");
 *   - a year inside "who was born in ...," or ", born 1920," or "(born 1920)" is about a third
 *     person, not what the memory is about, and competes with nothing;
 *   - a hedge NEXT TO the date ("maybe", "about", "I think") yields "~YYYY";
 *   - one year named (in any sentence): that year. Several different years: the one in the
 *     first substantive sentence when that sentence names exactly one, otherwise none.
 * Whatever is returned has been re-parsed by parseFuzzyDate.
 */

/* ── what is not a date ──────────────────────────────────────────────── */

/** 1,946 or 3.5, never a trailing comma: "1950, two years after the war" is a year, not a count */
// bounded on purpose: an open-ended group makes every start position scan the whole rest of a
// run like "1.1.1.1…" (400k characters took minutes)
const DIGITS = String.raw`\d{1,6}(?:[,.]\d{1,3}){0,2}`;
const NUMW = String.raw`(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|${DIGITS})`;
/** up to eight number words or numbers in a row ("nineteen hundred and forty-six") */
const NUMSEQ = String.raw`(?:${NUMW}[\s-]+){0,7}${NUMW}`;
const QTY = String.raw`(?:dollars?|bucks?|cents?|pounds?|euros?|yen|pesos?|cows?|chickens?|pigs?|sheep|goats?|horses?|ducks?|people|persons?|men|women|children|kids|boys|girls|soldiers|workers|guests|students|neighbou?rs|acres?|miles?|feet|foot|yards?|inches|meters?|metres?|kilometers?|kilometres?|years?|months?|weeks?|days?|hours?|minutes?|tons?|bags?|bushels?|percent|per\s+cent|times|steps)`;
const YEAR = String.raw`(?:1[89]\d{2}|20[0-4]\d)`;
/** "maybe ten families in 1950" hedges the count, not the year */
const SMALL_NUMBER = String.raw`zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|few|several|couple|dozen`;

/** "nineteen hundred dollars", "two thousand people", "1946 chickens" */
const BEFORE_QUANTITY = new RegExp(String.raw`\b${NUMSEQ}(?=\s+${QTY}\b)`, 'gi');
/** "paid nineteen fifty for that cow", "it cost nineteen ninety-five", "sold the boat for nineteen hundred" */
const PRICE_VERB = new RegExp(
  String.raw`\b(?:paid|cost|costs|costing|priced?|worth|(?:sold|bought|sell|buy|traded)(?:\s+\S+){0,3}?\s+for)\s+(?:about\s+|around\s+|only\s+|just\s+|over\s+|almost\s+|nearly\s+)?${NUMSEQ}`,
  'gi',
);
const MONEY_SIGN = new RegExp(String.raw`[$€£¥]\s?${DIGITS}`, 'g');
/** "twenty-twenty vision", "20/20 vision" */
const VISION = /\b(?:twenty[\s-]+twenty|20[/-]20)\s+vision\b/gi;
/** a model year before a brand: "a 1957 Chevy", "my nineteen fifty-two Farmall" (Capitalised word after it) */
const MODEL_YEAR = new RegExp(
  String.raw`\b(?:a|an|my|our|his|her|their|the)\s+${NUMSEQ}\s+(?=[A-Z][a-z])`,
  'g',
);
/** a time of day: "at 1930 sharp", "at nineteen thirty hours", "at 1930" */
const TIME_OF_DAY = new RegExp(
  String.raw`\bat\s+${NUMSEQ}(?:\s+(?:sharp|hours|hrs|o'clock))?`,
  'gi',
);
const STREET =
  /\b\d{3,4}\s+(?:[A-Z][a-z]+\s+){0,2}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct)\b/g;

/**
 * A number that names a THING: "Room 1912", "Flight 1946", "the bus number was 2005", "jersey number
 * 1984", "prisoner number 1944", "#1949". (No adjacent `\s*` pairs: a long run of spaces must stay linear.)
 */
const IDENT = new RegExp(
  String.raw`\b(?:room|rm|flight|bus|route|highway|hwy|apartment|apt|unit|suite|building|bldg|gate|cell|block|lot|plot|box|channel|chapter|page|pier|dock|ward|seat|bed|locker|stall|booth|table|train|platoon|company|battalion|regiment|division|squad|bunker|number|num|no)\b\.?(?:\s+(?:number|num|no)\b\.?)?(?:\s+(?:was|is|were|are)\b)?\s*(?:[:#]\s*)?\d{3,5}\b|#\s?\d{3,5}\b`,
  'gi',
);
/** "555-1946", "010-1946-5523", "1946-2233": digit groups joined by hyphens are numbers, not years */
const PHONE = /(?<![\d-])\d{2,4}(?:[-–]\d{2,4}){1,3}(?![\d-])/g;
/** the date-shaped ones are NOT phone numbers: 1965-06-05, 1965-06, 12-25-1950 */
const DATE_SHAPED = new RegExp(
  String.raw`^(?:${YEAR}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|\d{1,2}-\d{1,2}-${YEAR})$`,
);
const ISO = new RegExp(
  String.raw`(?<!\d)(${YEAR})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?(?!\d)`,
);

/* the start or end of a span, a range, a decade: time claims that are not an event */

/** "since 1934", "until nineteen seventy", "between 1950 and 1953" */
const SPAN = new RegExp(
  String.raw`\b(?:since|until|till|from|before|after|through|between)\s+(?:the\s+(?:year|summer|winter|spring|fall|autumn)\s+(?:of\s+)?|in\s+)?${NUMSEQ}(?:\s+(?:and|to)\s+${NUMSEQ})?`,
  'gi',
);
/** "1950-53", "1950–1953" (a second part that is no year, like 2233, is not a range) */
const RANGE = new RegExp(
  String.raw`(?<![\d-])(${YEAR})[ \t]{0,2}[-–—][ \t]{0,2}(${YEAR}|[1-9]\d)(?![\d-])`,
  'g',
);
/** "the 1960s" */
const DECADE = new RegExp(String.raw`(?<!\d)(1[89]\d0|20[0-4]0)s\b`, 'g');
/** ", who was born in eighteen ninety-eight," about someone else; ", born 1920,"; "(born 1920)" */
const THIRD_PERSON_BIRTH =
  /(?:,\s*)?\b(?:who|whom)\s+(?:was|were|had been)\s+(?:born|raised)\b[^,.;!?]{0,50}/gi;
const APPOSITIVE_BORN = new RegExp(
  String.raw`,[ \t]{0,2}(?:born|b\.)[ \t]{1,2}(?:in[ \t]{1,2})?${NUMSEQ}(?=[ \t]{0,2}[,.;!?]|$)`,
  'gi',
);
const PAREN_BORN = /\((?:born|b\.|d\.|died)\s*[^)]{0,24}\)/gi;
/** a statement of today's date or of when the tape was made: not a memory */
const RECORDING =
  /\b(?:today\s+is|today's\s+date|the\s+date\s+(?:today\s+)?is|this\s+year\s+is|(?:recorded|recording)\s+(?:on|in|today))\b/i;

/** the year is the LAST thing in these, so dropping it keeps the words in front */
const NEGATED = new RegExp(
  String.raw`(?:\bnot|n['’]t|\bnever)\b(?:\s+[\p{L}']+){0,3}?\s+(?:(?:in|on|until|till|during|around|about|by)\s+)?(${YEAR})(?!\d)|\bno\b[,.]?\s+(?:(?:in|on|until|till|during|around|about|by)\s+)?(${YEAR})(?!\d)`,
  'giu',
);
const ATTRIBUTED = new RegExp(
  String.raw`\b(?:people|everyone|everybody|they|others)\s+(?:say|says|said|think|thinks|thought|believe[sd]?|claim(?:s|ed)?|remember(?:ed)?)\b(?:\s+[\p{L}0-9']+){0,6}?\s+(?:(?:in|on|around|about|was|were|is)\s+)*(${YEAR})(?!\d)`,
  'giu',
);
/** "it is 2026 now": a recent year with a present-time word right beside it is today, not a memory */
const PRESENT = /\b(?:now|nowadays|currently|these\s+days|at\s+present|right\s+now|today)\b/i;
const THIS_YEAR = new Date().getFullYear();

const YEAR4 = new RegExp(String.raw`(?<!\d)(${YEAR})(?!\d)`, 'g');

interface Rivals {
  /** years named as a span, a range or an unread number: they compete with an event year */
  years: Set<string>;
  /** decades ("the 1960s"): a rival only when no year inside the decade is also named */
  decades: Set<string>;
}

const yearsIn = (text: string): string[] => spokenYearsToDigits(text).match(YEAR4) ?? [];

/** Remove what only looks like a date; each is replaced by a space so words never fuse. */
function maskNonDates(sentence: string, rivals: Rivals): string {
  const noted = (text: string, re: RegExp) =>
    text.replace(re, (hit) => {
      for (const y of yearsIn(hit)) rivals.years.add(y);
      return ' ';
    });
  let t = sentence
    .replace(MONEY_SIGN, ' ')
    .replace(STREET, ' ')
    .replace(VISION, ' ')
    .replace(MODEL_YEAR, ' ')
    .replace(TIME_OF_DAY, ' ');
  // ranges: both ends compete ("1950–53" is 1950 and 1953)
  t = t.replace(RANGE, (hit, a: string, b: string) => {
    if (b.length === 2 && Number(b) <= 12) return hit; // "1965-12" is December 1965
    rivals.years.add(a);
    rivals.years.add(b.length === 2 ? a.slice(0, 2) + b : b);
    return ' ';
  });
  // phone numbers go BEFORE the "number 010" rules, which would leave "-1946-5523" behind
  t = t.replace(PHONE, (hit) => (DATE_SHAPED.test(hit) ? hit : ' '));
  t = t
    .replace(IDENT, ' ')
    .replace(PAREN_BORN, ' ')
    .replace(THIRD_PERSON_BIRTH, ' ')
    .replace(APPOSITIVE_BORN, ' ');
  t = noted(t, SPAN);
  t = t.replace(DECADE, (_hit, d: string) => {
    rivals.decades.add(d);
    return ' ';
  });
  return t
    .replace(PRICE_VERB, ' ')
    .replace(BEFORE_QUANTITY, ' ')
    .replace(new RegExp(String.raw`\b${DIGITS}(?=\s+${QTY}\b)`, 'gi'), ' ');
}

/** Years (in digits) the speaker rejects, attributes to others, or that are today or the future. */
function dropNotMemories(text: string): string {
  const dropEnd = (hit: string) => hit.replace(/\d{4}(?!.*\d{4})/, ' ');
  const t = text.replace(NEGATED, dropEnd).replace(ATTRIBUTED, dropEnd);
  return t.replace(YEAR4, (y, _g, at: number) => {
    const n = Number(y);
    if (n > THIS_YEAR) return ' ';
    if (n < 2015) return y;
    return PRESENT.test(t.slice(Math.max(0, at - 24), at + y.length + 24)) ? ' ' : y;
  });
}

/* ── hedges ──────────────────────────────────────────────────────────── */

/**
 * A hedge counts only when it sits NEXT TO the date, and on the side where it can mean
 * "I am not sure of this date". Before the date: "maybe 1958", "about nineteen sixty-two",
 * "I think we moved in 1960". After it only a closed list: "1960 or so", "1960, I think".
 * "about" after the year starts another phrase ("1984 and I dream about that barn"), and
 * "about ten in 1950" hedges the age, not the year: only light words may stand between.
 */
const BEFORE_EN = new RegExp(
  String.raw`\b(?:about|around|roughly|approximately|circa|somewhere(?:\s+around)?|something\s+like|could\s+(?:have\s+)?been|might\s+(?:have\s+)?been|must\s+(?:have\s+)?been)\b(?:\s+(?:in|around|about|the|year|of|like|sometime|late|early|mid|spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december))*[\s,]*$`,
  'i',
);
/** "maybe it was 1950", "perhaps we moved in 1960": these cover the clause they open (no digits between) */
const CLAUSE_ADVERB = new RegExp(
  String.raw`\b(?:maybe|perhaps|probably)\b(?:(?!\b(?:${SMALL_NUMBER})\b)[^,;.!?\d]){0,24}$`,
  'i',
);
/** "I think we moved in 1960": a hedge that covers the whole clause the date is in */
const CLAUSE_EN =
  /\b(?:i\s+think|i\s+believe|i\s+guess|i\s+suppose|not\s+sure|if\s+i\s+(?:remember|recall))\b/i;
const AFTER_EN =
  /^\W{0,3}(?:or\s+(?:'?\d{2}|\d{4})\b|or\s+so|or\s+thereabouts|ish\b|i\s+think|i\s+believe|i\s+guess|maybe|perhaps|probably|if\s+i\s+(?:remember|recall))\b/i;
/** Is the first mention of `year` in `text` hedged, by a word on the right side of it? */
function hedgedNear(text: string, year: string): boolean {
  const at = text.indexOf(year);
  if (at < 0) return false;
  const before = (
    text
      .slice(Math.max(0, at - 40), at)
      .split(/[.!?;。…]/)
      .pop() ?? ''
  ).trimEnd();
  const after = text.slice(at + year.length, at + year.length + 18).split(/[.!?;。…]/)[0] ?? '';
  return (
    BEFORE_EN.test(before) ||
    CLAUSE_ADVERB.test(before) ||
    CLAUSE_EN.test(before.split(',').pop() ?? '') ||
    AFTER_EN.test(after)
  );
}

/* ── one sentence ────────────────────────────────────────────────────── */

interface Facts {
  /** the date this sentence states as an event, and every distinct year it names */
  reading: { raw: string; all: Set<string> } | null;
  rivals: Rivals;
}

function readSentence(sentence: string): Facts {
  const rivals: Rivals = { years: new Set(), decades: new Set() };
  const converted = dropNotMemories(spokenYearsToDigits(maskNonDates(sentence, rivals)));
  const all = new Set(converted.match(YEAR4) ?? []);

  let raw: string | null = null;
  if (all.size > 0) {
    raw = readEnglishDate(converted);
    if (raw !== null) {
      // whether the speaker hedged is decided HERE, on the right side of the year, not by the reader
      const core = raw.replace('~', '');
      const hedge = hedgedNear(converted, core.slice(0, 4));
      // "1965-06-05" says more than the bare year the readers take from it
      const iso = ISO.exec(converted);
      const more =
        iso && iso[1] === core.slice(0, 4)
          ? [iso[1], iso[2], iso[3]].filter(Boolean).join('-')
          : core;
      raw = (hedge ? '~' : '') + (more.length > core.length && parseFuzzyDate(more) ? more : core);
    }
  }
  if (raw === null || parseFuzzyDate(raw) === null) {
    // a number that looks like a year but was not read as one competes all the same
    for (const y of all) rivals.years.add(y);
    return { reading: null, rivals };
  }
  return { reading: { raw, all }, rivals };
}

/* ── the memory ──────────────────────────────────────────────────────── */

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?。…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** A sentence that says something: not "Yes." or "Well." */
const substantive = (s: string, hasDate: boolean): boolean =>
  hasDate || (s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 4;

export function readMemoryDate(text: string): string | null {
  const body = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n');
  const sentences = sentencesOf(body);

  const facts = sentences.map((s) => (RECORDING.test(s) ? null : readSentence(s)));
  const read = facts.flatMap((f, i) => (f?.reading ? [{ i, ...f.reading }] : []));
  if (read.length === 0) return null;

  const years = new Set(read.flatMap((r) => [...r.all]));
  for (const f of facts) for (const y of f?.rivals.years ?? []) years.add(y);
  for (const f of facts) {
    for (const d of f?.rivals.decades ?? []) {
      // "in the 1960s, in 1965 exactly": the decade only places the year
      if (![...years].some((y) => y >= d && y < String(Number(d) + 10))) years.add(d);
    }
  }
  if (years.size === 1) {
    // the same year said again: the most specific reading of it wins (a month beats a bare year)
    return [...read].sort((a, b) => b.raw.length - a.raw.length || a.i - b.i)[0]!.raw;
  }

  // several different years: what the speaker led with, if that one sentence names exactly one
  const hasDate = (f: Facts | null) =>
    f !== null && (f.reading !== null || f.rivals.years.size > 0 || f.rivals.decades.size > 0);
  const lead = sentences.findIndex((s, i) => substantive(s, hasDate(facts[i] ?? null)));
  const led = read.find((r) => r.i === lead);
  if (!led || led.all.size !== 1) return null;
  const rivalInLead = [...(facts[lead]?.rivals.years ?? [])].some((y) => !led.all.has(y));
  return rivalInLead ? null : led.raw;
}
