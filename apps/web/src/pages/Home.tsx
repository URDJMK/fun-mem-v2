import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listImports, listNotes, type ImportRun, type NoteSummary } from '../lib/api';
import { inArchive, isEntity, noteHref, useArchive } from '../lib/archive';
import { byDecade } from '../lib/timeline';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Decades } from '../components/Decades';
import { Avatar, count, Failed, Icon, Loading, whenLabel } from '../components/ui';

interface Loaded {
  notes: NoteSummary[];
  imports: ImportRun[];
}

/** One person's archive at a glance: how much is kept, where to add more, and their life so far. */
export function Home() {
  const archive = useArchive();
  const [data, setData] = useState<Loaded | null | 'failed'>(null);

  useEffect(() => {
    let live = true;
    Promise.all([listNotes(archive.id), listImports(archive.id)])
      .then(([notes, imports]) => live && setData({ notes, imports }))
      .catch(() => live && setData('failed'));
    return () => {
      live = false;
    };
  }, [archive.id]);

  const name = archive.subjectName;

  return (
    <ArchiveLayout title="Home">
      <section className="row" style={{ gap: '13px 18px' }}>
        <Avatar name={name} size={48} />
        <div className="stack" style={{ gap: 4, flex: '1 1 300px' }}>
          <h1 style={{ fontSize: 24, lineHeight: 1.05 }}>{name}</h1>
          {data && data !== 'failed' && (
            <p className="muted" data-testid="archive-counts">
              {summary(data)}
            </p>
          )}
        </div>
      </section>

      {archive.writer && (
        <section className="glow" aria-labelledby="start-h">
          <div className="glow-blobs" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="glow-content">
            <h2 id="start-h" style={{ fontSize: 24, textWrap: 'balance' }}>
              Sat down with {name} lately?
            </h2>
            <p style={{ fontSize: 15, color: 'var(--muted)', maxWidth: '40ch' }}>
              Bring in the transcript of your conversation. Every memory waits for you to read it
              before it joins the archive.
            </p>
            <Link
              to={inArchive(archive.id, '/interviews/new')}
              className="btn btn-primary btn-lg"
              style={{ minHeight: 32 }}
            >
              <Icon name="mic" size={20} />
              Add an interview
            </Link>
            <Link
              to={inArchive(archive.id, '/stories/new')}
              className="small"
              style={{
                color: 'var(--muted)',
                minHeight: 32,
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              or write down a memory yourself
            </Link>
          </div>
        </section>
      )}

      {data === null ? (
        <Loading what="Opening the archive…" />
      ) : data === 'failed' ? (
        <Failed>Could not load the archive. Reload the page.</Failed>
      ) : (
        <Overview archiveId={archive.id} name={name} notes={data.notes} />
      )}
    </ArchiveLayout>
  );
}

function summary({ notes, imports }: Loaded): string {
  const stories = notes.filter((n) => !isEntity(n.type)).length;
  const entities = notes.length - stories;
  const interviews = imports.filter((r) => !r.undone).length;
  if (notes.length === 0 && interviews === 0) return 'Nothing kept yet.';
  return [
    count(stories, 'story', 'stories'),
    count(entities, 'person or place', 'people and places'),
    count(interviews, 'interview', 'interviews'),
  ].join(' · ');
}

function Overview({
  archiveId,
  name,
  notes,
}: {
  archiveId: string;
  name: string;
  notes: NoteSummary[];
}) {
  const decades = byDecade(notes);
  const recent = [...notes]
    .filter((n) => !isEntity(n.type))
    .sort((a, b) => (b.revised ?? '').localeCompare(a.revised ?? ''))
    .slice(0, 4);

  return (
    <>
      <section aria-labelledby="life-h" className="card stack" style={{ gap: 10 }}>
        <div className="spread">
          <h2 id="life-h" style={{ fontSize: 16 }}>
            {name}’s life so far
          </h2>
          <Link to={inArchive(archiveId, '/timeline')} className="small">
            See the timeline
          </Link>
        </div>
        {decades.length === 0 ? (
          <p className="muted">
            No dated memories yet. When a memory says when it happened, it shows up here.
          </p>
        ) : (
          <>
            <Decades decades={decades} />
            <p className="small muted">
              Each dot is a memory. The dashed decades haven’t come up yet.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="recent-h" className="stack" style={{ gap: 8 }}>
        <h2 id="recent-h" className="label-heading">
          Recently added or changed
        </h2>
        {recent.length === 0 ? (
          <p className="empty">No stories yet.</p>
        ) : (
          <ul className="list">
            {recent.map((n) => (
              <li key={n.id}>
                <Link to={noteHref(archiveId, n)} className="list-row">
                  <span className="stack" style={{ flex: '1 1 260px' }}>
                    <span className="row-title">{n.title}</span>
                    {n.occurred && <span className="small muted">{whenLabel(n.occurred)}</span>}
                  </span>
                  <Icon name="next" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
