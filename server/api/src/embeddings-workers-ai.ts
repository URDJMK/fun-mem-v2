import type { EmbeddingProvider } from '@funmem/core';
import { EmbeddingContentError, EmbeddingWorkerError } from './embedding-errors';

/**
 * Embeddings on a Cloudflare Worker: Workers AI's bge-m3, the model the Node server runs
 * locally (embeddings-real.ts), which a Worker cannot load (568 MB against 128 MB of memory).
 *
 * The vectors are not the local model's to the last digit (that one is an int8 ONNX export),
 * so they carry a model version of their own: a deployment embeds its archive once with this
 * provider, and the vector search only ever compares vectors of one version (search.ts).
 *
 * Privacy: the text of every chunk goes to Workers AI to be embedded, as it would go to any
 * hosted model; Cloudflare does not train on it (docs/deploy.md).
 */

/** The part of the Workers AI binding this uses (`env.AI`). */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

const MODEL = '@cf/baai/bge-m3';
const DIMS = 1024;
/** the model's own limit on texts per call */
const PER_CALL = 100;

/** Input the model refused: the text is at fault (the drain isolates it), not the service. */
const REFUSED = /\b(5006|input validation|invalid input|validation error)\b/i;

export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = `${MODEL}#workers-ai:${DIMS}d`;
  readonly dims = DIMS;

  constructor(private readonly ai: AiBinding) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += PER_CALL) {
      out.push(...(await this.call(texts.slice(i, i + PER_CALL))));
    }
    return out;
  }

  private async call(text: string[]): Promise<number[][]> {
    let reply: unknown;
    try {
      // a chunk longer than the model takes is embedded by its beginning, not refused
      reply = await this.ai.run(MODEL, { text, truncate_inputs: true });
    } catch (e) {
      // classified by what the service said; the message itself is never logged (it may echo text)
      const said = e instanceof Error ? e.message : String(e);
      if (REFUSED.test(said)) throw new EmbeddingContentError('bge-m3 refused the input');
      throw new EmbeddingWorkerError('Workers AI did not answer');
    }
    const data = (reply as { data?: unknown } | null)?.data;
    // A short reply must never be zipped by index (see the drain): a WORKER fault, not content.
    if (
      !Array.isArray(data) ||
      data.length !== text.length ||
      !data.every((v) => Array.isArray(v) && v.length === DIMS)
    ) {
      throw new EmbeddingWorkerError(
        `Workers AI returned ${Array.isArray(data) ? data.length : 'no'} vectors for ${text.length} texts`,
      );
    }
    return (data as number[][]).map(unit);
  }
}

/** L2-normalized, as the local model's are: the vector search ranks by inner product. */
function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}
