import { describe, expect, it } from 'vitest';
import {
  clock,
  estimateTokens,
  linesOf,
  parseCite,
  partsOf,
  renderLines,
  textOf,
} from '../src/stories/lines';
import type { Turn } from '../src/transcript';

/**
 * The transcript as the story workflow shows it to the AI: numbered lines (L1, L2, …) that a
 * story's sentences cite, and parts small enough for one read.
 */
const turn = (index: number, speaker: string, text: string, start: number | null = null): Turn => ({
  index,
  speaker,
  start,
  end: start === null ? null : start + 5,
  text,
});
const TURNS = [
  turn(0, 'Q', 'Where were you born?', 0),
  turn(1, 'SPEAKER_01', 'I was born in Busan, in a little house near the harbour.', 3),
  turn(2, 'Q', 'And your father?', 25),
  turn(3, 'SPEAKER_01', 'My father repaired boats.', 28),
];
const lines = linesOf(TURNS, ['SPEAKER_01'], [['SPEAKER_01', 'Sunja']]);

describe('linesOf', () => {
  it('numbers from 1, marks the narrator, and names voices where it can', () => {
    expect(lines.map((l) => [l.n, l.name, l.teller])).toEqual([
      [1, 'Q', false],
      [2, 'Sunja', true],
      [3, 'Q', false],
      [4, 'Sunja', true],
    ]);
    expect(lines[1]).toMatchObject({ start: 3, end: 8, speaker: 'SPEAKER_01' });
  });
});

describe('renderLines', () => {
  it('writes each line with its number and who said it; others are marked as asking', () => {
    expect(renderLines(lines.slice(0, 2))).toBe(
      'L1 Q (asking): Where were you born?\nL2 Sunja: I was born in Busan, in a little house near the harbour.',
    );
  });
});

describe('parseCite', () => {
  it('reads the ways a model writes a line or a range', () => {
    expect(parseCite('L12')).toEqual({ from: 12, to: 12 });
    expect(parseCite('L12-L15')).toEqual({ from: 12, to: 15 });
    expect(parseCite('L12–15')).toEqual({ from: 12, to: 15 });
    expect(parseCite('12-15')).toEqual({ from: 12, to: 15 });
    expect(parseCite(' l3 ')).toEqual({ from: 3, to: 3 });
    expect(parseCite({ from: 2, to: 4 })).toEqual({ from: 2, to: 4 });
  });

  it('refuses what is not a line', () => {
    for (const bad of ['L0', 'L15-L12', 'line twelve', '', null, 7, { from: 'a' }]) {
      expect(parseCite(bad)).toBeNull();
    }
  });
});

describe('textOf', () => {
  it('joins the cited lines with who said them, once each, in order', () => {
    expect(
      textOf(lines, [
        { from: 4, to: 4 },
        { from: 1, to: 2 },
        { from: 2, to: 2 },
      ]),
    ).toBe(
      'Q: Where were you born?\nSunja: I was born in Busan, in a little house near the harbour.\nSunja: My father repaired boats.',
    );
  });

  it('ignores lines that do not exist', () => {
    expect(textOf(lines, [{ from: 9, to: 12 }])).toBe('');
  });
});

describe('estimateTokens and partsOf', () => {
  it('estimates four characters to a token', () => {
    expect(estimateTokens('a'.repeat(8))).toBe(2);
    expect(estimateTokens('abc')).toBe(1);
  });

  it('keeps everything in one part when it fits', () => {
    expect(partsOf(lines, 100_000)).toEqual([lines]);
  });

  it('splits only after one of the narrator’s lines, never leaving an empty part', () => {
    const parts = partsOf(lines, 15);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeGreaterThan(0);
      expect(p[p.length - 1]!.teller || p === parts[parts.length - 1]).toBe(true);
    }
    expect(parts.flat()).toEqual(lines);
  });
});

describe('clock', () => {
  it('reads seconds as minutes and seconds', () => {
    expect(clock(63.2)).toBe('1:03');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(null)).toBeNull();
  });

  it('a line without an end time ends where the next one starts', () => {
    const timed = linesOf(
      [
        { index: 0, speaker: 'Q', start: 3, end: null, text: 'Where?' },
        { index: 1, speaker: 'S', start: 28, end: null, text: 'Busan.' },
      ],
      ['S'],
      [],
    );
    expect(timed.map((l) => [l.start, l.end])).toEqual([
      [3, 28],
      [28, null],
    ]);
  });
});
