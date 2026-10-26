import { useState } from 'react';
import type { EntityType } from '@funmem/core';
import { ApiError, type NoteFields } from '../lib/api';
import { TYPE_LABEL, TYPES } from '../lib/words';

export interface NoteFormValues extends NoteFields {
  type: EntityType;
}

/** What the person is told when a save is refused, in words they can act on. */
function saveFailure(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Could not save.';
  if (e.status === 409)
    return 'A memory with this title already exists. Try a slightly different title.';
  if (e.code === 'date')
    return 'That date could not be read. Write it like 1987, 1987-03 or ~1948.';
  if (e.code === 'too_long' || e.code === 'too_large')
    return 'The text is too long. Split it into more than one memory.';
  if (e.code === 'too_many_links') return 'This memory links to too many others.';
  if (e.status === 403) return 'In this project you can read, but not write.';
  if (e.status === 400) return 'A title cannot contain [ ] # ^ or |.';
  return 'Could not save.';
}

/**
 * Writing a memory, new or again: its title, when it happened, what it is about (only when it
 * is new: the server keeps a memory's kind), and what happened.
 */
export function NoteForm({
  initial,
  withType,
  onSave,
  onCancel,
}: {
  initial: NoteFormValues;
  /** a memory's kind is chosen once, when it is written */
  withType: boolean;
  onSave: (values: NoteFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [occurred, setOccurred] = useState(initial.occurred ?? '');
  const [type, setType] = useState<EntityType>(initial.type);
  const [body, setBody] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (title.trim() === '') {
      setError('A title is needed.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // an empty box means UNDATED, and undated is a real answer
      await onSave({ title: title.trim(), type, body, occurred: occurred.trim() || null });
    } catch (e) {
      setError(saveFailure(e));
      setSaving(false);
    }
  }

  return (
    <form
      data-testid="note-form"
      className="stack"
      style={{ gap: 13 }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        Title
        <input
          className="input"
          data-testid="note-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="The clothesline in the yard"
        />
      </label>
      <label className="field">
        When
        <input
          className="input"
          style={{ maxWidth: 320 }}
          data-testid="note-occurred"
          value={occurred}
          onChange={(e) => setOccurred(e.target.value)}
          placeholder="1987 · 1987-03 · ~1948"
        />
        <span className="hint">
          A year alone is fine, and ~ means “around”. If you don’t know, leave it empty: a date is
          never made up.
        </span>
      </label>
      {withType && (
        <fieldset style={{ margin: 0, padding: 2, border: 'none' }} className="stack">
          <legend style={{ fontWeight: 600, marginBottom: 10 }}>What is this memory about?</legend>
          <div className="row" data-testid="note-type">
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="chip"
                aria-pressed={type === t}
                data-type={t}
                onClick={() => setType(t)}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <label className="field">
        Text
        <textarea
          className="textarea textarea-serif"
          data-testid="note-body"
          rows={12}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What happened, in your own words."
        />
        <span className="hint">
          Put a name in double brackets, like [[Mother]], to link it to their page.
        </span>
      </label>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" data-testid="note-save" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
