import { useEffect, useRef, useState } from 'react';
import { clock, type Note } from '../lib/interview';

/**
 * The interviewer's own notes, written as the interview goes, the way a Granola user jots beside
 * a call. Each line is stamped with the moment in the recording. They do three jobs: their names
 * and acronyms ("NLCS") are spelled right in the transcript from then on, the coach reads them,
 * and at the end they correct what the transcript misheard near each note (InterviewReview).
 */
export function Notes({
  notes,
  at,
  terms,
  onChange,
}: {
  notes: Note[];
  /** seconds into the recording now */
  at: () => number;
  /** the words in the notes being listened for */
  terms: string[];
  onChange: (notes: Note[]) => void;
}) {
  const [value, setValue] = useState('');
  // stamped when the writing began: a note is about what was being said then
  const began = useRef<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [notes.length]);

  function add() {
    const text = value.trim();
    if (!text) return;
    onChange([...notes, { at: Math.round(began.current ?? at()), text }]);
    setValue('');
    began.current = null;
  }

  return (
    <section className="coach-notes" aria-label="Your notes">
      <div className="coach-notes-head">
        <h3 className="label-heading">Your notes</h3>
        <span className="small muted">Names you write here are spelled right.</span>
      </div>
      {notes.length > 0 && (
        <ol className="coach-notes-list" ref={list}>
          {notes.map((n, i) => (
            <li key={`${n.at}-${i}`}>
              <span className="coach-notes-time">{clock(n.at)}</span>
              <span className="coach-notes-text">{n.text}</span>
              <button
                type="button"
                className="coach-notes-remove"
                aria-label={`Remove the note “${n.text}”`}
                onClick={() => onChange(notes.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          id="interview-note"
          className="input coach-notes-input"
          placeholder="Jot a name, a place, a year… Enter to add"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            if (!value && e.target.value) began.current = at();
            setValue(e.target.value);
          }}
        />
      </form>
      {terms.length > 0 && (
        <p className="small muted coach-notes-terms">Listening for: {terms.join(', ')}</p>
      )}
    </section>
  );
}
