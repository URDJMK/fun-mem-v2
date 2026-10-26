import { Link } from 'react-router';
import type { NoteSummary } from '../lib/api';
import { noteHref } from '../lib/archive';
import { piecesOf } from '../lib/links';

/**
 * A note's text, split the way a reader takes it in: the paragraphs, the machine-written
 * "may disagree" lines (shown side by side, never merged: no one has to be right), and the
 * other `> ` lines an import writes under a memory (where it came from, who told it).
 */
export interface NoteParts {
  paragraphs: string[];
  differs: string[];
  provenance: string[];
}

export function splitNote(body: string): NoteParts {
  const paragraphs: string[] = [];
  const differs: string[] = [];
  const provenance: string[] = [];
  let block: string[] = [];
  const flush = () => {
    const text = block.join('\n').trim();
    if (text) paragraphs.push(text);
    block = [];
  };
  for (const line of body.split('\n')) {
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flush();
      const text = quoted[1]!.trim();
      if (text.startsWith('⚠')) differs.push(text.replace(/^⚠\s*/, ''));
      else if (text) provenance.push(text);
    } else if (line.trim() === '') {
      flush();
    } else {
      block.push(line);
    }
  }
  flush();
  return { paragraphs, differs, provenance };
}

/** Words and `[[links]]`: a link to a note the reader can see opens it; any other stays as written. */
export function Linked({
  text,
  notes,
  archiveId,
}: {
  text: string;
  notes: NoteSummary[];
  archiveId: string;
}) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  return (
    <>
      {piecesOf(text, notes).map((p, i) =>
        p.kind === 'text' ? (
          p.text
        ) : (
          <Link
            key={i}
            to={noteHref(archiveId, byId.get(p.noteId) ?? { id: p.noteId, type: 'event' })}
            data-testid="note-link"
          >
            {p.label}
          </Link>
        ),
      )}
    </>
  );
}

/** A search snippet with its `[[links]]` read as plain words: "[[Joe|Uncle Joe]]" is "Uncle Joe". */
export function plainLinks(text: string): string {
  return text.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) =>
    (alias ?? target).trim(),
  );
}
