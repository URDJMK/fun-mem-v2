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

    // stable: same text ⇒ byte-identical vector, every call
    const [a1] = await p.embed(['We went to the sea together']);
    const [a2] = await p.embed(['We went to the sea together']);
    expect(a1).toEqual(a2);
    expect(a1!.length).toBe(1024);

    // normalized: unit L2 norm (inner product ≡ cosine — the vector leg uses <#>)
    const norm = Math.sqrt(a1!.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);

    // batch order matches input order and distinct texts get distinct vectors
    const [b, c] = await p.embed(['sea trip photos', 'company meeting schedule review']);
    expect(b).not.toEqual(c);
    expect(await p.embed([])).toEqual([]);

    // controllable similarity: shared tokens pull vectors together — the
    // property every fusion fixture in server/api relies on
    const simNear = cosine(a1!, b!); // shares the word 'sea'
    const simFar = cosine(a1!, c!); // disjoint topic
    expect(simNear).toBeGreaterThan(simFar);

    // inflected forms overlap through character bigrams (swim vs swimming):
    // closer than an unrelated text, the honest morphology property
    const [swim, swimming, other] = await p.embed([
      'swim',
      'swimming in the lake',
      'mountain trail maintenance plan',
    ]);
    expect(cosine(swim!, swimming!)).toBeGreaterThan(cosine(swim!, other!));
  });

  it('text in a script the English rules cannot read is embedded as plain text', async () => {
    // Tokens are runs of letters and digits in any script, so another language
    // gets real vectors, not the fixed vector that token-free text gets: it
    // stays searchable by its own words and never collapses into one point.
    const p = new DeterministicEmbeddingProvider();
    const [a1, a2, same, unrelated, tokenFree] = await p.embed([
      'бабушка родилась в Лиссабоне',
      'бабушка родилась в Лиссабоне',
      'бабушка любила море',
      'квартальный бюджет собрание',
      '?! ...',
    ]);
    expect(a1).toEqual(a2); // stable
    expect(a1).not.toEqual(tokenFree);
    expect(cosine(a1!, same!)).toBeGreaterThan(cosine(a1!, unrelated!));
    expect(cosine(a1!, same!)).toBeGreaterThan(0.1); // above the search leg's noise floor
  });
});
