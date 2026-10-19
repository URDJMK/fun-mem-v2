import { isIsoDateTime, parseFuzzyDate } from './dates';
import { ENTITY_TYPES } from './types';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Per-type known keys whose values must be fuzzy dates when present (FR-023). */
const TYPED_DATE_KEYS: Record<string, string[]> = {
  person: ['born', 'died'],
  place: [],
  event: ['occurred'],
  period: ['from', 'to'],
  object: ['acquired'],
  source: ['captured'],
};

/** Validate untrusted frontmatter. Reports problems; never throws on user data. */
export function validateFrontmatter(fm: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  if (typeof fm.id !== 'string' || !fm.id) errors.push('id: required string');
  if (typeof fm.title !== 'string' || !fm.title.trim()) errors.push('title: required string');
  const type = typeof fm.type === 'string' ? fm.type : '';
  if (!(ENTITY_TYPES as readonly string[]).includes(type))
    errors.push(`type: must be one of ${ENTITY_TYPES.join(', ')}`);

  const dateKeys = ['occurred', ...(TYPED_DATE_KEYS[type] ?? [])];
  for (const k of dateKeys) {
    const v = fm[k];
    if (v !== undefined && parseFuzzyDate(String(v)) === null)
      errors.push(`${k}: not a valid fuzzy date`);
  }
  for (const k of ['recorded', 'revised']) {
    const v = fm[k];
    if (v !== undefined && (typeof v !== 'string' || !isIsoDateTime(v)))
      errors.push(`${k}: not an ISO datetime`);
  }
  if (
    fm.contributors !== undefined &&
    (!Array.isArray(fm.contributors) || fm.contributors.some((c) => typeof c !== 'string'))
  )
    errors.push('contributors: must be a list of strings');

  return { ok: errors.length === 0, errors };
}

/**
 * The one title comparison key (spec §4.4) — resolver, link index and every SQL
 * site must produce this exact sequence.
 *
 * NFC is applied LAST, matching `normalize(lower(btrim(x)), NFC)` in SQL. An
 * expression index is matched on expression TEXT, not semantics: the two orders
 * happen to agree for Hangul, but the operand must be written the same way on
 * both sides or the index is silently not used.
 *
 * NFC, not NFKC. NFKC folds `Ⅳ`→`IV`, `①`→`1`, `ﬀ`→`ff` — for titles that are
 * person and place identities, that is lossy identity collapse.
 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().normalize('NFC');
}

/** Canonical STORED form: composition only, never case-folded. */
export function canonicalTitle(title: string): string {
  return title.trim().normalize('NFC');
}

/** Case-insensitive per-archive title uniqueness (spec §4.4). */
export class TitleResolver {
  private byTitle = new Map<string, string>();

  register(title: string, id: string): void {
    const key = normalizeTitle(title);
    const existing = this.byTitle.get(key);
    if (existing !== undefined && existing !== id)
      throw new Error(`title "${title}" is taken by ${existing}; titles are unique per archive`);
    this.byTitle.set(key, id);
  }

  /** Remove a registration; a no-op unless (title, id) matches the current owner. */
  unregister(title: string, id: string): void {
    const key = normalizeTitle(title);
    if (this.byTitle.get(key) === id) this.byTitle.delete(key);
  }

  resolve(title: string): string | null {
    return this.byTitle.get(normalizeTitle(title)) ?? null;
  }
}
