import { extractWikilinks, normalizeTitle } from '@funmem/core';
import { findIn, NAME_FILLER } from './shared';

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

/** what a mark's words may be: a name, an alias, a way, or a word of a name (2 letters or more) */
export function allowedWords(e: Listed): Set<string> {
  const out = new Set<string>();
  for (const n of [e.name, ...e.aliases, ...e.ways]) out.add(bare(n));
  for (const n of [e.name, ...e.aliases]) {
    for (const w of n.split(/\s+/)) {
      const b = bare(w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
      if ([...b].length >= 2 && !NAME_FILLER.has(b)) out.add(b);
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

/** case and the two apostrophes alike, one character for one, so a place found is a place in the text */
const foldSameLength = (s: string) =>
  Array.from(s.replace(/[’‘]/g, "'"), (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  }).join('');

/** where `words` stand in `text` as whole words, outside the spans already taken */
function placeOf(text: string, words: string, taken: ReadonlyArray<[number, number]>): number {
  const t = foldSameLength(text);
  const w = foldSameLength(words);
  for (let at = t.indexOf(w); at >= 0; at = t.indexOf(w, at + 1)) {
    const before = t[at - 1] ?? '';
    const after = t[at + w.length] ?? '';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
    if (taken.some(([s, e]) => at < e && at + w.length > s)) continue;
    return at;
  }
  return -1;
}

/** each sentence with a link at the first mark of each entity in the story */
export function linkSentences(
  sentences: readonly string[],
  marks: ReadonlyArray<ReadonlyArray<Mark>>,
  titleOf: (ref: string) => string,
): string[] {
  const done = new Set<string>();
  return sentences.map((text, i) => {
    const wanted = [...(marks[i] ?? [])]
      .filter((m) => !done.has(m.e))
      .sort((a, b) => b.words.length - a.words.length);
    // a link already in the sentence is not linked again
    const taken: Array<[number, number]> = extractWikilinks(text).map((l) => [l.start, l.end]);
    const edits: Array<{ at: number; len: number; link: string }> = [];
    for (const m of wanted) {
      if (done.has(m.e)) continue;
      const at = placeOf(text, m.words, taken);
      if (at < 0) continue;
      taken.push([at, at + m.words.length]);
      edits.push({
        at,
        len: m.words.length,
        link: linkText(titleOf(m.e), text.slice(at, at + m.words.length)),
      });
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
