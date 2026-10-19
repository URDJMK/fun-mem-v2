import { describe, expect, it } from 'vitest';
import { budgetEvidence, estimateTokens, fenceBlock } from '../src/evidence';
import { distinctSources, interleaveBySource } from '../src/diversity';
import { block } from './fixtures';
import { verboseTestimony } from './korean-fixtures';

/**
 * FM-027 — source diversity as a PURE property.
 *
 * Deliberately unit-level. The end-to-end version of this assertion turned out
 * to be timing-dependent: `budgetEvidence` skips an oversized block and keeps
 * going (`continue`, not `break`), so a small second-source chunk can slip into
 * leftover space without any interleaving at all — and whether it does depends
 * on how many chunks of the verbose note rank into the top-K, which depends on
 * whether the async embedding drain has populated the vector leg yet. A test
 * that passes or fails on background timing is worse than no test.
 */
const src = (noteId: string, chunkId: string, content: string, score: number) =>
  block({ noteId, chunkId, content, score });

describe('FM-027 source diversity', () => {
  it('a verbose source cannot crowd a second source out of the window', () => {
    // Realistic transcribed testimony, not a repeated syllable: the token
    // estimate treats CJK per codepoint, so filler would mis-model real cost.
    const account = verboseTestimony(1);
    const blocks = [
      ...Array.from({ length: 8 }, (_, i) => src('note-A', `a${i}`, account, 0.9 - i / 100)),
      src('note-B', 'b0', account, 0.1),
    ];

    // The budget is DERIVED from the fixture, not guessed: room for two blocks
    // and no more. A hardcoded number silently stops testing anything the
    // moment the fixture text changes length.
    const one = estimateTokens(fenceBlock(blocks[0]!));
    const budget = one * 2 + Math.floor(one / 2);

    // WITHOUT interleaving, score order fills the window with note-A alone.
    const naive = budgetEvidence(blocks, budget);
    expect(naive.fitted.length, 'the budget did not fit exactly two blocks').toBe(2);
    expect(
      distinctSources(naive.fitted.map((b) => b.noteId)),
      'the naive path already fits both, so this proves nothing',
    ).toBe(1);

    // WITH it, the second relative is present. Same budget, same blocks.
    const fair = budgetEvidence(interleaveBySource(blocks), budget);
    expect(
      distinctSources(fair.fitted.map((b) => b.noteId)),
      'the second source was crowded out',
    ).toBe(2);
  });

  it('interleaving reorders without dropping or inventing evidence', () => {
    const blocks = [
      src('n1', 'c1', 'x', 0.9),
      src('n1', 'c2', 'y', 0.8),
      src('n2', 'c3', 'z', 0.7),
    ];
    const out = interleaveBySource(blocks);
    // pure re-ordering: nothing added, nothing removed. This is what keeps it
    // incapable of admitting a note the ACL excluded.
    expect(out.map((b) => b.chunkId).sort()).toEqual(['c1', 'c2', 'c3']);
    // the second source is promoted ahead of the first source's second chunk
    expect(out.map((b) => b.noteId)).toEqual(['n1', 'n2', 'n1']);
    // deterministic
    expect(interleaveBySource(blocks)).toEqual(out);
  });
});
