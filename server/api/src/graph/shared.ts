/**
 * The pieces both steps that name people, places and things use: the Graph step (graph/step.ts,
 * reads stories already written) and the Entity step (graph/find.ts, reads the transcript before
 * any story is written). The read-only tools, the name rules, the checks kept, the match
 * resolution.
 */
import { matchKey } from '@funmem/core';
import type { ProblemKind } from '../stories/check';
import { parseCite, type Range } from '../stories/lines';
import type { Tool } from '../stories/tools';
import type { EntityLookup, KnownEntity } from './store';
import type { EntityMatch } from './types';

/** "knew Tom only from Sarah's stories", "known to Noah through Sarah", "heard of him from her" */
export const SECOND_HAND =
  /\b(?:knew|know[ns]?|heard(?:\s+(?:of|about))?)\b.{0,60}?\b(?:through|from|via)\b/iu;
/** a mention's words are a name or a short phrase, never a clause */
export const MAX_WORDS = 4;
/** words a name may hold that need not be in the lines */
export const NAME_FILLER = new Set(
  'the a an of from in at on and s his her their my our de la le van von'.split(' '),
);
export const PRONOUNS = new Set(
  'he she they him her them his hers their i me my we us our you'.split(' '),
);

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
export const lower = (s: string) => s.normalize('NFC').toLowerCase();

export const cites = (v: unknown): Range[] =>
  (Array.isArray(v) ? v : []).map((c) => parseCite(c)).filter((r): r is Range => r !== null);

/**
 * The code checks that fail a line the AI wrote about an entity: a citation missing, wrong or
 * outside the lines it may cite, or a name, number or quote the cited lines do not hold.
 */
export const KEPT: readonly ProblemKind[] = [
  'no_citation',
  'bad_citation',
  'not_in_source',
  'quote',
  'outside_story',
];

/** the words of a text, lowercased, each without a "'s" ("Sarah's" is "sarah") */
export const wordsOf = (text: string): Set<string> =>
  new Set(
    lower(text)
      .replace(/['’]s\b/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

/** endings that make a people or a language of a place: "Korean", "Japanese", "Israeli" */
const PEOPLE_OF = ['n', 'an', 'ian', 'ese', 'i', 'ish'];

/** places whose people or language is not the place with one of those endings */
const PEOPLE_OF_PLACE = new Map(
  Object.entries({
    china: 'chinese',
    spain: 'spanish',
    sweden: 'swedish',
    poland: 'polish',
    mexico: 'mexican',
    germany: 'german',
    canada: 'canadian',
    france: 'french',
    england: 'english',
    scotland: 'scottish',
    wales: 'welsh',
    ireland: 'irish',
    philippines: 'filipino',
    thailand: 'thai',
    greece: 'greek',
    turkey: 'turkish',
    switzerland: 'swiss',
    britain: 'british',
    netherlands: 'dutch',
  }),
);

/** a place's word said as its people or language ("korea" in "korean", "italy" in "italian") */
const saidAsPeople = (w: string, said: ReadonlySet<string>): boolean => {
  const odd = PEOPLE_OF_PLACE.get(w);
  return (
    PEOPLE_OF.some((end) => said.has(w + end)) ||
    (w.endsWith('y') && said.has(`${w.slice(0, -1)}ian`)) ||
    (odd !== undefined && said.has(odd))
  );
};

/**
 * The name rule: a name comes from the lines. Every word of it but filler is a word `said` there,
 * or a word of a `known` name; a surname the AI added ("Sarah Lee" for a "Sarah") fails it, even
 * when the lines hold it inside another word ("sleep"). A place (`asPeople`) may also be said as
 * its people or language: "Korea" from "Korean food"; a person never ("Cho" is not "Choi").
 */
export function nameHeld(
  name: string,
  said: ReadonlySet<string>,
  known: ReadonlySet<string>,
  o: { asPeople?: boolean } = {},
): boolean {
  return [...wordsOf(name)]
    .filter((w) => !NAME_FILLER.has(w))
    .every((w) => known.has(w) || said.has(w) || (o.asPeople === true && saidAsPeople(w, said)));
}

/** capitalized words that are not names: they open a sentence or stand for anyone */
export const NOT_A_NAME = new Set(
  `i a an the and but or so if then when where while after before he she they we you it his her
  their our my its this that these those there here one two every each mr mrs ms dr
  monday tuesday wednesday thursday friday saturday sunday january february march april may june
  july august september october november december`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Names in `texts` that none of `covered` holds: capitalized words not opening a sentence ("in
 * Korea", "a dance in Xenia"), at most `limit`. What the AI is asked about once more (the recall
 * pass).
 */
export function uncovered(
  texts: readonly string[],
  covered: readonly string[],
  limit = 10,
): string[] {
  const have = new Set(covered.flatMap((c) => matchKey(c).split(' ')).filter(Boolean));
  const out: string[] = [];
  for (const text of texts) {
    for (const sentence of text.split(/(?<=[.!?]["”’)]?)\s+/)) {
      const words = sentence.split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        const w = words[i]!.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/['’]s$/u, '');
        if (!/^\p{Lu}/u.test(w) || w.length < 2) continue;
        const key = matchKey(w);
        if (!key || NOT_A_NAME.has(key) || NOT_A_NAME.has(key.replace(/s$/, '')) || have.has(key))
          continue;
        if (!out.includes(w)) out.push(w);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * Case and the two apostrophes alike, one character for one, so a place found in the folded text
 * is a place in the text. A letter whose lowercase is longer (the dotted capital I) is kept as it is.
 */
export const fold = (s: string) => {
  const plain = s.replace(/[’‘]/g, "'");
  const lowered = plain.toLowerCase();
  if (lowered.length === plain.length) return lowered;
  return Array.from(plain, (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  }).join('');
};

/**
 * Where `words` first stand in `text` as whole words (ignoring case and which apostrophe), outside
 * the `taken` spans; -1 when they do not stand there, or when `words` is empty.
 */
export function placeIn(
  text: string,
  words: string,
  taken: ReadonlyArray<[number, number]> = [],
): number {
  const w = fold(words.trim());
  if (!w) return -1;
  const t = fold(text);
  for (let at = t.indexOf(w); at >= 0; at = t.indexOf(w, at + 1)) {
    const before = t[at - 1] ?? '';
    const after = t[at + w.length] ?? '';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
    if (taken.some(([s, e]) => at < e && at + w.length > s)) continue;
    return at;
  }
  return -1;
}

/**
 * `words` as `text` writes them (whole words, ignoring case and which apostrophe), or null when
 * the text does not hold them. The page underlines exactly what is returned.
 */
export function findIn(text: string, words: string): string | null {
  const at = placeIn(text, words);
  return at < 0 ? null : text.slice(at, at + words.trim().length);
}

/**
 * How a story may write a name: the name itself, a name it goes by, and for a name made from a
 * relationship ("Noah Kim's mother") the ways a story says that ("Noah's mother", "his mother").
 */
export function waysToSay(name: string, aliases: readonly string[]): string[] {
  const out = [name, ...aliases];
  const rel = /^(.+?)['’]s\s+(.+)$/u.exec(name);
  if (rel) {
    const owner = rel[1]!;
    const what = rel[2]!;
    const first = owner.split(/\s+/)[0]!;
    out.push(`${first}'s ${what}`, `his ${what}`, `her ${what}`, `their ${what}`);
    // "uncle Jae-won": the relation holds a name of its own
    if (/\p{Lu}/u.test(what)) out.push(what);
  }
  return out;
}

/** the read-only tools both steps use; `offered` collects every entity id the AI was shown */
export function entityTools(lookup: EntityLookup, offered: Map<string, string>): Tool[] {
  return [
    {
      name: 'find_entity',
      description: 'finds people, places and things already in the project by name or alias',
      args: '{"name": string}',
      run: async (a) => {
        const name = str(a.name);
        if (!name) return 'give a name';
        const found = await lookup.find(name);
        for (const f of found) offered.set(f.id, f.name);
        return found.length
          ? found
              .map(
                (f) =>
                  `- ${f.name} (${f.type}, id ${f.id})${f.aliases.length ? `, also called ${f.aliases.join(', ')}` : ''}${f.close ? ' [only a similar spelling]' : ''}${f.lines.length ? `: ${f.lines.join(' ')}` : ''}`,
              )
              .join('\n')
          : 'nobody by that name yet';
      },
    },
    {
      name: 'read_entity',
      description: 'reads one entity: what the stories say about it and its relationships',
      args: '{"id": string}',
      run: async (a) => {
        const e = await lookup.read(str(a.id));
        if (!e) return 'no such entity';
        offered.set(e.id, e.name);
        return `${e.name} (${e.type}, id ${e.id})${e.aliases.length ? `, also called ${e.aliases.join(', ')}` : ''}\n${e.description}\n${e.relationships.join('\n')}`;
      },
    },
  ];
}

/**
 * The AI's "match" made safe: an id it was shown, or a project entity of the same name. The ids
 * its lookups find are added to `offered`, so a later entity may match them.
 */
export async function resolveMatch(
  e: { name: string; match: string; candidates: string[] },
  o: {
    lookup: EntityLookup;
    known: readonly KnownEntity[];
    offered: Map<string, string>;
  },
): Promise<EntityMatch> {
  if (e.match === 'ask') {
    const found = await o.lookup.find(e.name);
    for (const f of found) o.offered.set(f.id, f.name);
    const candidates = e.candidates
      .filter((c) => o.offered.has(c))
      .map((c) => ({ entityId: c, name: o.offered.get(c)! }));
    if (candidates.length) return { kind: 'ask', candidates };
  } else if (e.match !== 'new' && o.offered.has(e.match)) {
    return { kind: 'existing', entityId: e.match, name: o.offered.get(e.match)! };
  }
  const exact = (await o.lookup.find(e.name)).find((f) => !f.close);
  const known = o.known.find((k) =>
    [k.name, ...k.aliases].some((n) => matchKey(n) === matchKey(e.name)),
  );
  const same = exact ?? known;
  return same ? { kind: 'existing', entityId: same.id, name: same.name } : { kind: 'new' };
}
