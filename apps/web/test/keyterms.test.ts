import { describe, expect, it } from 'vitest';
import { keytermsFor } from '../src/lib/keyterms';
import type { NoteSummary } from '../src/lib/api';

const note = (title: string, type: string, revised = '2026-01-01'): NoteSummary => ({
  id: title,
  title,
  type,
  revised,
  occurred: null,
});

describe('keytermsFor', () => {
  it('listens for the person, by full name and by the name inside it', () => {
    expect(keytermsFor('Grandma Nell', [])).toEqual(['Grandma Nell', 'Nell']);
  });

  it('adds the people and places the archive knows, newest first, and never a story', () => {
    const terms = keytermsFor('Grandma Nell', [
      note('Dorothy Peltier', 'person', '2026-01-01'),
      note('Duluth', 'place', '2026-03-01'),
      note('Her twenties in Duluth', 'event'),
      note('Mrs. Harju', 'person', '2026-02-01'),
    ]);
    expect(terms).toEqual(['Grandma Nell', 'Nell', 'Duluth', 'Mrs. Harju', 'Dorothy Peltier']);
  });

  it('says a name as it is spoken, once, and leaves out what is not a name', () => {
    const terms = keytermsFor('Nell', [
      note('Anna Lee (she/her)', 'person'),
      note('nell', 'person'),
      note('The house on the hill by the old mill', 'place'),
    ]);
    expect(terms).toEqual(['Nell', 'Anna Lee']);
  });

  it('stays within what Deepgram accepts', () => {
    const many = Array.from({ length: 300 }, (_, i) => note(`Person Number${i}`, 'person'));
    const terms = keytermsFor('Nell', many);
    expect(terms.length).toBeLessThanOrEqual(50);
    expect(terms.join('').length).toBeLessThanOrEqual(1200);
  });
});
