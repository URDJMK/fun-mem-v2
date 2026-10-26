import type { NoteSummary } from './api';
import { isEntity } from './archive';

/**
 * The names Deepgram should listen out for during a live interview (its "keyterm prompting"):
 * the person being remembered and the people and places their archive already knows.
 *
 * Names, never notes. A keyterm is a spelling to favour, not context to understand: a story's
 * text would only spend the budget, and an ordinary word ("harbour") boosted is a word heard
 * where it was not said. Deepgram refuses a list over 500 tokens and advises the 20-50 that
 * matter most; the cost is the same per minute however many are sent.
 */
const MAX_TERMS = 50;
/** a rough count (about four characters a token) kept well under Deepgram's 500 */
const MAX_CHARS = 1200;

/** words that come before a name and are not one: "Grandma Nell" is listened for as "Nell" too */
const KIN =
  /^(?:grandma|grandpa|granny|gran|nana|nanna|papa|mama|grandmother|grandfather|great|aunt|auntie|uncle|cousin|mom|mum|dad|mother|father|mrs?|ms|dr|miss|sister|brother)\.?$/i;

/** titles that go with the name after them: "Mrs. Harju" is called "Mrs. Harju" */
const HONORIFIC = /^(?:mrs?|ms|dr|miss)\.?$/i;

/** A list of names to listen for: no family word on its own, nobody twice, within the budget. */
function termList(): { out: string[]; add: (raw: string) => void } {
  const out: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  const add = (raw: string) => {
    // "Anna Lee (she/her)", "Mrs. Harju" → the name as it is said
    const term = raw
      .replace(/\s*[([].*?[)\]]\s*/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (!term || term.split(' ').length > 4 || KIN.test(term)) return;
    const key = term.toLowerCase();
    if (seen.has(key) || out.length >= MAX_TERMS || chars + term.length > MAX_CHARS) return;
    seen.add(key);
    chars += term.length;
    out.push(term);
  };
  return { out, add };
}

/** A name, and the names inside it ("Grandma Nell" → "Grandma Nell", "Nell"). */
function addName(add: (raw: string) => void, name: string): void {
  add(name);
  for (const part of name.split(/\s+/)) if (/^\p{Lu}/u.test(part)) add(part);
}

export function keytermsFor(subjectName: string, notes: NoteSummary[]): string[] {
  const { out, add } = termList();
  addName(add, subjectName);

  const entities = notes
    .filter((n) => isEntity(n.type))
    .sort((a, b) => (b.revised ?? '').localeCompare(a.revised ?? ''));
  for (const n of entities) add(n.title);
  return out;
}

/**
 * The people in the room first, then the archive's names (`base`). The people are who will be
 * named most, and the ones least likely to be spelled right: a long archive must not crowd
 * them out of the list.
 */
export function withPeople(base: readonly string[], people: readonly string[]): string[] {
  const { out, add } = termList();
  for (const name of people) addName(add, name);
  for (const term of base) add(term);
  return out;
}

/**
 * What to call someone, in a question read out to them: their given name ("Nell Marsh" →
 * "Nell"), past a family word ("Grandma Nell" → "Nell"), and a title with the name it goes
 * with ("Mrs. Harju"). Never the surname alone.
 */
export function callName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return name.trim();
  if (HONORIFIC.test(parts[0]!)) return parts.join(' ');
  return parts.find((p) => !KIN.test(p)) ?? parts[0]!;
}
