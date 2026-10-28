import { Link } from 'react-router';
import type { Mention, NoteSummary } from '../lib/api';
import { inArchive, noteHref } from '../lib/archive';
import { piecesOf, withMentions } from '../lib/links';

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

/**
 * Words and `[[links]]`: a link to a note the reader can see opens it; any other stays as
 * written. With `mentions`, the first time the text names each person, place or thing of the
 * graph opens its page (graph design 6.3).
 */
export function Linked({
  text,
  notes,
  archiveId,
  mentions,
}: {
  text: string;
  notes: NoteSummary[];
  archiveId: string;
  mentions?: Mention[];
}) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const pieces = piecesOf(text, notes);
  return (
    <>
      {(mentions?.length ? withMentions(pieces, mentions) : pieces).map((p, i) =>
        p.kind === 'text' ? (
          p.text
        ) : p.kind === 'entity' ? (
          <Link
            key={i}
            to={inArchive(archiveId, `/people/${p.entityId}`)}
            className="mention"
            data-testid="mention-link"
          >
            {p.label}
          </Link>
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
