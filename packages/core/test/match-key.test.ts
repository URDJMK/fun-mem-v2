import { describe, expect, it } from 'vitest';
import { matchKey } from '../src/match-key';

/** One rule for "is this the same name?", used by the graph everywhere (graph design 3.2). */
describe('matchKey', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(matchKey('Mrs. Han')).toBe('mrs han');
    expect(matchKey('Mrs Han')).toBe('mrs han');
    expect(matchKey('  Sarah   LEE ')).toBe('sarah lee');
    expect(matchKey('Sarah-Lee')).toBe('sarah lee');
    expect(matchKey("Mae's farm")).toBe('mae s farm');
  });

  it('drops a leading "the"', () => {
    expect(matchKey('The sewing machine')).toBe(matchKey('sewing machine'));
    expect(matchKey('the  Old Mill')).toBe('old mill');
  });

  it('compares composed and decomposed letters alike, and keeps every script', () => {
    expect(matchKey('José')).toBe(matchKey('José'));
    expect(matchKey('김순자')).toBe('김순자');
    expect(matchKey('Москва')).toBe('москва');
  });

  it('is empty for a name with no letters or digits', () => {
    expect(matchKey('...')).toBe('');
    expect(matchKey('')).toBe('');
  });
});
