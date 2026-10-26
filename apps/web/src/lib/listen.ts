/**
 * What the interview assistant learns from what people say, without anyone clicking: the name a
 * voice gives itself, what the conversation is about, and whether a question has been asked.
 * Plain pattern matching on Deepgram's words (which capitalise names and punctuate), English only
 * like the rest of v2 (docs/adr/0003). Every answer can be corrected by hand on the page.
 */
import { TOPICS } from './questions';

/** words that can follow "I'm" with a capital and are not a name: "I'm Okay", "This is Great" */
const NOT_NAMES = new Set(
  `okay ok fine good great glad happy here ready sorry not just so really very still also only
  going the a an and his her their my our your from with in on at to for of about this that what
  well yes no oh hello hi grandma grandpa granny nana mom mum dad mother father aunt uncle`
    .split(/\s+/)
    .filter(Boolean),
);

/** the name a speaker gives themselves, as said: "I'm Theo, Nell's grandson" → "Theo" */
export function nameIn(text: string): string | null {
  // "my" is optional: speech-to-text often loses a quick "my" ("Name is Theo")
  const re =
    /\b(?:i'm|i’m|i am|(?:my )?name is|(?:my )?name's|(?:my )?name’s|this is|call me|it's|it’s)\s+((?:[A-Z][\p{L}'’-]+)(?:\s+[A-Z][\p{L}'’-]+)?)/giu;
  for (const m of text.matchAll(re)) {
    const words = m[1]!.split(/\s+/);
    // keep the leading words that are names; "I'm Theo And" stops at Theo
    const name: string[] = [];
    for (const w of words) {
      const bare = w.replace(/['’]s$/, '');
      if (NOT_NAMES.has(bare.toLowerCase()) || !/^\p{Lu}/u.test(bare)) break;
      name.push(bare);
    }
    if (name.length > 0) return name.join(' ');
  }
  return null;
}

/** "Nell" is "Grandma Nell", "theo" is "Theo Marsh": any word of one is a word of the other */
export function sameName(a: string, b: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length > 1 && !NOT_NAMES.has(w));
  const wa = new Set(words(a));
  return words(b).some((w) => wa.has(w));
}

const TOPIC_WORDS: Record<string, RegExp> = {
  childhood:
    /\b(child(hood)?|kids?|little|young(er)?|grow(ing|n)? up|grew up|school|born|toys?|play(ed|ing)?)\b/i,
  family:
    /\b(family|mother|father|mom|mum|dad|parents?|brothers?|sisters?|siblings?|grand(parents?|mother|father|ma|pa)|aunts?|uncles?|cousins?)\b/i,
  // never a bare "love": "I'd love to hear about…" is how half of these answers begin
  love: /\b(how (you|they|we) met|met (your|my|her|his)|marri(ed|age)|husband|wife|wedding|fell in love|in love|courting|sweetheart)\b/i,
  work: /\b(work(ed|ing)?|jobs?|career|boss|office|factory|farm(ing)?|business|retired?)\b/i,
  places:
    /\b(mov(e|ed|ing)|lived|town|city|country|neighbou?rhood|street|house|home|emigrat|immigrat)\w*\b/i,
  traditions:
    /\b(holidays?|christmas|easter|thanksgiving|hanukkah|cook(ing|ed)?|recipes?|food|dish(es)?|traditions?|songs?|church|prayers?)\b/i,
  hard: /\b(war|hard (times?|years?)|difficult|struggl\w*|lost|loss|illness|sick|depression|poor|poverty|died)\b/i,
  advice:
    /\b(advice|lessons?|learn(ed|t)?|believe|beliefs?|faith|wisdom|grateful|remembered|regrets?)\b/i,
};

/** the topics a stretch of talk touches on, in the order the question bank lists them */
export function topicsIn(text: string): string[] {
  return TOPICS.map((t) => t.id).filter((id) => TOPIC_WORDS[id]?.test(text));
}

const STOP = new Set(
  `a an the and or but so to of in on at for with you your yours was were is are be been do did
  does what who how when where why which that this it its me my i we us our they them their he
  she his her there here then than as if about from up down out tell remember like can could
  would will just really very`
    .split(/\s+/)
    .filter(Boolean),
);
const content = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Whether what was said asks this question, in the asker's own words: most of the question's
 * meaningful words are there ("So, Nell, where were you born?" asks "Where and when were you
 * born?"). A question with too few meaningful words to tell is never matched by accident.
 */
export function asks(spoken: string, question: string): boolean {
  // the {name} in a question template is whoever is being asked, not a word to listen for
  const q = [...new Set(content(question.replace(/\{name\}/g, ' ')))];
  if (q.length === 0) return false;
  const said = new Set(content(spoken));
  const hit = q.filter((w) => said.has(w)).length;
  return q.length <= 2 ? hit === q.length : hit / q.length >= 0.5;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
