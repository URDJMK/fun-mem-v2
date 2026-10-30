import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listNotes, type NoteSummary } from '../lib/api';
import { noteHref, useArchive } from '../lib/archive';
import { byDecade, yearOf } from '../lib/timeline';
import { typeLabel } from '../lib/words';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Decades } from '../components/Decades';
import { count, Failed, Loading, whenLabel } from '../components/ui';

/** Their life, decade by decade: exact years when they are known, "around" when they are not. */
export function Timeline() {
  const archive = useArchive();
  const [notes, setNotes] = useState<NoteSummary[] | null | 'failed'>(null);

  useEffect(() => {
    let live = true;
    listNotes(archive.id)
      .then((n) => live && setNotes(n))
      .catch(() => live && setNotes('failed'));
    return () => {
      live = false;
    };
  }, [archive.id]);

  return (
    <ArchiveLayout title="Timeline">
      <div className="stack" style={{ gap: 3 }}>
        <h1 className="page-title">
          {archive.kind === 'family'
            ? `${archive.subjectName}, year by year`
            : `${archive.subjectName}’s life, year by year`}
        </h1>
        <span className="muted">
          Exact years when we know them, “around” when we don’t. A date is never made up.
        </span>
      </div>
      {notes === null ? (
        <Loading what="Opening the timeline…" />
      ) : notes === 'failed' ? (
        <Failed>Could not load the timeline. Reload the page.</Failed>
      ) : (
        <Years archiveId={archive.id} notes={notes} />
      )}
    </ArchiveLayout>
  );
}

function Years({ archiveId, notes }: { archiveId: string; notes: NoteSummary[] }) {
  const decades = byDecade(notes);
  const undated = notes.filter((n) => yearOf(n.occurred) === null).length;

  if (decades.length === 0) {
    return (
      <p className="empty">
        No dated memories yet. When a memory says when it happened — even just “around 1950” — it
        shows up here.
      </p>
    );
  }

  return (
    <>
      <section aria-label="Memories by decade" className="card">
        <Decades decades={decades} hrefFor={(d) => `#d${d}`} />
        <p className="small muted" style={{ marginTop: 10 }}>
          Each dot is a memory. The dashed decades haven’t come up yet.
        </p>
      </section>

      {decades.map((d) => (
        <section
          key={d.start}
          id={`d${d.start}`}
          aria-labelledby={`h${d.start}`}
          className="stack"
          style={{ gap: 8 }}
        >
          <h2 id={`h${d.start}`} className="t-small">
            The {d.start}s{' '}
            <span className="muted t-small">
              · {d.items.length === 0 ? 'nothing yet' : count(d.items.length, 'memory', 'memories')}
            </span>
          </h2>
          {d.items.length === 0 ? (
            <div className="when-row">
              <span className="when muted">
                {d.start} – {String(d.start + 9).slice(2)}
              </span>
              <div
                className="when-card"
                style={{ border: '1.5px dashed var(--line)', background: 'none' }}
              >
                <span style={{ color: 'var(--graphite)' }}>
                  Nothing here yet. These years might be a lovely next conversation.
                </span>
              </div>
            </div>
          ) : (
            <ol className="stack" style={{ margin: 0, padding: 0, listStyle: 'none', gap: 8 }}>
              {d.items.map((n) => (
                <li key={n.id} className="when-row">
                  <span
                    className="when"
                    style={n.occurred?.startsWith('~') ? { color: 'var(--ink)' } : undefined}
                  >
                    {whenLabel(n.occurred).replace(/^Around /, '~')}
                  </span>
                  <Link to={noteHref(archiveId, n)} className="when-card">
                    <span className="title t-small">{n.title}</span>
                    <span className="small muted">{typeLabel(n.type)}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}

      {undated > 0 && (
        <p className="small muted">
          {count(undated, 'memory has', 'memories have')} no date, so{' '}
          {undated === 1 ? 'it isn’t' : 'they aren’t'} on the timeline.
        </p>
      )}
    </>
  );
}
