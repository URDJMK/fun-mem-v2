import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { formatFuzzyDate, isIsoDateTime, parseFuzzyDate } from './dates';
import { ENTITY_TYPES, type EntityType, type Note, type NoteMeta } from './types';

const KNOWN_KEYS = new Set([
  'id',
  'title',
  'type',
  'occurred',
  'recorded',
  'revised',
  'contributors',
]);
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Serialize a Note to Obsidian-compatible markdown. Frontmatter values stay human-readable. */
export function noteToMarkdown(note: Note): string {
  const { meta } = note;
  const fm: Record<string, unknown> = { id: note.id, title: note.title, type: meta.type };
  if (meta.occurred) fm.occurred = formatFuzzyDate(meta.occurred);
  if (meta.recorded) fm.recorded = meta.recorded;
  if (meta.revised) fm.revised = meta.revised;
  if (meta.contributors) fm.contributors = meta.contributors;
  Object.assign(fm, meta.extra);
  return `---\n${stringifyYaml(fm)}---\n${note.body}`;
}

/** Parse markdown back to a Note. Identity fields are required; unknown keys are preserved. */
export function noteFromMarkdown(raw: string): Note {
  const m = FM_RE.exec(raw);
  if (!m) throw new Error('note has no frontmatter block');
  const fm = parseYaml(m[1]!) as Record<string, unknown>;
  if (fm === null || typeof fm !== 'object') throw new Error('frontmatter is not a map');
  const { id, title, type } = fm;
  if (typeof id !== 'string' || !id) throw new Error('frontmatter missing id');
  if (typeof title !== 'string' || !title) throw new Error('frontmatter missing title');
  if (typeof type !== 'string' || !(ENTITY_TYPES as readonly string[]).includes(type))
    throw new Error('frontmatter missing or invalid type');

  const meta: NoteMeta = { type: type as EntityType, extra: {} };
  if (fm.occurred !== undefined) {
    const d = parseFuzzyDate(String(fm.occurred));
    if (!d) throw new Error(`invalid occurred date: ${String(fm.occurred)}`);
    meta.occurred = d;
  }
  for (const k of ['recorded', 'revised'] as const) {
    const v = fm[k];
    if (v !== undefined) {
      if (typeof v !== 'string' || !isIsoDateTime(v)) throw new Error(`invalid ${k} datetime`);
      meta[k] = v;
    }
  }
  if (fm.contributors !== undefined) {
    if (!Array.isArray(fm.contributors) || fm.contributors.some((c) => typeof c !== 'string'))
      throw new Error('contributors must be a string list');
    meta.contributors = fm.contributors as string[];
  }
  for (const [k, v] of Object.entries(fm)) if (!KNOWN_KEYS.has(k)) meta.extra[k] = v;

  return { id, title, meta, body: raw.slice(m[0].length) };
}
