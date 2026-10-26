import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listNotes, type NoteSummary } from '../lib/api';
import { inArchive, isEntity, noteHref, useArchive } from '../lib/archive';
import { yearOf } from '../lib/timeline';
import { typeLabel } from '../lib/words';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { count, Failed, Icon, Loading, whenLabel } from '../components/ui';

/** Stories in the order they happened; the undated ones after, newest change first. */
export function storyOrder(notes: readonly NoteSummary[]): NoteSummary[] {
  return notes
    .filter((n) => !isEntity(n.type))
    .sort((a, b) => {
      const ya = yearOf(a.occurred);
      const yb = yearOf(b.occurred);
      if (ya !== null && yb !== null)
        return ya - yb || (a.occurred ?? '').localeCompare(b.occurred ?? '');
      if (ya !== null) return -1;
      if (yb !== null) return 1;
      return (b.revised ?? '').localeCompare(a.revised ?? '');
    });
}

/** Every story the reader can see. */
export function Stories() {
  const archive = useArchive();
  const [notes, setNotes] = useState<NoteSummary[] | null | 'failed'>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let live = true;
    listNotes(archive.id)
      .then((n) => live && setNotes(n))
      .catch(() => live && setNotes('failed'));
    return () => {
      live = false;
    };
  }, [archive.id]);

  const stories = notes && notes !== 'failed' ? storyOrder(notes) : [];
  const q = filter.trim().toLowerCase();
  const shown = q ? stories.filter((s) => s.title.toLowerCase().includes(q)) : stories;

  return (
    <ArchiveLayout title="Stories">
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 3 }}>
          <h1 className="page-title">Stories</h1>
          <span className="muted">
            {notes && notes !== 'failed' && stories.length > 0
              ? `${count(stories.length, 'story', 'stories')}, in the order they happened`
              : archive.kind === 'family'
                ? `What ${archive.subjectName} remember`
                : `What ${archive.subjectName} and the family remember`}
          </span>
        </div>
        {archive.writer && (
          <Link
            to={inArchive(archive.id, '/stories/new')}
            className="btn btn-primary"
            data-testid="nav-new"
          >
            <Icon name="pen" />
            Write a memory
          </Link>
        )}
      </div>

      {stories.length > 6 && (
        <label className="field" style={{ fontWeight: 400 }}>
          <span className="visually-hidden">Find a story by its title</span>
          <input
            className="input"
            placeholder="Find a story by its title…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
      )}

      <section data-testid="note-list" aria-label="Stories">
        {notes === null ? (
          <Loading what="Opening the stories…" />
        ) : notes === 'failed' ? (
          <Failed>Could not load the stories. Reload the page.</Failed>
        ) : stories.length === 0 ? (
          <p className="empty">
            No stories yet. Add an interview, or write down a memory yourself.
          </p>
        ) : shown.length === 0 ? (
          <p className="muted">No story has “{filter.trim()}” in its title.</p>
        ) : (
          <ul className="list">
            {shown.map((n) => (
              <li key={n.id}>
                <Link to={noteHref(archive.id, n)} className="list-row">
                  <span className="stack" style={{ flex: '1 1 260px' }}>
                    <span className="row-title">{n.title}</span>
                    <span className="small muted">
                      {[whenLabel(n.occurred) || 'No date', typeLabel(n.type)].join(' · ')}
                    </span>
                  </span>
                  <Icon name="next" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ArchiveLayout>
  );
}
