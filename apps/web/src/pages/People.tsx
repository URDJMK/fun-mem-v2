import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  getNeighborhood,
  listNotes,
  listPeople,
  type Neighborhood,
  type NoteSummary,
} from '../lib/api';
import { inArchive, noteHref, useArchive, type Archive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Linked, plainLinks, splitNote } from '../components/NoteText';
import { Avatar, count, Failed, Icon, Loading } from '../components/ui';
import { EditNote, NotFound, useNoteActions, useNoteData, type Loaded } from './NotePage';

type Kind = 'person' | 'place';

interface Index {
  people: Array<NoteSummary & { backlinks: number }>;
  places: NoteSummary[];
}

/** Everyone and everywhere that comes up, and one of them opened beside the list. */
export function People({ noteId }: { noteId?: string }) {
  const archive = useArchive();
  const navigate = useNavigate();
  const [index, setIndex] = useState<Index | null | 'failed'>(null);
  const [kind, setKind] = useState<Kind>('person');

  useEffect(() => {
    let live = true;
    Promise.all([listPeople(archive.id), listNotes(archive.id)])
      .then(([people, notes]) => {
        if (!live) return;
        const byId = new Map(notes.map((n) => [n.id, n]));
        setIndex({
          people: people.flatMap((p) => {
            const n = byId.get(p.id);
            return n ? [{ ...n, backlinks: p.backlinks }] : [];
          }),
          places: notes
            .filter((n) => n.type === 'place')
            .sort((a, b) => a.title.localeCompare(b.title)),
        });
      })
      .catch(() => live && setIndex('failed'));
    return () => {
      live = false;
    };
  }, [archive.id, noteId]);

  // open the tab the chosen note belongs to
  useEffect(() => {
    if (!noteId || !index || index === 'failed') return;
    if (index.places.some((p) => p.id === noteId)) setKind('place');
    else if (index.people.some((p) => p.id === noteId)) setKind('person');
  }, [noteId, index]);

  // with nobody chosen, open the first one there is
  useEffect(() => {
    if (noteId || !index || index === 'failed') return;
    const first = index.people[0] ?? index.places[0];
    if (first) void navigate(noteHref(archive.id, first), { replace: true });
  }, [noteId, index, archive.id, navigate]);

  const list = index && index !== 'failed' ? (kind === 'person' ? index.people : index.places) : [];

  return (
    <ArchiveLayout title="People & places" wide>
      <div className="entity-layout">
        <nav aria-label="People and places" className="entity-index">
          <div role="tablist" aria-label="Show" className="segmented">
            {(['person', 'place'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
              >
                {k === 'person' ? 'People' : 'Places'}
              </button>
            ))}
          </div>
          {index === null ? (
            <Loading what="Opening…" />
          ) : index === 'failed' ? (
            <Failed>Could not load the people and places. Reload the page.</Failed>
          ) : list.length === 0 ? (
            <p className="muted small" style={{ padding: '0 4px' }}>
              {kind === 'person' ? 'No people yet.' : 'No places yet.'} A memory that puts a name in
              [[double brackets]] links to their page.
            </p>
          ) : (
            <ul className="stack" style={{ margin: 0, padding: 2, listStyle: 'none', gap: 2 }}>
              {list.map((n) => (
                <li key={n.id}>
                  <Link
                    to={noteHref(archive.id, n)}
                    className="entity-link"
                    aria-current={n.id === noteId ? 'page' : undefined}
                  >
                    <Avatar name={n.title} size={28} />
                    <span className="stack" style={{ lineHeight: 1.3, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{n.title}</span>
                      {'backlinks' in n && (
                        <span style={{ fontSize: 13 }} className="muted">
                          {n.backlinks === 0
                            ? 'Not mentioned elsewhere yet'
                            : `Comes up in ${count(n.backlinks as number, 'memory', 'memories')}`}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {archive.writer && (
            <Link
              to={inArchive(archive.id, `/stories/new?type=${kind}`)}
              className="btn btn-outline btn-sm"
              style={{ alignSelf: 'flex-start' }}
            >
              <Icon name="plus" size={14} />
              {kind === 'person' ? 'Add a person' : 'Add a place'}
            </Link>
          )}
        </nav>

        <div className="entity-main">
          {noteId ? (
            <Entity key={noteId} archive={archive} noteId={noteId} />
          ) : index && index !== 'failed' && index.people.length + index.places.length === 0 ? (
            <p className="empty">
              Nobody and nowhere has a page yet. When an interview or a memory names someone, they
              can get one.
            </p>
          ) : null}
        </div>
      </div>
    </ArchiveLayout>
  );
}

function Entity({ archive, noteId }: { archive: Archive; noteId: string }) {
  const [data, load] = useNoteData(archive.id, noteId);
  const [editing, setEditing] = useState(false);

  if (data === 'loading') return <Loading what="Opening…" />;
  if (data === 'missing' || data === 'failed') {
    return (
      <NotFound
        data={data}
        back={inArchive(archive.id, '/people')}
        backLabel="Back to people & places"
      />
    );
  }
  if (editing) {
    return (
      <EditNote
        archive={archive}
        note={data.note}
        onDone={(saved) => {
          setEditing(false);
          if (saved) void load();
        }}
      />
    );
  }
  return <EntityView archive={archive} data={data} onEdit={() => setEditing(true)} />;
}

function EntityView({
  archive,
  data,
  onEdit,
}: {
  archive: Archive;
  data: Loaded;
  onEdit: () => void;
}) {
  const { note, backlinks, notes } = data;
  const { remove, deleting, deleteFailed } = useNoteActions(
    archive,
    note,
    inArchive(archive.id, '/people'),
  );
  const parts = splitNote(note.body);
  const sources = new Set(backlinks.occurrences.map((o) => o.sourceId)).size;

  return (
    <article data-testid="note" className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: '6px 9px' }}>
        <Avatar name={note.title} size={40} />
        <div className="stack" style={{ gap: 2, flex: '1 1 240px' }}>
          <h1 data-testid="note-heading" style={{ fontSize: 16, lineHeight: 1.05 }}>
            {note.title}
          </h1>
          <span className="muted">
            {note.type === 'place' ? 'A place' : 'A person'}
            {sources > 0 ? ` · comes up in ${count(sources, 'memory', 'memories')}` : ''}
          </span>
        </div>
        {archive.writer && (
          <div className="row">
            <button type="button" className="btn btn-sm" data-testid="note-edit" onClick={onEdit}>
              Edit
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
      </div>
      {deleteFailed && <Failed>Could not delete.</Failed>}

      <Graph archiveId={archive.id} center={note} />

      <div className="grid-auto" style={{ '--min': '280px' } as CSSProperties}>
        <section aria-labelledby="facts-h" className="card stack" style={{ gap: 8, padding: 13 }}>
          <h2 id="facts-h" style={{ fontSize: 15 }}>
            What we know
          </h2>
          <div data-testid="note-text" className="stack" style={{ gap: 6 }}>
            {parts.paragraphs.length === 0 ? (
              <p className="muted">Nothing written about {note.title} yet.</p>
            ) : (
              parts.paragraphs.map((p, i) => (
                <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
                  <Linked text={p} notes={notes} archiveId={archive.id} />
                </p>
              ))
            )}
            {parts.provenance.map((line, i) => (
              <span key={i} className="small" style={{ color: 'var(--sage-ink)', fontWeight: 600 }}>
                <Linked text={line} notes={notes} archiveId={archive.id} />
              </span>
            ))}
          </div>
        </section>
        <section
          aria-labelledby="in-h"
          data-testid="backlinks"
          className="card stack"
          style={{ gap: 8, padding: 13 }}
        >
          <h2 id="in-h" style={{ fontSize: 15 }}>
            Where {note.type === 'place' ? 'it' : 'they'} come{note.type === 'place' ? 's' : ''} up
          </h2>
          {backlinks.occurrences.length === 0 ? (
            <p className="muted">No memory links here yet.</p>
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
                <span style={{ fontWeight: 600 }}>{o.sourceTitle}</span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>{plainLinks(o.snippet)}</span>
              </Link>
            ))
          )}
          {backlinks.truncated && (
            <p data-testid="backlinks-truncated" className="small muted">
              Showing {backlinks.occurrences.length} of {backlinks.total} mentions.
            </p>
          )}
        </section>
      </div>

      {parts.differs.length > 0 && (
        <section aria-labelledby="differ-h" className="stack" style={{ gap: 8 }}>
          <h2 id="differ-h" style={{ fontSize: 15 }}>
            Remembered a little differently
          </h2>
          <div className="differ">
            {parts.differs.map((d, i) => (
              <div key={i}>
                <p style={{ fontSize: 13 }}>
                  <Linked text={d} notes={notes} archiveId={archive.id} />
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

/** The notes linked to this one, laid out around it. Eight at most; the rest are in the lists below. */
function Graph({
  archiveId,
  center,
}: {
  archiveId: string;
  center: { id: string; title: string };
}) {
  const [hood, setHood] = useState<Neighborhood | null>(null);

  useEffect(() => {
    let live = true;
    getNeighborhood(archiveId, center.id)
      .then((h) => live && setHood(h))
      .catch(() => {
        /* the lists below say the same in words */
      });
    return () => {
      live = false;
    };
  }, [archiveId, center.id]);

  const around = (hood?.nodes ?? []).filter((n) => n.depth === 1).slice(0, 8);
  if (around.length === 0) return null;

  const spots = around.map((n, i) => {
    const a = (i / around.length) * 2 * Math.PI - Math.PI / 2;
    return { n, x: 50 + Math.cos(a) * 32, y: 50 + Math.sin(a) * 36 };
  });
  const said = around.map((n) => n.title).join(', ');

  return (
    <section aria-labelledby="graph-h" className="card" style={{ padding: 2, overflow: 'hidden' }}>
      <h2 id="graph-h" style={{ fontSize: 15, padding: '12px 14px 0' }}>
        How {center.title} fits in
      </h2>
      <div className="graph" role="img" aria-label={`${center.title} is linked with ${said}.`}>
        <svg
          aria-hidden="true"
          width="100%"
          height="100%"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {spots.map(({ n, x, y }) => (
            <path
              key={n.id}
              d={`M50 50 C ${(50 + x) / 2} 50, ${(50 + x) / 2} ${y}, ${x} ${y}`}
              fill="none"
              stroke="var(--dashed)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <span className="graph-node center" style={{ left: '50%', top: '50%' }}>
          {center.title}
        </span>
        {spots.map(({ n, x, y }) => (
          <Link
            key={n.id}
            to={noteHref(archiveId, n)}
            className={`graph-node ${n.type}`}
            style={{ left: `${x}%`, top: `${y}%` }}
            aria-hidden="true"
            tabIndex={-1}
          >
            {n.title}
          </Link>
        ))}
      </div>
    </section>
  );
}
