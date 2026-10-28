import { saidDate, type ProfileFields } from '@funmem/core';

export { parseProfileInput, readProfile, saidDate, type ProfileFields } from '@funmem/core';

/**
 * The protagonist's profile (PRD D13, D14, 7.5): when they were born and died, and what the family
 * calls them. It lives on their person note (`notes.extra.profile`); a personal project points at
 * that note (`archives.subject_note_id`), and in a family project each narrator's note carries
 * their own. Every AI step that writes or checks a story reads it, and ages said in an interview
 * become years from it, in code.
 */
export interface Profile extends ProfileFields {
  noteId: string | null;
  /** the person note's title: their name */
  name: string;
}

/** "Who this is about:" for the AI: one line per person, or nothing when there is no one. */
export function profileBlock(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return '';
  const line = (p: Profile) =>
    [
      `- ${p.name}${p.aliases.length ? ` (called ${p.aliases.map((a) => `"${a}"`).join(', ')})` : ''}.`,
      p.born ? `Born ${saidDate(p.born)}.` : '',
      p.died ? `Died ${saidDate(p.died)}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  return `Who this is about:\n${profiles.map(line).join('\n')}`;
}

/** The profile as one line a story may cite ("P"): the checks read it like a transcript line. */
export function profileLine(profiles: readonly Profile[]): string {
  return profiles
    .map((p) =>
      [
        p.name,
        p.aliases.length ? `called ${p.aliases.join(' or ')}` : '',
        p.born ? `born ${saidDate(p.born)}` : '',
        p.died ? `died ${saidDate(p.died)}` : '',
      ]
        .filter(Boolean)
        .join(', '),
    )
    .join('; ')
    .concat(profiles.length ? '.' : '');
}

/** The year at an age: born ~1946, at eighteen → "~1964". Always approximate (a birthday may fall either side). */
export function ageYear(born: string | null, years: number): string | null {
  if (!born || !Number.isInteger(years) || years < 0 || years > 120) return null;
  const year = /\d{4}/.exec(born)?.[0];
  return year ? `~${Number(year) + years}` : null;
}
