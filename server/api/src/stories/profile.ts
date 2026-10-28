import { parseFuzzyDate } from '@funmem/core';

/**
 * The protagonist's profile (PRD D13, D14, 7.5): when they were born and died, and what the family
 * calls them. It lives on their person note (`notes.extra.profile`); a personal project points at
 * that note (`archives.subject_note_id`), and in a family project each narrator's note carries
 * their own. Every AI step that writes or checks a story reads it, and ages said in an interview
 * become years from it, in code.
 */
export interface ProfileFields {
  /** a fuzzy date: "1946", "~1946", "1946-04-12" */
  born: string | null;
  died: string | null;
  /** what the family calls them: "Grandma Sunja", "Mom" */
  aliases: string[];
}

export interface Profile extends ProfileFields {
  noteId: string | null;
  /** the person note's title: their name */
  name: string;
}

const MAX_ALIASES = 10;
const MAX_ALIAS_CHARS = 60;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "about 1946", "c. 1946", "circa 1946" → "~1946"; a fuzzy date as it is; "" → null. */
function readDate(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return null;
  const about = /^(?:about|around|circa|ca\.?|c\.?|~)\s*(\d{4})$/i.exec(t);
  const date = about ? `~${about[1]}` : t;
  const parsed = parseFuzzyDate(date);
  return parsed && parsed.kind !== 'unknown' ? date : undefined;
}

/** What a person entered; a sentence saying what is wrong otherwise. */
export function parseProfileInput(v: unknown): ProfileFields | string {
  if (!isObj(v)) return 'give a profile: { born, died, aliases }';
  const born = readDate(v.born);
  if (born === undefined)
    return 'born: give a year like 1946, "about 1946", or a date like 1946-04-12';
  const died = readDate(v.died);
  if (died === undefined)
    return 'died: give a year like 2019, "about 2019", or a date like 2019-03-02';
  const raw = Array.isArray(v.aliases)
    ? v.aliases
    : typeof v.aliases === 'string'
      ? v.aliases.split(',')
      : [];
  const aliases: string[] = [];
  for (const a of raw) {
    if (typeof a !== 'string') return 'names: give them as text';
    const t = a.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (t.length > MAX_ALIAS_CHARS) return `names: each at most ${MAX_ALIAS_CHARS} characters`;
    if (!aliases.some((x) => x.toLowerCase() === t.toLowerCase())) aliases.push(t);
  }
  if (aliases.length > MAX_ALIASES) return `names: at most ${MAX_ALIASES}`;
  return { born, died, aliases };
}

/** The profile as stored, read leniently: a field that is not right is left out. */
export function readProfile(v: unknown): ProfileFields {
  const p = parseProfileInput(isObj(v) ? v : {});
  if (typeof p !== 'string') return p;
  const o = isObj(v) ? v : {};
  return {
    born: readDate(o.born) ?? null,
    died: readDate(o.died) ?? null,
    aliases: Array.isArray(o.aliases)
      ? o.aliases.filter((a): a is string => typeof a === 'string').slice(0, MAX_ALIASES)
      : [],
  };
}

/** "~1946" → "about 1946"; any other date as it is */
export const saidDate = (date: string): string =>
  date.startsWith('~') ? `about ${date.slice(1)}` : date;
const said = saidDate;

/** "Who this is about:" for the AI: one line per person, or nothing when there is no one. */
export function profileBlock(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return '';
  const line = (p: Profile) =>
    [
      `- ${p.name}${p.aliases.length ? ` (called ${p.aliases.map((a) => `"${a}"`).join(', ')})` : ''}.`,
      p.born ? `Born ${said(p.born)}.` : '',
      p.died ? `Died ${said(p.died)}.` : '',
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
        p.born ? `born ${said(p.born)}` : '',
        p.died ? `died ${said(p.died)}` : '',
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
