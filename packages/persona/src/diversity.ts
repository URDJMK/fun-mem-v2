import type { EvidenceBlock } from './types';

/**
 * FM-027 unit 4 — source diversity, and what it deliberately does NOT claim.
 *
 * FR-083 wants materially disagreeing evidence retrieved and shown together,
 * and spec §2.3 forbids averaging it into one narrative. The obvious reading is
 * "detect contradiction", and that is not buildable here: two lanes proved it
 * from opposite directions, one of them by running this repo's own pinned
 * bge-m3. Two chunks stating OPPOSITE facts about the same event are
 * semantically SIMILAR, so cosine cannot separate agreement from contradiction,
 * and no NLI model is available under D-47.
 *
 * So this does not pretend to identify disagreement. It guarantees the weaker,
 * honest, verifiable property that makes disagreement VISIBLE: when several
 * notes speak to the same question, evidence from DIFFERENT source notes is
 * preserved and separately cited rather than collapsed into whichever note
 * happened to rank highest. A reader who sees two relatives' accounts side by
 * side can tell the archive disagrees with itself; the system never asserts
 * which one is right, which is the outcome §2.3 actually protects.
 */

/**
 * Re-order evidence so distinct source notes appear before a second chunk from
 * a note already represented, preserving score order within each rank.
 *
 * Pure re-ordering, never filtering: nothing is dropped, so this cannot remove
 * a note the ACL admitted, and it runs strictly downstream of the `allowed`
 * CTE. Selecting for diversity BEFORE the ACL resolves would be a way to leak
 * the existence of restricted notes through which sources got represented.
 */
export function interleaveBySource(blocks: EvidenceBlock[]): EvidenceBlock[] {
  const byNote = new Map<string, EvidenceBlock[]>();
  for (const b of [...blocks].sort(
    (x, y) => y.score - x.score || (x.chunkId < y.chunkId ? -1 : 1),
  )) {
    const list = byNote.get(b.noteId);
    if (list) list.push(b);
    else byNote.set(b.noteId, [b]);
  }
  // round-robin across notes; Map preserves insertion order, which is score
  // order of each note's best chunk, so the result is deterministic
  const out: EvidenceBlock[] = [];
  let round = 0;
  for (;;) {
    let added = false;
    for (const list of byNote.values()) {
      const b = list[round];
      if (b) {
        out.push(b);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return out;
}

/** How many distinct source notes the surviving claims speak from. */
export function distinctSources(noteIds: string[]): number {
  return new Set(noteIds).size;
}
