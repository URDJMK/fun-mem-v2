/**
 * Embedding provider seam (FM-022, spec §4.7/§16). Every embedding that
 * reaches pgvector flows through this interface — the real ONNX model and the
 * deterministic test/fallback provider are interchangeable behind it, and each
 * row records the provider's modelVersion (§16: vectors from different models
 * live in different spaces; comparing them is meaningless).
 */
export interface EmbeddingProvider {
  /** Recorded on every pgvector row; the vector leg filters on it at query time. */
  readonly modelVersion: string;
  readonly dims: number;
  /** One L2-normalized vector of `dims` numbers per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

/** FNV-1a over UTF-16 code units — stable across platforms, zero deps. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, seeded per token. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
const WORD_WEIGHT = 1.0;
const BIGRAM_WEIGHT = 0.7;

/**
 * Zero-dependency deterministic provider: same text ⇒ byte-identical vector,
 * on every machine. Token/bigram overlap ⇒ controllable cosine similarity, so
 * fusion fixtures can assert exact rank order (LangChain
 * DeterministicFakeEmbedding precedent, structure-preserving variant). Each
 * word token and each character bigram contributes a PRNG unit direction
 * seeded by its own hash — a word and an identical bigram share a direction,
 * which is the honest morphological bridge (바다 ↔ 바다에). It is a real
 * interface implementation — the drain, the model_version recording, and the
 * pgvector write path run unmodified — not a bypass. Also the runtime
 * fallback when the real model cannot load.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = 'funmem-det-1024-v1';
  readonly dims = 1024;

  private readonly directions = new Map<string, Float64Array>();

  private direction(token: string): Float64Array {
    const cached = this.directions.get(token);
    if (cached) return cached;
    const rand = mulberry32(fnv1a(token));
    const v = new Float64Array(this.dims);
    let norm = 0;
    for (let i = 0; i < this.dims; i++) {
      const x = rand() * 2 - 1;
      v[i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dims; i++) v[i]! /= norm;
    this.directions.set(token, v);
    return v;
  }

  private embedOne(text: string): number[] {
    const acc = new Float64Array(this.dims);
    const tokens = text.normalize('NFC').toLowerCase().match(WORD_RE) ?? [];
    let contributions = 0;
    for (const token of tokens) {
      const d = this.direction(token);
      for (let i = 0; i < this.dims; i++) acc[i]! += WORD_WEIGHT * d[i]!;
      contributions++;
      for (let i = 0; i + 1 < token.length; i++) {
        const b = this.direction(token.slice(i, i + 2));
        for (let j = 0; j < this.dims; j++) acc[j]! += BIGRAM_WEIGHT * b[j]!;
        contributions++;
      }
    }
    if (contributions === 0) {
      // token-free text still gets a fixed unit vector (never a zero vector)
      const empty = Array.from({ length: this.dims }, () => 0);
      empty[0] = 1;
      return empty;
    }
    let norm = 0;
    for (let i = 0; i < this.dims; i++) norm += acc[i]! * acc[i]!;
    norm = Math.sqrt(norm) || 1;
    return Array.from(acc, (x) => x / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}
