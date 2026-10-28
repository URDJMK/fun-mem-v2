import { parseProfileInput, saidDate, type ProfileFields } from '@funmem/core';

/** The profile as typed: dates and names as text, checked when sent. */
export interface ProfileDraft {
  born: string;
  died: string;
  aliases: string;
}

export const EMPTY_PROFILE: ProfileDraft = { born: '', died: '', aliases: '' };

export const draftOf = (p: ProfileFields): ProfileDraft => ({
  born: p.born ? saidDate(p.born) : '',
  died: p.died ? saidDate(p.died) : '',
  aliases: p.aliases.join(', '),
});

/** The fields to send, or a sentence saying what to fix (the server's own rules). */
export function readProfileDraft(d: ProfileDraft): ProfileFields | string {
  const p = parseProfileInput(d);
  return typeof p === 'string' ? `${p.charAt(0).toUpperCase()}${p.slice(1)}.` : p;
}

export const sameDraft = (a: ProfileDraft, b: ProfileDraft) =>
  a.born.trim() === b.born.trim() &&
  a.died.trim() === b.died.trim() &&
  a.aliases.trim() === b.aliases.trim();

/**
 * When someone was born and died, and what the family calls them. Every field may stay empty; a
 * birth year lets "when I was seven" in their stories become a year.
 */
export function ProfileInputs({
  value,
  onChange,
  name,
  idPrefix,
  disabled,
}: {
  value: ProfileDraft;
  onChange: (d: ProfileDraft) => void;
  /** their name, for the hints; empty while it is being typed */
  name: string;
  idPrefix: string;
  disabled?: boolean;
}) {
  const set = (k: keyof ProfileDraft) => (e: { target: { value: string } }) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="profile-dates">
        <label className="field" htmlFor={`${idPrefix}-born`}>
          Born
          <input
            id={`${idPrefix}-born`}
            className="input"
            name="born"
            inputMode="text"
            autoComplete="off"
            placeholder="1946, or about 1946"
            disabled={disabled}
            value={value.born}
            onChange={set('born')}
          />
        </label>
        <label className="field" htmlFor={`${idPrefix}-died`}>
          Died
          <input
            id={`${idPrefix}-died`}
            className="input"
            name="died"
            autoComplete="off"
            placeholder="If they have passed"
            disabled={disabled}
            value={value.died}
            onChange={set('died')}
          />
        </label>
      </div>
      <label className="field" htmlFor={`${idPrefix}-aliases`}>
        Also called
        <input
          id={`${idPrefix}-aliases`}
          className="input"
          name="aliases"
          autoComplete="off"
          placeholder="Grandma Nell, Nell"
          disabled={disabled}
          value={value.aliases}
          onChange={set('aliases')}
        />
        <span className="hint">
          A year is enough, and every field can wait. With a birth year, “when I was seven” in{' '}
          {name ? `${name}’s` : 'their'} stories becomes a year.
        </span>
      </label>
    </div>
  );
}
