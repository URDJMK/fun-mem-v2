import type { EvidenceBlock } from '../src/types';

/**
 * Shared fixtures. Plain English family testimony. The quote/paraphrase boundary
 * is drawn by single small words (a preposition, an ending, a capital letter) that
 * a near-quote can differ in, so the sentences below are ones a paraphrase can
 * change by exactly one of them.
 */
export function block(over: Partial<EvidenceBlock> = {}): EvidenceBlock {
  return {
    chunkId: '11111111-1111-1111-1111-111111111111',
    noteId: '22222222-2222-2222-2222-222222222222',
    noteTitle: 'Grandma',
    anchor: 'abc-1',
    headingPath: ['Childhood'],
    chunkIndex: 0,
    content: 'Grandma was born in Lisbon in 1943. Everyone had a hard time back then.',
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
  content: 'my father was a farmer and back then everyone had a hard time',
});

/**
 * Text in scripts the English rules have no knowledge of. The package keeps it,
 * compares it exactly and costs it at its worst case; it never reads it.
 */
export const OTHER_SCRIPT = {
  /** "grandmother was born in Lisbon" */
  cyrillic: 'бабушка родилась в Лиссабоне',
  /** "everyone loved grandmother": the same word as above, in another case ending */
  cyrillicOtherCase: 'бабушку любили все',
  /** "Where did grandmother live?" */
  cyrillicQuestion: 'где жила бабушка?',
  /** "Grandma was born in Lisbon." */
  greek: 'Η γιαγιά γεννήθηκε στη Λισαβόνα.',
  /** A two-character word, the shortest unit of meaning in its script. */
  han: '\u{5317}\u{4EAC}',
};
