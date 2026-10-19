import { describe, expect, it } from 'vitest';
import { formatFuzzyDate, isIsoDateTime, parseFuzzyDate } from '../src/dates';

describe('temporal model', () => {
  it('fuzzy and bi-temporal dates round-trip losslessly', () => {
    for (const raw of ['1994', '1994-07', '1994-07-15', '~1948', '~1948-03', 'unknown']) {
      const d = parseFuzzyDate(raw);
      expect(d, raw).not.toBeNull();
      expect(formatFuzzyDate(d!)).toBe(raw);
    }
    expect(parseFuzzyDate('1994-07-15')!.kind).toBe('exact');
    expect(parseFuzzyDate('1994-07')).toMatchObject({ kind: 'month', year: 1994, month: 7 });
    expect(parseFuzzyDate('~1948')!.kind).toBe('approx');
    expect(parseFuzzyDate('unknown')!.kind).toBe('unknown');
    // malformed inputs are rejected, never coerced (tempting shortcut #1)
    for (const bad of [
      '1994-13',
      '1994-00-10',
      '07/15/1994',
      '1994-07-32',
      '1994-02-31',
      '1900-02-29',
      '',
    ]) {
      expect(parseFuzzyDate(bad), bad).toBeNull();
    }
    // bi-temporal companions (recorded/revised) are strict ISO datetimes
    expect(parseFuzzyDate('1996-02-29')).not.toBeNull(); // leap year
    expect(isIsoDateTime('2026-07-15T09:30:00Z')).toBe(true);
    expect(isIsoDateTime('2026-07-15T09:30:00+09:00')).toBe(true);
    expect(isIsoDateTime('yesterday')).toBe(false);
    expect(isIsoDateTime('2026-07-15')).toBe(false);
  });
});
