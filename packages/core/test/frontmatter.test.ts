import { describe, expect, it } from 'vitest';
import { parseFuzzyDate } from '../src/dates';
import { noteFromMarkdown, noteToMarkdown } from '../src/frontmatter';
import { ENTITY_TYPES, type Note } from '../src/types';

// mulberry32: tiny seeded RNG so the property loop is deterministic
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const TITLES = ['Grandma Kim', '엄마', 'The 1994 beach trip: part #2', 'Mr. O\'Neil — "uncle"'];
const BODIES = [
  '',
  'One line.',
  'First memory. ^b1\n\nSecond paragraph with [[links]].\n',
  '---\nA body that starts with a dash line.\n\n```\ncode ^not-an-anchor\n```\n',
  '기억 하나: 부산에서.\n',
];
const OCCURRED = [undefined, '1994', '1994-07', '~1948', 'unknown'];

function genNote(r: () => number, i: number): Note {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: pick(r, TITLES),
    meta: {
      type: pick(r, ENTITY_TYPES),
      ...(r() > 0.5 && { occurred: parseFuzzyDate(pick(r, OCCURRED.slice(1)) as string)! }),
      ...(r() > 0.5 && { recorded: '2026-07-15T09:30:00Z' }),
      ...(r() > 0.7 && { revised: '2026-07-15T10:00:00+09:00' }),
      ...(r() > 0.5 && { contributors: ['noah', 'aunt-mira'].slice(0, 1 + Math.floor(r() * 2)) }),
      extra: r() > 0.5 ? { mood: pick(r, ['warm', '그리움']), pinned: r() > 0.5 } : {},
    },
    body: pick(r, BODIES),
  };
}

describe('frontmatter', () => {
  it('frontmatter round-trip preserves notes', () => {
    const r = rng(42);
    for (let i = 0; i < 100; i++) {
      const note = genNote(r, i);
      expect(noteFromMarkdown(noteToMarkdown(note)), `case ${i}`).toEqual(note);
    }
  });

  it('preserves unknown keys and rejects notes missing identity fields', () => {
    const raw = noteToMarkdown({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Grandma Kim',
      meta: { type: 'person', occurred: parseFuzzyDate('~1948')!, extra: { shrine: true } },
      body: 'She grew up in Busan.\n',
    });
    const back = noteFromMarkdown(raw);
    expect(back.meta.extra).toEqual({ shrine: true });
    expect(back.meta.occurred?.raw).toBe('~1948');
    expect(() => noteFromMarkdown('---\ntitle: no id\n---\nbody')).toThrow(/id|type/i);
  });
});
