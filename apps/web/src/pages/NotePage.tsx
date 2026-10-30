import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { extractWikilinks, normalizeTitle, type EntityType } from '@funmem/core';
import {
  ApiError,
  deleteNote,
  getBacklinks,
  getNote,
  listNotes,
  updateNote,
  type Backlinks,
  type Note,
  type NoteSummary,
} from '../lib/api';
import { inArchive, noteHref, useArchive, type Archive } from '../lib/archive';
import { missingTargets } from '../lib/links';
import { typeLabel } from '../lib/words';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { NoteForm } from '../components/NoteForm';
import { Linked, plainLinks, splitNote } from '../components/NoteText';
import { Failed, Icon, Loading, whenLabel } from '../components/ui';
import { storyOrder } from './Stories';

export interface Loaded {
  note: Note;
  backlinks: Backlinks;
  /** every note the reader can see: what the note's `[[links]]` resolve against */
  notes: NoteSummary[];
}

export type NoteData = Loaded | 'loading' | 'missing' | 'failed';

/** One note, what links to it, and every note its links can point at. */
export function useNoteData(archiveId: string, noteId: string): [NoteData, () => Promise<void>] {
  const [data, setData] = useState<NoteData>('loading');
  const load = useCallback(async () => {
    try {
      const [note, backlinks, notes] = await Promise.all([
        getNote(archiveId, noteId),
        getBacklinks(archiveId, noteId),
        listNotes(archiveId),
      ]);
      setData({ note, backlinks, notes });
    } catch (e) {
      setData(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
    }
  }, [archiveId, noteId]);
  useEffect(() => {
    void load();
  }, [load]);
  return [data, load];
}

/** The notes this note links to that exist, in the order they first appear. */
export function linkedNotes(body: string, notes: NoteSummary[]): NoteSummary[] {
  const byTitle = new Map(notes.map((n) => [normalizeTitle(n.title), n]));
  const out = new Map<string, NoteSummary>();
  for (const l of extractWikilinks(body)) {
    const n = l.embed ? undefined : byTitle.get(normalizeTitle(l.target));
    if (n) out.set(n.id, n);
  }
  return [...out.values()];
}

/** Changing or deleting a note, for someone who may write here. */
export function useNoteActions(archive: Archive, note: Note, after: string) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  async function remove() {
    if (!window.confirm(`Delete “${note.title}”? A deleted memory cannot be brought back.`)) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await deleteNote(archive.id, note.id);
      void navigate(after, { replace: true });
    } catch {
      setDeleteFailed(true);
      setDeleting(false);
    }
  }
  return { remove, deleting, deleteFailed };
}

export function EditNote({
  archive,
  note,
  onDone,
}: {
  archive: Archive;
  note: Note;
  onDone: (saved: boolean) => void;
}) {
  return (
    <div className="card" style={{ borderRadius: 8 }}>
      <NoteForm
        initial={{
          title: note.title,
          type: note.type as EntityType,
          body: note.body,
          occurred: note.occurred,
        }}
        withType={false}
        onSave={async (v) => {
          await updateNote(archive.id, note.id, {
            title: v.title,
            body: v.body,
            occurred: v.occurred,
          });
          onDone(true);
        }}
        onCancel={() => onDone(false)}
      />
    </div>
  );
}

export function NotFound({
  data,
  back,
  backLabel,
}: {
  data: 'missing' | 'failed';
  back: string;
  backLabel: string;
}) {
  return (
    <>
      <Failed>
        {data === 'missing'
          ? 'This memory could not be found. It was deleted, or you cannot see it.'
          : 'Could not load the memory. Reload the page.'}
      </Failed>
      <p>
        <Link to={back}>{backLabel}</Link>
      </p>
    </>
  );
}

/** One story: read it, follow its links, see who and what is in it, change it, delete it. */
export function NotePage({ noteId }: { noteId: string }) {
  const archive = useArchive();
  const [data, load] = useNoteData(archive.id, noteId);
  const [editing, setEditing] = useState(false);
  const stories = inArchive(archive.id, '/stories');

  if (data === 'loading') {
    return (
      <ArchiveLayout title="Story">
        <Loading what="Opening the memory…" />
      </ArchiveLayout>
    );
  }
  if (data === 'missing' || data === 'failed') {
    return (
      <ArchiveLayout title="Story">
        <NotFound data={data} back={stories} backLabel="Back to the stories" />
      </ArchiveLayout>
    );
  }
  return (
    <ArchiveLayout title={data.note.title} wide>
      {editing ? (
        <>
          <h1 className="page-title">Fix something</h1>
          <EditNote
            archive={archive}
            note={data.note}
            onDone={(saved) => {
              setEditing(false);
              if (saved) void load();
            }}
          />
        </>
      ) : (
        <Story archive={archive} data={data} onEdit={() => setEditing(true)} />
      )}
    </ArchiveLayout>
  );
}

function Story({ archive, data, onEdit }: { archive: Archive; data: Loaded; onEdit: () => void }) {
  const { note, backlinks, notes } = data;
  const stories = inArchive(archive.id, '/stories');
  const { remove, deleting, deleteFailed } = useNoteActions(archive, note, stories);
  const parts = splitNote(note.body);
  const inThis = linkedNotes(note.body, notes);
  const missing = missingTargets(note.body, notes);

  const order = storyOrder(notes);
  const at = order.findIndex((n) => n.id === note.id);
  const prev = at > 0 ? order[at - 1] : undefined;
  const next = at >= 0 ? order[at + 1] : undefined;

  return (
    <>
      <div className="spread">
        <nav aria-label="Breadcrumb" className="row small muted">
          <Link to={stories} style={{ color: 'var(--graphite)' }}>
            Stories
          </Link>
          <span aria-hidden="true">/</span>
          <span>{note.title}</span>
        </nav>
        <div className="row" style={{ gap: 4 }}>
          {prev && (
            <Link
              to={noteHref(archive.id, prev)}
              className="btn btn-sm"
              aria-label={`Previous story: ${prev.title}`}
            >
              <Icon name="back" size={14} />
              Previous
            </Link>
          )}
          {next && (
            <Link
              to={noteHref(archive.id, next)}
              className="btn btn-sm"
              aria-label={`Next story: ${next.title}`}
            >
              Next
              <Icon name="next" size={14} />
            </Link>
          )}
        </div>
      </div>

      <div className="story-layout">
        <article data-testid="note" className="story">
          <div className="stack" style={{ gap: 8 }}>
            <span className="small muted">
              {[whenLabel(note.occurred), typeLabel(note.type)].filter(Boolean).join(' · ')}
            </span>
            <h1 data-testid="note-heading" className="t-heading" style={{ textWrap: 'balance' }}>
              {note.title}
            </h1>
            {note.revised && (
              <span className="small muted">
                Last changed {new Date(note.revised).toLocaleDateString()}
              </span>
            )}
            {archive.writer && (
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="note-edit"
                  onClick={onEdit}
                >
                  Fix something
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  data-testid="note-delete"
                  disabled={deleting}
                  onClick={() => void remove()}
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            )}
            {deleteFailed && <Failed>Could not delete.</Failed>}
          </div>

          <div className="prose" data-testid="note-text">
            {parts.paragraphs.length === 0 ? (
              <p className="muted">Nothing written here yet.</p>
            ) : (
              parts.paragraphs.map((p, i) => (
                <p key={i}>
                  <Linked text={p} notes={notes} archiveId={archive.id} mentions={note.mentions} />
                </p>
              ))
            )}
            {parts.provenance.length > 0 && (
              <div className="provenance stack" style={{ gap: 3 }}>
                {parts.provenance.map((line, i) => (
                  <span key={i}>
                    <Linked text={line} notes={notes} archiveId={archive.id} />
                  </span>
                ))}
              </div>
            )}
          </div>

          {parts.differs.length > 0 && (
            <section
              aria-labelledby="differ-h"
              className="stack"
              style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 16 }}
            >
              <h2 id="differ-h" className="t-small">
                Remembered a little differently
              </h2>
              <p className="muted">We keep both. No one has to be right.</p>
              <div className="differ">
                {parts.differs.map((d, i) => (
                  <div key={i}>
                    <p className="t-small">
                      <Linked text={d} notes={notes} archiveId={archive.id} />
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </article>

        <aside aria-label="About this story" className="story-aside">
          {(inThis.length > 0 || (archive.writer && missing.length > 0)) && (
            <section className="stack" style={{ gap: 5 }}>
              <h2 className="label-heading t-small">In this story</h2>
              <div className="row" style={{ gap: 4 }}>
                {inThis.map((n) => (
                  <Link key={n.id} to={noteHref(archive.id, n)} className="tag-link">
                    {n.title}
                  </Link>
                ))}
                {archive.writer &&
                  missing.map((t) => (
                    <Link
                      key={t}
                      to={inArchive(archive.id, `/stories/new?title=${encodeURIComponent(t)}`)}
                      className="tag-link missing"
                      data-testid="create-note"
                      title={`No page for “${t}” yet. Write one.`}
                    >
                      + {t}
                    </Link>
                  ))}
              </div>
            </section>
          )}
          <section data-testid="backlinks" className="stack" style={{ gap: 6 }}>
            <h2 className="label-heading t-small">Mentioned in</h2>
            {backlinks.occurrences.length === 0 ? (
              <p className="muted">No other memory links here yet.</p>
            ) : (
              backlinks.occurrences.map((o, i) => (
                <Link
                  key={`${o.sourceId}-${i}`}
                  to={noteHref(
                    archive.id,
                    notes.find((n) => n.id === o.sourceId) ?? { id: o.sourceId, type: 'event' },
                  )}
                  data-testid="backlink-row"
                  className="stack"
                  style={{ textDecoration: 'none' }}
                >
                  <span>{o.sourceTitle}</span>
                  <span className="t-small" style={{ color: 'var(--graphite)' }}>
                    {plainLinks(o.snippet)}
                  </span>
                </Link>
              ))
            )}
            {/* say it was cut: a short list that looks complete is a quiet lie */}
            {backlinks.truncated && (
              <p data-testid="backlinks-truncated" className="small muted">
                Showing {backlinks.occurrences.length} of {backlinks.total} mentions.
              </p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
