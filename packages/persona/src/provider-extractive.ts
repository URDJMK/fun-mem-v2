import type { AnswerDraft, AnswerProvider, Claim, GroundingRequest } from './types';

/**
 * FM-026 unit 7 — the default provider, and the one the acceptance command
 * runs.
 *
 * This is a REAL implementation, not a mock, and the distinction matters: it
 * selects spans from admitted evidence rather than generating prose, so its
 * citations are correct by construction and every one of them is checked by the
 * same validator a real model's would be. It has the same standing as
 * `DeterministicEmbeddingProvider` — it exercises the validator, the abstention
 * gates, the labelling and self-identification, which is everything the
 * acceptance command gates.
 *
 * What it cannot do is produce fluent prose. That is precisely what a real
 * generator would add, and precisely what D-47 defers.
 */
export class DeterministicExtractiveAnswerProvider implements AnswerProvider {
  readonly providerVersion = 'extractive-1';

  answer(req: GroundingRequest): Promise<AnswerDraft> {
    // HONOURS THE GIVEN ORDER. Re-sorting by score here silently undid FM-027's
    // source interleaving one layer downstream: the caller carefully promoted a
    // second relative's account, and slicing to maxClaims after a score sort
    // dropped it again. That is the exact failure the required test names —
    // "returning only the higher-scoring source and dropping the other".
    const ordered = req.evidence;
    const claims: Claim[] = [];
    for (const b of ordered.slice(0, req.rules.maxClaims)) {
      // The first sentence-ish span of the chunk, taken VERBATIM so the quote
      // proof holds. Splitting on a terminator is safe here only because the
      // result is checked against the source rather than trusted.
      const text = (b.content.split(/(?<=[.!?])\s/)[0] ?? b.content).trim();
      if (!text) continue;
      claims.push({
        text,
        kind: 'quote',
        citation: {
          noteId: b.noteId,
          anchor: b.anchor,
          grain: b.anchor ? 'block' : b.headingPath.length ? 'heading' : 'chunk',
          chunkId: b.chunkId,
          ...(b.headingPath.length ? { headingPath: b.headingPath } : {}),
          chunkIndex: b.chunkIndex,
        },
      });
    }
    return Promise.resolve({
      selfIdentification: req.turnIndex === 0 ? req.rules.selfIdentification : null,
      claims,
      abstained: claims.length === 0,
    });
  }
}
