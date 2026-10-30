import { extractWikilinks, normalizeTitle } from '@funmem/core';

/**
 * A note's text in pieces, for reading: words as they were written, and the `[[links]]`
 * among them. A link names a note by title, so it is resolved against the titles the reader
 * can see, exactly as the server resolves it (case- and composition-insensitive).
 *
 * What is not a link to another note stays the reader's text, character for character: an
 * embed `![[...]]` (there are no photographs here), a link to a heading of this same note
 * (`[[#…]]`), and a link whose note does not exist (yet), which is shown as written so the
 * reader can see it points nowhere.
 */
export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'link'; label: string; noteId: string }
  | { kind: 'proposed'; label: string }
  | { kind: 'entity'; label: string; entityId: string };

export function piecesOf(
  body: string,
  notes: ReadonlyArray<{ id: string; title: string }>,
  opts?: { proposed?: ReadonlyMap<string, boolean> },
): Piece[] {
  const byTitle = new Map(notes.map((n) => [normalizeTitle(n.title), n.id]));
  const out: Piece[] = [];
  let at = 0;
  const text = (t: string) => {
    if (t === '') return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  for (const l of extractWikilinks(body)) {
    text(body.slice(at, l.start));
    const key = normalizeTitle(l.target);
    const label = l.alias?.trim() || l.target;
    const proposed = l.embed || key === '' ? undefined : opts?.proposed?.get(key);
    const noteId = l.embed || key === '' ? undefined : byTitle.get(key);
    if (proposed === true) out.push({ kind: 'proposed', label });
    else if (proposed === false) text(label);
    else if (noteId) out.push({ kind: 'link', label, noteId });
    else text(l.raw);
    at = l.end;
  }
  text(body.slice(at));
  return out;
}

/** The titles a note links to that no note of the archive has: what could be written next. */
export function missingTargets(
  body: string,
  notes: ReadonlyArray<{ id: string; title: string }>,
): string[] {
  const known = new Set(notes.map((n) => normalizeTitle(n.title)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of extractWikilinks(body)) {
    const key = normalizeTitle(l.target);
    if (l.embed || key === '' || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(l.target);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /[\p{L}\p{N}]/u;

/**
 * The people, places and things a story names, marked where it first names each (graph design
 * 6.3): the words as written, ignoring case, as whole words only, the longer name first. Links
 * are left as they are, and so is the story's text.
 */
export function withMentions(
  pieces: readonly Piece[],
  mentions: ReadonlyArray<{ entityId: string; words: string[] }>,
): Piece[] {
  const wanted = mentions
    .flatMap((m) =>
      m.words.filter((w) => w.trim()).map((w) => ({ id: m.entityId, words: w.trim() })),
    )
    .sort((a, b) => b.words.length - a.words.length);
  let out: Piece[] = [...pieces];
  const done = new Set<string>();
  for (const w of wanted) {
    if (done.has(w.id)) continue;
    const re = new RegExp(escape(w.words), 'iu');
    const next: Piece[] = [];
    let found = false;
    for (const p of out) {
      if (found || p.kind !== 'text') {
        next.push(p);
        continue;
      }
      let from = 0;
      let hit: RegExpExecArray | null = null;
      for (;;) {
        const m = re.exec(p.text.slice(from));
        if (!m) break;
        const at = from + m.index;
        const before = p.text[at - 1] ?? '';
        const after = p.text[at + m[0].length] ?? '';
        if (!WORD.test(before) && !WORD.test(after)) {
          hit = Object.assign(m, { index: at });
          break;
        }
        from = at + 1;
      }
      if (!hit) {
        next.push(p);
        continue;
      }
      found = true;
      const head = p.text.slice(0, hit.index);
      const tail = p.text.slice(hit.index + hit[0].length);
      if (head) next.push({ kind: 'text', text: head });
      next.push({ kind: 'entity', label: hit[0], entityId: w.id });
      if (tail) next.push({ kind: 'text', text: tail });
    }
    if (found) done.add(w.id);
    out = next;
  }
  return out;
}
