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
  { kind: 'text'; text: string } | { kind: 'link'; label: string; noteId: string };

export function piecesOf(
  body: string,
  notes: ReadonlyArray<{ id: string; title: string }>,
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
    const noteId = l.embed || l.target === '' ? undefined : byTitle.get(normalizeTitle(l.target));
    if (noteId) out.push({ kind: 'link', label: l.alias?.trim() || l.target, noteId });
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
