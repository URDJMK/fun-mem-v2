import { describe, expect, it } from 'vitest';
import { renameLinkTargets, validateNoteTitle } from '../src/rename';

describe('renameLinkTargets', () => {
  it('renameLinkTargets rewrites only real wikilink targets', () => {
    const body = [
      'Visit [[Mom]] and [[Mom|my mother]] and ![[Mom]].',
      'Deep [[Mom#Early Years#School]] and [[Mom#^b1]] and [[  Mom  ]] and [[mom]].',
      'Literal \\[[Mom]] stays. Alias pipe [[Mom|a\\|b]] keeps its alias.',
      '```',
      'fenced [[Mom]] untouched',
      '```',
      'inline `[[Mom]]` untouched, and [[Momentum]] is a different note.',
    ].join('\n');

    const out = renameLinkTargets(body, 'Mom', 'Grandma Kim');

    expect(out).toContain(
      'Visit [[Grandma Kim]] and [[Grandma Kim|my mother]] and ![[Grandma Kim]].',
    );
    // fragments byte-verbatim; interior padding preserved; case-insensitive match
    expect(out).toContain(
      'Deep [[Grandma Kim#Early Years#School]] and [[Grandma Kim#^b1]] and [[  Grandma Kim  ]] and [[Grandma Kim]].',
    );
    // escaped opener is not a link; escaped pipe stays inside the alias
    expect(out).toContain(
      'Literal \\[[Mom]] stays. Alias pipe [[Grandma Kim|a\\|b]] keeps its alias.',
    );
    // code is never rewritten; prefix-overlapping titles are not matches
    expect(out).toContain('fenced [[Mom]] untouched');
    expect(out).toContain('inline `[[Mom]]` untouched, and [[Momentum]] is a different note.');
    // no matching target -> body returned unchanged
    expect(renameLinkTargets('nothing here [[Dad]]', 'Mom', 'X')).toBe('nothing here [[Dad]]');
  });

  it('validateNoteTitle rejects link-breaking characters', () => {
    // a title is spliced verbatim into referrer link text — link syntax would
    // forge or corrupt links in other members' bodies
    expect(validateNoteTitle('Beach Trip')).toBeNull();
    expect(validateNoteTitle('할머니와 바다-여행 (1987)')).toBeNull();
    for (const bad of [
      'Trip #3',
      'Either|Or',
      'X]] [[Salary Data',
      'Trip [2020]',
      'block ^ref',
      'line\nbreak',
      'tab\there',
      '',
      '   ',
    ]) {
      expect(validateNoteTitle(bad)).not.toBeNull();
    }
  });
});
