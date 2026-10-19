import { describe, expect, it } from 'vitest';
import { extractHeadingPaths, checkFragment } from '../src/fragments';
import { extractWikilinks } from '../src/wikilink';

/**
 * FM-052 — a resolved link's FRAGMENT is never validated, so `[[Mom#Childhood]]`
 * against a note with no such heading is indistinguishable from a working link.
 *
 * These test the pure core half. The endpoint half lives in server/api/test.
 */
const link = (body: string) => extractWikilinks(body)[0]!;

describe('FM-052 fragment integrity (core)', () => {
  it('extractHeadingPaths returns nested paths and ignores fenced text', () => {
    const body = [
      '# Day 1',
      '',
      'Some prose.',
      '',
      '## Morning',
      '',
      '```',
      '# not a heading',
      '```',
      '',
      '### Coffee',
      '',
      '# Day 2',
    ].join('\n');
    const paths = extractHeadingPaths(body);
    expect(paths).toContainEqual(['Day 1']);
    expect(paths).toContainEqual(['Day 1', 'Morning']);
    expect(paths).toContainEqual(['Day 1', 'Morning', 'Coffee']);
    expect(paths).toContainEqual(['Day 2']);
    // a fenced line that looks like a heading is content
    expect(paths.flat(), 'a fenced line was read as a heading').not.toContain('not a heading');
  });

  it('a citation to a block id the target does not have is reported broken', () => {
    const target = 'A paragraph. ^realid\n\n```\ncode\n```\n^ownline';
    expect(checkFragment(target, link('see [[N#^realid]]'))).toBe('ok');
    // FM-053's own-line form counts too
    expect(checkFragment(target, link('see [[N#^ownline]]'))).toBe('ok');
    expect(checkFragment(target, link('see [[N#^missing]]'))).toBe('broken');
    // block ids are machine-minted tokens, so matching is EXACT
    expect(
      checkFragment(target, link('see [[N#^REALID]]')),
      'block ids matched case-insensitively',
    ).toBe('broken');
  });

  it('a citation to a heading the target does not have is reported broken', () => {
    // "Day 1" has no prose beneath it before the next heading, so it produces
    // no chunk — matching against chunk output would report it broken
    const target = '# Day 1\n## Morning\n\nCoffee at the harbour.\n\n## Evening\n\nRain.';
    expect(
      checkFragment(target, link('see [[N#Day 1]]')),
      'a contentless heading was rejected',
    ).toBe('ok');
    expect(checkFragment(target, link('see [[N#Morning]]'))).toBe('ok');
    // nesting: an ancestor path must match in order, not as a flat membership test
    expect(checkFragment(target, link('see [[N#Day 1#Morning]]'))).toBe('ok');
    expect(
      checkFragment(target, link('see [[N#Evening#Morning]]')),
      'ancestors matched out of order',
    ).toBe('broken');
    expect(checkFragment(target, link('see [[N#Childhood]]'))).toBe('broken');
    // prose headings fold case, consistent with normalizeTitle (house rule)
    expect(checkFragment(target, link('see [[N#morning]]'))).toBe('ok');
  });

  it('a working fragment is reported ok and a fragmentless link reports nothing', () => {
    const target = '# Heading\n\nBody. ^anchored';
    // ABSENT, not 'ok' — "no fragment" and "fine" are different answers
    expect(checkFragment(target, link('see [[N]]'))).toBeUndefined();
    expect(checkFragment(target, link('see [[N|alias]]'))).toBeUndefined();
    expect(checkFragment(target, link('see [[N#Heading]]'))).toBe('ok');
    expect(checkFragment(target, link('see [[N#^anchored]]'))).toBe('ok');
    // a malformed block id falls through to the heading branch and is broken
    expect(checkFragment(target, link('see [[N#^bad_id]]'))).toBe('broken');
  });
});
