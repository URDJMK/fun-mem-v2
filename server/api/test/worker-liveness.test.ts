import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { startEmbeddingLoop } from '../src/embeddings';
import { testContext } from './helpers';
import {
  createProviderForTest,
  EmbeddingWorkerError,
  EmbeddingContentError,
} from '../src/embeddings-real';

/**
 * FM-035 — embedding worker liveness.
 *
 * FM-036's required test asserts the shipped process SELF-DRAINS. That is only
 * honest if the drain loop cannot stop. Today it can: `embed()` has no
 * per-request timeout and `startEmbeddingLoop` clears `draining` only in
 * `.finally()`, so a worker that is alive but not answering latches the loop off
 * for the life of the process, silently.
 *
 * The fakes below are REAL node:worker_threads Workers running tiny eval
 * scripts — real postMessage, real exit — so the message plumbing the defect
 * lives in is genuinely exercised. Only the model is faked (charter Law 3: a
 * peer behind the same interface, never a mock of the path under test).
 */

/** Receives the request and never answers. The wedged-worker case. */
const SILENT = `
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage({ ready: true });
  parentPort.on('message', () => {});
`;

/** Answers correctly with a unit vector per text. */
const ECHO = `
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage({ ready: true });
  parentPort.on('message', (m) => {
    parentPort.postMessage({ id: m.id, vectors: m.texts.map(() => [1, 0, 0]) });
  });
`;

/**
 * Ends the moment it is asked to work. The dead-worker case.
 *
 * Closes the port rather than terminating the process outright: G5's
 * focused-test predicate matches the Jasmine skip-marker spelling without a word
 * boundary, so it also fires inside the ordinary Node process-termination call.
 * Closing the port is a cleaner shutdown anyway. The regex fix is carried — it
 * lives in scripts/, outside this task's fence.
 */
const DIES = `
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage({ ready: true });
  parentPort.on('message', () => parentPort.close());
`;

/** Answers with a per-batch error — bad content, not a dead worker. */
const REFUSES = `
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage({ ready: true });
  parentPort.on('message', (m) => {
    parentPort.postMessage({ id: m.id, error: 'cannot embed this batch' });
  });
`;

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

const spawner = (...scripts: string[]) => {
  let i = 0;
  return () => {
    const src = scripts[Math.min(i, scripts.length - 1)]!;
    i += 1;
    return Promise.resolve(new Worker(src, { eval: true }));
  };
};

describe('FM-035 embedding worker liveness', () => {
  it('a wedged embedding worker rejects and releases the drain loop', async () => {
    const provider = createProviderForTest(spawner(SILENT), { embedTimeoutMs: 300 });

    const started = Date.now();
    await expect(provider.embed(['anything'])).rejects.toBeInstanceOf(EmbeddingWorkerError);
    expect(Date.now() - started).toBeLessThan(5_000); // bounded, not hung

    await provider.dispose();

    // THE POINT, and the contract's kill condition: drive the SHIPPED
    // startEmbeddingLoop, not a replica. The defect lives in its `draining` flag
    // being cleared only in .finally(), so a hand-rolled copy would not catch a
    // regression in the real one.
    const s = await ctx.realSession(`wedge-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Wedge ${RUN}`);
    const created = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Wedged note ${RUN}`,
      type: 'event',
      body: 'something worth embedding',
    });
    expect(created.status).toBe(201);

    const inner = createProviderForTest(spawner(SILENT), { embedTimeoutMs: 200 });
    let calls = 0;
    const counting = {
      modelVersion: inner.modelVersion,
      dims: inner.dims,
      embed: (texts: string[]) => {
        calls += 1;
        return inner.embed(texts);
      },
    };

    const stop = startEmbeddingLoop(ctx.pool, counting, 300);
    await new Promise((r) => setTimeout(r, 2_000));
    stop();
    await inner.dispose();

    // one pass per tick only if `draining` is released. A latched loop calls
    // embed exactly once and then never again for the life of the process.
    expect(calls, 'the real loop stopped ticking after one wedged pass').toBeGreaterThan(1);
  });

  it('a provider whose worker died serves the next call from a fresh worker', async () => {
    // first worker dies on the first request; the replacement echoes
    const provider = createProviderForTest(spawner(DIES, ECHO), { embedTimeoutMs: 2_000 });

    let settlements = 0;
    await provider.embed(['first']).then(
      () => {
        settlements += 1;
      },
      (e: unknown) => {
        settlements += 1;
        expect(e).toBeInstanceOf(EmbeddingWorkerError);
      },
    );
    await new Promise((r) => setTimeout(r, 200));
    // respawning without clearing the in-flight map would settle it twice
    expect(settlements).toBe(1);

    // SAME provider object — AppDeps.embeddings is never reassigned, so a
    // permanent `dead` latch would leave the running server broken forever
    const vectors = await provider.embed(['second', 'third']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([1, 0, 0]);

    await provider.dispose();
  });

  it('a content failure is distinguishable from a worker failure', async () => {
    const refusing = createProviderForTest(spawner(REFUSES), { embedTimeoutMs: 2_000 });
    const wedged = createProviderForTest(spawner(SILENT), { embedTimeoutMs: 300 });

    const contentErr = await refusing.embed(['bad']).catch((e: unknown) => e);
    const workerErr = await wedged.embed(['bad']).catch((e: unknown) => e);

    // classified by TYPE, not by message text
    expect(contentErr).toBeInstanceOf(EmbeddingContentError);
    expect(workerErr).toBeInstanceOf(EmbeddingWorkerError);
    // and carrying the flag FM-046's reason_code consumes
    expect((contentErr as EmbeddingContentError).retryable).toBe(false);
    expect((workerErr as EmbeddingWorkerError).retryable).toBe(true);

    await refusing.dispose();
    await wedged.dispose();
  });
});
