import { describe, expect, it } from 'vitest';
import { ageYear, profileBlock, profileLine } from '../src/stories/profile';

/**
 * The protagonist's profile (PRD D13, D14): when they were born and died, and what the family calls
 * them. Read by every AI step that writes or checks a story; ages become years from it.
 */
const SUNJA = {
  noteId: 'n1',
  name: 'Sunja Kim',
  born: '~1946',
  died: null,
  aliases: ['Grandma Sunja', 'Sunja'],
};

describe('profileBlock and profileLine', () => {
  it('tells the AI who the interview is about', () => {
    expect(
      profileBlock([
        SUNJA,
        { noteId: 'n2', name: 'Walter', born: '1938', died: '2001', aliases: [] },
      ]),
    ).toBe(
      'Who this is about:\n- Sunja Kim (called "Grandma Sunja", "Sunja"). Born about 1946.\n- Walter. Born 1938. Died 2001.',
    );
    expect(profileBlock([])).toBe('');
  });

  it('is a line a story may cite, holding the names and dates', () => {
    expect(profileLine([SUNJA])).toBe('Sunja Kim, called Grandma Sunja or Sunja, born about 1946.');
  });
});

describe('ageYear', () => {
  it('turns an age into an approximate year', () => {
    expect(ageYear('~1946', 18)).toBe('~1964');
    expect(ageYear('1946-04-12', 7)).toBe('~1953');
  });

  it('needs a birth year and a believable age', () => {
    expect(ageYear(null, 18)).toBeNull();
    expect(ageYear('1946', -1)).toBeNull();
    expect(ageYear('1946', 130)).toBeNull();
    expect(ageYear('1946', 2.5)).toBeNull();
  });
});
