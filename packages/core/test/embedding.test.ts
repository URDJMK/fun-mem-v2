import { describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider } from '../src/embedding';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are unit-norm, so the dot product IS the cosine
}

describe('DeterministicEmbeddingProvider', () => {
  it('deterministic embedding provider is stable normalized and version-stamped', async () => {
    const p = new DeterministicEmbeddingProvider();

    // version-stamped: a non-empty model version and a fixed dimensionality
    expect(p.modelVersion).toBe('funmem-det-1024-v1');
    expect(p.dims).toBe(1024);

    // stable: same text (Korean included) ⇒ byte-identical vector, every call
    const [a1] = await p.embed(['우리는 바다에 갔다']);
    const [a2] = await p.embed(['우리는 바다에 갔다']);
    expect(a1).toEqual(a2);
    expect(a1!.length).toBe(1024);

    // normalized: unit L2 norm (inner product ≡ cosine — the vector leg uses <#>)
    const norm = Math.sqrt(a1!.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);

    // batch order matches input order and distinct texts get distinct vectors
    const [b, c] = await p.embed(['바다 여행 사진', '회사 회의 일정 정리']);
    expect(b).not.toEqual(c);
    expect(await p.embed([])).toEqual([]);

    // controllable similarity: shared tokens pull vectors together — the
    // property every fusion fixture in server/api relies on
    const simNear = cosine(a1!, b!); // shares 바다-ish content
    const simFar = cosine(a1!, c!); // disjoint topic
    expect(simNear).toBeGreaterThan(simFar);

    // particle variants overlap through character bigrams (바다 vs 바다에):
    // closer than an unrelated text, the honest Korean-morphology property
    const [sea, seaAt, other] = await p.embed(['바다', '바다에 갔다', '등산로 정비 계획']);
    expect(cosine(sea!, seaAt!)).toBeGreaterThan(cosine(sea!, other!));
  });
});
