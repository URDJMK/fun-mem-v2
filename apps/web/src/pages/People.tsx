import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  ApiError,
  cancelImport,
  type EntityDetail,
  type EntitySummary,
  type EntityType,
  getEntity,
  getNeighborhood,
  listEntities,
  type Neighborhood,
} from '../lib/api';
import { inArchive, noteHref, useArchive, type Archive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { GraphCanvas } from '../components/WhoAndWhere';
import { Review, Running, Saved, useImportRun } from '../components/ImportRun';
import { Linked, plainLinks, splitNote } from '../components/NoteText';
import { Avatar, count, Failed, Icon, Loading } from '../components/ui';
import { EditNote, NotFound, useNoteActions, useNoteData, type Loaded } from './NotePage';

type Kind = EntityType;

const KINDS: Array<{ kind: Kind; tab: string; none: string; add: string; noteType: string }> = [
  {
    kind: 'person',
    tab: 'People',
    none: 'No people yet.',
    add: 'Add a person',
    noteType: 'person',
  },
  { kind: 'place', tab: 'Places', none: 'No places yet.', add: 'Add a place', noteType: 'place' },
  { kind: 'thing', tab: 'Things', none: 'No things yet.', add: 'Add a thing', noteType: 'object' },
];

/**
 * Everyone, everywhere and everything the stories name (graph design 6.2), and one of them
 * opened beside the list. `id` is an entity's id, or the id of a note about one; a person or
 * place note that has no entity of its own is shown as the note.
 */
export function People({ noteId: id }: { noteId?: string }) {
  const archive = useArchive();
  const navigate = useNavigate();
  const [index, setIndex] = useState<EntitySummary[] | null | 'failed'>(null);
  const [kind, setKind] = useState<Kind>('person');
  // "Find people, places and things" (graph design 4.4); Home's empty graph links here with ?find=1
  const [params, setParams] = useSearchParams();
  const [finding, setFinding] = useState(archive.writer && params.get('find') === '1');
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    listEntities(archive.id)
      .then((list) => live && setIndex(list))
      .catch(() => live && setIndex('failed'));
    return () => {
      live = false;
    };
  }, [archive.id, id, reloads]);

  // open the tab the chosen one belongs to
  useEffect(() => {
    if (!id || !index || index === 'failed') return;
    const e = index.find((x) => x.id === id || x.noteId === id);
    if (e) setKind(e.type);
  }, [id, index]);

  // with nobody chosen, open the first one there is
  useEffect(() => {
    if (id || finding || !index || index === 'failed') return;
    const first = index[0];
    if (first) void navigate(inArchive(archive.id, `/people/${first.id}`), { replace: true });
  }, [id, index, archive.id, navigate]);

  const list = index && index !== 'failed' ? index.filter((e) => e.type === kind) : [];
  const k = KINDS.find((x) => x.kind === kind)!;

  return (
    <ArchiveLayout title="People, places & things" wide>
      <div className="entity-layout">
        <nav aria-label="People, places and things" className="entity-index">
          <div role="tablist" aria-label="Show" className="segmented">
            {KINDS.map((x) => (
              <button
                key={x.kind}
                type="button"
                role="tab"
                aria-selected={kind === x.kind}
                onClick={() => setKind(x.kind)}
              >
                {x.tab}
              </button>
            ))}
          </div>
          {index === null ? (
            <Loading what="Opening…" />
          ) : index === 'failed' ? (
            <Failed>Could not load the people, places and things. Reload the page.</Failed>
          ) : list.length === 0 ? (
            <p className="muted small" style={{ padding: '0 4px' }}>
              {k.none} They are found in the stories as interviews come in.
            </p>
          ) : (
            <ul className="stack" style={{ margin: 0, padding: 2, listStyle: 'none', gap: 2 }}>
              {list.map((e) => (
                <li key={e.id}>
                  <Link
                    to={inArchive(archive.id, `/people/${e.id}`)}
                    className="entity-link"
                    aria-current={e.id === id || e.noteId === id ? 'page' : undefined}
                  >
                    <Avatar name={e.name} size={28} />
                    <span className="stack" style={{ lineHeight: 1.3, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{e.name}</span>
                      <span style={{ fontSize: 13 }} className="muted">
                        {e.subject
                          ? 'Whose stories these are'
                          : e.stories === 0
                            ? 'In no story yet'
                            : `In ${count(e.stories, 'story', 'stories')}`}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {archive.writer && !finding && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ alignSelf: 'flex-start' }}
              data-testid="find-graph"
              onClick={() => setFinding(true)}
            >
              <Icon name="search" size={14} />
              Find people, places and things
            </button>
          )}
          {archive.writer && (
            <Link
              to={inArchive(archive.id, `/stories/new?type=${k.noteType}`)}
              className="btn btn-outline btn-sm"
              style={{ alignSelf: 'flex-start' }}
            >
              <Icon name="plus" size={14} />
              {k.add}
            </Link>
          )}
        </nav>

        <div className="entity-main">
          {finding ? (
            <FindGraph
              archive={archive}
              onDone={() => {
                setFinding(false);
                if (params.has('find')) setParams({}, { replace: true });
                setReloads((n) => n + 1);
              }}
            />
          ) : id ? (
            <EntityPage key={id} archive={archive} id={id} />
          ) : index && index !== 'failed' && index.length === 0 ? (
            <p className="empty">
              Nobody, nowhere and nothing yet. When an interview names someone, they appear here.
            </p>
          ) : null}
        </div>
      </div>
    </ArchiveLayout>
  );
}

const TYPE_LABEL: Record<Kind, string> = { person: 'A person', place: 'A place', thing: 'A thing' };

/** The button's run, followed here: reading the stories, then the review, then what was added. */
function FindGraph({ archive, onDone }: { archive: Archive; onDone: () => void }) {
  const run = useImportRun(archive.id);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run.build();
  }, [run]);
  const step = run.step;
  if (!step) return <Loading what="Starting…" />;
  if (step.kind === 'running')
    return (
      <Running
        graph
        job={step.job}
        onCancel={async () => {
          try {
            await cancelImport(archive.id, step.job.id);
          } catch {
            /* too late to stop: it finishes, and can be undone */
          }
        }}
      />
    );
  if (step.kind === 'failed')
    return (
      <div className="stack" style={{ gap: 8 }}>
        <Failed>{step.text}</Failed>
        <div className="row">
          <button type="button" className="btn" onClick={onDone}>
            Back
          </button>
        </div>
      </div>
    );
  if (step.kind === 'review')
    return (
      <div className="stack" style={{ gap: 10 }}>
        <Review
          archiveId={archive.id}
          jobId={step.jobId}
          outcome={step.outcome}
          name={archive.subjectName}
          onSaved={run.saved}
        />
        <div className="row">
          <button type="button" className="btn btn-quiet" onClick={onDone}>
            Not now
          </button>
        </div>
      </div>
    );
  if (step.kind === 'saved')
    return <Saved archiveId={archive.id} outcome={step.outcome} onRestart={onDone} />;
  return null;
}

/** One entity: what the stories say about it, its relationships, and the graph around it. */
function EntityPage({ archive, id }: { archive: Archive; id: string }) {
  const [entity, setEntity] = useState<EntityDetail | null | 'missing' | 'failed'>(null);

  useEffect(() => {
    let live = true;
    getEntity(archive.id, id)
      .then((e) => live && setEntity(e))
      .catch(
        (e: unknown) =>
          live && setEntity(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed'),
      );
    return () => {
      live = false;
    };
  }, [archive.id, id]);

  if (entity === null) return <Loading what="Opening…" />;
  // a person or place note with no entity of its own (a second note of the same name)
  if (entity === 'missing') return <Entity archive={archive} noteId={id} />;
  if (entity === 'failed') return <Failed>Could not open this just now. Reload the page.</Failed>;
  const e = entity;
  const stories = new Set([
    ...e.mentions.map((m) => m.storyId),
    ...e.relationships.map((r) => r.storyId),
  ]).size;

  return (
    <article data-testid="entity" className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: '6px 9px' }}>
        <Avatar name={e.name} size={40} />
        <div className="stack" style={{ gap: 2, flex: '1 1 240px' }}>
          <h1 data-testid="entity-heading" style={{ fontSize: 16, lineHeight: 1.05 }}>
            {e.name}
          </h1>
          <span className="muted">
            {TYPE_LABEL[e.type]}
            {stories > 0 ? ` · in ${count(stories, 'story', 'stories')}` : ''}
            {e.aliases.length ? ` · also called ${e.aliases.join(', ')}` : ''}
          </span>
        </div>
      </div>

      {e.subject && e.profile && (
        <p className="small muted">
          {[
            e.profile.born ? `Born ${said(e.profile.born)}` : 'Birth date not entered',
            e.profile.died ? `died ${said(e.profile.died)}` : '',
          ]
            .filter(Boolean)
            .join(', ')}
          . <Link to={inArchive(archive.id, '/settings')}>Change it in Settings</Link>
        </p>
      )}

      {e.graph.nodes.length > 1 && (
        <section aria-labelledby="fits-h" className="card stack" style={{ gap: 6, padding: 12 }}>
          <h2 id="fits-h" style={{ fontSize: 15 }}>
            How {e.name} fits in
          </h2>
          <GraphCanvas archiveId={archive.id} view={e.graph} height={320} />
        </section>
      )}

      <div className="grid-auto" style={{ '--min': '280px' } as CSSProperties}>
        <section
          aria-labelledby="say-h"
          data-testid="entity-mentions"
          className="card stack"
          style={{ gap: 8, padding: 13 }}
        >
          <h2 id="say-h" style={{ fontSize: 15 }}>
            What the stories say
          </h2>
          {e.mentions.length === 0 ? (
            <p className="muted">No story names {e.name} yet.</p>
          ) : (
            e.mentions.map((m) => (
              <Link
                key={m.storyId}
                to={inArchive(archive.id, `/stories/${m.storyId}`)}
                className="stack"
                style={{ textDecoration: 'none', gap: 1 }}
              >
                <span style={{ fontWeight: 600 }}>{m.storyTitle}</span>
                {m.line && <span style={{ fontSize: 14 }}>{m.line}</span>}
              </Link>
            ))
          )}
        </section>
        <section
          aria-labelledby="rel-h"
          data-testid="entity-relationships"
          className="card stack"
          style={{ gap: 8, padding: 13 }}
        >
          <h2 id="rel-h" style={{ fontSize: 15 }}>
            Relationships
          </h2>
          {e.relationships.length === 0 ? (
            <p className="muted">No relationship told yet.</p>
          ) : (
            e.relationships.map((r) => (
              <div key={r.id} className="stack" style={{ gap: 1 }}>
                <Link
                  to={inArchive(archive.id, `/people/${r.other.id}`)}
                  style={{ fontWeight: 600 }}
                >
                  {r.other.name}
                </Link>
                <span style={{ fontSize: 14 }}>{r.description}</span>
                <Link to={inArchive(archive.id, `/stories/${r.storyId}`)} className="small muted">
                  from “{r.storyTitle}”
                </Link>
              </div>
            ))
          )}
        </section>
      </div>

      {e.noteId ? (
        <EntityNote archive={archive} noteId={e.noteId} name={e.name} />
      ) : (
        archive.writer && (
          <Link
            to={inArchive(
              archive.id,
              `/stories/new?type=${KINDS.find((x) => x.kind === e.type)!.noteType}&title=${encodeURIComponent(e.name)}`,
            )}
            className="btn btn-outline btn-sm"
            style={{ alignSelf: 'flex-start' }}
          >
            Write about {e.name}
          </Link>
        )
      )}
    </article>
  );
}

const said = (d: string) => (d.startsWith('~') ? `about ${d.slice(1)}` : d);

/** what someone wrote about an entity, in its own note, with the note's edit button */
function EntityNote({ archive, noteId, name }: { archive: Archive; noteId: string; name: string }) {
  const [data, load] = useNoteData(archive.id, noteId);
  const [editing, setEditing] = useState(false);
  if (data === 'loading' || data === 'missing' || data === 'failed') return null;
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
  const parts = splitNote(data.note.body);
  return (
    <section aria-labelledby="note-h" className="card stack" style={{ gap: 8, padding: 13 }}>
      <div className="spread" style={{ gap: 6 }}>
        <h2 id="note-h" style={{ fontSize: 15 }}>
          Written about {name}
        </h2>
        {archive.writer && (
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {parts.paragraphs.length === 0 ? (
        <p className="muted">Nothing written about {name} yet.</p>
      ) : (
        parts.paragraphs.map((p, i) => (
          <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
            <Linked text={p} notes={data.notes} archiveId={archive.id} />
          </p>
        ))
      )}
    </section>
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
        backLabel="Back to people, places & things"
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
