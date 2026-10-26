import { describe, expect, it } from 'vitest';
import { EmbeddingContentError, EmbeddingWorkerError } from '../src/embedding-errors';
import { WorkersAiEmbeddingProvider, type AiBinding } from '../src/embeddings-workers-ai';

/**
 * On a Worker the embeddings come from Workers AI's bge-m3 (the model the Node server runs
 * locally cannot: 568 MB against 128 MB of memory). It must keep the provider contract the
 * drain and the vector search rely on: one unit-length 1024-number vector per text, in order,
 * and failures classified as the drain's isolation expects.
 */
const DIMS = 1024;
const raw = (seed: number): number[] => Array.from({ length: DIMS }, (_, i) => Math.sin(seed + i));

/** a stand-in for the AI binding: records its calls, answers like @cf/baai/bge-m3 */
function fakeAi(answer?: (input: { text: string[] }) => unknown): AiBinding & {
  calls: Array<{ model: string; input: { text: string[]; truncate_inputs?: boolean } }>;
} {
  const calls: Array<{ model: string; input: { text: string[]; truncate_inputs?: boolean } }> = [];
  return {
    calls,
    run: async (model: string, input: unknown) => {
      const i = input as { text: string[]; truncate_inputs?: boolean };
      calls.push({ model, input: i });
      if (answer) return answer(i);
      return {
        shape: [i.text.length, DIMS],
        data: i.text.map((t) => raw(t.length)),
        pooling: 'cls',
      };
    },
  };
}

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('WorkersAiEmbeddingProvider', () => {
  it('names its model and size, distinct from the local model', () => {
    const p = new WorkersAiEmbeddingProvider(fakeAi());
    expect(p.dims).toBe(DIMS);
    expect(p.modelVersion).toContain('@cf/baai/bge-m3');
  });

  it('gives one unit-length vector per text, in order, asking bge-m3 to truncate long ones', async () => {
    const ai = fakeAi();
    const texts = ['a', 'bb', 'ccc'];
    const out = await new WorkersAiEmbeddingProvider(ai).embed(texts);
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v).toHaveLength(DIMS);
      expect(norm(v)).toBeCloseTo(1, 6);
    }
    // in order: the second vector is the second text's
    const second = raw(2);
    const n = norm(second);
    expect(out[1]![5]).toBeCloseTo(second[5]! / n, 9);
    expect(ai.calls[0]).toMatchObject({
      model: '@cf/baai/bge-m3',
      input: { truncate_inputs: true },
    });
  });

  it('sends at most 100 texts per call, the model limit', async () => {
    const ai = fakeAi();
    const texts = Array.from({ length: 230 }, (_, i) => `t${i}`);
    const out = await new WorkersAiEmbeddingProvider(ai).embed(texts);
    expect(out).toHaveLength(230);
    expect(ai.calls.map((c) => c.input.text.length)).toEqual([100, 100, 30]);
  });

  it('a reply with the wrong number of vectors is a worker fault, never zipped by index', async () => {
    const ai = fakeAi((i) => ({ shape: [1, DIMS], data: [raw(1)], pooling: 'cls', n: i }));
    await expect(new WorkersAiEmbeddingProvider(ai).embed(['a', 'b'])).rejects.toBeInstanceOf(
      EmbeddingWorkerError,
    );
  });

  it('a refused input is a content fault, so the drain can isolate the text; anything else is the service', async () => {
    const refusing = fakeAi(() => {
      throw new Error('AiError: Input validation error (5006): text must not be empty');
    });
    await expect(new WorkersAiEmbeddingProvider(refusing).embed(['x'])).rejects.toBeInstanceOf(
      EmbeddingContentError,
    );
    const down = fakeAi(() => {
      throw new Error('InferenceUpstreamError: 503 Service Unavailable');
    });
    await expect(new WorkersAiEmbeddingProvider(down).embed(['x'])).rejects.toBeInstanceOf(
      EmbeddingWorkerError,
    );
  });
});
