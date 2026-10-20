import { describe, expect, it } from 'vitest';
import { ENTITY_TYPES } from '../src/types';
import { TitleResolver, validateFrontmatter } from '../src/validate';

describe('typed frontmatter', () => {
  it('typed frontmatter validates all six entity types', () => {
    for (const type of ENTITY_TYPES) {
      expect(validateFrontmatter({ id: 'u1', title: 't', type }).ok, type).toBe(true);
    }
    // validation reports, never throws on user data
    expect(validateFrontmatter({ id: 'u1', title: 't', type: 'alien' })).toMatchObject({
      ok: false,
    });
    expect(validateFrontmatter({ title: 't', type: 'person' }).errors[0]).toMatch(/id/);
    expect(
      validateFrontmatter({ id: 'u1', title: 't', type: 'person', occurred: '~1948' }).ok,
    ).toBe(true);
    expect(
      validateFrontmatter({ id: 'u1', title: 't', type: 'person', occurred: '13/13' }).ok,
    ).toBe(false);
    expect(
      validateFrontmatter({ id: 'u1', title: 't', type: 'event', recorded: 'yesterday' }).ok,
    ).toBe(false);
    expect(
      validateFrontmatter({ id: 'u1', title: 't', type: 'event', contributors: 'noah' }).ok,
    ).toBe(false);
    // per-type known keys are checked when present
    expect(validateFrontmatter({ id: 'u1', title: 't', type: 'person', born: '~1948' }).ok).toBe(
      true,
    );
    expect(validateFrontmatter({ id: 'u1', title: 't', type: 'person', born: 'nope' }).ok).toBe(
      false,
    );
    expect(
      validateFrontmatter({ id: 'u1', title: 't', type: 'period', from: '1960', to: '1975' }).ok,
    ).toBe(true);
  });
});

describe('title resolver', () => {
  it('title resolver enforces case-insensitive uniqueness', () => {
    const r = new TitleResolver();
    r.register('Grandma Kim', 'uuid-1');
    expect(r.resolve('grandma kim')).toBe('uuid-1');
    expect(r.resolve('  GRANDMA KIM ')).toBe('uuid-1');
    expect(() => r.register('GRANDMA KIM', 'uuid-2')).toThrow(/unique|taken/i);
    r.register('Grandma Kim', 'uuid-1'); // same id re-register is a no-op
    r.register('Zo\u{EB}', 'uuid-3');
    expect(r.resolve('ZO\u{CB}')).toBe('uuid-3'); // case-insensitive beyond ASCII
    expect(r.resolve('Zoe\u{308}')).toBe('uuid-3'); // and the decomposed spelling is the same title
    expect(r.resolve('nobody')).toBeNull();
  });
});
