import { describe, expect, it } from 'vitest';
import { parseProfileInput } from '../src/profile';

/** A person's profile as entered (PRD D13): when they were born and died, and what they're called. */
describe('parseProfileInput', () => {
  it('takes a year, an approximate year, or a full date, and the names the family uses', () => {
    expect(parseProfileInput({ born: '1946', aliases: 'Grandma Sunja, Sunja' })).toEqual({
      born: '1946',
      died: null,
      aliases: ['Grandma Sunja', 'Sunja'],
    });
    expect(parseProfileInput({ born: 'about 1946' })).toMatchObject({ born: '~1946' });
    expect(parseProfileInput({ born: 'c. 1946' })).toMatchObject({ born: '~1946' });
    expect(parseProfileInput({ born: '~1946', died: '2019-03-02' })).toMatchObject({
      born: '~1946',
      died: '2019-03-02',
    });
    expect(parseProfileInput({ aliases: ['Mom', ' mom ', 'Nell', ''] })).toEqual({
      born: null,
      died: null,
      aliases: ['Mom', 'Nell'],
    });
    expect(parseProfileInput({})).toEqual({ born: null, died: null, aliases: [] });
  });

  it('refuses a date it cannot read, and names that are too long or too many', () => {
    expect(parseProfileInput({ born: 'spring of 46' })).toMatch(/born/);
    expect(parseProfileInput({ died: '1946-13-01' })).toMatch(/died/);
    expect(parseProfileInput({ aliases: ['x'.repeat(61)] })).toMatch(/names/);
    expect(parseProfileInput({ aliases: Array.from({ length: 11 }, (_, i) => `n${i}`) })).toMatch(
      /names/,
    );
    expect(parseProfileInput('nonsense')).toMatch(/profile/);
  });
});
