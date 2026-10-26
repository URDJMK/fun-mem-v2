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

export function keytermsFor(subjectName: string, notes: NoteSummary[]): string[] {
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

  add(subjectName);
  for (const part of subjectName.split(/\s+/)) if (/^\p{Lu}/u.test(part)) add(part);

  const entities = notes
    .filter((n) => isEntity(n.type))
    .sort((a, b) => (b.revised ?? '').localeCompare(a.revised ?? ''));
  for (const n of entities) add(n.title);
  return out;
}
