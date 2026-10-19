import { useState } from 'react';
import type { EntityType } from '@funmem/core';
import { ApiError, type NoteFields } from '../lib/api';
import { TYPE_LABEL, TYPES } from '../lib/words';

export interface NoteFormValues extends NoteFields {
  type: EntityType;
}

/** What the person is told when a save is refused, in words they can act on. */
function saveFailure(e: unknown): string {
  if (!(e instanceof ApiError)) return '저장하지 못했습니다.';
  if (e.status === 409) return '같은 제목의 기억이 이미 있습니다. 조금 다르게 적어 주세요.';
  if (e.code === 'date') return '날짜를 읽지 못했습니다. 1987, 1987-03, ~1948 처럼 적어 주세요.';
  if (e.code === 'too_long' || e.code === 'too_large')
    return '글이 너무 깁니다. 나누어 적어 주세요.';
  if (e.code === 'too_many_links') return '한 기억에 이어 둔 기억이 너무 많습니다.';
  if (e.status === 403) return '이 기록에서는 읽기만 할 수 있습니다.';
  if (e.status === 400) return '제목에 쓸 수 없는 글자가 있습니다. [ ] # ^ | 는 빼 주세요.';
  return '저장하지 못했습니다.';
}

/**
 * Writing a memory, new or again: its title, when it happened, what it is about (only when it
 * is new: the server keeps a memory's kind), and what happened. v1's words throughout.
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
      setError('제목이 필요합니다.');
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
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p>
        <label>
          제목
          <br />
          <input
            data-testid="note-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="마당의 빨랫줄"
          />
        </label>
      </p>
      <p>
        <label>
          언제
          <br />
          <input
            data-testid="note-occurred"
            value={occurred}
            onChange={(e) => setOccurred(e.target.value)}
            placeholder="1987 · 1987-03 · ~1948 · 비워 두어도 됩니다"
          />
        </label>
        <br />
        연도만 알아도 괜찮습니다. 모르면 비워 두세요 — 없는 날짜를 지어내지 않습니다.
      </p>
      {withType && (
        <p>
          <label>
            무엇에 대한 기억인가요
            <br />
            <select
              data-testid="note-type"
              value={type}
              onChange={(e) => setType(e.target.value as EntityType)}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      <p>
        <label>
          내용
          <br />
          <textarea
            data-testid="note-body"
            rows={12}
            cols={60}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="[[어머니]] 처럼 대괄호로 감싸면 다른 기억과 이어집니다."
          />
        </label>
      </p>
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="submit" data-testid="note-save" disabled={saving}>
          {saving ? '저장하는 중' : '저장하기'}
        </button>{' '}
        <button type="button" onClick={onCancel}>
          그만두기
        </button>
      </p>
    </form>
  );
}
