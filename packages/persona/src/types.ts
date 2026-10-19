/**
 * FM-026 — the vocabulary of a grounded answer.
 *
 * The shape here is the load-bearing design decision of the whole task: a
 * `Claim` is something the provider EMITS, never something parsed out of prose
 * afterwards. Requiring "a citation per claim" first requires knowing what a
 * claim is, and there is no Korean claim segmenter anywhere in this monorepo.
 * `Intl.Segmenter('ko')` splits on terminal punctuation that oral-transcript
 * Korean routinely omits — `'아버지는 농부였어요 그때는 다들 힘들었죠'` is ONE
 * segment and TWO claims — so splitting prose would let a single citation
 * silently cover a second, uncited claim. That is the forbidden shortcut
 * arriving through a segmentation gap rather than through laziness.
 */

/**
 * How precisely a citation can point into its source.
 *
 * D-46. `block` is the ideal and requires an authored `^anchor`. Measured
 * across all 67 real markdown files in this repo: 7,664 chunks, **0 anchored**.
 * Anchors are author-typed, never invented, and the editor never offers to
 * insert one. So a citation contract that only admits `block` would force
 * abstention on essentially the whole archive — which contradicts the "useful
 * abstention" half of FR-084. The weaker grains are declared, surfaced to the
 * reader, and never silently substituted.
 */
export type CitationGrain = 'block' | 'heading' | 'chunk';

/**
 * The epistemic relation between a claim and its source.
 *
 * Only `quote` is mechanically provable — it is a substring of the source after
 * NFC normalisation of BOTH sides. `paraphrase` and `inference` cannot be
 * proved by code, so the validator's job for them is narrower: confirm the
 * citation is real and the claim is not secretly a failed quote.
 *
 * The spec disagrees with itself on the taxonomy: §8.5 lists four labels
 * (including family recollection), the ledger three, journey 6.4 a different
 * three. This is the 3-way EPISTEMIC axis; contributor attribution rides on the
 * source note as metadata rather than becoming a fourth computed label. The
 * divergence is flagged in the contract, not silently resolved.
 */
export type ClaimKind = 'quote' | 'paraphrase' | 'inference';

/**
 * A pointer back into the archive.
 *
 * The durable key is `(noteId, anchor)`. `chunkId` is deliberately NOT identity:
 * `reindexChunks` deletes and re-inserts every chunk of a note on each save
 * without specifying `id`, so chunk UUIDs are re-minted for byte-identical text.
 * A validator keyed on `chunkId` would spuriously invalidate after any unrelated
 * edit. It is carried only for membership checking within a single turn.
 */
export interface Citation {
  noteId: string;
  /** The authored `^anchor`, or null when the chunk has none. */
  anchor: string | null;
  grain: CitationGrain;
  /** Membership within THIS turn only — never persisted as identity. */
  chunkId: string;
  /** Heading path used when `grain === 'heading'`. */
  headingPath?: string[];
  /** Chunk index used when `grain === 'chunk'`. */
  chunkIndex?: number;
}

export interface Claim {
  text: string;
  kind: ClaimKind;
  citation: Citation;
}

/**
 * One retrieved chunk, as it enters a prompt.
 *
 * `content` is the FULL chunk text, not the 200-char search snippet: the
 * validator has to prove a quote against the whole thing, and a snippet would
 * make every quote past character 200 unprovable.
 */
export interface EvidenceBlock {
  chunkId: string;
  noteId: string;
  noteTitle: string;
  anchor: string | null;
  headingPath: string[];
  chunkIndex: number;
  content: string;
  /** Which search legs found this chunk. Abstention reads this, never the fused score. */
  legs: string[];
  ranks: Record<string, number>;
  score: number;
  contributor: string | null;
  recorded: string | null;
  occurred: string | null;
}

export interface SystemRules {
  /** Injected by code on the first turn — never left to the model to volunteer. */
  selfIdentification: string;
  maxClaims: number;
}

export interface GroundingRequest {
  question: string;
  evidence: EvidenceBlock[];
  rules: SystemRules;
  /** Caller-supplied. There is no hidden session state in this package. */
  turnIndex: number;
}

/** What a provider returns. Nothing here is trusted until the validator runs. */
export interface AnswerDraft {
  selfIdentification: string | null;
  claims: Claim[];
  abstained: boolean;
}

/**
 * The provider seam.
 *
 * Deliberately NOT `EmbeddingProvider`'s shape — that one is
 * `embed(texts) => number[][]` and has no notion of a prompt, system rules,
 * retrieved context or structured output. What is reused is the SEAM DISCIPLINE
 * that FM-022 established: one interface, a deterministic default that is a real
 * implementation rather than a mock, a real provider isolated in its own file
 * and selected by dependency injection at exactly one call site, and
 * `providerVersion` recorded on every turn the way `modelVersion` is recorded on
 * every embedding row.
 */
export interface AnswerProvider {
  readonly providerVersion: string;
  answer(req: GroundingRequest): Promise<AnswerDraft>;
}
