import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { EmbeddingProvider } from '@funmem/core';
import { EmbeddingContentError, EmbeddingWorkerError } from './embedding-errors';

/**
 * Real embedding provider (FM-022, D-30): BAAI/bge-m3 dense embeddings via the
 * Xenova ONNX mirror (MIT), int8, CLS-pooled + L2-normalized, no query/passage
 * prefixes — bge-m3's documented usage. Runs in a worker_thread because
 * onnxruntime-node's session.run() blocks the event loop despite returning a
 * Promise (onnxruntime#19611); the pipeline is loaded ONCE per process and the
 * worker lives for the process lifetime (session churn leaks — ORT#26831).
 * Weights download anonymously from HF on first use into a MACHINE-GLOBAL
 * cache (a repo-relative cache would re-download 568MB in every scratch
 * worktree/clone the harness creates), pinned to an immutable commit.
 */

const MODEL_ID = 'Xenova/bge-m3';
/** immutable HF commit of the vendored artifact (2026-02-10) */
const REVISION = '4de13258303883538bd53b696b452bf8099f0858';
const DIMS = 1024;
/**
 * bge-m3 accepts 8192 tokens, but an uncapped tokenization is the documented
 * seconds-per-chunk footgun; retrieval quality for block-level chunks is
 * unaffected by capping input length.
 */
const MAX_CHARS = 4000;
const READY_TIMEOUT_MS = 300_000; // first call may download 568MB

// the worker is evaluated as plain CJS source (no TS/loader coupling); the
// parent resolves the library path so worker resolution never depends on CWD
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
(async () => {
  try {
    const mod = await import(pathToFileURL(workerData.modPath).href);
    const { env, pipeline } = mod;
    env.cacheDir = workerData.cacheDir;
    if (workerData.remoteHost) env.remoteHost = workerData.remoteHost;
    const fe = await pipeline('feature-extraction', workerData.modelId, {
      dtype: 'int8',
      revision: workerData.revision,
    });
    parentPort.postMessage({ ready: true });
    parentPort.on('message', async ({ id, texts }) => {
      try {
        const out = await fe(texts, { pooling: 'cls', normalize: true });
        parentPort.postMessage({ id, vectors: out.tolist() });
      } catch (e) {
        parentPort.postMessage({ id, error: String((e && e.message) || e) });
      }
    });
  } catch (e) {
    parentPort.postMessage({ fatal: String((e && e.message) || e) });
  }
})();
`;

export function defaultModelCacheDir(): string {
  return process.env.FUNMEM_MODEL_CACHE ?? `${process.env.HOME ?? '.'}/.cache/funmem/models`;
}

/**
 * Where the weights download from: Hugging Face, or the mirror HF_ENDPOINT names (the
 * variable Hugging Face's own tools read). transformers.js does not read it itself, so a
 * mirror or a deliberately dead endpoint was ignored and the download went to huggingface.co.
 */
function modelHost(): string | undefined {
  return process.env.HF_ENDPOINT || undefined;
}

// The error taxonomy lives apart (embedding-errors.ts), so the drain and the Workers AI provider
// can use it without importing this file's worker_threads; re-exported for existing importers.
export { EmbeddingContentError, EmbeddingWorkerError } from './embedding-errors';

/** How long one embed request may go unanswered before the worker is replaced. */
export const EMBED_TIMEOUT_MS = 120_000;

class BgeM3EmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = `${MODEL_ID}@${REVISION.slice(0, 12)}#int8:${DIMS}d`;
  readonly dims = DIMS;

  private nextId = 0;
  /**
   * FM-035: null means "no live worker" — NOT a permanent death latch. The next
   * embed() respawns. A latch would be terminal in production because
   * AppDeps.embeddings is a plain field set once at createApp() and is never
   * reassigned anywhere in the repo, so the running server would hold a dead
   * provider forever.
   */
  private worker: Worker | null = null;
  private readonly waiting = new Map<
    number,
    { resolve: (v: number[][]) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly spawn: () => Promise<Worker>,
    private readonly embedTimeoutMs: number = EMBED_TIMEOUT_MS,
  ) {}

  private attach(worker: Worker): Worker {
    worker.on('message', (m: { id?: number; vectors?: number[][]; error?: string }) => {
      if (m.id === undefined) return;
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      // the worker ANSWERED and refused this batch: a content fault, not a
      // liveness fault — retrying it forever is what stalls a queue
      if (m.error !== undefined || !m.vectors) {
        w.reject(new EmbeddingContentError(m.error ?? 'embed failed'));
      } else w.resolve(m.vectors);
    });
    worker.on('exit', (code) => {
      // settle everything in flight, then allow a respawn on the next call
      const err = new EmbeddingWorkerError(`embedding worker exited (code ${code})`);
      for (const [, w] of this.waiting) w.reject(err);
      this.waiting.clear();
      if (this.worker === worker) this.worker = null;
    });
    return worker;
  }

  /** Adopt an already-ready worker (the boot handshake's), without respawning. */
  primeWith(worker: Worker): void {
    this.worker = this.attach(worker);
  }

  private spawning: Promise<Worker> | null = null;

  private live(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    // memoized: two concurrent embed() calls must not each spawn a worker and
    // leak the loser — its `this.worker === worker` exit guard would no longer
    // match, so nothing would ever terminate it
    if (!this.spawning) {
      this.spawning = this.spawn()
        .then((w) => {
          this.spawning = null;
          this.worker = this.attach(w);
          return this.worker;
        })
        .catch((e: unknown) => {
          this.spawning = null;
          throw new EmbeddingWorkerError(`embedding worker failed to spawn: ${String(e)}`);
        });
    }
    return this.spawning;
  }

  /** Drop the current worker so the next call gets a fresh one. */
  private replace(worker: Worker): void {
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const worker = await this.live();
    const id = this.nextId++;
    const capped = texts.map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t));
    return new Promise<number[][]>((resolve, reject) => {
      // A worker that is ALIVE but not answering emits neither 'error' nor
      // 'exit', so without this timer the promise never settles — and
      // startEmbeddingLoop clears `draining` only in .finally(), which means one
      // wedged request latches the drain loop off for the life of the process,
      // silently. This timer is what makes FM-036's self-drain claim honest.
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        this.replace(worker);
        reject(
          new EmbeddingWorkerError(`embedding request timed out after ${this.embedTimeoutMs}ms`),
        );
      }, this.embedTimeoutMs);
      timer.unref?.();
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ id, texts: capped });
    });
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}

/**
 * FM-035 test seam: the same class with an injected spawn, so liveness is
 * testable against a real worker_threads Worker running a tiny script instead
 * of the 568MB model.
 */
export function createProviderForTest(
  spawn: () => Promise<Worker>,
  opts: { embedTimeoutMs?: number } = {},
): RealProvider {
  return new BgeM3EmbeddingProvider(spawn, opts.embedTimeoutMs ?? EMBED_TIMEOUT_MS);
}

export interface RealProvider extends EmbeddingProvider {
  dispose(): Promise<void>;
}

let singleton: Promise<RealProvider> | null = null;

/**
 * Load-once singleton. Resolves when the model is loaded and ready (first call
 * may download the weights); REJECTS if the model cannot load — the caller
 * wires `embeddings: null` in that case so search degrades to keyword-only
 * rather than crashing or silently swapping providers.
 */
/**
 * Spawn ONE model worker and resolve when it reports ready. This is the unit the
 * provider respawns — passing a closure over a single boot-time Worker instead
 * would make respawn illusory in production while passing every test that
 * injects its own spawn.
 */
function spawnModelWorker(cacheDir: string): Promise<Worker> {
  return new Promise<Worker>((resolve, reject) => {
    const modPath = createRequire(import.meta.url).resolve('@huggingface/transformers');
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        modPath,
        cacheDir,
        modelId: MODEL_ID,
        revision: REVISION,
        remoteHost: modelHost(),
      },
    });
    const fail = (e: Error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new EmbeddingWorkerError('embedding model load timed out')),
      READY_TIMEOUT_MS,
    );
    timer.unref?.();
    worker.once('message', (m: { ready?: boolean; fatal?: string }) => {
      if (m.ready) {
        clearTimeout(timer);
        resolve(worker);
      } else {
        fail(new EmbeddingWorkerError(m.fatal ?? 'embedding model failed to load'));
      }
    });
    worker.once('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

export function createBgeM3Provider(cacheDir = defaultModelCacheDir()): Promise<RealProvider> {
  if (singleton) return singleton;
  singleton = spawnModelWorker(cacheDir)
    .then((worker) => {
      // the provider respawns through the SAME function, so a timeout or death
      // in production genuinely produces a fresh, model-loaded worker
      const provider = new BgeM3EmbeddingProvider(() => spawnModelWorker(cacheDir));
      provider.primeWith(worker); // reuse the boot handshake's worker for call 1
      return provider;
    })
    .catch((e: unknown) => {
      singleton = null; // every failure path is retryable, timeout included
      throw e;
    });
  return singleton;
}
