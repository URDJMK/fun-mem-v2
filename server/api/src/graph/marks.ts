import { extractWikilinks, normalizeTitle } from '@funmem/core';
import { findIn, NAME_FILLER, placeIn } from './shared';

/**
 * The names a story uses, as links (entity design 6): the writer marks who each sentence names
 * and with which words; code keeps a mark only when the words are in the sentence and are a way
 * to call that entity, finds the names the writer did not mark, and links the first time a story
 * names each one. Pure functions: no AI, no database.
 */
export interface Listed {
  ref: string;
  name: string;
  aliases: readonly string[];
  ways: readonly string[];
  subject?: boolean;
}
export interface Mark {
  e: string;
  words: string;
}

const bare = (w: string) =>
  w.replace(/[’‘]/g, "'").toLowerCase().replace(/'s$/u, '').replace(/\s+/g, ' ').trim();

/** titles before or after a name: not words a story calls someone by */
const HONORIFICS = new Set('mr mrs ms dr jr sr st'.split(' '));

/**
 * what a mark's words may be: a name, an alias, a way, or a word of a name (2 letters or more,
 * not filler and not a title)
 */
export function allowedWords(e: Listed): Set<string> {
  const out = new Set<string>();
  for (const n of [e.name, ...e.aliases, ...e.ways]) out.add(bare(n));
  for (const n of [e.name, ...e.aliases]) {
    for (const w of n.split(/\s+/)) {
      const b = bare(w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
      if ([...b].length >= 2 && !NAME_FILLER.has(b) && !HONORIFICS.has(b)) out.add(b);
    }
  }
  return out;
}

/** the words as the sentence writes them, when the mark holds; else null */
export function checkMark(
  sentence: string,
  m: Mark,
  list: ReadonlyMap<string, Listed>,
): string | null {
  const e = list.get(m.e);
  if (!e || e.subject) return null;
  const found = findIn(sentence, m.words);
  if (!found) return null;
  return allowedWords(e).has(bare(found)) ? found : null;
}

/** an entity's name or alias in a sentence the writer did not mark; never its ways */
export function unmarked(
  sentences: readonly string[],
  list: readonly Listed[],
  marked: ReadonlySet<string>,
): Array<{ sentence: number; mark: Mark }> {
  const out: Array<{ sentence: number; mark: Mark }> = [];
  for (const e of list) {
    if (e.subject || marked.has(e.ref)) continue;
    const names = [e.name, ...e.aliases].sort((a, b) => b.length - a.length);
    for (let i = 0; i < sentences.length; i++) {
      const words = names.map((n) => findIn(sentences[i]!, n)).find((w) => w !== null);
      if (words) {
        out.push({ sentence: i, mark: { e: e.ref, words } });
        break;
      }
    }
  }
  return out;
}

export const linkText = (title: string, words: string) =>
  words === title ? `[[${title}]]` : `[[${title}|${words}]]`;

/**
 * Each sentence with a link at the first mark of each entity in the story. A link to an entity
 * already in the story counts as its first mention, and words inside a link are never linked again.
 */
export function linkSentences(
  sentences: readonly string[],
  marks: ReadonlyArray<ReadonlyArray<Mark>>,
  titleOf: (ref: string) => string,
): string[] {
  const refsByTitle = new Map<string, Set<string>>();
  for (const m of marks.flat()) {
    const key = normalizeTitle(titleOf(m.e));
    refsByTitle.set(key, (refsByTitle.get(key) ?? new Set()).add(m.e));
  }
  const done = new Set<string>();
  return sentences.map((text, i) => {
    const existing = text.includes('[[') ? extractWikilinks(text) : [];
    for (const l of existing) {
      if (l.embed) continue;
      for (const ref of refsByTitle.get(normalizeTitle(l.target)) ?? []) done.add(ref);
    }
    const taken: Array<[number, number]> = existing.map((l) => [l.start, l.end]);
    const wanted = [...(marks[i] ?? [])]
      .map((m) => ({ e: m.e, words: m.words.trim() }))
      .sort((a, b) => b.words.length - a.words.length);
    const edits: Array<{ at: number; len: number; link: string }> = [];
    for (const m of wanted) {
      if (done.has(m.e)) continue;
      const at = placeIn(text, m.words, taken);
      if (at < 0) continue;
      taken.push([at, at + m.words.length]);
      const shown = text.slice(at, at + m.words.length);
      edits.push({ at, len: m.words.length, link: linkText(titleOf(m.e), shown) });
      done.add(m.e);
    }
    let out = text;
    for (const x of edits.sort((a, b) => b.at - a.at))
      out = out.slice(0, x.at) + x.link + out.slice(x.at + x.len);
    return out;
  });
}

/**
 * Links to `unlink` (normalized titles) become the words they show; links to a key of `to` get
 * its title, still showing the words they showed. Everything else is left byte for byte.
 */
export function relink(
  body: string,
  unlink: ReadonlySet<string>,
  to: ReadonlyMap<string, string>,
): string {
  if (!body.includes('[[')) return body;
  let out = '';
  let at = 0;
  for (const l of extractWikilinks(body)) {
    if (l.embed || l.heading || l.blockId) continue;
    const key = normalizeTitle(l.target);
    const shown = l.alias?.trim() || l.target;
    const next = to.get(key);
    if (!unlink.has(key) && next === undefined) continue;
    out += body.slice(at, l.start) + (unlink.has(key) ? shown : linkText(next!, shown));
    at = l.end;
  }
  return out + body.slice(at);
}

/** the text with every link read as the words it shows */
export function plainOf(body: string): string {
  let out = '';
  let at = 0;
  for (const l of extractWikilinks(body)) {
    if (l.embed) continue;
    out += body.slice(at, l.start) + (l.alias?.trim() || l.target);
    at = l.end;
  }
  return out + body.slice(at);
}
