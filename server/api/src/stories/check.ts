import { acceptTitle } from '../ingest-lang';
import { spokenNumbersToDigits, spokenYearsToDigits } from '../speech';
import { checkTitleFacts } from '../title-check';
import { textOf, type Line, type Range } from './lines';
import type { StoryDraft } from './write';

/**
 * Step 4, first half (PRD 6.4): the code checks. Cheap and certain, and blind to wording: a
 * story may say anything in its own words (D11). What fails here is a fact the cited lines do
 * not hold: a number, a name or place, a quotation that is not word for word, a date, or a title
 * that adds any of those. The AI judge (judge.ts) rules on the rest: whether an event or detail
 * was made up.
 */
export type ProblemKind =
  | 'no_citation'
  | 'bad_citation'
  | 'not_in_source'
  | 'quote'
  | 'date'
  | 'title'
  | 'outside_story'
  // from the AI judge
  | 'made_up'
  | 'contradicts'
  | 'misattributed';

export interface Problem {
  /** the sentence's index; -1 for the story as a whole (its title or date) */
  sentence: number;
  kind: ProblemKind;
  detail: string;
}

const ORDINALS: Record<string, string> = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
  eleventh: '11',
  twelfth: '12',
};

/**
 * Spoken numbers, years and ordinals as digits ("nineteen forty-six" → 1946, "fifth" → 5). Clause
 * by clause: the converter will not read a year near a word about money ("… sixty-seven, in a
 * small ceremony, because we did not have money …") in case it is a price. Here, reading too many
 * numbers only lets a story repeat a number that was said; reading too few fails a true sentence.
 */
function digits(text: string): string {
  return text
    .split(/(?<=[,.;:!?])\s+/)
    .map((clause) => spokenNumbersToDigits(spokenYearsToDigits(clause)))
    .join(' ')
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1')
    .replace(
      /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b/gi,
      (w) => ORDINALS[w.toLowerCase()]!,
    );
}

const numbersOf = (text: string): string[] =>
  [...digits(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ''));

/** Does the text say this number, however it was said ("eighteen", "18")? */
export const saysNumber = (text: string, n: number): boolean => numbersOf(text).includes(String(n));

/** capitalized words that are not names: they may open a clause or stand for a relative */
const NOT_NAMES = new Set(
  `i a an the and but or so then when where while after before during later later in on at of to
  for from with by as if once since until though although because this that these those there
  their her his she he they we it its one some many most every each all both
  january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday
  mom mum mommy mother mama ma dad daddy father papa pa grandma grandmother granny nana gran
  grandpa grandfather grandad granddad gramps aunt auntie uncle cousin brother sister son daughter
  mr mrs ms miss dr sir madam god christmas easter church school war`
    .split(/\s+/)
    .filter(Boolean),
);

const flat = (s: string): string =>
  ` ${s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

const QUOTE = /[“"]([^”"]{3,}?)[”"]/g;

/** a title from the story's heart is a few words; more is a summary */
const TITLE_WORDS = 7;

/**
 * `allowed`: the story's own lines. A sentence citing lines outside them (beyond the question
 * just before) tells another story, which is written on its own.
 */
export function checkDraft(
  d: StoryDraft,
  lines: readonly Line[],
  known: readonly string[],
  allowed?: readonly Range[],
): Problem[] {
  const problems: Problem[] = [];
  const last = lines.length ? lines[lines.length - 1]!.n : 0;
  const knownWords = new Set(known.flatMap((k) => flat(k).trim().split(' ')).filter(Boolean));
  const allCites: Range[] = [];

  d.sentences.forEach((s, i) => {
    if (s.cites.length === 0) {
      problems.push({
        sentence: i,
        kind: 'no_citation',
        detail: 'say which lines this comes from',
      });
      return;
    }
    if (s.cites.some((r) => r.to > last)) {
      problems.push({
        sentence: i,
        kind: 'bad_citation',
        detail: `the transcript ends at L${last}`,
      });
      return;
    }
    if (allowed) {
      // the line just before a range counts only when it is a question, never another answer
      const asked = (n: number) => lines.some((l) => l.n === n && !l.teller);
      // the profile (line 0, cited as P) belongs to every story
      const inside = (n: number) =>
        n === 0 ||
        allowed.some((r) => (n >= r.from && n <= r.to) || (n === r.from - 1 && asked(n)));
      const outside = s.cites.find((r) => !inside(r.from) || !inside(r.to));
      if (outside) {
        const at =
          outside.to !== outside.from ? `L${outside.from}-L${outside.to}` : `L${outside.from}`;
        problems.push({
          sentence: i,
          kind: 'outside_story',
          detail: `${at} belongs to another story: tell only this story, from its own lines`,
        });
        return;
      }
    }
    allCites.push(...s.cites);
    const source = textOf(lines, s.cites);
    const sourceFlat = flat(digits(source));
    const speakers = new Set(
      lines
        .filter((l) => s.cites.some((r) => l.n >= r.from && l.n <= r.to))
        .flatMap((l) => flat(l.name).trim().split(' ')),
    );

    // numbers
    const have = new Set(numbersOf(source));
    for (const n of numbersOf(s.text)) {
      if (!have.has(n)) {
        problems.push({
          sentence: i,
          kind: 'not_in_source',
          detail: `the cited lines do not say ${n}`,
        });
      }
    }

    // quotations: word for word
    const unquoted = s.text.replace(QUOTE, (_m, q: string) => {
      if (!flat(source).includes(flat(q))) {
        problems.push({
          sentence: i,
          kind: 'quote',
          detail: `“${q.trim()}” was not said word for word`,
        });
      }
      return ' ';
    });

    // names and places: capitalized words after the first
    const words = unquoted.split(/\s+/).filter(Boolean);
    words.forEach((raw, k) => {
      if (k === 0) return;
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/['’]s$/, '');
      if (!/^\p{Lu}/u.test(w) || w.length < 2) return;
      // the first word of a sentence inside the sentence ("… boats. Then …")
      if (/[.!?:;]["”’)]*$/.test(words[k - 1]!)) return;
      const lower = w.toLowerCase();
      if (NOT_NAMES.has(lower) || knownWords.has(lower) || speakers.has(lower)) return;
      const parts = lower.split(/[-'’.]/).filter(Boolean);
      if (sourceFlat.includes(` ${lower} `) || parts.every((p) => sourceFlat.includes(` ${p}`)))
        return;
      problems.push({
        sentence: i,
        kind: 'not_in_source',
        detail: `the cited lines do not name ${w}`,
      });
    });
  });

  // the story's date: told somewhere in its lines
  const storyText = textOf(lines, allCites);
  const storyNumbers = new Set(numbersOf(storyText));
  for (const [key, date] of [
    ['occurred', d.occurred],
    ['until', d.until],
  ] as const) {
    const year = date ? /\d{4}/.exec(date)?.[0] : undefined;
    if (year && !storyNumbers.has(year)) {
      problems.push({
        sentence: -1,
        kind: 'date',
        detail: `${key} ${date}: the story's lines do not say ${year}`,
      });
    }
  }

  // the title: its shape, and no name, number or heavy fact the story does not hold
  if (!acceptTitle(d.title)) {
    problems.push({ sentence: -1, kind: 'title', detail: 'the title is missing or not usable' });
  } else if (
    d.title
      .split(/\s+/)
      .some(
        (w) => /^I$|^(?:my|me|we|our|us)$/i.test(w.replace(/[^\p{L}]/gu, '')) && !/^US$/.test(w),
      )
  ) {
    problems.push({
      sentence: -1,
      kind: 'title',
      detail:
        'the title is in the narrator\'s voice ("my", "I"): write it about them, like the story',
    });
  } else if (d.title.split(/\s+/).length > TITLE_WORDS) {
    problems.push({
      sentence: -1,
      kind: 'title',
      detail: `the title is a summary: give a few words from the story's heart (at most ${TITLE_WORDS}), like "Gravy at the church supper"`,
    });
  } else {
    const facts = checkTitleFacts(
      d.title,
      `${digits(storyText)}\n${d.sentences.map((s) => s.text).join(' ')}\n${known.join(' ')}`,
    );
    if (!facts.ok) {
      problems.push({
        sentence: -1,
        kind: 'title',
        detail: `the title adds what the story does not say (${facts.reason})`,
      });
    }
  }
  return problems;
}
