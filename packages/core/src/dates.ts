import type { FuzzyDate } from './types';

const FUZZY_RE = /^(~?)(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse a fuzzy date, preserving the raw text. Malformed input returns null — never coerced. */
export function parseFuzzyDate(raw: string): FuzzyDate | null {
  if (raw === 'unknown') return { raw, kind: 'unknown' };
  const m = FUZZY_RE.exec(raw);
  if (!m) return null;
  const [, approx, y, mo, d] = m;
  const year = Number(y);
  const month = mo === undefined ? undefined : Number(mo);
  const day = d === undefined ? undefined : Number(d);
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined) {
    if (month === undefined || day < 1) return null;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > daysInMonth[month - 1]!) return null;
  }
  const kind = approx
    ? 'approx'
    : day !== undefined
      ? 'exact'
      : month !== undefined
        ? 'month'
        : 'year';
  return {
    raw,
    kind,
    year,
    ...(month !== undefined && { month }),
    ...(day !== undefined && { day }),
  };
}

/** Lossless by construction: the raw text is the format. */
export function formatFuzzyDate(d: FuzzyDate): string {
  return d.raw;
}

/** recorded/revised (bi-temporal companions) must be full ISO datetimes. */
export function isIsoDateTime(s: string): boolean {
  return ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
}
