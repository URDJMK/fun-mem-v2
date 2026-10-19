import type { EvidenceBlock } from '../src/types';

/**
 * Shared fixtures. Korean throughout, because this is a Korean-market product
 * and the quote/paraphrase boundary is drawn by particles (조사) that an
 * English-only fixture would never exercise.
 */
export function block(over: Partial<EvidenceBlock> = {}): EvidenceBlock {
  return {
    chunkId: '11111111-1111-1111-1111-111111111111',
    noteId: '22222222-2222-2222-2222-222222222222',
    noteTitle: '할머니',
    anchor: 'abc-1',
    headingPath: ['어린 시절'],
    chunkIndex: 0,
    content: '할머니는 1943년에 부산에서 태어나셨다. 그때는 다들 힘들었죠.',
    legs: ['ts'],
    ranks: { ts: 1 },
    score: 0.5,
    contributor: 'mother',
    recorded: '2026-01-02T00:00:00Z',
    occurred: '1943-01-01',
    ...over,
  };
}

/** A block with no authored anchor — the 100% case in real notes (D-46). */
export const unanchored = block({
  chunkId: '33333333-3333-3333-3333-333333333333',
  anchor: null,
  content: '아버지는 농부였어요 그때는 다들 힘들었죠',
});
